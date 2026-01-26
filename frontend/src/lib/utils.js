import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}
export function getProxiedImageUrl(url) {
    if (!url) return url;
    // En dev, on passe par le proxy local pour éviter les erreurs CORS
    // Surtout nécessaire pour les images qu'on manipule (crop/canvas)
    if (process.env.NODE_ENV === 'development' && url.includes('s3.onepiece-index.com')) {
        return url.replace('https://s3.onepiece-index.com', '/s3-proxy');
    }
    return url;
}

export const cropImage = (imageElement, rect) => {
    return new Promise((resolve, reject) => {
        if (!imageElement || !rect) {
            reject("No image or rect provided");
            return;
        }

        const canvas = document.createElement('canvas');
        const scaleX = imageElement.naturalWidth / imageElement.width;
        const scaleY = imageElement.naturalHeight / imageElement.height;

        canvas.width = rect.w;
        canvas.height = rect.h;

        const ctx = canvas.getContext('2d');

        // Draw the cropped image on the canvas
        // drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
        // We use the rect coordinates relative to the displayed image, scaled to natural dimensions
        // OR if rect is already scaled (AnnotatePage seems to scale it), we use it directly.
        // Let's check AnnotatePage logic in legacy:
        // setRectangle({ x: unscaledRect.x * scale ... }) -> rect IS in natural coordinates.

        ctx.drawImage(
            imageElement,
            rect.x, // sx (already scaled)
            rect.y, // sy
            rect.w, // sWidth
            rect.h, // sHeight
            0,      // dx
            0,      // dy
            rect.w, // dWidth
            rect.h  // dHeight
        );

        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject("Canvas to Blob failed");
            }
        }, 'image/jpeg', 0.95);
    });
};
