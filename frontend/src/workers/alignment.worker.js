self.addEventListener('message', async (event) => {
    const { type } = event.data;

    if (type === 'init') {
        self.postMessage({ status: 'ready' });
        return;
    }

    if (type === 'align') {
        const { bwImageData, colorImageData, pageId } = event.data;

        try {
            self.postMessage({ status: 'progress', pageId, step: 'préparation_données' });

            const Wb = bwImageData.width;
            const Wc = colorImageData.width;
            const baseScale = Wb / Wc;

            self.postMessage({ status: 'progress', pageId, step: 'recherche_grossiere' });

            const fastW = 150;
            const scaleToFast = fastW / Wb;
            const fastBW = await resizeImage(bwImageData, fastW, Math.round(bwImageData.height * scaleToFast));

            const fastInk = getInkPixels(fastBW, 1, 100);

            if (fastInk.length < 50) {
                throw new Error("Page vide ou aucun trait détecté.");
            }

            let bestMAD = Infinity;
            let bestM_fast = 1.0;
            let bestTx_fast = 0;
            let bestTy_fast = 0;

            for (let m = 0.80; m <= 1.20; m += 0.02) {
                const colW = Math.round(fastW * m);
                const colH = Math.round(colorImageData.height * baseScale * m * scaleToFast);
                const fastCol = await resizeImage(colorImageData, colW, colH);

                const maxT = Math.floor(fastW * 0.4);
                for (let ty = -maxT; ty <= maxT; ty += 2) {
                    for (let tx = -maxT; tx <= maxT; tx += 2) {
                        const mad = computeMAD(fastInk, fastCol, tx, ty);
                        if (mad < bestMAD) {
                            bestMAD = mad;
                            bestM_fast = m;
                            bestTx_fast = tx;
                            bestTy_fast = ty;
                        }
                    }
                }
            }

            self.postMessage({ status: 'progress', pageId, step: 'affinage_echelle' });

            const medW = 500;
            const scaleToMed = medW / Wb;
            const medBW = await resizeImage(bwImageData, medW, Math.round(bwImageData.height * scaleToMed));
            const medInk = getInkPixels(medBW, 2, 80);

            bestMAD = Infinity;
            let bestM_med = bestM_fast;
            let bestTx_med = 0;
            let bestTy_med = 0;

            const baseTx_med = Math.round(bestTx_fast * (medW / fastW));
            const baseTy_med = Math.round(bestTy_fast * (medW / fastW));

            for (let m = bestM_fast - 0.04; m <= bestM_fast + 0.04; m += 0.005) {
                const colW = Math.round(medW * m);
                const colH = Math.round(colorImageData.height * baseScale * m * scaleToMed);
                const medCol = await resizeImage(colorImageData, colW, colH);

                for (let ty = baseTy_med - 10; ty <= baseTy_med + 10; ty += 1) {
                    for (let tx = baseTx_med - 10; tx <= baseTx_med + 10; tx += 1) {
                        const mad = computeMAD(medInk, medCol, tx, ty);
                        if (mad < bestMAD) {
                            bestMAD = mad;
                            bestM_med = m;
                            bestTx_med = tx;
                            bestTy_med = ty;
                        }
                    }
                }
            }

            self.postMessage({ status: 'progress', pageId, step: 'pixel_perfect' });

            const finalScale = baseScale * bestM_med;
            const finalColW = Math.round(colorImageData.width * finalScale);
            const finalColH = Math.round(colorImageData.height * finalScale);

            const finalCol = await resizeImage(colorImageData, finalColW, finalColH);

            const origInk = getInkPixels(bwImageData, 4, 100);

            const baseTx_orig = Math.round(bestTx_med * (Wb / medW));
            const baseTy_orig = Math.round(bestTy_med * (Wb / medW));

            bestMAD = Infinity;
            let finalTx = baseTx_orig;
            let finalTy = baseTy_orig;

            for (let ty = baseTy_orig - 6; ty <= baseTy_orig + 6; ty += 1) {
                for (let tx = baseTx_orig - 6; tx <= baseTx_orig + 6; tx += 1) {
                    const mad = computeMAD(origInk, finalCol, tx, ty);
                    if (mad < bestMAD) {
                        bestMAD = mad;
                        finalTx = tx;
                        finalTy = ty;
                    }
                }
            }

            const transform = [finalScale, 0, 0, finalScale, finalTx, finalTy];

            self.postMessage({
                status: 'complete',
                pageId,
                transform,
                stats: { scale: finalScale.toFixed(5), tx: finalTx, ty: finalTy }
            });

        } catch (err) {
            self.postMessage({ status: 'error', error: err.message, pageId });
        }
    }
});

async function resizeImage(imgData, targetWidth, targetHeight) {
    const bitmap = await createImageBitmap(imgData);
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    const data = ctx.getImageData(0, 0, targetWidth, targetHeight);
    bitmap.close();
    return data;
}

function getInkPixels(imgData, step, threshold) {
    const points = [];
    const w = imgData.width;
    const h = imgData.height;
    const data = imgData.data;

    for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
            const idx = (y * w + x) * 4;
            const lum = (data[idx] * 2 + data[idx + 1] * 5 + data[idx + 2]) >> 3;
            if (lum < threshold) {
                points.push({ x, y, lum });
            }
        }
    }

    const maxPoints = 5000;
    if (points.length > maxPoints) {
        const subsampled = [];
        const skip = points.length / maxPoints;
        for (let i = 0; i < points.length; i += skip) {
            subsampled.push(points[Math.floor(i)]);
        }
        return subsampled;
    }
    return points;
}

function computeMAD(inkPixels, colorData, tx, ty) {
    let diff = 0;
    let valid = 0;
    const w = colorData.width;
    const h = colorData.height;
    const data = colorData.data;

    for (let i = 0; i < inkPixels.length; i++) {
        const p = inkPixels[i];

        const cx = Math.round(p.x - tx);
        const cy = Math.round(p.y - ty);

        if (cx >= 0 && cx < w && cy >= 0 && cy < h) {
            const idx = (cy * w + cx) * 4;
            const colLum = (data[idx] * 2 + data[idx + 1] * 5 + data[idx + 2]) >> 3;
            diff += Math.abs(p.lum - colLum);
            valid++;
        }
    }

    if (valid < inkPixels.length * 0.25) return Infinity;

    return diff / valid;
}