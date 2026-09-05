"""CPU contract tests; `run_pipeline.py --smoke` separately validates real CUDA."""

import json
import math
import random
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import torch
from config import Config, same_training_identity
from data import (
    assign_splits,
    image_hash,
    load_dataset,
    normalize,
    parse_r2_reference,
    write_json,
)
from model import hybrid_mask, sink_attention
from PIL import Image
from report import (
    aggregate,
    create_artifacts,
    model_card,
    page_bootstrap,
    score_sample,
    write_benchmark,
)
from train import prepared_training_batches


class ResumeTests(unittest.TestCase):
    def test_eval_batch_can_change_but_training_and_data_cannot(self):
        original = {"config": {"eval_batch": 2, "lr": 1e-5}, "fingerprint": "abc"}
        faster = {"config": {"eval_batch": 16, "lr": 1e-5}, "fingerprint": "abc"}
        self.assertTrue(same_training_identity(original, faster))
        self.assertTrue(
            same_training_identity(
                original,
                {
                    **faster,
                    "config": {
                        **faster["config"],
                        "checkpoint_token_budget": 8192,
                        "prefetch_batches": True,
                    },
                },
            )
        )
        self.assertEqual(original["config"]["eval_batch"], 2)
        self.assertFalse(
            same_training_identity(original, {**faster, "fingerprint": "xyz"})
        )
        self.assertFalse(
            same_training_identity(
                original, {**faster, "config": {"eval_batch": 16, "lr": 2e-5}}
            )
        )


class PrefetchTests(unittest.TestCase):
    def test_order_augmentation_and_partial_microbatch_match_serial(self):
        class Engine:
            config = Config(effective_batch=4)

            def collate(self, rows, rng, cpu_only):
                self_test.assertTrue(cpu_only)
                return [(r, rng.random()) for r in rows]

        self_test = self
        engine = Engine()
        outcomes = []
        for enabled in (False, True):
            engine.config = replace(engine.config, prefetch_batches=enabled)
            rng = random.Random(42)
            with prepared_training_batches(engine, list(range(11)), rng, 2) as batches:
                outcomes.append((list(batches), rng.getstate()))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(
            [r for group, _ in outcomes[1][0] for r in group], list(range(11))
        )
        self.assertEqual(outcomes[1][0][-1][1][-1][0], 1)

    def test_producer_errors_reach_training(self):
        class Engine:
            config = Config(effective_batch=4)

            def collate(self, rows, rng, cpu_only):
                if 5 in rows:
                    raise ValueError("invalid crop")
                return rows

        with (
            self.assertRaisesRegex(ValueError, "invalid crop"),
            prepared_training_batches(
                Engine(), list(range(8)), random.Random(42), 2
            ) as batches,
        ):
            list(batches)


class AttentionTests(unittest.TestCase):
    def test_sink_forward_and_all_gradients_match_dense_reference(self):
        torch.manual_seed(3)
        q, k, v = [
            torch.randn(2, 3, 5, 8, dtype=torch.double, requires_grad=True)
            for _ in range(3)
        ]
        sinks = torch.randn(3, dtype=torch.double, requires_grad=True)
        allowed = torch.ones(2, 1, 5, 5, dtype=torch.bool).tril()
        allowed[0, :, :, 0] = False
        got = sink_attention(q, k, v, sinks, allowed)
        scores = (q @ k.transpose(-1, -2) / math.sqrt(8)).masked_fill(
            ~allowed, float("-inf")
        )
        sink_scores = sinks[None, :, None, None].expand(2, -1, 5, 1)
        expected = (
            torch.softmax(torch.cat([scores, sink_scores], dim=-1), dim=-1)[..., :-1]
            @ v
        )
        torch.testing.assert_close(got, expected, atol=1e-10, rtol=1e-10)
        gradient = torch.randn_like(got)
        actual_grads = torch.autograd.grad(
            got, (q, k, v, sinks), gradient, retain_graph=True
        )
        reference_grads = torch.autograd.grad(expected, (q, k, v, sinks), gradient)
        for actual, reference in zip(actual_grads, reference_grads):
            torch.testing.assert_close(actual, reference, atol=1e-10, rtol=1e-10)

    def test_padding_and_image_bidirectionality(self):
        c = SimpleNamespace(image_cls_token_id=2, img_end_id=4)
        tokens = torch.tensor([[0, 2, 3, 3, 4, 5, 6]])
        mask = hybrid_mask(tokens, c, 0)[0, 0]
        self.assertFalse(mask[:, 0].any())
        self.assertTrue(mask[1, 3])
        self.assertFalse(mask[1, 4])
        self.assertFalse(mask[5, 6])
        self.assertTrue(mask[6, 5])
        q = torch.randn(1, 2, 7, 8, requires_grad=True)
        result = sink_attention(q, q, q, torch.zeros(2), mask[None, None])
        self.assertTrue(torch.isfinite(result).all())
        result.sum().backward()
        self.assertTrue(torch.isfinite(q.grad).all())


