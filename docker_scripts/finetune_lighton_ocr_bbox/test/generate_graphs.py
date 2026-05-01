import json
import sys
from pathlib import Path
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output"
GRAPHS_DIR = OUTPUT_DIR / "graphs"

ACCENT = "#4ECDC4"
ACCENT_LIGHT = "#D4F5F0"
DARK = "#2C3E50"
RED = "#FF6B6B"
GREEN = "#3FB950"
GRID = "#E0E0E0"

plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": ["Segoe UI", "Arial", "Helvetica"],
        "font.size": 11,
        "axes.titlesize": 14,
        "axes.labelsize": 12,
        "axes.facecolor": "#FAFAFA",
        "figure.facecolor": "white",
        "grid.color": GRID,
        "grid.alpha": 0.5,
        "axes.grid": True,
        "axes.spines.top": False,
        "axes.spines.right": False,
    }
)


def load_metrics():
    path = OUTPUT_DIR / "metrics.json"
    if not path.exists():
        print(f"metrics.json not found at {path}")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def plot_main_metrics_bar(m):
    names = [
        "1 - CER",
        "1 - WER",
        "Mean IoU",
        "F1@0.5",
        "Precision@0.5",
        "Recall@0.5",
        "Detection Rate",
        "Combined Score",
    ]
    keys = [
        "cer",
        "wer",
        "mean_iou",
        "f1@0_5",
        "precision@0_5",
        "recall@0_5",
        "avg_detection_rate",
        "combined_score",
    ]
    vals = [(1 - m[k]) if k in ("cer", "wer") else m[k] for k in keys]
    colors = [
        GREEN if v >= 0.7 else ACCENT if v >= 0.5 else "#FFA500" if v >= 0.3 else RED
        for v in vals
    ]

    fig, ax = plt.subplots(figsize=(12, 6))
    bars = ax.barh(names, vals, color=colors, edgecolor="white", height=0.6, zorder=3)
    for bar, val in zip(bars, vals):
        w = bar.get_width()
        ax.text(
            w + 0.008,
            bar.get_y() + bar.get_height() / 2.0,
            f"{val:.3f}",
            ha="left",
            va="center",
            fontsize=10,
            fontweight="bold",
        )
    ax.set_xlim(0, 1.1)
    ax.set_title("Poneglyph Performance Overview", fontsize=16, fontweight="bold")
    ax.axvline(0.8, color="gray", linestyle=":", alpha=0.4, label="0.8 threshold")
    ax.legend(fontsize=9)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "metrics_overview.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> metrics_overview.png")


def plot_iou_histogram(m):
    ious = m.get("iou_distribution", [])
    if not ious:
        return
    fig, ax = plt.subplots(figsize=(10, 5))
    n, bins, patches = ax.hist(
        ious,
        bins=40,
        range=(0, 1),
        color=ACCENT,
        edgecolor="white",
        alpha=0.85,
        zorder=3,
    )
    for patch, left_edge in zip(patches, bins[:-1]):
        if left_edge >= 0.7:
            patch.set_facecolor(GREEN)
        elif left_edge >= 0.5:
            patch.set_facecolor(ACCENT)
        elif left_edge < 0.3:
            patch.set_facecolor(RED)

    ax.axvline(
        np.mean(ious),
        color="black",
        linestyle="--",
        linewidth=1.5,
        label=f"Mean: {np.mean(ious):.3f}",
        zorder=4,
    )
    ax.axvline(
        np.median(ious),
        color="gray",
        linestyle=":",
        linewidth=1.5,
        label=f"Median: {np.median(ious):.3f}",
        zorder=4,
    )
    ax.set_title("IoU Distribution (Matched Bubbles)", fontsize=14, fontweight="bold")
    ax.set_xlabel("IoU Score")
    ax.set_ylabel("Count")
    ax.legend(fontsize=10)
    ax.set_xlim(0, 1)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "iou_distribution.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> iou_distribution.png")


