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
        requested_backend: null,
        active_backend: null,
        backend_fallback_reason: null,
        download: null
    },
    localTextModelStatus: {
        installed: false,
        loaded: false,
        loading: false,
        ready: false,
        model_dir: '',
        error: null,
        device: null,
        dtype: null,
        requested_backend: null,
        active_backend: null,
        backend_fallback_reason: null,
        download: null
    },
    localSuryaModelStatus: {
        installed: false,
        loaded: false,
        loading: false,
        ready: false,
        model_dir: '',
        error: null,
        device: null,
        dtype: null,
        requested_backend: null,
        active_backend: null,
        backend_fallback_reason: null,
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
    isDownloadingLocalTextModel: false,
    isDownloadingLocalSuryaModel: false,
    localDownloadState: null,
    localTextDownloadState: null,
    localSuryaDownloadState: null,
    localDownloadProgress: null,
    localTextDownloadProgress: null,
    localSuryaDownloadProgress: null,
    isLoadingLocalModel: false,
    isLoadingLocalTextModel: false,
    isLoadingLocalSuryaModel: false,
    isLocalInferencing: false,
    isLocalTextInferencing: false,
    isLocalSuryaInferencing: false,
    localError: null,
    canRunLocalOcr: false,
    canRunLocalTextOcr: false,
    canRunLocalSuryaOcr: false,
    refreshLocalModelStatus: async () => null,
    refreshLocalTextModelStatus: async () => null,
    refreshLocalSuryaModelStatus: async () => null,
    healthcheckLocalBackend: async () => null,
    refreshLocalDiagnostics: async () => null,
    downloadLocalModel: async () => ({ ok: false, error: "OCR local indisponible." }),
    downloadLocalTextModel: async () => ({ ok: false, error: "OCR local indisponible." }),
    downloadLocalSuryaModel: async () => ({ ok: false, error: "OCR local indisponible." }),
    loadLocalModel: async () => ({ error: "OCR local indisponible." }),
    loadLocalTextModel: async () => ({ error: "OCR local indisponible." }),
    loadLocalSuryaModel: async () => ({ error: "OCR local indisponible." }),
    runLocalOcrBlob: async () => {
        throw new Error("OCR local indisponible.");
    },
    runLocalTextOcrBlob: async () => {
        throw new Error("OCR local indisponible.");
    },
    runLocalSuryaOcrBlob: async () => {
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
