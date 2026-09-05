"""Private, local browser fixtures and native Falcon references; never uploaded."""

import json
import shutil
from pathlib import Path

import numpy as np
from config import Config
from model import FalconEngine, autocast

root = Path("/app/dataset")
out = Path("/browser/fixtures")
out.mkdir(exist_ok=True)
rows = [
    dict(json.loads(line), image_path=str(root / json.loads(line)["image_file"]))
    for line in (root / "val/metadata.jsonl").read_text().splitlines()
]
selected = [r for r in rows if 8 <= len(r["text"]) <= 100][:5]
engine = FalconEngine(Config(), source="/app/outputs/release")
engine.model.eval()
fixtures = []
for index, row in enumerate(selected):
    with autocast():
        prediction = engine.generate([row])[0]
    shutil.copy2(row["image_path"], out / f"bubble-{index}.png")
    fixtures.append(
        {
            "id": row["id"],
            "image": f"fixtures/bubble-{index}.png",
            "reference": row["text"],
            "native": prediction["prediction"],
        }
    )
    if index == 0:
        batch = engine.collate([row], supervised=False)
        tokens = batch["tokens"].cpu().numpy()
        pixels = batch["pixel_values"][0, 0].cpu().numpy()
        mask = batch["pixel_mask"][0, 0].cpu().numpy()
        height, width = pixels.shape[:2]
        patches = (
            pixels.reshape(height // 16, 16, width // 16, 16, 3)
            .transpose(0, 2, 1, 3, 4)
            .reshape(-1, 768)
        )
        valid = mask.reshape(height // 16, 16, width // 16, 16).any((1, 3)).ravel()
        slot_pixels = np.zeros((1, tokens.shape[1], 768), np.float16)
        slot_pixels[0, tokens[0] == 227] = patches[valid].astype(np.float16)
        time_pos = batch["pos_t"].cpu().numpy()
        hw = batch["pos_hw"].cpu().numpy()
        freq = engine.model.freqs_cis_golden.cpu().numpy()
        angles = np.zeros((1, tokens.shape[1], 16, 32), np.float32)
        angles[:, :, :, :16] = (
            time_pos[:, :, None, None]
            * (1 / (10000 ** (np.arange(16, dtype=np.float32) * 2 / 32)))[
                None, None, None, :
            ]
        )
        for s in range(tokens.shape[1]):
            if np.isfinite(hw[0, s]).all():
                angles[0, s, :, 16:] = np.einsum("p,hfp->hf", hw[0, s], freq)
        image = ((tokens == 244).cumsum(-1) - (tokens == 230).cumsum(-1)) > 0
        allowed = np.tri(tokens.shape[1], dtype=bool)[None] | (
            image[:, :, None] & image[:, None, :]
        )
        np.savez(
            out / "native-inputs.npz",
            input_ids=tokens,
            pixel_values=slot_pixels,
            pixel_mask=(tokens == 227)[:, :, None],
            rope_cos=np.cos(angles),
            rope_sin=np.sin(angles),
            attention_mask=np.where(allowed[:, None], 0, -10000).astype(np.float16),
            past_key_values=np.zeros((22, 2, 1, 16, 0, 64), np.float16),
        )
        (out / "native-inputs.json").write_text(
            json.dumps(
                {
                    "tokens": tokens.tolist(),
                    "pos_t": time_pos.tolist(),
                    "last_pos": int(time_pos[0, -1]),
                }
            )
        )
(out / "examples.json").write_text(json.dumps(fixtures, indent=2), encoding="utf-8")
print(json.dumps(fixtures), flush=True)