def plot_iou_boxplot(m):
    ious = m.get("iou_distribution", [])
    if not ious:
        return
    fig, ax = plt.subplots(figsize=(8, 5))
    bp = ax.boxplot(
        [ious],
        tick_labels=["IoU"],
        patch_artist=True,
        widths=0.4,
        showfliers=True,
        flierprops=dict(marker="o", markersize=3, alpha=0.4),
    )
    bp["boxes"][0].set_facecolor(ACCENT)
    bp["boxes"][0].set_alpha(0.7)
    bp["medians"][0].set_color("black")
    bp["medians"][0].set_linewidth(2)

    stats_text = (
        f"Mean: {np.mean(ious):.3f}  Median: {np.median(ious):.3f}\n"
        f"P25: {np.percentile(ious, 25):.3f}  P75: {np.percentile(ious, 75):.3f}\n"
        f"P90: {np.percentile(ious, 90):.3f}  P95: {np.percentile(ious, 95):.3f}"
    )
    ax.text(
        0.75,
        0.95,
        stats_text,
        transform=ax.transAxes,
        fontsize=9,
        verticalalignment="top",
        fontfamily="monospace",
        bbox=dict(boxstyle="round", facecolor="white", alpha=0.8),
    )
    ax.set_title("IoU Score Distribution", fontsize=14, fontweight="bold")
    ax.set_ylim(0, 1)
    ax.set_ylabel("IoU Score")
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "iou_boxplot.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> iou_boxplot.png")


def plot_f1_at_thresholds(m):
    thresholds = [0.3, 0.5, 0.75, 0.9]
    f1_vals = [m.get(f"f1@{str(t).replace('.', '_')}", 0) for t in thresholds]
    prec_vals = [m.get(f"precision@{str(t).replace('.', '_')}", 0) for t in thresholds]
    rec_vals = [m.get(f"recall@{str(t).replace('.', '_')}", 0) for t in thresholds]

    x = np.arange(len(thresholds))
    width = 0.25

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.bar(
        x - width,
        prec_vals,
        width,
        label="Precision",
        color=ACCENT,
        edgecolor="white",
        zorder=3,
    )
    ax.bar(x, rec_vals, width, label="Recall", color=GREEN, edgecolor="white", zorder=3)
    ax.bar(
        x + width, f1_vals, width, label="F1", color=DARK, edgecolor="white", zorder=3
    )

    for vals, offset in [(prec_vals, -width), (rec_vals, 0), (f1_vals, width)]:
        for xi, v in zip(x, vals):
            ax.text(
                xi + offset,
                v + 0.005,
                f"{v:.3f}",
                ha="center",
                va="bottom",
                fontsize=8,
                fontweight="bold",
            )

    ax.set_xlabel("IoU Threshold")
    ax.set_ylabel("Score")
    ax.set_title(
        "Precision / Recall / F1 at IoU Thresholds", fontsize=14, fontweight="bold"
    )
    ax.set_xticks(x)
    ax.set_xticklabels([f"IoU >= {t}" for t in thresholds])
    ax.legend(fontsize=10)
    ax.set_ylim(0, max(max(f1_vals), max(prec_vals), max(rec_vals)) * 1.12)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "f1_at_thresholds.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> f1_at_thresholds.png")


def plot_cer_histogram(m):
    cer_vals = m.get("cer_distribution", [])
    if not cer_vals:
        return
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.hist(
        cer_vals,
        bins=30,
        range=(0, max(cer_vals) * 1.1 if max(cer_vals) > 0 else 1),
        color=ACCENT,
        edgecolor="white",
        alpha=0.85,
        zorder=3,
    )
    ax.axvline(
        np.mean(cer_vals),
        color="black",
        linestyle="--",
        linewidth=1.5,
        label=f"Mean: {np.mean(cer_vals):.4f}",
        zorder=4,
    )
    ax.axvline(
        np.median(cer_vals),
        color="gray",
        linestyle=":",
        linewidth=1.5,
        label=f"Median: {np.median(cer_vals):.4f}",
        zorder=4,
    )
    ax.set_title("CER Distribution (per sample)", fontsize=14, fontweight="bold")
    ax.set_xlabel("Character Error Rate")
    ax.set_ylabel("Number of Samples")
    ax.legend(fontsize=10)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "cer_distribution.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> cer_distribution.png")


