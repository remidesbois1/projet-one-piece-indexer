"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

const INITIAL_MODEL_STATUS = {
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
};

const INITIAL_CONNECTION_STATE = {
    status: 'checking',
    failureCount: 0,
    lastOkAt: null,
    lastError: null
};

const TRANSIENT_DIAGNOSTIC_GRACE_MS = 15000;

function getErrorMessage(error) {
    return error?.message || String(error);
}

function getRejectedMessage(...results) {
    const rejected = results.find(result => result.status === 'rejected');
    return rejected ? getErrorMessage(rejected.reason) : null;
}

async function resolveTauriInvoke() {
    if (typeof window === 'undefined') return null;

    const { invoke, isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) return invoke;

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.__TAURI_INTERNALS__) {
            return invoke;
        }
    }

    return null;
}

async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return window.btoa(binary);
}

export function useTauriLocalOcr() {
    const invokeRef = useRef(null);
    const [isTauri, setIsTauri] = useState(false);
    const [isCheckingLocalConnection, setIsCheckingLocalConnection] = useState(true);
    const [localModelStatus, setLocalModelStatus] = useState(INITIAL_MODEL_STATUS);
    const [localTextModelStatus, setLocalTextModelStatus] = useState(INITIAL_MODEL_STATUS);
    const [localSuryaModelStatus, setLocalSuryaModelStatus] = useState(INITIAL_MODEL_STATUS);
    const [localHealth, setLocalHealth] = useState(null);
    const [isDownloadingLocalModel, setIsDownloadingLocalModel] = useState(false);
    const [isDownloadingLocalTextModel, setIsDownloadingLocalTextModel] = useState(false);
    const [isDownloadingLocalSuryaModel, setIsDownloadingLocalSuryaModel] = useState(false);
    const [isLoadingLocalModel, setIsLoadingLocalModel] = useState(false);
    const [isLoadingLocalTextModel, setIsLoadingLocalTextModel] = useState(false);
    const [isLoadingLocalSuryaModel, setIsLoadingLocalSuryaModel] = useState(false);
    const [isLocalInferencing, setIsLocalInferencing] = useState(false);
    const [isLocalTextInferencing, setIsLocalTextInferencing] = useState(false);
    const [isLocalSuryaInferencing, setIsLocalSuryaInferencing] = useState(false);
    const [localError, setLocalError] = useState(null);
    const [localConnectionState, setLocalConnectionState] = useState(INITIAL_CONNECTION_STATE);
    const diagnosticFailureCountRef = useRef(0);
    const lastDiagnosticOkAtRef = useRef(null);

    const getInvoke = useCallback(async () => {
        if (invokeRef.current) return invokeRef.current;

        setIsCheckingLocalConnection(true);
        try {
            const invoke = await resolveTauriInvoke();
            invokeRef.current = invoke;
            setIsTauri(Boolean(invoke));
            if (!invoke) {
                setLocalConnectionState({
                    status: 'unavailable',
                    failureCount: 0,
                    lastOkAt: null,
                    lastError: "App desktop non detectee ou API locale indisponible."
                });
            }
            return invoke;
        } finally {
            setIsCheckingLocalConnection(false);
        }
    }, []);

    const markDiagnosticsOnline = useCallback((health = null, status = null) => {
        const now = Date.now();
        const message = status?.error || health?.error || status?.download?.error || null;

        diagnosticFailureCountRef.current = 0;
        lastDiagnosticOkAtRef.current = now;
        setLocalConnectionState({
            status: message ? 'degraded' : 'online',
            failureCount: 0,
            lastOkAt: now,
            lastError: message
        });
        setLocalError(message);
    }, []);

    const markDiagnosticsFailure = useCallback((message) => {
        const now = Date.now();
        const lastOkAt = lastDiagnosticOkAtRef.current;
        const failureCount = diagnosticFailureCountRef.current + 1;
        const hasRecentSuccess = Boolean(lastOkAt && now - lastOkAt < TRANSIENT_DIAGNOSTIC_GRACE_MS);
        const isTransient = hasRecentSuccess || failureCount <= 2;

        diagnosticFailureCountRef.current = failureCount;

        if (hasRecentSuccess) {
            setLocalConnectionState(prev => {
                const previousStatus = prev?.status && !['checking', 'offline', 'unavailable'].includes(prev.status)
                    ? prev.status
                    : 'online';

                return {
                    status: previousStatus,
                    failureCount,
                    lastOkAt,
                    lastError: message
                };
            });
            return true;
        }

        setLocalConnectionState({
            status: isTransient ? 'reconnecting' : 'offline',
            failureCount,
            lastOkAt,
            lastError: message
        });
        setLocalError(message);

        setLocalHealth(prev => {
            if (isTransient) {
                return prev
                    ? { ...prev, transient_error: message }
                    : {
                        ok: false,
                        python_available: false,
                        torch_available: false,
                        cuda_available: null,
                        device: null,
                        error: message,
                        transient_error: message
                    };
            }

            return {
                ok: false,
                python_available: false,
                torch_available: false,
                cuda_available: null,
                device: null,
                error: message
            };
        });

        setLocalModelStatus(prev => isTransient
            ? { ...prev, error: message }
            : { ...INITIAL_MODEL_STATUS, error: message }
        );
        setLocalTextModelStatus(prev => isTransient
            ? { ...prev, error: message }
            : { ...INITIAL_MODEL_STATUS, error: message }
        );
        setLocalSuryaModelStatus(prev => isTransient
            ? { ...prev, error: message }
            : { ...INITIAL_MODEL_STATUS, error: message }
        );

        return isTransient;
    }, []);

    const refreshLocalModelStatus = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) return INITIAL_MODEL_STATUS;

        try {
            const status = await invoke('get_local_model_status');
            setLocalModelStatus(status);
            markDiagnosticsOnline(null, status);
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            markDiagnosticsFailure(message);
            return { ...INITIAL_MODEL_STATUS, error: message };
        }
    }, [getInvoke, markDiagnosticsFailure, markDiagnosticsOnline]);

    const refreshLocalTextModelStatus = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) return INITIAL_MODEL_STATUS;

        try {
            const status = await invoke('get_local_text_model_status');
            setLocalTextModelStatus(status);
            markDiagnosticsOnline(null, status);
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalTextModelStatus(prev => ({ ...prev, error: message }));
            return { ...INITIAL_MODEL_STATUS, error: message };
        }
    }, [getInvoke, markDiagnosticsOnline]);

    const refreshLocalSuryaModelStatus = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) return INITIAL_MODEL_STATUS;

        try {
            const status = await invoke('get_local_surya_model_status');
            setLocalSuryaModelStatus(status);
            markDiagnosticsOnline(null, status);
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalSuryaModelStatus(prev => ({ ...prev, error: message }));
            return { ...INITIAL_MODEL_STATUS, error: message };
        }
    }, [getInvoke, markDiagnosticsOnline]);

    const healthcheckLocalBackend = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) return null;

        try {
            const health = await invoke('healthcheck_local_backend');
            setLocalHealth(health);
            markDiagnosticsOnline(health, null);
            return health;
        } catch (error) {
            const message = getErrorMessage(error);
            markDiagnosticsFailure(message);
            return { ok: false, python_available: false, torch_available: false, error: message };
        }
    }, [getInvoke, markDiagnosticsFailure, markDiagnosticsOnline]);

    const refreshLocalDiagnostics = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "App desktop non detectee ou API locale indisponible.";
            const health = {
                ok: false,
                python_available: false,
                torch_available: false,
                cuda_available: null,
                device: null,
                error: message
            };
            const status = { ...INITIAL_MODEL_STATUS, error: message };
            setLocalHealth(health);
            setLocalModelStatus(status);
            setLocalTextModelStatus(status);
            setLocalSuryaModelStatus(status);
            setLocalError(message);
            setLocalConnectionState({
                status: 'unavailable',
                failureCount: 0,
                lastOkAt: null,
                lastError: message
            });
            return { health, status };
        }

        const [healthResult, statusResult, textStatusResult, suryaStatusResult] = await Promise.allSettled([
            invoke('healthcheck_local_backend'),
            invoke('get_local_model_status'),
            invoke('get_local_text_model_status'),
            invoke('get_local_surya_model_status')
        ]);

        const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
        const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
        const textStatus = textStatusResult.status === 'fulfilled' ? textStatusResult.value : null;
        const suryaStatus = suryaStatusResult.status === 'fulfilled' ? suryaStatusResult.value : null;

        if (health || status || textStatus || suryaStatus) {
            if (health) setLocalHealth(health);
            if (status) setLocalModelStatus(status);
            if (textStatus) setLocalTextModelStatus(textStatus);
            if (suryaStatus) setLocalSuryaModelStatus(suryaStatus);
            const partialError = getRejectedMessage(healthResult, statusResult, textStatusResult, suryaStatusResult);
            markDiagnosticsOnline(health, status || textStatus || suryaStatus);
            if (partialError) {
                setLocalConnectionState(prev => ({ ...prev, lastError: partialError }));
                if (!textStatus) setLocalTextModelStatus(prev => ({ ...prev, error: partialError }));
                if (!suryaStatus) setLocalSuryaModelStatus(prev => ({ ...prev, error: partialError }));
            }
            return { health, status, textStatus, suryaStatus };
        }

        try {
            const message = getRejectedMessage(healthResult, statusResult, textStatusResult, suryaStatusResult) || "Diagnostic OCR local indisponible.";
            throw new Error(message);
        } catch (error) {
            const message = getErrorMessage(error);
            markDiagnosticsFailure(message);
            const health = { ok: false, python_available: false, torch_available: false, cuda_available: null, device: null, error: message };
            const status = { ...INITIAL_MODEL_STATUS, error: message };
            const textStatus = { ...INITIAL_MODEL_STATUS, error: message };
            const suryaStatus = { ...INITIAL_MODEL_STATUS, error: message };
            return { health, status, textStatus, suryaStatus };
        }
    }, [getInvoke, markDiagnosticsFailure, markDiagnosticsOnline]);

    const downloadLocalModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ok: false, error: message };
        }

        setIsDownloadingLocalModel(true);
        setLocalError(null);
        try {
            const result = await invoke('download_local_model');
            if (!result?.ok) {
                setLocalError(result?.error || "Telechargement du modele local impossible.");
            }
            if (result?.download) {
                setLocalModelStatus(prev => ({ ...prev, download: result.download }));
            }
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            return { ok: false, error: message };
        } finally {
            setIsDownloadingLocalModel(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    const downloadLocalTextModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ok: false, error: message };
        }

        setIsDownloadingLocalTextModel(true);
        setLocalError(null);
        try {
            const result = await invoke('download_local_text_model');
            if (!result?.ok) {
                setLocalError(result?.error || "Telechargement du modele Poneglyph local impossible.");
            }
            if (result?.download) {
                setLocalTextModelStatus(prev => ({ ...prev, download: result.download }));
            }
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            return { ok: false, error: message };
        } finally {
            setIsDownloadingLocalTextModel(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    const downloadLocalSuryaModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ok: false, error: message };
        }

        setIsDownloadingLocalSuryaModel(true);
        setLocalError(null);
        try {
            const result = await invoke('download_local_surya_model');
            if (!result?.ok) {
                setLocalError(result?.error || "Telechargement du modele Surya local impossible.");
            }
            if (result?.download) {
                setLocalSuryaModelStatus(prev => ({ ...prev, download: result.download }));
            }
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            return { ok: false, error: message };
        } finally {
            setIsDownloadingLocalSuryaModel(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    const loadLocalModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ...INITIAL_MODEL_STATUS, error: message };
        }

        setIsLoadingLocalModel(true);
        setLocalError(null);
        setLocalModelStatus(prev => ({ ...prev, loading: true, error: null }));
        try {
            const status = await invoke('load_local_model');
            setLocalModelStatus(status);
            markDiagnosticsOnline(null, status);
            await refreshLocalDiagnostics();
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            setLocalModelStatus(prev => ({ ...prev, loaded: false, loading: false, ready: false, error: message }));
            return { ...INITIAL_MODEL_STATUS, error: message };
        } finally {
            setIsLoadingLocalModel(false);
        }
    }, [getInvoke, markDiagnosticsOnline, refreshLocalDiagnostics]);

    const loadLocalTextModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ...INITIAL_MODEL_STATUS, error: message };
        }

        setIsLoadingLocalTextModel(true);
        setLocalError(null);
        setLocalTextModelStatus(prev => ({ ...prev, loading: true, error: null }));
        try {
            const status = await invoke('load_local_text_model');
            setLocalTextModelStatus(status);
            markDiagnosticsOnline(null, status);
            await refreshLocalDiagnostics();
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            setLocalTextModelStatus(prev => ({ ...prev, loaded: false, loading: false, ready: false, error: message }));
            return { ...INITIAL_MODEL_STATUS, error: message };
        } finally {
            setIsLoadingLocalTextModel(false);
        }
    }, [getInvoke, markDiagnosticsOnline, refreshLocalDiagnostics]);

    const loadLocalSuryaModel = useCallback(async () => {
        const invoke = await getInvoke();
        if (!invoke) {
            const message = "Tauri indisponible.";
            setLocalError(message);
            return { ...INITIAL_MODEL_STATUS, error: message };
        }

        setIsLoadingLocalSuryaModel(true);
        setLocalError(null);
        setLocalSuryaModelStatus(prev => ({ ...prev, loading: true, error: null }));
        try {
            const status = await invoke('load_local_surya_model');
            setLocalSuryaModelStatus(status);
            markDiagnosticsOnline(null, status);
            await refreshLocalDiagnostics();
            return status;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            setLocalSuryaModelStatus(prev => ({ ...prev, loaded: false, loading: false, ready: false, error: message }));
            return { ...INITIAL_MODEL_STATUS, error: message };
        } finally {
            setIsLoadingLocalSuryaModel(false);
        }
    }, [getInvoke, markDiagnosticsOnline, refreshLocalDiagnostics]);

    const runLocalOcrBlob = useCallback(async (blob) => {
        const invoke = await getInvoke();
        if (!invoke) throw new Error("Tauri indisponible.");

        setIsLocalInferencing(true);
        setLocalError(null);
        try {
            const image_bytes_base64 = await blobToBase64(blob);
            const result = await invoke('run_local_ocr', { image_bytes_base64 });
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            throw new Error(message);
        } finally {
            setIsLocalInferencing(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    const runLocalTextOcrBlob = useCallback(async (blob) => {
        const invoke = await getInvoke();
        if (!invoke) throw new Error("Tauri indisponible.");

        setIsLocalTextInferencing(true);
        setLocalError(null);
        try {
            const image_bytes_base64 = await blobToBase64(blob);
            const result = await invoke('run_local_text_ocr', { image_bytes_base64 });
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            throw new Error(message);
        } finally {
            setIsLocalTextInferencing(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    const runLocalSuryaOcrBlob = useCallback(async (blob) => {
        const invoke = await getInvoke();
        if (!invoke) throw new Error("Tauri indisponible.");

        setIsLocalSuryaInferencing(true);
        setLocalError(null);
        try {
            const image_bytes_base64 = await blobToBase64(blob);
            const result = await invoke('run_local_surya_ocr', { image_bytes_base64 });
            await refreshLocalDiagnostics();
            return result;
        } catch (error) {
            const message = getErrorMessage(error);
            setLocalError(message);
            throw new Error(message);
        } finally {
            setIsLocalSuryaInferencing(false);
        }
    }, [getInvoke, refreshLocalDiagnostics]);

    useEffect(() => {
        let cancelled = false;

        async function init() {
            const invoke = await getInvoke();
            if (!invoke || cancelled) return;
            await refreshLocalDiagnostics();
        }

        init();
        return () => {
            cancelled = true;
        };
    }, [getInvoke, refreshLocalDiagnostics]);

    useEffect(() => {
        if (!isTauri) return undefined;

        const intervalId = window.setInterval(() => {
            refreshLocalDiagnostics();
        }, localModelStatus?.download?.active || localTextModelStatus?.download?.active || localSuryaModelStatus?.download?.active || isLoadingLocalModel || isLoadingLocalTextModel || isLoadingLocalSuryaModel || isLocalInferencing || isLocalTextInferencing || isLocalSuryaInferencing ? 2000 : 5000);

        return () => window.clearInterval(intervalId);
    }, [isTauri, isLoadingLocalModel, isLoadingLocalTextModel, isLoadingLocalSuryaModel, isLocalInferencing, isLocalTextInferencing, isLocalSuryaInferencing, localModelStatus?.download?.active, localTextModelStatus?.download?.active, localSuryaModelStatus?.download?.active, refreshLocalDiagnostics]);

    const localDownloadState = localModelStatus?.download || null;
    const localDownloadProgress = localDownloadState?.total_bytes
        ? Math.min(100, (Number(localDownloadState.downloaded_bytes || 0) / Number(localDownloadState.total_bytes)) * 100)
        : null;
    const isLocalDownloadActive = Boolean(isDownloadingLocalModel || localDownloadState?.active);
    const localTextDownloadState = localTextModelStatus?.download || null;
    const localTextDownloadProgress = localTextDownloadState?.total_bytes
        ? Math.min(100, (Number(localTextDownloadState.downloaded_bytes || 0) / Number(localTextDownloadState.total_bytes)) * 100)
        : null;
    const isLocalTextDownloadActive = Boolean(isDownloadingLocalTextModel || localTextDownloadState?.active);
    const localSuryaDownloadState = localSuryaModelStatus?.download || null;
    const localSuryaDownloadProgress = localSuryaDownloadState?.total_bytes
        ? Math.min(100, (Number(localSuryaDownloadState.downloaded_bytes || 0) / Number(localSuryaDownloadState.total_bytes)) * 100)
        : null;
    const isLocalSuryaDownloadActive = Boolean(isDownloadingLocalSuryaModel || localSuryaDownloadState?.active);

    const canRunLocalOcr = Boolean(
        isTauri &&
        localConnectionState.status !== 'offline' &&
        localModelStatus?.ready &&
        localModelStatus?.loaded &&
        !localModelStatus?.loading &&
        !isLoadingLocalModel &&
        !isLocalDownloadActive &&
        !isLocalInferencing &&
        !isLocalTextInferencing &&
        !isLocalSuryaInferencing
    );

    const canRunLocalTextOcr = Boolean(
        isTauri &&
        localConnectionState.status !== 'offline' &&
        localTextModelStatus?.ready &&
        localTextModelStatus?.loaded &&
        !localTextModelStatus?.loading &&
        !isLoadingLocalTextModel &&
        !isLocalTextDownloadActive &&
        !isLocalTextInferencing &&
        !isLocalInferencing &&
        !isLocalSuryaInferencing
    );

    const canRunLocalSuryaOcr = Boolean(
        isTauri &&
        localConnectionState.status !== 'offline' &&
        localSuryaModelStatus?.ready &&
        localSuryaModelStatus?.loaded &&
        !localSuryaModelStatus?.loading &&
        !isLoadingLocalSuryaModel &&
        !isLocalSuryaDownloadActive &&
        !isLocalSuryaInferencing &&
        !isLocalInferencing &&
        !isLocalTextInferencing
    );

    return {
        isTauri,
        isCheckingLocalConnection,
        localModelStatus,
        localTextModelStatus,
        localSuryaModelStatus,
        localHealth,
        localConnectionState,
        isDownloadingLocalModel: isLocalDownloadActive,
        isDownloadingLocalTextModel: isLocalTextDownloadActive,
        isDownloadingLocalSuryaModel: isLocalSuryaDownloadActive,
        localDownloadState,
        localTextDownloadState,
        localSuryaDownloadState,
        localDownloadProgress,
        localTextDownloadProgress,
        localSuryaDownloadProgress,
        isLoadingLocalModel,
        isLoadingLocalTextModel,
        isLoadingLocalSuryaModel,
        isLocalInferencing,
        isLocalTextInferencing,
        isLocalSuryaInferencing,
        localError,
        canRunLocalOcr,
        canRunLocalTextOcr,
        canRunLocalSuryaOcr,
        refreshLocalModelStatus,
        refreshLocalTextModelStatus,
        refreshLocalSuryaModelStatus,
        healthcheckLocalBackend,
        refreshLocalDiagnostics,
        downloadLocalModel,
        downloadLocalTextModel,
        downloadLocalSuryaModel,
        loadLocalModel,
        loadLocalTextModel,
        loadLocalSuryaModel,
        runLocalOcrBlob,
        runLocalTextOcrBlob,
        runLocalSuryaOcrBlob
    };
}
