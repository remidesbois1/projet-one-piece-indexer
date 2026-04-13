# 02_inject_and_quantize.py
# Injects fine-tuned Poneglyph weights into base LightonOCR-2 ONNX models.
# Uses direct ONNX→safetensors key mapping (no fragile normalization).
import os
import re
import glob
import shutil
import numpy as np
from safetensors import safe_open
import onnx


def charger_safetensors_unifies(repertoire):
    """Load all safetensors weights as FP16 numpy arrays via PyTorch .half()."""
    dictionnaire_poids = {}
    for fichier in glob.glob(os.path.join(repertoire, "*.safetensors")):
        with safe_open(fichier, framework="pt", device="cpu") as st:
            for cle in st.keys():
                dictionnaire_poids[cle] = st.get_tensor(cle).half().numpy()
    return dictionnaire_poids


# ---------------------------------------------------------------------------
# Direct ONNX initializer name → safetensors key mapping
# ---------------------------------------------------------------------------


def derive_safetensors_key_decoder(onnx_name):
    """Map a decoder ONNX initializer name to its safetensors key.
    Returns (safetensors_key, needs_transpose) or (None, False) if unmappable.
    """
    name = onnx_name

    # cos_cache / sin_cache — not weights, skip
    if name in ("cos_cache", "sin_cache"):
        return None, False

    # lm_head.MatMul.weight → tied with embed_tokens
    if name == "lm_head.MatMul.weight":
        return "model.language_model.model.embed_tokens.weight", True

    # model.layers.28.final_norm_layernorm.weight → model.language_model.model.norm.weight
    if name == "model.layers.28.final_norm_layernorm.weight":
        return "model.language_model.model.norm.weight", False

    # model.layers.X.attn.{q,k,v,o}_proj.MatMul.weight
    m = re.match(r"model\.layers\.(\d+)\.attn\.([qkvo]_proj)\.MatMul\.weight$", name)
    if m:
        layer, proj = m.group(1), m.group(2)
        return (
            f"model.language_model.model.layers.{layer}.self_attn.{proj}.weight",
            True,
        )

    # model.layers.X.mlp.{gate,up,down}_proj.MatMul.weight
    m = re.match(
        r"model\.layers\.(\d+)\.mlp\.(gate_proj|up_proj|down_proj)\.MatMul\.weight$",
        name,
    )
    if m:
        layer, proj = m.group(1), m.group(2)
        return f"model.language_model.model.layers.{layer}.mlp.{proj}.weight", True

    # model.layers.X.input_layernorm.weight
    m = re.match(r"model\.layers\.(\d+)\.input_layernorm\.weight$", name)
    if m:
        layer = m.group(1)
        return (
            f"model.language_model.model.layers.{layer}.input_layernorm.weight",
            False,
        )

    # model.layers.X.post_attention_layernorm.weight
    m = re.match(r"model\.layers\.(\d+)\.post_attention_layernorm\.weight$", name)
    if m:
        layer = m.group(1)
        return (
            f"model.language_model.model.layers.{layer}.post_attention_layernorm.weight",
            False,
        )

    return None, False


def derive_safetensors_key_vision(onnx_name):
    """Map a vision encoder ONNX initializer name to its safetensors key.
    Returns (safetensors_key, needs_transpose) or (None, False) if unmappable.
    """
    name = onnx_name

    # --- Special / non-layer weights ---

    # model.layers.-1.ln_pre_layernorm.weight
    if name == "model.layers.-1.ln_pre_layernorm.weight":
        return "model.vision_encoder.ln_pre.weight", False

    # patch_conv.weight (4D conv, no transpose)
    if name == "patch_conv.weight":
        return "model.vision_encoder.patch_conv.weight", False

    # --- Projector weights ---

    # model.multimodal_projector.linear_1.MatMul.weight
    if name == "model.multimodal_projector.linear_1.MatMul.weight":
        return "model.vision_projection.linear_1.weight", True

    # model.multimodal_projector.linear_2.MatMul.weight
    if name == "model.multimodal_projector.linear_2.MatMul.weight":
        return "model.vision_projection.linear_2.weight", True

    # model.layers.projector.multi_modal_projector.norm_layernorm.weight
    if name == "model.layers.projector.multi_modal_projector.norm_layernorm.weight":
        return "model.vision_projection.norm.weight", False

    # model.multimodal_projector.patch_merger.Linear.weight
    if name == "model.multimodal_projector.patch_merger.Linear.weight":
        return "model.vision_projection.patch_merger.merging_layer.weight", True

    # --- Transformer layer weights ---

    # model.layers.X.attn.{q,k,v,o}_proj.MatMul.weight
    m = re.match(r"model\.layers\.(\d+)\.attn\.([qkvo]_proj)\.MatMul\.weight$", name)
    if m:
        layer, proj = m.group(1), m.group(2)
        return (
            f"model.vision_encoder.transformer.layers.{layer}.attention.{proj}.weight",
            True,
        )

    # model.layers.X.mlp.{gate,up,down}_proj.MatMul.weight
    m = re.match(
        r"model\.layers\.(\d+)\.mlp\.(gate_proj|up_proj|down_proj)\.MatMul\.weight$",
        name,
    )
    if m:
        layer, proj = m.group(1), m.group(2)
        return (
            f"model.vision_encoder.transformer.layers.{layer}.feed_forward.{proj}.weight",
            True,
        )

    # model.layers.X.attention_norm_layernorm.weight
    m = re.match(r"model\.layers\.(\d+)\.attention_norm_layernorm\.weight$", name)
    if m:
        layer = m.group(1)
        return (
            f"model.vision_encoder.transformer.layers.{layer}.attention_norm.weight",
            False,
        )

    # model.layers.X.ffn_norm_layernorm.weight
    m = re.match(r"model\.layers\.(\d+)\.ffn_norm_layernorm\.weight$", name)
    if m:
        layer = m.group(1)
        return f"model.vision_encoder.transformer.layers.{layer}.ffn_norm.weight", False

    return None, False