def plot_bubble_count_scatter(m):
    per_sample = m.get("per_sample", [])
    if not per_sample:
        return
    gt_counts = [s["num_gt"] for s in per_sample]
    pred_counts = [s["num_pred"] for s in per_sample]

    fig, ax = plt.subplots(figsize=(8, 8))
    ax.scatter(
        gt_counts,
        pred_counts,
        color=ACCENT,
        alpha=0.6,
        s=40,
        zorder=3,
        edgecolors="white",
        linewidth=0.5,
    )
    max_val = max(max(gt_counts), max(pred_counts), 1)
    ax.plot(
        [0, max_val],
        [0, max_val],
        "k--",
        alpha=0.3,
        label="Perfect prediction",
        zorder=2,
    )
    ax.set_xlabel("Ground Truth Bubble Count")
    ax.set_ylabel("Predicted Bubble Count")
    ax.set_title(
        "Bubble Count: Predicted vs Ground Truth", fontsize=14, fontweight="bold"
    )
    ax.legend(fontsize=10)
    ax.set_aspect("equal", adjustable="box")
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "bubble_count_scatter.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> bubble_count_scatter.png")


def plot_per_sample_iou_sorted(m):
    per_sample = m.get("per_sample", [])
    if not per_sample:
        return
    ious = sorted([s.get("mean_iou", 0) for s in per_sample], reverse=True)
    colors = [
        GREEN if v >= 0.7 else ACCENT if v >= 0.5 else "#FFA500" if v >= 0.3 else RED
        for v in ious
    ]

    fig, ax = plt.subplots(figsize=(12, 5))
    ax.bar(range(len(ious)), ious, color=colors, width=1.0, edgecolor="none", zorder=3)
    ax.axhline(
        np.mean(ious),
        color="black",
        linestyle="--",
        linewidth=1,
        label=f"Mean: {np.mean(ious):.3f}",
        zorder=4,
    )
    ax.set_xlabel("Sample (sorted by IoU)")
    ax.set_ylabel("Mean IoU")
    ax.set_title(
        "Per-Sample IoU (sorted best to worst)", fontsize=14, fontweight="bold"
    )
    ax.legend(fontsize=10)
    ax.set_xlim(0, len(ious))
    ax.set_ylim(0, 1)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "per_sample_iou_sorted.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> per_sample_iou_sorted.png")


def plot_iou_cumulative(m):
    ious = sorted(m.get("iou_distribution", []))
    if not ious:
        return
    cumulative = np.arange(1, len(ious) + 1) / len(ious)

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.plot(ious, cumulative, color=ACCENT, linewidth=2.5, zorder=3)
    ax.fill_between(ious, cumulative, alpha=0.15, color=ACCENT)

    for threshold, label in [(0.5, "IoU=0.5"), (0.75, "IoU=0.75"), (0.9, "IoU=0.9")]:
        pct = sum(1 for iou in ious if iou >= threshold) / len(ious) * 100
        ax.axvline(threshold, color="gray", linestyle=":", alpha=0.5)
        ax.text(
            threshold + 0.01, 0.5, f"{label}\n{pct:.1f}% above", fontsize=8, alpha=0.8
        )

    ax.set_xlabel("IoU Score")
    ax.set_ylabel("Cumulative Proportion")
    ax.set_title("Cumulative IoU Distribution", fontsize=14, fontweight="bold")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "iou_cumulative.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> iou_cumulative.png")


