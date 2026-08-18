import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = dirname(fileURLToPath(import.meta.resolve('onnxruntime-web')));
const targetDirectory = join(frontendRoot, 'public', 'onnx');
const assetPattern = /^ort-wasm-simd-threaded(?:\.(?:asyncify|jsep|jspi))?\.(?:mjs|wasm)$/;

const assets = (await readdir(sourceDirectory))
  .filter((name) => assetPattern.test(name))
  .sort();

const requiredAssets = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

for (const requiredAsset of requiredAssets) {
  if (!assets.includes(requiredAsset)) {
    throw new Error(`onnxruntime-web is missing required runtime asset: ${requiredAsset}`);
  }
}

await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });

await Promise.all(assets.map((asset) => (
  copyFile(join(sourceDirectory, asset), join(targetDirectory, asset))
)));

console.log(`Synchronized ${assets.length} ONNX Runtime Web assets.`);
