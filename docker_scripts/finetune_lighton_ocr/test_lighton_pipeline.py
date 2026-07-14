import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

import export_dataset
import train_lighton_ocr


class FakeTokenizer:
    pad_token_id = 0

    def batch_decode(self, rows, skip_special_tokens=True):
        return ["decoded" for _ in rows]


class FakeProcessor:
    tokenizer = FakeTokenizer()

    def apply_chat_template(self, messages, add_generation_prompt, tokenize=False):
        return "prompt"

    def __call__(self, text, images, **kwargs):
        batch = len(text)
        return {
            "input_ids": torch.tensor([[1, 2]] * batch),
            "attention_mask": torch.ones((batch, 2), dtype=torch.long),
            "pixel_values": torch.ones((batch, 3, 4, 4)),
        }


class FakeModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.ones(1))

    def generate(self, input_ids, **kwargs):
        suffix = torch.tensor([[10, 11]] * input_ids.shape[0], device=input_ids.device)
        return torch.cat([input_ids, suffix], dim=1)


class LightOnPipelineTests(unittest.TestCase):
    def test_assistant_mask_only_keeps_answer(self):
        input_ids = torch.tensor([[0, 5, 6, 7, 8, 0]])
        attention = torch.tensor([[0, 1, 1, 1, 1, 0]])
        labels = train_lighton_ocr.mask_assistant_labels(
            input_ids, attention, marker=[5, 6], pad_token_id=0
        )
        self.assertEqual(labels.tolist(), [[-100, -100, -100, 7, 8, -100]])

    def test_batch_generation_decodes_each_crop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_dir = root / "test" / "images"
            image_dir.mkdir(parents=True)
            for name in ("a.png", "b.png"):
                Image.new("RGB", (20, 10), "white").save(image_dir / name)
            entries = [
                {
                    "id": name,
                    "split": "test",
                    "messages": [
                        {"role": "user", "content": [{"type": "image", "image": f"images/{name}.png"}]}
                    ],
                }
                for name in ("a", "b")
            ]
            with patch.object(train_lighton_ocr, "BASE_PATH", root):
                predictions, meta, _ = train_lighton_ocr.generate_predictions(
                    FakeModel(), FakeProcessor(), entries
                )
            self.assertEqual(predictions, ["decoded", "decoded"])
            self.assertEqual(meta[0]["image_width"], 20)

    def test_duplicate_index_detects_exact_and_near(self):
        image = Image.new("RGB", (32, 16), "white")
        exact, perceptual = export_dataset.image_hashes(image)
        index = export_dataset.DuplicateIndex(max_distance=4)
        payload = {"split": "test", "text": "A"}
        index.add(exact, perceptual, payload)
        found, kind = index.find(exact, perceptual)
        self.assertEqual(found, payload)
        self.assertEqual(kind, "exact")
        found, kind = index.find("different", perceptual ^ 1)
        self.assertEqual(found, payload)
        self.assertEqual(kind, "near")

    def test_frozen_manifest_keeps_test_and_assigns_new_pages_outside_test(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            manifest = output / "split_manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "splits": {
                            "train": ["train-page"],
                            "val": ["val-page"],
                            "test": ["test-page"],
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(export_dataset, "OUTPUT_DIR", output), patch.object(
                export_dataset, "SPLIT_MANIFEST", manifest
            ):
                first = export_dataset.split_pages(
                    ["train-page", "val-page", "test-page", "new-page"]
                )
                second = export_dataset.split_pages(
                    ["train-page", "val-page", "test-page", "new-page"]
                )
            self.assertEqual(first, second)
            self.assertEqual(first["test"], ["test-page"])
            self.assertNotIn("new-page", first["test"])

    def test_page_bootstrap_recognizes_clear_improvement(self):
        current = []
        baseline = []
        for index in range(20):
            current.append(
                {
                    "id": str(index),
                    "page_id": str(index // 2),
                    "reference": "BONJOUR",
                    "strict_prediction": "BONJOUR",
                }
            )
            baseline.append(
                {
                    "id": str(index),
                    "page_id": str(index // 2),
                    "reference": "BONJOUR",
                    "prediction": "BONJXUR",
                }
            )
        result = train_lighton_ocr.paired_page_bootstrap(
            current, baseline, iterations=200
        )
        self.assertTrue(result["statistically_better"])
        self.assertLess(result["cer_delta_current_minus_baseline_ci95"][1], 0)

    def test_candidate_promotion_preserves_previous_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            final = root / "final"
            candidate = root / "candidate"
            previous = root / "previous"
            final.mkdir()
            candidate.mkdir()
            (final / "version.txt").write_text("old", encoding="utf-8")
            (candidate / "version.txt").write_text("new", encoding="utf-8")
            with patch.object(train_lighton_ocr, "FINAL_DIR", final), patch.object(
                train_lighton_ocr, "CANDIDATE_DIR", candidate
            ), patch.object(train_lighton_ocr, "PREVIOUS_DIR", previous):
                train_lighton_ocr.promote_candidate()
            self.assertEqual((final / "version.txt").read_text(encoding="utf-8"), "new")
            self.assertEqual(
                (previous / "version.txt").read_text(encoding="utf-8"), "old"
            )

    def test_quality_gate_requires_speed_evidence(self):
        metrics = {
            "strict": {
                "cer": 0.001,
                "exact_match": 0.99,
            }
        }
        comparison = {
            "available": True,
            "bootstrap": {
                "shared_sample_count": 1128,
                "statistically_better": True,
            },
        }
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            "os.environ",
            {
                "LIGHTON_BASELINE_TRAIN_SECONDS": "0",
                "LIGHTON_ALLOW_MISSING_SPEED_BASELINE": "0",
            },
            clear=False,
        ), patch.object(train_lighton_ocr, "OUTPUT_DIR", Path(tmp)):
            gate = train_lighton_ocr.quality_gate(
                metrics, comparison, training_seconds=100
            )
        self.assertTrue(gate["quality_pass"])
        self.assertFalse(gate["speed_pass"])
        self.assertFalse(gate["release_ready"])


if __name__ == "__main__":
    unittest.main()
