"use client";

import React from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2, RefreshCw, Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';

function formatBytes(value) {
    if (!value) return "-";
    const units = ["B", "KB", "MB", "GB"];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function boolLabel(value) {
    return value === true ? "Oui" : value === false ? "Non" : "-";
}

function timeLabel(value) {
    if (!value) return "-";
    return new Date(value).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function modelStateLabel(status, loaded) {
    if (status?.ready) return "Pret";
    if (status?.loading) return "Chargement";
    if (loaded || status?.loaded) return "Charge";
    if (status?.installed) return "Installe";
    return "Absent";
}

function DetailRow({ label, value, valueClassName }) {
    return (
        <div className="flex items-center justify-between gap-3 text-[11px] font-semibold leading-tight">
            <span className="text-slate-500">{label}</span>
            <span className={cn("min-w-0 truncate text-right font-bold text-slate-800", valueClassName)} title={String(value ?? "-")}>
                {value ?? "-"}
            </span>
        </div>
    );
}

export default function LocalOcrStatusIndicator() {
    const {
        isTauri,
        isCheckingLocalConnection,
        localModelStatus,
        localTextModelStatus,
        localHealth,
        localConnectionState,
        isDownloadingLocalModel,
        isDownloadingLocalTextModel,
        localDownloadState,
        localTextDownloadState,
        localDownloadProgress,
        localTextDownloadProgress,
        isLoadingLocalModel,
        isLoadingLocalTextModel,
        localError,
        downloadLocalModel,
        downloadLocalTextModel,
        loadLocalModel,
        loadLocalTextModel,
        refreshLocalDiagnostics
    } = useTauriLocalOcrContext();

    if (!isTauri) return null;

    const connectionStatus = localConnectionState?.status || (isCheckingLocalConnection ? 'checking' : 'unknown');
    const localLoaded = Boolean(localModelStatus?.loaded || localHealth?.model_loaded);
    const textLoaded = Boolean(localTextModelStatus?.loaded || localHealth?.models?.base?.loaded);
    const bboxDownloadActive = Boolean(isDownloadingLocalModel || localDownloadState?.active || localModelStatus?.download?.active);
    const textDownloadActive = Boolean(isDownloadingLocalTextModel || localTextDownloadState?.active || localTextModelStatus?.download?.active);
    const downloadActive = Boolean(bboxDownloadActive || textDownloadActive);
    const downloadPercent = Number.isFinite(localDownloadProgress) ? Math.round(localDownloadProgress) : null;
    const textDownloadPercent = Number.isFinite(localTextDownloadProgress) ? Math.round(localTextDownloadProgress) : null;
    const localDevice = localHealth?.device || localModelStatus?.device;
    const memoryLabel = localHealth?.gpu_memory_total_mb
        ? `${localHealth.gpu_memory_allocated_mb ?? 0}/${localHealth.gpu_memory_total_mb} MB`
        : "-";
    const downloadBytesLabel = localDownloadState?.total_bytes
        ? `${formatBytes(localDownloadState.downloaded_bytes)} / ${formatBytes(localDownloadState.total_bytes)}`
        : formatBytes(localDownloadState?.downloaded_bytes);
    const textDownloadBytesLabel = localTextDownloadState?.total_bytes
        ? `${formatBytes(localTextDownloadState.downloaded_bytes)} / ${formatBytes(localTextDownloadState.total_bytes)}`
        : formatBytes(localTextDownloadState?.downloaded_bytes);

    const summaryLabel = isCheckingLocalConnection
        ? "Connexion"
        : connectionStatus === 'reconnecting'
            ? "Reconnexion"
            : connectionStatus === 'offline'
                ? "Hors ligne"
                : downloadActive
                    ? `Telechargement${downloadPercent !== null || textDownloadPercent !== null ? ` ${downloadPercent ?? textDownloadPercent}%` : ""}`
                    : localModelStatus?.loading || localTextModelStatus?.loading || isLoadingLocalModel || isLoadingLocalTextModel
                        ? "Chargement"
                        : localModelStatus?.ready && localTextModelStatus?.ready
                            ? "Batch pret"
                            : localModelStatus?.ready
                                ? "BBox pret"
                                : localTextModelStatus?.ready
                                    ? "Poneglyph pret"
                                    : localLoaded || textLoaded
                                        ? "Charge"
                                        : localModelStatus?.installed || localTextModelStatus?.installed
                                            ? "Installe"
                                            : "Modeles absents";

    const tone = connectionStatus === 'offline'
        ? 'red'
        : connectionStatus === 'reconnecting' || connectionStatus === 'degraded'
            ? 'amber'
            : downloadActive || isLoadingLocalModel || isLoadingLocalTextModel || localModelStatus?.loading || localTextModelStatus?.loading
                ? 'blue'
                : localModelStatus?.ready || localTextModelStatus?.ready
                    ? 'emerald'
                    : 'slate';

    const toneClass = {
        emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
        blue: "border-blue-200 bg-blue-50 text-blue-700",
        amber: "border-amber-200 bg-amber-50 text-amber-700",
        red: "border-red-200 bg-red-50 text-red-700",
        slate: "border-slate-200 bg-slate-50 text-slate-600"
    }[tone];

    const dotClass = {
        emerald: "bg-emerald-500",
        blue: "bg-blue-500",
        amber: "bg-amber-500",
        red: "bg-red-500",
        slate: "bg-slate-400"
    }[tone];

    const canDownload = !localModelStatus?.installed && !bboxDownloadActive;
    const canLoad = localModelStatus?.installed && !localModelStatus?.ready && !isLoadingLocalModel && !bboxDownloadActive;
    const canDownloadText = !localTextModelStatus?.installed && !textDownloadActive;
    const canLoadText = localTextModelStatus?.installed && !localTextModelStatus?.ready && !isLoadingLocalTextModel && !textDownloadActive;

    return (
        <div className="group relative hidden sm:block">
            <button
                type="button"
                className={cn(
                    "relative inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
                    toneClass
                )}
                aria-label="Etat OCR local"
            >
                {downloadActive || isLoadingLocalModel || isLoadingLocalTextModel || localModelStatus?.loading || localTextModelStatus?.loading ? (
                    <Loader2 size={15} className="animate-spin" />
                ) : (
                    <Cpu size={15} />
                )}
                <span className={cn("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white", dotClass)} />
            </button>

            <div className="pointer-events-none absolute left-0 top-full hidden w-[360px] pt-2 group-hover:block group-focus-within:block group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
                <div className="rounded-lg border border-slate-200 bg-white p-3 text-slate-900 shadow-xl">
                    <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-900">
                                <Server size={14} />
                                OCR local
                            </div>
                            <div className="mt-1 truncate text-[11px] font-semibold text-slate-500">
                                {localDevice ? `${summaryLabel} - ${String(localDevice).toUpperCase()}` : summaryLabel}
                            </div>
                        </div>
                        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase", toneClass)}>
                            {connectionStatus === 'reconnecting' ? "Reconnexion" : connectionStatus === 'offline' ? "Hors ligne" : localHealth?.ok ? "Serveur OK" : "Diagnostic"}
                        </span>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                        <DetailRow label="BBox" value={modelStateLabel(localModelStatus, localLoaded)} valueClassName={localModelStatus?.ready ? "text-emerald-700" : ""} />
                        <DetailRow label="Poneglyph" value={modelStateLabel(localTextModelStatus, textLoaded)} valueClassName={localTextModelStatus?.ready ? "text-emerald-700" : ""} />
                        <DetailRow label="CUDA" value={boolLabel(localHealth?.cuda_available)} valueClassName={localHealth?.cuda_available ? "text-emerald-700" : ""} />
                        <DetailRow label="Torch" value={boolLabel(localHealth?.torch_available)} />
                        <DetailRow label="VRAM" value={memoryLabel} />
                        <DetailRow label="Dtype" value={localModelStatus?.dtype || localTextModelStatus?.dtype || "-"} />
                        <DetailRow label="Dernier OK" value={timeLabel(localConnectionState?.lastOkAt)} />
                        <DetailRow label="Port local" value={localHealth?.port || "-"} />
                    </div>

                    {(localHealth?.gpu_name || localHealth?.torch_version || localHealth?.cuda_version) && (
                        <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-[11px] font-semibold text-slate-500">
                            {localHealth?.gpu_name && <div className="truncate" title={localHealth.gpu_name}>GPU: <span className="font-bold text-slate-800">{localHealth.gpu_name}</span></div>}
                            {localHealth?.torch_version && <div>Torch build: <span className="font-bold text-slate-800">{localHealth.torch_version}</span></div>}
                            {localHealth?.cuda_version && <div>CUDA build: <span className="font-bold text-slate-800">{localHealth.cuda_version}</span></div>}
                        </div>
                    )}

                    {(bboxDownloadActive || localDownloadState?.downloaded_bytes || localDownloadState?.error) && (
                        <div className="mt-3 border-t border-slate-100 pt-2">
                            <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-slate-600">
                                <span>Telechargement BBox</span>
                                <span>{downloadPercent !== null ? `${downloadPercent}%` : downloadBytesLabel}</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                                <div
                                    className={cn("h-full rounded-full transition-all", localDownloadState?.error ? "bg-amber-500" : "bg-emerald-500", downloadPercent === null && bboxDownloadActive && "animate-pulse")}
                                    style={{ width: `${downloadPercent ?? (bboxDownloadActive ? 35 : 100)}%` }}
                                />
                            </div>
                            {downloadPercent !== null && (
                                <div className="mt-1 text-[10px] font-semibold text-slate-400">{downloadBytesLabel}</div>
                            )}
                        </div>
                    )}

                    {(textDownloadActive || localTextDownloadState?.downloaded_bytes || localTextDownloadState?.error) && (
                        <div className="mt-3 border-t border-slate-100 pt-2">
                            <div className="mb-1 flex items-center justify-between text-[11px] font-bold text-slate-600">
                                <span>Telechargement Poneglyph</span>
                                <span>{textDownloadPercent !== null ? `${textDownloadPercent}%` : textDownloadBytesLabel}</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                                <div
                                    className={cn("h-full rounded-full transition-all", localTextDownloadState?.error ? "bg-amber-500" : "bg-emerald-500", textDownloadPercent === null && textDownloadActive && "animate-pulse")}
                                    style={{ width: `${textDownloadPercent ?? (textDownloadActive ? 35 : 100)}%` }}
                                />
                            </div>
                            {textDownloadPercent !== null && (
                                <div className="mt-1 text-[10px] font-semibold text-slate-400">{textDownloadBytesLabel}</div>
                            )}
                        </div>
                    )}

                    {localError && (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-semibold leading-snug text-amber-800">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                            <span className="break-words">{localError}</span>
                        </div>
                    )}

                    <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                        <button
                            type="button"
                            onClick={refreshLocalDiagnostics}
                            disabled={isCheckingLocalConnection}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                            <RefreshCw size={12} className={cn(isCheckingLocalConnection && "animate-spin")} />
                            Actualiser
                        </button>
                        {canDownload && (
                            <button
                                type="button"
                                onClick={downloadLocalModel}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-2 text-[11px] font-bold text-white hover:bg-slate-800"
                            >
                                <Download size={12} />
                                BBox
                            </button>
                        )}
                        {canLoad && (
                            <button
                                type="button"
                                onClick={loadLocalModel}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700"
                            >
                                <CheckCircle2 size={12} />
                                Charger BBox
                            </button>
                        )}
                        {canDownloadText && (
                            <button
                                type="button"
                                onClick={downloadLocalTextModel}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-2 text-[11px] font-bold text-white hover:bg-slate-800"
                            >
                                <Download size={12} />
                                Poneglyph
                            </button>
                        )}
                        {canLoadText && (
                            <button
                                type="button"
                                onClick={loadLocalTextModel}
                                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700"
                            >
                                <CheckCircle2 size={12} />
                                Charger Poneglyph
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
