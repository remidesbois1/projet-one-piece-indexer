"use client";

import React, { createContext, useContext } from 'react';
import { useTauriLocalOcr } from '@/hooks/useTauriLocalOcr';

const EMPTY_LOCAL_OCR = {
    isTauri: false,
    isCheckingLocalConnection: false,
    localModelStatus: {
        installed: false,
        loaded: false,
        loading: false,
        ready: false,
        model_dir: '',
        error: null,
        device: null,
        dtype: null,
        download: null
    },
    localHealth: null,
    localConnectionState: {
        status: 'unavailable',
        failureCount: 0,
        lastOkAt: null,
        lastError: null
    },
    isDownloadingLocalModel: false,
    localDownloadState: null,
    localDownloadProgress: null,
    isLoadingLocalModel: false,
    isLocalInferencing: false,
    localError: null,
    canRunLocalOcr: false,
    refreshLocalModelStatus: async () => null,
    healthcheckLocalBackend: async () => null,
    refreshLocalDiagnostics: async () => null,
    downloadLocalModel: async () => ({ ok: false, error: "OCR local indisponible." }),
    loadLocalModel: async () => ({ error: "OCR local indisponible." }),
    runLocalOcrBlob: async () => {
        throw new Error("OCR local indisponible.");
    }
};

const TauriLocalOcrContext = createContext(EMPTY_LOCAL_OCR);

export function TauriLocalOcrProvider({ children }) {
    const localOcr = useTauriLocalOcr();
    return (
        <TauriLocalOcrContext.Provider value={localOcr}>
            {children}
        </TauriLocalOcrContext.Provider>
    );
}

export function useTauriLocalOcrContext() {
    return useContext(TauriLocalOcrContext);
}
