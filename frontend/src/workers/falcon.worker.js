import { FalconWebGPU } from '../lib/falconWebgpu';

const engine = new FalconWebGPU();
let queue = Promise.resolve();
self.addEventListener('message', ({ data }) => {
    queue = queue.catch(() => undefined).then(async () => {
        try {
            if (data.type === 'init') {
                await engine.load(info => self.postMessage({ status: 'download_progress', ...info }));
                self.postMessage({ status: 'ready', modelKey: 'falconWebgpu', gpu: engine.gpuName });
            } else if (data.type === 'run') {
                const result = await engine.recognize(data.imageBitmap || data.imageBlob,
                    text => self.postMessage({ status: 'stream', text, requestId: data.requestId }));
                self.postMessage({ status: 'complete', requestId: data.requestId, ...result });
            } else if (data.type === 'dispose') { await engine.dispose(); }
        } catch (error) {
            self.postMessage({ status: 'error', requestId: data.requestId,
                error: error?.message || String(error), detail: error?.stack || String(error) });
        }
    });
});
