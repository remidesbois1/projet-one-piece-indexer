let worker = null;

function getWorker() {
    if (!worker) {
        worker = new Worker(
            new URL('../workers/alignment.worker.js', import.meta.url),
            { type: 'module' }
        );
        worker.postMessage({ type: 'init' });
    }
    return worker;
}

export function initAlignmentWorker() {
    getWorker();
    return Promise.resolve();
}

export function alignPages(bwImageData, colorImageData, pageId, onProgress) {
    const w = getWorker();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Alignment timeout (15s)')), 15000);

        const handler = (e) => {
            if (e.data.pageId !== pageId && e.data.status !== 'error') return;

            if (e.data.status === 'complete') {
                clearTimeout(timeout);
                w.removeEventListener('message', handler);
                resolve(e.data);
            } else if (e.data.status === 'error') {
                clearTimeout(timeout);
                w.removeEventListener('message', handler);
                reject(new Error(e.data.error));
            } else if (e.data.status === 'progress' && onProgress) {
                onProgress(e.data);
            }
        };
        w.addEventListener('message', handler);
        w.postMessage({ type: 'align', bwImageData, colorImageData, pageId });
    });
}

export function terminateAlignmentWorker() {
    if (worker) {
        worker.terminate();
        worker = null;
    }
}

export function applyTransformToCanvas(canvas, ctx, img, transform) {
    const [a, b, c, d, tx, ty] = transform;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.save();
    ctx.setTransform(a, b, c, d, tx, ty);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

export function applyTransformOffscreen(bitmap, transform, targetWidth, targetHeight) {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    const [a, b, c, d, tx, ty] = transform;
    ctx.save();
    ctx.setTransform(a, b, c, d, tx, ty);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    return canvas;
}