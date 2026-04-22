import json
from pathlib import Path
from PIL import Image
from sklearn.model_selection import train_test_split
from tqdm import tqdm
import shutil

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset"
IMAGES_DIR = DATASET_DIR / "images"
ANNOTATIONS_FILE = DATASET_DIR / "annotations.json"
OUTPUT_DIR = SCRIPT_DIR / "dataset_yolo"

TEST_SIZE = 0.1
RANDOM_SEED = 42

# YOLO-pose keypoint order: TL, TR, BR, BL (matches label_panels.py)
NUM_KEYPOINTS = 4


def load_annotations():
    with open(ANNOTATIONS_FILE) as f:
        data = json.load(f)
    return data.get("annotations", {})


def main():
    annotations = load_annotations()

    # Filter to images that have at least one panel annotated
    samples = []
    for img_name, info in annotations.items():
        panels = info.get("panels", [])
        if not panels:
            continue
        img_path = IMAGES_DIR / img_name
        if not img_path.exists():
            print(f"Warning: image not found: {img_path}")
            continue
        samples.append((img_name, panels))

    if not samples:
        print("No annotated samples found.")
        return

    print(f"Total annotated images: {len(samples)}")

    train_data, val_data = train_test_split(
        samples, test_size=TEST_SIZE, random_state=RANDOM_SEED
    )

    for split_name, split_samples in [("train", train_data), ("val", val_data)]:
        img_dir = OUTPUT_DIR / split_name / "images"
        lbl_dir = OUTPUT_DIR / split_name / "labels"
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        print(f"\nProcessing '{split_name}' ({len(split_samples)} images)...")
        for img_name, panels in tqdm(split_samples, desc=split_name):
            src_path = IMAGES_DIR / img_name
            img = Image.open(src_path)
            w, h = img.size

            # Copy image
            dst_img = img_dir / img_name
            shutil.copy2(src_path, dst_img)

            # Write YOLO-pose label
            label_name = Path(img_name).stem + ".txt"
            with open(lbl_dir / label_name, "w") as f:
                for panel in panels:
                    kps = panel.get("keypoints", [])
                    if len(kps) != 4:
                        continue

                    # Compute bbox from keypoints (normalized)
                    xs = [k["x"] for k in kps]
                    ys = [k["y"] for k in kps]
                    x_center = (min(xs) + max(xs)) / 2.0 / w
                    y_center = (min(ys) + max(ys)) / 2.0 / h
                    bw = (max(xs) - min(xs)) / w
                    bh = (max(ys) - min(ys)) / h

                    # Keypoints: x y visibility (2=visible) for each, normalized
                    kp_parts = []
                    for kp in kps:
                        kp_parts.append(f"{kp['x'] / w:.6f}")
                        kp_parts.append(f"{kp['y'] / h:.6f}")
                        kp_parts.append("2")  # visible

                    line = f"0 {x_center:.6f} {y_center:.6f} {bw:.6f} {bh:.6f} {' '.join(kp_parts)}"
                    f.write(line + "\n")

    # Write data.yaml
    yaml_content = f"""path: {OUTPUT_DIR.absolute().as_posix()}
train: train/images
val: val/images

kpt_shape: [{NUM_KEYPOINTS}, 3]

names:
  0: panel
"""
    with open(OUTPUT_DIR / "data.yaml", "w") as f:
        f.write(yaml_content)

    print(f"\nDataset exported. YAML at: {OUTPUT_DIR / 'data.yaml'}")


if __name__ == "__main__":
    main()