def plot_bbox_area_error(m):
    area_errors = m.get("bbox_area_error_distribution", [])
    if not area_errors:
        return
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.hist(
        area_errors,
        bins=30,
        range=(0, min(max(area_errors), 2.0)),
        color=ACCENT,
        edgecolor="white",
        alpha=0.85,
        zorder=3,
    )
    ax.axvline(
        np.mean(area_errors),
        color="black",
        linestyle="--",
        linewidth=1.5,
        label=f"Mean: {np.mean(area_errors):.3f}",
        zorder=4,
    )
    ax.axvline(
        np.median(area_errors),
        color="gray",
        linestyle=":",
        linewidth=1.5,
        label=f"Median: {np.median(area_errors):.3f}",
        zorder=4,
    )
    ax.set_title(
        "Relative BBox Area Error (pred vs GT)", fontsize=14, fontweight="bold"
    )
    ax.set_xlabel("|Pred Area - GT Area| / GT Area")
    ax.set_ylabel("Count")
    ax.legend(fontsize=10)
    fig.tight_layout()
    fig.savefig(GRAPHS_DIR / "bbox_area_error.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("  -> bbox_area_error.png")


def plot_summary_card(m):
    fig = plt.figure(figsize=(14, 10))
    fig.patch.set_facecolor("#0D1117")

    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 10)
    ax.axis("off")
    ax.set_facecolor("#0D1117")

    ax.text(
        7,
        9.5,
        "LightOnOCR Poneglyph BBox",
        fontsize=22,
        fontweight="bold",
        ha="center",
        va="center",
        color="white",
    )
    ax.text(
        7,
        9.0,
        "Manga Bubble OCR + Bounding Box Detection Benchmark",
        fontsize=11,
        ha="center",
        va="center",
        color="#8B949E",
    )

    metrics_list = [
        ("Character Error Rate (CER)", f"{m['cer']:.4f}", m["cer"] < 0.05),
        ("Word Error Rate (WER)", f"{m['wer']:.4f}", m["wer"] < 0.05),
        ("Mean IoU", f"{m['mean_iou']:.4f}", m["mean_iou"] >= 0.7),
        ("Median IoU", f"{m['median_iou']:.4f}", m["median_iou"] >= 0.7),
        ("F1 @ IoU=0.3", f"{m['f1@0_3']:.4f}", m["f1@0_3"] >= 0.8),
        ("F1 @ IoU=0.5", f"{m['f1@0_5']:.4f}", m["f1@0_5"] >= 0.6),
        ("F1 @ IoU=0.75", f"{m['f1@0_75']:.4f}", m["f1@0_75"] >= 0.3),
        ("Precision @ IoU=0.5", f"{m['precision@0_5']:.4f}", m["precision@0_5"] >= 0.6),
        ("Recall @ IoU=0.5", f"{m['recall@0_5']:.4f}", m["recall@0_5"] >= 0.6),
        (
            "Detection Rate",
            f"{m['avg_detection_rate']:.4f}",
            m["avg_detection_rate"] >= 0.95,
        ),
        ("Mean GIoU", f"{m['mean_giou']:.4f}", m["mean_giou"] >= 0.6),
        ("Combined Score", f"{m['combined_score']:.4f}", m["combined_score"] >= 0.8),
    ]

    y_start = 8.2
    for i, (name, val, good) in enumerate(metrics_list):
        y = y_start - i * 0.58
        ax.text(1, y, name, fontsize=11, ha="left", va="center", color="#C9D1D9")
        color = GREEN if good else "#FFA500"
        ax.text(
            11,
            y,
            val,
            fontsize=12,
            ha="center",
            va="center",
            color=color,
            fontfamily="monospace",
            fontweight="bold",
        )
        status = "OK" if good else "!!"
        ax.text(
            13,
            y,
            status,
            fontsize=10,
            ha="center",
            va="center",
            color=color,
            fontweight="bold",
        )

    ax.text(
        11,
        y_start + 0.4,
        "Value",
        fontsize=11,
        ha="center",
        va="center",
        color="white",
        fontweight="bold",
    )

    for i in range(len(metrics_list) + 1):
        y = y_start + 0.3 - i * 0.58
        ax.axhline(y=y, xmin=0.05, xmax=0.95, color="#21262D", linewidth=0.5)

    ax.text(
        7,
        0.5,
        f"Test: {m['num_samples']} pages | {m['total_gt_bubbles']} GT bubbles | "
        f"{m['total_pred_bubbles']} predicted | Avg: {m['avg_inference_time']:.2f}s/page",
        fontsize=9,
        ha="center",
        va="center",
        color="#8B949E",
    )

    fig.savefig(
        GRAPHS_DIR / "summary_card.png",
        dpi=200,
        bbox_inches="tight",
        facecolor=fig.get_facecolor(),
    )
    plt.close(fig)
    print("  -> summary_card.png")


def main():
    print("\nGenerating graphs...")
    m = load_metrics()

    plot_main_metrics_bar(m)
    plot_iou_histogram(m)
    plot_iou_boxplot(m)
    plot_f1_at_thresholds(m)
    plot_cer_histogram(m)
    plot_bubble_count_scatter(m)
    plot_per_sample_iou_sorted(m)
    plot_iou_cumulative(m)
    plot_bbox_area_error(m)
    plot_summary_card(m)

    print(f"\nAll graphs saved to {GRAPHS_DIR}/")


if __name__ == "__main__":
    main()
