"use client";

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { getCachedCoverUrl, preloadCoverUrl } from '@/lib/coverImageCache';

export default function CoverThumbnailImage({ src, alt, className, sizes, ...props }) {
    const [loadedCover, setLoadedCover] = useState(() => ({ source: src, url: getCachedCoverUrl(src) }));

    useEffect(() => {
        let active = true;

        if (!src || getCachedCoverUrl(src)) return undefined;

        preloadCoverUrl(src)
            .then((objectUrl) => {
                if (active) setLoadedCover({ source: src, url: objectUrl });
            })
            .catch(() => {
                if (active) setLoadedCover({ source: src, url: src });
            });

        return () => {
            active = false;
        };
    }, [src]);

    const cachedSrc = loadedCover.source === src ? loadedCover.url : getCachedCoverUrl(src);

    if (!cachedSrc) {
        return <div className={`h-full w-full animate-pulse bg-[#0b1624] ${className || ''}`} aria-label={alt} />;
    }

    return (
        <Image
            {...props}
            src={cachedSrc}
            alt={alt}
            fill
            sizes={sizes}
            unoptimized
            className={className}
        />
    );
}
