const MIN_RALLY_IOU = 0.05;

function isFiniteBox(box) {
    return box && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(box[key])))
        && Number(box.w) > 0
        && Number(box.h) > 0;
}

function normalizedToPixels(bubble, imageWidth, imageHeight) {
    if (!Array.isArray(bubble?.bbox) || bubble.bbox.length !== 4) return null;
    const [x1, y1, x2, y2] = bubble.bbox.map(Number);
    if (![x1, y1, x2, y2, imageWidth, imageHeight].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
    return {
        x: Math.round((x1 / 1000) * imageWidth),
        y: Math.round((y1 / 1000) * imageHeight),
        w: Math.round(((x2 - x1) / 1000) * imageWidth),
        h: Math.round(((y2 - y1) / 1000) * imageHeight),
    };
}

function boxIou(a, b) {
    const intersectionWidth = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const intersectionHeight = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const intersection = intersectionWidth * intersectionHeight;
    const union = (a.w * a.h) + (b.w * b.h) - intersection;
    return union > 0 ? intersection / union : 0;
}

export function reconcileOcrBubblesWithYolo(ocrBubbles, yoloBoxes, imageWidth, imageHeight) {
    const ocr = (Array.isArray(ocrBubbles) ? ocrBubbles : [])
        .map((bubble, index) => ({ bubble, index, box: normalizedToPixels(bubble, imageWidth, imageHeight) }))
        .filter(item => isFiniteBox(item.box));
    const yolo = (Array.isArray(yoloBoxes) ? yoloBoxes : [])
        .map((box, index) => ({ index, box: isFiniteBox(box) ? {
            x: Math.round(Number(box.x)),
            y: Math.round(Number(box.y)),
            w: Math.round(Number(box.w)),
            h: Math.round(Number(box.h)),
        } : null }))
        .filter(item => item.box);

    const candidates = [];
    for (const ocrItem of ocr) {
        for (const yoloItem of yolo) {
            const iou = boxIou(ocrItem.box, yoloItem.box);
            if (iou > MIN_RALLY_IOU) candidates.push({ ocrIndex: ocrItem.index, yoloIndex: yoloItem.index, iou });
        }
    }
    candidates.sort((a, b) => b.iou - a.iou);

    const usedOcr = new Set();
    const usedYolo = new Set();
    const matchedYoloByOcr = new Map();
    for (const candidate of candidates) {
        if (usedOcr.has(candidate.ocrIndex) || usedYolo.has(candidate.yoloIndex)) continue;
        usedOcr.add(candidate.ocrIndex);
        usedYolo.add(candidate.yoloIndex);
        matchedYoloByOcr.set(candidate.ocrIndex, yolo.find(item => item.index === candidate.yoloIndex)?.box);
    }

    return ocr.map(item => ({
        ...item.bubble,
        ...(matchedYoloByOcr.get(item.index) || item.box),
        ralliedWithYolo: matchedYoloByOcr.has(item.index),
    }));
}
