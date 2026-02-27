import json
import os
import shutil
from pathlib import Path

MODEL_DIR = "./outputs_trocr_manga_large/final_manga_model"
ONNX_OUTPUT_DIR = "./onnx_export"

print("=" * 60)
print("  ÉTAPE 1 : Pré-configuration du modèle pour l'export ONNX")
print("=" * 60)

config_path = os.path.join(MODEL_DIR, "config.json")
with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)

config["decoder"]["use_cache"] = True
config["decoder"]["early_stopping"] = True
config["decoder"]["max_length"] = 64
config["decoder"]["num_beams"] = 6
config["decoder"]["no_repeat_ngram_size"] = 0
config["decoder"]["length_penalty"] = 1.0

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
print(f"  ✅ config.json mise à jour (use_cache=true, no_repeat=0, length_penalty=1.0)")

gen_config_path = os.path.join(MODEL_DIR, "generation_config.json")
with open(gen_config_path, "r", encoding="utf-8") as f:
    gen_config = json.load(f)

gen_config["use_cache"] = True

with open(gen_config_path, "w", encoding="utf-8") as f:
    json.dump(gen_config, f, indent=2, ensure_ascii=False)
print(f"  ✅ generation_config.json mise à jour (use_cache=true)")

print()
print("=" * 60)
print("  ÉTAPE 2 : Export ONNX via Optimum (fp32, with_past, merge)")
print("=" * 60)
print()

from optimum.exporters.onnx import main_export

main_export(
    model_name_or_path=MODEL_DIR,
    output=ONNX_OUTPUT_DIR,
    task="image-to-text-with-past",
    opset=14,
    device="cpu",
    fp16=False,
    no_post_process=False,
)

print()
print("=" * 60)
print("  ÉTAPE 3 : Nettoyage et structuration pour transformers.js")
print("=" * 60)
print()

onnx_subdir = os.path.join(ONNX_OUTPUT_DIR, "onnx")
os.makedirs(onnx_subdir, exist_ok=True)

onnx_files_to_move = [
    "encoder_model.onnx",
    "decoder_model_merged.onnx",
]

for fname in onnx_files_to_move:
    src = os.path.join(ONNX_OUTPUT_DIR, fname)
    dst = os.path.join(onnx_subdir, fname)
    if os.path.exists(src):
        shutil.move(src, dst)
        size_mb = os.path.getsize(dst) / (1024 * 1024)
        print(f"  ✅ {fname} → onnx/ ({size_mb:.1f} MB)")

cleanup_files = [
    "decoder_model.onnx",
    "decoder_with_past_model.onnx",
]
for fname in cleanup_files:
    fpath = os.path.join(ONNX_OUTPUT_DIR, fname)
    if os.path.exists(fpath):
        os.remove(fpath)
        print(f"  🗑️  Supprimé : {fname} (non nécessaire, merged utilisé)")

config_files = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
]
for fname in config_files:
    src = os.path.join(MODEL_DIR, fname)
    dst = os.path.join(ONNX_OUTPUT_DIR, fname)
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copy2(src, dst)
        print(f"  📄 Copié : {fname}")

print()
print("=" * 60)
print("  ÉTAPE 4 : Vérification finale")
print("=" * 60)
print()

expected_files = [
    "onnx/encoder_model.onnx",
    "onnx/decoder_model_merged.onnx",
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
]

all_ok = True
for fpath in expected_files:
    full = os.path.join(ONNX_OUTPUT_DIR, fpath)
    if os.path.exists(full):
        size = os.path.getsize(full)
        if size > 1024 * 1024:
            print(f"  ✅ {fpath} ({size / (1024*1024):.1f} MB)")
        else:
            print(f"  ✅ {fpath} ({size / 1024:.1f} KB)")
    else:
        print(f"  ❌ MANQUANT : {fpath}")
        all_ok = False

print()
if all_ok:
    print("🎉 Export ONNX terminé avec succès !")
    print(f"   Dossier prêt pour transformers.js : {os.path.abspath(ONNX_OUTPUT_DIR)}")
    print()
    print("   Usage transformers.js :")
    print('     const pipe = await pipeline("image-to-text", "./onnx_export", {')
    print('       device: "webgpu",')
    print('       dtype: "fp32"')
    print("     });")
else:
    print("⚠️  Des fichiers sont manquants, vérifiez les erreurs ci-dessus.")
