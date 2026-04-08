import onnx
from onnx import numpy_helper
import safetensors.numpy
from huggingface_hub import hf_hub_download
import numpy as np
import shutil
import os

print("Téléchargement du graphe ONNX Xenova structuré (FP32)...")
graph_path = hf_hub_download("onnx-community/LightOnOCR-2-1B-ONNX", "onnx/decoder_model_merged.onnx")
print("Téléchargement du fichier de données externe associé...")
data_path = hf_hub_download("onnx-community/LightOnOCR-2-1B-ONNX", "onnx/decoder_model_merged.onnx_data")

# Contourner le bug ONNX des liens symboliques HuggingFace
local_graph = "temp_decoder_model_merged.onnx"
local_data = "temp_decoder_model_merged.onnx_data"

print("Copie des fichiers pour contourner les liens symboliques...")
shutil.copyfile(graph_path, local_graph)
shutil.copyfile(data_path, local_data)

print("Chargement du graphe...")
model = onnx.load(local_graph, load_external_data=True)

print("Chargement de tes poids safetensors (Qwen2)...")
tensors = safetensors.numpy.load_file("model.safetensors")

def map_tensor_name(onnx_name):
    if onnx_name == "model.embed_tokens.weight":
        return "model.language_model.model.embed_tokens.weight"
    if onnx_name == "model.norm.weight":
        return "model.language_model.model.norm.weight"
    if onnx_name == "lm_head.weight":
        return "model.language_model.lm_head.weight"
    
    n = onnx_name
    n = n.replace("model.layers.", "model.language_model.model.layers.")
    n = n.replace(".attn.", ".self_attn.")
    
    if ".MatMul.weight" in n:
        n = n.replace(".MatMul.weight", ".weight")
        return n, True
    
    if ".layernorm.weight" in n:
        n = n.replace(".layernorm.weight", ".weight")
        return n, False
        
    return n, False

print("Remplacement des poids dans le graphe...")
replaced_count = 0
for init in model.graph.initializer:
    mapping = map_tensor_name(init.name)
    if isinstance(mapping, tuple):
        safe_name, do_transpose = mapping
    else:
        safe_name, do_transpose = mapping, False
        
    if safe_name in tensors:
        data = tensors[safe_name]
        if do_transpose:
            data = data.T
        data = data.astype(np.float32)
        new_init = numpy_helper.from_array(data, name=init.name)
        init.CopyFrom(new_init)
        replaced_count += 1

print(f"Remplacement terminé : {replaced_count} tenseurs injectés !")

print("Sauvegarde du modèle complet avec external data...")
onnx.save_model(model, "decoder_model_merged_poneglyph.onnx", save_as_external_data=True, all_tensors_to_one_file=True, location="decoder_model_merged_poneglyph.onnx_data")

# Suppression des fichiers temporaires
os.remove(local_graph)
os.remove(local_data)
print("Création terminée !")
