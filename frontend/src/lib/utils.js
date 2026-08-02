import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}
export function getProxiedImageUrl(url, pageId = null) {
    const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api').replace(/\/$/, '');
    if (pageId) {
        return `${backendUrl}/pages/${pageId}/image`;
    }

    if (!url) return url;
    if (url.startsWith('/api/pages/')) {
        return `${backendUrl}${url.slice('/api'.length)}`;
    }
    if (url.includes('s3.onepiece-index.com')) {
        const storageUrl = new URL(url);
        if (!storageUrl.pathname.startsWith('/covers/')) return null;
        return `/s3-proxy${storageUrl.pathname}`;
    }
    return url;
}

export function getPageImageThumbnailUrl(url, pageId = null, width = 640) {
    const imageUrl = getProxiedImageUrl(url, pageId);
    if (!imageUrl || !/\/pages\/[^/]+\/image$/.test(imageUrl)) return imageUrl;

    return `${imageUrl}/thumbnail?width=${encodeURIComponent(width)}`;
}

export function getMangaCoverThumbnailUrl(slug, width = 600) {
    if (!slug) return null;
    const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api').replace(/\/$/, '');
    return `${backendUrl}/mangas/${encodeURIComponent(slug)}/cover/thumbnail?width=${encodeURIComponent(width)}`;
}

export function getCoverThumbnailUrl(url, width = 512) {
    if (!url) return url;

    let coverPath = null;
    if (url.startsWith('/s3-proxy/covers/')) {
        coverPath = url.slice('/s3-proxy/covers/'.length);
    } else if (url.includes('s3.onepiece-index.com/covers/')) {
        coverPath = new URL(url).pathname.replace(/^\/covers\//, '');
    }

    if (!coverPath) return getProxiedImageUrl(url);

    const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api').replace(/\/$/, '');
    return `${backendUrl}/covers/thumbnail?path=${encodeURIComponent(coverPath)}&width=${encodeURIComponent(width)}`;
}

export function getPageDisplayStatus(status, isPublicViewer = false) {
    if (typeof status === 'string' && status.trim()) return status;
    return isPublicViewer ? 'completed' : 'not_started';
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

export const cropImageBitmap = async (imageElement, rect) => {
    if (!imageElement) {
        console.error("cropImageBitmap: imageElement is missing");
        throw "No image provided";
    }
    if (!rect) {
        console.error("cropImageBitmap: rect is missing");
        throw "No rect provided";
    }
    if (rect.w <= 0 || rect.h <= 0) {
        console.error("cropImageBitmap: Invalid dimensions", rect);
        throw "Invalid rect dimensions";
    }

    if (typeof createImageBitmap !== 'function') {
        return cropImage(imageElement, rect);
    }

    return createImageBitmap(
        imageElement,
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.w),
        Math.round(rect.h)
    );
};
export const loadImage = (src) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = src;
    });
};
