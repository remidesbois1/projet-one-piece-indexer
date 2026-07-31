import { describe, it, expect } from 'vitest';
import { cn, getProxiedImageUrl, cropImage } from './utils';

describe('Utils', () => {
    describe('cn (Tailwind class merger)', () => {
        it('merges simple classes', () => {
            expect(cn('bg-red-500', 'text-white')).toBe('bg-red-500 text-white');
        });

        it('handles conditional classes', () => {
            expect(cn('base-class', true && 'active-class', false && 'hidden')).toBe('base-class active-class');
        });

        it('resolves Tailwind conflicts (tailwind-merge behavior)', () => {
            
            expect(cn('p-4 p-2', 'p-8')).toBe('p-8');
            expect(cn('bg-red-500 text-white', 'bg-blue-500')).toBe('text-white bg-blue-500');
        });
    });

    describe('getProxiedImageUrl', () => {
        const originalEnv = process.env.NEXT_PUBLIC_BACKEND_URL;

        afterEach(() => {
            process.env.NEXT_PUBLIC_BACKEND_URL = originalEnv;
        });

        it('returns raw URL if no pageId is provided and url is not s3', () => {
            expect(getProxiedImageUrl('https://example.com/image.jpg')).toBe('https://example.com/image.jpg');
        });

        it('proxies public covers through the restricted cover path', () => {
            expect(getProxiedImageUrl('https://s3.onepiece-index.com/covers/image.jpg')).toBe('/s3-proxy/covers/image.jpg');
        });

        it('refuses direct page-storage URLs without a page endpoint', () => {
            expect(getProxiedImageUrl('https://s3.onepiece-index.com/tome-1/page.jpg')).toBeNull();
        });

        it('formats URL using pageId correctly without token', () => {
            process.env.NEXT_PUBLIC_BACKEND_URL = 'http://api.test';
            expect(getProxiedImageUrl(null, 'page123')).toBe('http://api.test/pages/page123/image');
        });

        it('resolves application page image paths against the backend API', () => {
            process.env.NEXT_PUBLIC_BACKEND_URL = 'https://api.test/api/';
            expect(getProxiedImageUrl('/api/pages/page123/image')).toBe('https://api.test/api/pages/page123/image');
        });

        it('never serializes a token into a page image URL', () => {
            process.env.NEXT_PUBLIC_BACKEND_URL = 'http://api.test';
            expect(getProxiedImageUrl(null, 'page123', 'tok456')).toBe('http://api.test/pages/page123/image');
        });

        it('returns falsy if url is falsy and no pageId is provided', () => {
            expect(getProxiedImageUrl(null)).toBeNull();
            expect(getProxiedImageUrl('')).toBe('');
        });
    });

    describe('cropImage', () => {
        it('rejects if no imageElement is provided', async () => {
            await expect(cropImage(null, { x: 0, y: 0, w: 100, h: 100 })).rejects.toEqual('No image provided');
        });

        it('rejects if no rect is provided', async () => {
            await expect(cropImage({}, null)).rejects.toEqual('No rect provided');
        });

        it('rejects if rect has invalid dimensions (w <= 0 or h <= 0)', async () => {
            await expect(cropImage({}, { x: 0, y: 0, w: 0, h: 100 })).rejects.toEqual('Invalid rect dimensions');
            await expect(cropImage({}, { x: 0, y: 0, w: 100, h: -10 })).rejects.toEqual('Invalid rect dimensions');
        });

        
        
        
    });
});
