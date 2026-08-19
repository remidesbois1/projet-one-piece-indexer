"use client";

import { useEffect, useState } from 'react';
import { DEFAULT_AI_MODEL_CONFIG, getAiModelConfig, subscribeToAiModelConfig } from '@/lib/aiModelConfig';

export function useAiModelConfig() {
    const [config, setConfig] = useState(DEFAULT_AI_MODEL_CONFIG);

    useEffect(() => {
        let cancelled = false;
        getAiModelConfig().then(nextConfig => {
            if (!cancelled) setConfig(nextConfig);
        });
        const unsubscribe = subscribeToAiModelConfig(nextConfig => setConfig(nextConfig));
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    return config;
}
