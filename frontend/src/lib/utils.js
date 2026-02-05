import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}
export function getProxiedImageUrl(url, pageId = null, token = null) {
    if (pageId) {
        const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';
        let imageUrl = `${backendUrl}/pages/${pageId}/image`;
        if (token) imageUrl += `?token=${token}`;
        return imageUrl;
    }

    if (!url) return url;
    if (url.includes('s3.onepiece-index.com')) {
        return url.replace('https://s3.onepiece-index.com', '/s3-proxy');
    }
    return url;
}

export const cropImage = (imageElement, rect) => {
    return new Promise((resolve, reject) => {
        if (!imageElement) {
            console.error("cropImage: imageElement is missing");
            reject("No image provided");
            return;
        }
        if (!rect) {
            console.error("cropImage: rect is missing");
            reject("No rect provided");
            return;
        }
        if (rect.w <= 0 || rect.h <= 0) {
            console.error("cropImage: Invalid dimensions", rect);
            reject("Invalid rect dimensions");
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = rect.w;
        canvas.height = rect.h;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(
            imageElement,
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            0,
            0,
            rect.w,
            rect.h
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
