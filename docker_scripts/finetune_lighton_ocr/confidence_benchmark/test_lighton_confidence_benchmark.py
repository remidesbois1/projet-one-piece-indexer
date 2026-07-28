import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

import lighton_confidence_benchmark as benchmark


class ConfidenceBenchmarkTests(unittest.TestCase):
    def test_edit_map_marks_substitution_but_keeps_omission_separate(self):
        substitution = benchmark.edit_map("trxsor", "trésor")
        self.assertTrue(substitution.bad_source_positions)
        omission = benchmark.edit_map("trésor", "trésors")
        self.assertFalse(omission.bad_source_positions)
        self.assertEqual(len(omission.insertions), 1)

    def test_token_alignment_labels_overlapping_substitution(self):
        sample = {
            "id": 1,
            "page_id": 1,
            "prediction": "trxsor",
            "reference": "trésor",
            "exact_match": False,
            "tokens": [
                {
                    "position": 0,
                    "token_id": 10,
                    "text": "trx",
                    "char_start": 0,
                    "char_end": 3,
                    "probability": 0.4,
                    "log_probability": -0.9,
                    "top1_top2_margin": 0.1,
                },
                {
                    "position": 1,
                    "token_id": 11,
                    "text": "sor",
                    "char_start": 3,
                    "char_end": 6,
                    "probability": 0.99,
                    "log_probability": -0.01,
                    "top1_top2_margin": 0.95,
                },
            ],
        }
        rows = benchmark.token_rows_for_sample(sample)
        self.assertTrue(rows[0]["token_error"])
        self.assertFalse(rows[1]["token_error"])

    def test_review_budget_captures_ranked_errors(self):
        labels = np.array([1, 0, 1, 0, 0])
        uncertainty = np.array([0.9, 0.1, 0.8, 0.2, 0.0])
        result = benchmark.review_budgets(labels, uncertainty, (0.4,))
        self.assertEqual(result["0.40"]["errors_captured"], 2)
        self.assertEqual(result["0.40"]["error_recall"], 1.0)

    def test_calibration_perfect_predictions_has_zero_brier(self):
        result = benchmark.calibration(
            np.array([0, 1, 1]), np.array([0.0, 1.0, 1.0]), bins=2
        )
        self.assertEqual(result["brier_score"], 0.0)
        self.assertEqual(result["expected_calibration_error"], 0.0)

    def test_page_bootstrap_returns_intervals(self):
        frame = pd.DataFrame(
            {
                "page_id": [1, 1, 2, 2, 3, 3],
                "sample_error": [1, 0, 1, 0, 1, 0],
            }
        )
        uncertainty = np.array([0.9, 0.1, 0.8, 0.2, 0.7, 0.3])
        result = benchmark.bootstrap_by_page(
            frame, "sample_error", uncertainty, iterations=50, seed=42
        )
        self.assertIsNotNone(result["roc_auc_ci95"])
        self.assertEqual(result["roc_auc_ci95"], [1.0, 1.0])


if __name__ == "__main__":
    unittest.main()
