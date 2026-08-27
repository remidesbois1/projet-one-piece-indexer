import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.resolve(
    here,
    '../../docker_scripts/package_readernet_models/hf_package/ordering.onnx'
);
const panelModelPath = path.resolve(
    here,
    '../../docker_scripts/package_readernet_models/hf_package/panel_detector.onnx'
);
const model = fs.readFileSync(modelPath);
const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
});
const outputs = await session.run({
    panel_features: new ort.Tensor('float32', new Float32Array(3 * 96), [3, 96]),
    bubble_features: new ort.Tensor('float32', new Float32Array(5 * 102), [5, 102]),
});

if (outputs.panel_logits.dims[0] !== 3 || outputs.bubble_logits.dims[0] !== 5) {
    throw new Error(`Unexpected ReaderNet output shapes: ${outputs.panel_logits.dims}, ${outputs.bubble_logits.dims}`);
}

const panelSession = await ort.InferenceSession.create(fs.readFileSync(panelModelPath), {
    executionProviders: ['wasm'],
});
const panelMetadata = Array.isArray(panelSession.inputMetadata)
    ? panelSession.inputMetadata[0]
    : panelSession.inputMetadata?.[panelSession.inputNames[0]];
const panelInputShape = panelMetadata?.shape ?? panelMetadata?.dims;
if (panelInputShape?.[2] !== 1504 || panelInputShape?.[3] !== 1504) {
    throw new Error(`Unexpected panel detector input shape: ${panelInputShape}`);
}

console.log(JSON.stringify({
    inputs: session.inputNames,
    outputs: session.outputNames,
    panelShape: outputs.panel_logits.dims,
    bubbleShape: outputs.bubble_logits.dims,
    panelDetectorInputShape: panelInputShape,
}));
