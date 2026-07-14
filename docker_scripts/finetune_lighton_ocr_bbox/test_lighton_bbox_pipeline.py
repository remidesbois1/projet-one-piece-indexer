import importlib.util
import os
from pathlib import Path

import torch
from PIL import Image


ROOT = Path(__file__).resolve().parent
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


train = load_module("bbox_train_test_module", "train_lighton_bbox.py")
export = load_module("bbox_export_test_module", "export_dataset.py")


def test_bbox_parser_rejects_invalid_and_clamps_coordinates():
    items, invalid = train.parse_bbox_output(
        "Bonjour [10,20,1100,200]\ninvalid\nDegenerate [4,4,4,8]"
    )
    assert items == [{"text": "Bonjour", "bbox": [10, 20, 1000, 200]}]
    assert invalid == 3


def test_exact_page_metrics_are_perfect():
    text = "Salut ! [10,20,100,120]\nÇa va ? [500,400,700,600]"
    score = train.score_page(text, text)
    assert score["cer"] == 0
    assert score["f1_50"] == 1
    assert score["mean_iou"] == 1
    assert score["page_exact"] is True


def test_missing_and_extra_boxes_are_penalized():
    reference = "A [0,0,100,100]\nB [200,200,300,300]"
    prediction = "A [0,0,100,100]\nC [700,700,800,800]"
    score = train.score_page(prediction, reference)
    assert score["true_positives"] == 1
    assert score["false_positives"] == 1
    assert score["false_negatives"] == 1
    assert score["f1_50"] == 0.5
    assert score["cer"] == 0  # historical metric only scores matched bubbles
    assert score["strict_cer"] > 0


def test_single_pass_assistant_masking():
    input_ids = torch.tensor([[0, 7, 8, 9, 10, 0]])
    attention = torch.tensor([[0, 1, 1, 1, 1, 0]])
    labels = train.engine.mask_assistant_labels(input_ids, attention, [8, 9], 0)
    assert labels.tolist() == [[-100, -100, -100, -100, 10, -100]]


def test_logits_slice_keeps_causal_lookbehind():
    original = train._shared_process_batch
    try:
        train._shared_process_batch = lambda *_args, **_kwargs: {
            "input_ids": torch.tensor([[1, 2, 3, 4, 5, 6]]),
            "labels": torch.tensor([[-100, -100, -100, 4, 5, 6]]),
        }
        batch = train.process_bbox_batch({}, None)
        assert batch["logits_to_keep"] == 4
        assert batch["labels"].tolist() == [[-100, 4, 5, 6]]
        assert batch["input_ids"].shape[1] == 6
    finally:
        train._shared_process_batch = original


def test_resize_never_exceeds_1500_and_preserves_small_pages():
    large = Image.new("RGB", (3000, 2000))
    resized, width, height = export.resize_page(large, export.TARGET_LONGEST_SIDE)
    assert resized.size == (1500, 1000)
    assert (width, height) == resized.size
    small = Image.new("RGB", (900, 1200))
    untouched, width, height = export.resize_page(small, export.TARGET_LONGEST_SIDE)
    assert untouched.size == (900, 1200)
    assert (width, height) == (900, 1200)


def test_page_cost_tracks_image_area_and_answer_length():
    short = {
        "resized_size": [750, 1000],
        "messages": [{"role": "assistant", "content": [{"type": "text", "text": "A"}]}],
    }
    long = {
        "resized_size": [1500, 1000],
        "messages": [
            {"role": "assistant", "content": [{"type": "text", "text": "A" * 300}]}
        ],
    }
    assert train._page_training_cost(long) > train._page_training_cost(short)


def test_inference_batching_preserves_pages_and_groups_costs():
    dataset = [
        {"resized_size": [1500, 1500], "messages": []},
        {"resized_size": [500, 500], "messages": []},
        {"resized_size": [900, 900], "messages": []},
    ]
    batches = train.engine.inference_batches(dataset, [0, 1, 2], 2)
    flattened = [index for batch in batches for index in batch]
    assert flattened == [1, 2, 0]
    assert sorted(flattened) == [0, 1, 2]


def test_frozen_splits_keep_duplicates_together(tmp_path):
    manifest_path = tmp_path / "split_manifest.json"
    splits, _ = export.build_frozen_splits(
        {1: "same", 2: "same", 3: "three", 4: "four", 5: "five"},
        manifest_path,
    )
    split_by_page = {
        page_id: split for split, page_ids in splits.items() for page_id in page_ids
    }
    assert split_by_page[1] == split_by_page[2]
    frozen_test = set(splits["test"])

    updated, _ = export.build_frozen_splits(
        {1: "same", 2: "same", 3: "three", 4: "four", 5: "five", 6: "six"},
        manifest_path,
    )
    assert set(updated["test"]) == frozen_test
    assert not (set(updated["train"]) & set(updated["test"]))
    assert not (set(updated["val"]) & set(updated["test"]))
