let worker = null;
let initPromise = null;

function getWorker() {
    if (!worker) {
        worker = new Worker(
            new URL('../workers/alignment.worker.js', import.meta.url),
            { type: 'module' }
        );
    }
    return worker;
}

export function initAlignmentWorker() {
    const w = getWorker();

    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Alignment worker init timeout (30s)'));
        }, 30000);

        const handler = (e) => {
            if (e.data.status === 'ready') {
                clearTimeout(timeout);
                w.removeEventListener('message', handler);
                resolve();
            } else if (e.data.status === 'error') {
                clearTimeout(timeout);
                w.removeEventListener('message', handler);
                reject(new Error(e.data.error));
            }
        };
        w.addEventListener('message', handler);
        w.postMessage({ type: 'init' });
    });

    return initPromise;
}

export function alignPages(bwImageData, colorImageData, pageId, onProgress) {
    const w = getWorker();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Alignment timeout (60s)'));
        }, 60000);

        const handler = (e) => {
            if (e.data.pageId !== pageId) return;

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
        w.postMessage({
            type: 'align',
            bwImageData,
            colorImageData,
            pageId
        });
    });
}

export function terminateAlignmentWorker() {
    if (worker) {
        worker.terminate();
        worker = null;
        initPromise = null;
    }
}

export function applyTransformToCanvas(canvas, ctx, img, transform) {
    const [a, b, tx, c, d, ty] = transform;
    ctx.save();
    ctx.setTransform(a, c, b, d, tx, ty);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
}

export function applyTransformOffscreen(bitmap, transform, targetWidth, targetHeight) {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');

    const [a, b, tx, c, d, ty] = transform;
    ctx.save();
    ctx.setTransform(a, c, b, d, tx, ty);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    return canvas;
}