def derive_safetensors_key_embed(onnx_name):
    """Map an embed_tokens ONNX initializer name to its safetensors key.
    Returns (safetensors_key, needs_transpose) or (None, False) if unmappable.
    """
    if onnx_name == "model.embed_tokens.weight":
        return "model.language_model.model.embed_tokens.weight", False
    return None, False


# Module type → mapping function
DERIVE_FN = {
    "decoder": derive_safetensors_key_decoder,
    "vision": derive_safetensors_key_vision,
    "embed": derive_safetensors_key_embed,
}


def patcher_modele_fp16(
    nom_fichier, module_type, dictionnaire_poids, repertoire_base, repertoire_sortie
):
    """Patch a single ONNX model file by injecting fine-tuned weights."""
    chemin_base_onnx = os.path.join(repertoire_base, nom_fichier)
    chemin_base_data = chemin_base_onnx + "_data"
    chemin_sortie_onnx = os.path.join(repertoire_sortie, nom_fichier)
    chemin_sortie_data = chemin_sortie_onnx + "_data"

    print(f"\nPatchage de {nom_fichier} (module_type={module_type})...")

    # Copy base files to output
    shutil.copy2(chemin_base_onnx, chemin_sortie_onnx)
    if os.path.exists(chemin_base_data):
        shutil.copy2(chemin_base_data, chemin_sortie_data)

    # Load ONNX graph (metadata only, no external data)
    modele = onnx.load(chemin_sortie_onnx, load_external_data=False)

    derive_fn = DERIVE_FN[module_type]

    patches = []
    matched = 0
    skipped_no_key = []
    skipped_no_weight = []
    skipped_shape = []

    for init in modele.graph.initializer:
        if not init.external_data:
            continue

        st_key, needs_transpose = derive_fn(init.name)

        if st_key is None:
            skipped_no_key.append(init.name)
            continue

        if st_key not in dictionnaire_poids:
            skipped_no_weight.append((init.name, st_key))
            continue

        poids = dictionnaire_poids[st_key]
        cible = tuple(init.dims)

        if needs_transpose:
            poids = poids.T

        if poids.shape != cible:
            skipped_shape.append((init.name, st_key, poids.shape, cible))
            continue

        # Read offset/length from external data references
        offset = int(
            next((e.value for e in init.external_data if e.key == "offset"), "0")
        )
        length = int(
            next((e.value for e in init.external_data if e.key == "length"), "0")
        )

        raw = np.ascontiguousarray(poids.astype(np.float16)).tobytes()
        if len(raw) == length:
            patches.append((offset, raw))
            matched += 1
        else:
            print(
                f"  WARNING: byte length mismatch for {init.name}: "
                f"expected {length}, got {len(raw)}"
            )

    # Fix GQA attributes (decoder only)
    gqa_fixes = 0
    for node in modele.graph.node:
        if node.op_type == "GroupQueryAttention":
            for attr in node.attribute:
                if attr.name == "num_heads" and attr.i != 16:
                    attr.i = 16
                    gqa_fixes += 1

    if gqa_fixes:
        with open(chemin_sortie_onnx, "wb") as f:
            f.write(modele.SerializeToString())
        print(f"  {gqa_fixes} attributs GQA corriges.")

    # Write patches to data file
    if patches and os.path.exists(chemin_sortie_data):
        with open(chemin_sortie_data, "r+b") as f:
            for offset, raw in patches:
                f.seek(offset)
                f.write(raw)
        print(f"  {matched} poids injectes dans {nom_fichier}_data.")

    # Report skipped
    if skipped_no_key:
        print(
            f"  {len(skipped_no_key)} initializers sans mapping (cos/sin cache, etc.)"
        )
    if skipped_no_weight:
        print(f"  {len(skipped_no_weight)} mappings sans poids safetensors:")
        for onnx_name, st_key in skipped_no_weight:
            print(f"    {onnx_name} -> {st_key} (NOT FOUND)")
    if skipped_shape:
        print(f"  {len(skipped_shape)} shape mismatches:")
        for onnx_name, st_key, got, expected in skipped_shape:
            print(f"    {onnx_name} -> {st_key}: got {got}, expected {expected}")

    del modele
    import gc

    gc.collect()


def main():
    repertoire_base = "./staging/onnx_base/onnx"
    repertoire_poids = "./staging/poneglyph_weights"
    repertoire_sortie = "./fp16_poneglyph/onnx"
    os.makedirs(repertoire_sortie, exist_ok=True)

    poids = charger_safetensors_unifies(repertoire_poids)
    if not poids:
        raise RuntimeError("Pas de safetensors trouves.")
    print(f"Charge {len(poids)} poids safetensors.")

    modules = [
        ("decoder_model_merged_fp16.onnx", "decoder"),
        ("embed_tokens_fp16.onnx", "embed"),
        ("vision_encoder_fp16.onnx", "vision"),
    ]

    for nom, module_type in modules:
        if not os.path.exists(os.path.join(repertoire_base, nom)):
            print(f"SKIP {nom}")
            continue
        patcher_modele_fp16(nom, module_type, poids, repertoire_base, repertoire_sortie)

    for cfg in ["config.json", "generation_config.json", "preprocessor_config.json"]:
        src = os.path.join("./staging/onnx_base", cfg)
        if os.path.exists(src):
            shutil.copy(src, os.path.join("./fp16_poneglyph", cfg))

    print("\nTermine.")


if __name__ == "__main__":
    main()
