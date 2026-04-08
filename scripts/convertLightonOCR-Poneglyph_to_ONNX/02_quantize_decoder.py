from optimum.onnxruntime.quantization import ORTQuantizer
from optimum.onnxruntime.configuration import AutoQuantizationConfig
import os

input_model = "decoder_model_merged.onnx"
output_dir = "quantized_poneglyph"

if not os.path.exists(output_dir):
    os.makedirs(output_dir)

print(f"Quantification du modèle {input_model} en int8...")
quantizer = ORTQuantizer.from_pretrained(".", file_name=input_model)

qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)

quantizer.quantize(
    save_dir=output_dir,
    quantization_config=qconfig
)

print(f"Quantification terminée avec succès ! Modèles enregistrés dans {output_dir}")
