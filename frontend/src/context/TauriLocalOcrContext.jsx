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
    localSuryaBBoxModelStatus: {
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
    isDownloadingLocalSuryaBBoxModel: false,
    localDownloadState: null,
    localTextDownloadState: null,
    localSuryaDownloadState: null,
    localSuryaBBoxDownloadState: null,
    localDownloadProgress: null,
    localTextDownloadProgress: null,
    localSuryaDownloadProgress: null,
    localSuryaBBoxDownloadProgress: null,
    isLoadingLocalModel: false,
    isLoadingLocalTextModel: false,
    isLoadingLocalSuryaModel: false,
    isLoadingLocalSuryaBBoxModel: false,
    isLocalInferencing: false,
    isLocalTextInferencing: false,
    isLocalSuryaInferencing: false,
    isLocalSuryaBBoxInferencing: false,
    localError: null,
    canRunLocalOcr: false,
    canRunLocalTextOcr: false,
    canRunLocalSuryaOcr: false,
    canRunLocalSuryaBBoxOcr: false,
    refreshLocalModelStatus: async () => null,
    refreshLocalTextModelStatus: async () => null,
    refreshLocalSuryaModelStatus: async () => null,
    refreshLocalSuryaBBoxModelStatus: async () => null,
    healthcheckLocalBackend: async () => null,
    refreshLocalDiagnostics: async () => null,
    downloadLocalModel: async () => ({ ok: false, error: "Inference locale indisponible." }),
    downloadLocalTextModel: async () => ({ ok: false, error: "Inference locale indisponible." }),
    downloadLocalSuryaModel: async () => ({ ok: false, error: "Inference locale indisponible." }),
    downloadLocalSuryaBBoxModel: async () => ({ ok: false, error: "Inference locale indisponible." }),
    loadLocalModel: async () => ({ error: "Inference locale indisponible." }),
    loadLocalTextModel: async () => ({ error: "Inference locale indisponible." }),
    loadLocalSuryaModel: async () => ({ error: "Inference locale indisponible." }),
    loadLocalSuryaBBoxModel: async () => ({ error: "Inference locale indisponible." }),
    runLocalOcrBlob: async () => {
        throw new Error("Inference locale indisponible.");
    },
    runLocalTextOcrBlob: async () => {
        throw new Error("Inference locale indisponible.");
    },
    runLocalSuryaOcrBlob: async () => {
        throw new Error("Inference locale indisponible.");
    },
    runLocalSuryaBBoxOcrBlob: async () => {
        throw new Error("Inference locale indisponible.");
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