class DataTests(unittest.TestCase):
    def test_private_r2_reference(self):
        self.assertEqual(
            parse_r2_reference("r2://pages/tome-1/page%203.avif", "pages"),
            ("pages", "tome-1/page 3.avif"),
        )
        for ref in (
            "r2://other/page.avif",
            "r2://user@pages/page.avif",
            "r2://pages/../page.avif",
            "r2://pages/foo%2Fbar.avif",
            "r2://pages/page%2eavif",
            "r2://pages/page.avif?x=1",
        ):
            with self.assertRaises(ValueError, msg=ref):
                parse_r2_reference(ref, "pages")

    def rows(self):
        return [
            {
                "id": str(i),
                "page_id": str(i),
                "image_sha256": f"crop{i}",
                "page_sha256": f"page{i}",
            }
            for i in range(200)
        ]

    def test_split_order_independent_and_duplicate_connected_pages_together(self):
        rows = self.rows()
        rows[1]["image_sha256"] = rows[0]["image_sha256"]
        rows[2]["page_sha256"] = rows[1]["page_sha256"]
        split = assign_splits(rows)
        self.assertEqual(split, assign_splits(list(reversed(rows))))
        self.assertEqual(split["0"], split["1"])
        self.assertEqual(split["1"], split["2"])
        self.assertEqual(set(split.values()), {"train", "val", "test"})

    def test_whitespace_accents_and_single_character(self):
        self.assertEqual(normalize(" e\u0301\n ! "), "é !")
        self.assertEqual(normalize("A"), "A")

    def test_dataset_image_tampering_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for i, split in enumerate(("train", "val", "test")):
                image = Image.new("RGB", (16, 16), (i * 50, 0, 0))
                image.save(directory / f"{split}.png")
                row = {
                    "id": split,
                    "page_id": split,
                    "text": "A",
                    "image_file": f"{split}.png",
                    "image_sha256": image_hash(image),
                    "page_sha256": "page" + split,
                }
                (directory / split).mkdir()
                (directory / split / "metadata.jsonl").write_text(
                    json.dumps(row) + "\n", encoding="utf-8"
                )
            write_json(
                directory / "manifest.json",
                {"fetched": 3, "exported": 3, "excluded": []},
            )
            splits, fingerprint, _ = load_dataset(directory)
            self.assertEqual(sum(map(len, splits.values())), 3)
            self.assertEqual(len(fingerprint), 64)
            Image.new("RGB", (16, 16), "white").save(directory / "train.png")
            with self.assertRaisesRegex(ValueError, "Image changed"):
                load_dataset(directory)

    def test_every_bubble_visited_once(self):
        from train import ordered_rows

        rows = [
            {"id": i, "text": "A", "width": i + 1, "height": 20} for i in range(521)
        ]
        result = ordered_rows(rows, 42)
        self.assertEqual(sorted(r["id"] for r in result), list(range(521)))


class ReportTests(unittest.TestCase):
    def samples(self):
        return [
            score_sample(
                {
                    "id": str(i),
                    "page_id": str(i // 2),
                    "text": ref,
                    "width": 100,
                    "height": 60,
                },
                {"prediction": pred, "token_limit": False, "generated_tokens": 4},
            )
            for i, (ref, pred) in enumerate(
                [("A", "B"), ("Bonjour !", "Bonjour !"), ("Été", "été")]
            )
        ]

    def test_corpus_cer_is_not_average_sample_cer(self):
        metrics = aggregate(self.samples())
        self.assertAlmostEqual(metrics["cer"], 2 / 13)
        self.assertAlmostEqual(metrics["exact_match"], 1 / 3)
        self.assertEqual(page_bootstrap(self.samples()), page_bootstrap(self.samples()))

    def test_reports_and_card_separate_full_refit_from_measured_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            samples = self.samples()
            report = write_benchmark(
                directory / "benchmark_test.json", samples, "evaluated", 1
            )
            rows = []
            for sample in samples:
                image_path = directory / (sample["id"] + ".png")
                Image.new("RGB", (100, 60), "white").save(image_path)
                rows.append({**sample, "image_path": str(image_path)})
            history = [
                {"epoch": 1, "loss": 0.5, "val_cer": 0.2},
                {"epoch": 2, "loss": 0.3, "val_cer": 0.1},
            ]
            create_artifacts(directory, history, report, report, rows)
            model_card(Config(), {"exported": 3, "best_epoch": 2}, report, directory)
            card = (directory / "README.md").read_text(encoding="utf-8")
            self.assertIn("no independent held-out score", card)
            self.assertIn("evaluated/", card)
            for path in (directory / "analysis").glob("*.png"):
                with Image.open(path) as image:
                    self.assertGreater(image.width, 100)
                    image.verify()

    def test_upload_refuses_modified_release(self):
        from run_pipeline import publish, release_hashes

        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "release"
            directory.mkdir()
            (directory / "README.md").write_text("complete")
            write_json(
                directory / "release_ready.json",
                {"complete": True, "hashes": release_hashes(directory)},
            )
            (directory / "README.md").write_text("changed")
            with self.assertRaisesRegex(RuntimeError, "modified"):
                publish(replace(Config(), output_dir=tmp))


if __name__ == "__main__":
    unittest.main()
