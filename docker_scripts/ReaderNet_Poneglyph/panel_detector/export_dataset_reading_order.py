import json
from pathlib import Path
from PIL import Image
from sklearn.model_selection import train_test_split
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset"
IMAGES_DIR = DATASET_DIR / "images"
ANNOTATIONS_FILE = DATASET_DIR / "annotations.json"
OUTPUT_DIR = SCRIPT_DIR / "dataset_reading_order"

TEST_SIZE = 0.1
RANDOM_SEED = 42


def get_bbox_from_keypoints(kps):
    xs = [k["x"] for k in kps]
    ys = [k["y"] for k in kps]
    return [min(xs), min(ys), max(xs), max(ys)]


def compute_pos_features(bbox_a, bbox_b, w, h):
    def norm(bbox):
        return [bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h]

    a = norm(bbox_a)
    b = norm(bbox_b)

    cxa, cya = (a[0] + a[2]) / 2.0, (a[1] + a[3]) / 2.0
    cxb, cyb = (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0
    wa, ha = a[2] - a[0], a[3] - a[1]
    wb, hb = b[2] - b[0], b[3] - b[1]

    return [
        cxa,
        cya,
        wa,
        ha,
        cxb,
        cyb,
        wb,
        hb,
        cxa - cxb,
        cya - cyb,
        wa - wb,
        ha - hb,
    ]


def main():
    with open(ANNOTATIONS_FILE) as f:
        data = json.load(f)
    annotations = data.get("annotations", {})

    pages = []
    for img_name, info in tqdm(annotations.items(), desc="Processing annotations"):
        panels = info.get("panels", [])
        if len(panels) < 2:
            continue

        img_path = IMAGES_DIR / img_name
        if not img_path.exists():
            continue

        with Image.open(img_path) as img_raw:
            img = img_raw.convert("RGB")
            w, h = img.size

        page_panels = []
        for panel in panels:
            kps = panel.get("keypoints", [])
            if len(kps) != 4:
                continue
            page_panels.append(get_bbox_from_keypoints(kps))

        if len(page_panels) < 2:
            continue

        pairs = []
        n = len(page_panels)
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                label = 1 if i < j else 0
                pos = compute_pos_features(page_panels[i], page_panels[j], w, h)
                pairs.append(
                    {
                        "panel_a_idx": i,
                        "panel_b_idx": j,
                        "bbox_a": page_panels[i],
                        "bbox_b": page_panels[j],
                        "label": label,
                        "pos": pos,
                    }
                )

        pages.append(
            {
                "image": str(img_path),
                "w": w,
                "h": h,
                "panels": page_panels,
                "pairs": pairs,
            }
        )

    if not pages:
        print("No valid pages with >=2 panels found.")
        return

    print(f"\nTotal pages with pairs: {len(pages)}")
    train_pages, val_pages = train_test_split(
        pages, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for split_name, split_pages in [("train", train_pages), ("val", val_pages)]:
        out_path = OUTPUT_DIR / f"{split_name}.json"
        with open(out_path, "w") as f:
            json.dump(split_pages, f, indent=2)

        num_pairs = sum(len(p["pairs"]) for p in split_pages)
        print(
            f"{split_name}: {len(split_pages)} pages, {num_pairs} pairs -> {out_path}"
        )

    print("Reading order dataset export complete.")


if __name__ == "__main__":
    main()
