// Falcon's patch order and 3D rotary positions, shared by the worker and tests.
const bits = new DataView(new ArrayBuffer(4));
export function half(value) {
    bits.setFloat32(0, value, false);
    const x = bits.getUint32(0, false);
    const sign = (x >>> 16) & 0x8000;
    const exponent = ((x >>> 23) & 255) - 127 + 15;
    const mantissa = x & 0x7fffff;
    if (exponent >= 31) return sign | 0x7c00;
    if (exponent <= 0) {
        if (exponent < -10) return sign;
        const shifted = (mantissa | 0x800000) >>> (1 - exponent);
        return sign | ((shifted + 0xfff + ((shifted >>> 13) & 1)) >>> 13);
    }
    const rounded = mantissa + 0xfff + ((mantissa >>> 13) & 1);
    return sign | ((exponent << 10) + (rounded >>> 13));
}

export function roundEven(value) {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
}

export function resizedDimensions(width, height, min = 64, max = 896) {
    const ratio = width / height;
    if (!(width >= min && width <= max && height >= min && height <= max)) {
        if (width < min || height < min) {
            if (width < height) { width = min; height = Math.floor(width / ratio); }
            else { height = min; width = Math.floor(height * ratio); }
        } else if (width < height) { height = max; width = Math.floor(height * ratio); }
        else { width = max; height = Math.floor(width / ratio); }
        if (width > max) { width = max; height = Math.floor(width / ratio); }
        if (height > max) { height = max; width = Math.floor(height * ratio); }
    }
    return [width, height];
}

export function smartDimensions(width, height) {
    let w = roundEven(width / 16) * 16;
    let h = roundEven(height / 16) * 16;
    if (w * h > 1003520) {
        const beta = Math.sqrt(width * height / 1003520);
        w = Math.floor(width / beta / 16) * 16;
        h = Math.floor(height / beta / 16) * 16;
    } else if (w * h < 3136) {
        const beta = Math.sqrt(3136 / (width * height));
        w = Math.ceil(width * beta / 16) * 16;
        h = Math.ceil(height * beta / 16) * 16;
    }
    return [w, h];
}

export function rotaryPositions(manifest, timePositions, spatialPositions) {
    const cos = new Float32Array(timePositions.length * 16 * 32);
    const sin = new Float32Array(cos.length);
    for (let s = 0; s < timePositions.length; s++) {
        for (let head = 0; head < 16; head++) {
            for (let f = 0; f < 32; f++) {
                const spatial = spatialPositions?.[s];
                const frequency = manifest.golden_frequencies[head][f - 16];
                const angle = Math.fround(f < 16
                    ? timePositions[s] / (10000 ** (2 * f / 32))
                    : spatial ? spatial[0] * frequency[0] + spatial[1] * frequency[1] : 0);
                const i = (s * 16 + head) * 32 + f;
                cos[i] = Math.cos(angle);
                sin[i] = Math.sin(angle);
            }
        }
    }
    return { cos, sin };
}

export function packImage(manifest, rgba, width, height) {
    const c = manifest.config;
    const columns = width / 16, rows = height / 16;
    const count = columns * rows;
    const ids = [...manifest.prompt_chunks[0], c.image_cls_token_id,
        c.image_reg_1_token_id, c.image_reg_2_token_id, c.image_reg_3_token_id,
        c.image_reg_4_token_id, ...Array(count).fill(c.img_id), c.img_end_id,
        ...manifest.prompt_chunks[1]];
    const start = manifest.prompt_chunks[0].length, imageEnd = start + 5 + count;
    const pixels = new Uint16Array(ids.length * 768);
    const mask = new Uint8Array(ids.length);
    const spatial = Array(ids.length).fill(null);
    for (let py = 0; py < rows; py++) {
        for (let px = 0; px < columns; px++) {
            const token = start + 5 + py * columns + px;
            mask[token] = 1;
            spatial[token] = [Math.fround(Math.sqrt(rows / columns) * (rows === 1 ? -1 : -1 + 2 * py / (rows - 1))),
                Math.fround(Math.sqrt(columns / rows) * (columns === 1 ? -1 : -1 + 2 * px / (columns - 1)))];
            let index = token * 768;
            for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
                const offset = ((py * 16 + y) * width + px * 16 + x) * 4;
                for (let channel = 0; channel < 3; channel++) pixels[index++] = half(rgba[offset + channel] / 127.5 - 1);
            }
        }
    }
    const noIncrease = new Set([c.img_id, c.img_end_id, c.image_reg_1_token_id,
        c.image_reg_2_token_id, c.image_reg_3_token_id, c.image_reg_4_token_id]);
    let position = -1;
    const positions = ids.map(id => { if (!noIncrease.has(id)) position++; return Math.max(position, 0); });
    const attention = new Uint16Array(ids.length ** 2);
    for (let q = 0; q < ids.length; q++) for (let k = 0; k < ids.length; k++) {
        if (!(k <= q || (q >= start && q < imageEnd && k >= start && k < imageEnd))) attention[q * ids.length + k] = half(-10000);
    }
    return { ids, pixels, mask, attention, ...rotaryPositions(manifest, positions, spatial), lastPosition: position };
}

export async function prepareImage(manifest, bitmap) {
    const paddedWidth = Math.max(bitmap.width, Math.ceil(bitmap.height / 32), 16);
    const paddedHeight = Math.max(bitmap.height, Math.ceil(bitmap.width / 32), 16);
    let canvas = new OffscreenCanvas(paddedWidth, paddedHeight);
    let ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, paddedWidth, paddedHeight);
    ctx.drawImage(bitmap, Math.floor((paddedWidth - bitmap.width) / 2), Math.floor((paddedHeight - bitmap.height) / 2));
    for (const [w, h] of [resizedDimensions(paddedWidth, paddedHeight, manifest.min_dimension, manifest.max_dimension),
        smartDimensions(...resizedDimensions(paddedWidth, paddedHeight, manifest.min_dimension, manifest.max_dimension))]) {
        if (canvas.width === w && canvas.height === h) continue;
        const next = new OffscreenCanvas(w, h);
        ctx = next.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, w, h); canvas = next;
    }
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return packImage(manifest, rgba, canvas.width, canvas.height);
}
