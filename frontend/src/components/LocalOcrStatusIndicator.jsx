"use client";

import React from 'react';
import {
    Activity,
    AlertTriangle,
    Bot,
    CheckCircle2,
    Cpu,
    Database,
    Download,
    Gauge,
    HardDrive,
    Loader2,
    RefreshCw,
    Server,
    Wifi,
    Zap
} from 'lucide-react';
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
    if (status?.error) return "Erreur";
    return "Absent";
}

function modelTone(status, loaded) {
    if (status?.ready) return "ready";
    if (status?.loading) return "busy";
    if (status?.error) return "error";
    if (loaded || status?.loaded || status?.installed) return "idle";
    return "missing";
}

function toneClasses(tone) {
    return {
        ready: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
        busy: "border-sky-500/40 bg-sky-500/10 text-sky-300",
        error: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        idle: "border-slate-600 bg-slate-700/40 text-slate-300",
        missing: "border-slate-700 bg-slate-800/60 text-slate-500"
    }[tone];
}

function ModelRow({ label, status, loaded, icon: Icon }) {
    const tone = modelTone(status, loaded);
    const stateLabel = modelStateLabel(status, loaded);
    return (
        <div className={cn("flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2", toneClasses(tone))}>
            <Icon size={14} className="shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-bold uppercase tracking-wide">{label}</div>
                <div className="truncate text-[10px] font-medium opacity-75">
                    {status?.device ? String(status.device).toUpperCase() : status?.dtype || status?.error || "Local"}
                </div>
            </div>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide">{stateLabel}</span>
        </div>
    );
}

function StatTile({ icon: Icon, label, value, tone = "zinc" }) {
    const color = {
        emerald: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
        sky: "text-sky-300 border-sky-500/40 bg-sky-500/10",
        amber: "text-amber-300 border-amber-500/40 bg-amber-500/10",
        zinc: "text-slate-200 border-slate-600 bg-slate-700/40"
    }[tone];
    return (
        <div className={cn("min-w-0 rounded-md border px-2.5 py-2", color)}>
            <div className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide opacity-70">
                <Icon size={11} />
                {label}
            </div>
            <div className="truncate text-[11px] font-bold" title={String(value ?? "-")}>{value ?? "-"}</div>
        </div>
    );
}

function ProgressLine({ label, active, state, percent }) {
    if (!active && !state?.downloaded_bytes && !state?.error) return null;

    const safePercent = Number.isFinite(percent) ? Math.round(percent) : null;
    const bytesLabel = state?.total_bytes
        ? `${formatBytes(state.downloaded_bytes)} / ${formatBytes(state.total_bytes)}`
        : formatBytes(state?.downloaded_bytes);

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-[10px] font-bold text-slate-300">
                <span className="truncate">{label}</span>
                <span className="shrink-0 text-slate-400">{safePercent !== null ? `${safePercent}%` : bytesLabel}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                <div
                    className={cn("h-full rounded-full transition-all", state?.error ? "bg-amber-500" : "bg-emerald-500", safePercent === null && active && "animate-pulse")}
                    style={{ width: `${safePercent ?? (active ? 35 : 100)}%` }}
                />
            </div>
            {safePercent !== null && <div className="truncate text-[9px] font-semibold text-slate-400">{bytesLabel}</div>}
        </div>
    );
}

function ActionButton({ children, onClick, variant = "dark", disabled = false }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-[11px] font-bold transition-colors disabled:pointer-events-none disabled:opacity-50",
                variant === "green"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                    : "border-slate-600 bg-slate-700/50 text-slate-200 hover:bg-slate-700"
            )}
        >
            {children}
        </button>
    );
}

function SectionLabel({ children }) {
    return (
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{children}</div>
    );
}

export default function LocalOcrStatusIndicator() {
    const {
        isTauri,
        isCheckingLocalConnection,
        localModelStatus,
        localTextModelStatus,
        localSuryaModelStatus,
        localSuryaBBoxModelStatus,
        localHealth,
        localConnectionState,
        isDownloadingLocalModel,
        isDownloadingLocalTextModel,
        isDownloadingLocalSuryaModel,
        isDownloadingLocalSuryaBBoxModel,
        localDownloadState,
        localTextDownloadState,
        localSuryaDownloadState,
        localSuryaBBoxDownloadState,
        localDownloadProgress,
        localTextDownloadProgress,
        localSuryaDownloadProgress,
        localSuryaBBoxDownloadProgress,
        isLoadingLocalModel,
        isLoadingLocalTextModel,
        isLoadingLocalSuryaModel,
        isLoadingLocalSuryaBBoxModel,
        localError,
        downloadLocalModel,
        downloadLocalTextModel,
        downloadLocalSuryaModel,
        downloadLocalSuryaBBoxModel,
        loadLocalModel,
        loadLocalTextModel,
        loadLocalSuryaModel,
        loadLocalSuryaBBoxModel,
        refreshLocalDiagnostics
    } = useTauriLocalOcrContext();

    if (!isTauri) return null;

    const connectionStatus = localConnectionState?.status || (isCheckingLocalConnection ? 'checking' : 'unknown');
    const bboxLoaded = Boolean(localModelStatus?.loaded || localHealth?.models?.bbox?.loaded || localHealth?.model_loaded);
    const textLoaded = Boolean(localTextModelStatus?.loaded || localHealth?.models?.base?.loaded);
    const suryaLoaded = Boolean(localSuryaModelStatus?.loaded || localHealth?.models?.surya?.loaded);
    const suryaBBoxLoaded = Boolean(localSuryaBBoxModelStatus?.loaded || localHealth?.models?.surya_bbox?.loaded);

    const bboxDownloadActive = Boolean(isDownloadingLocalModel || localDownloadState?.active || localModelStatus?.download?.active);
    const textDownloadActive = Boolean(isDownloadingLocalTextModel || localTextDownloadState?.active || localTextModelStatus?.download?.active);
    const suryaDownloadActive = Boolean(isDownloadingLocalSuryaModel || localSuryaDownloadState?.active || localSuryaModelStatus?.download?.active);
    const suryaBBoxDownloadActive = Boolean(isDownloadingLocalSuryaBBoxModel || localSuryaBBoxDownloadState?.active || localSuryaBBoxModelStatus?.download?.active);
    const downloadActive = Boolean(bboxDownloadActive || textDownloadActive || suryaDownloadActive || suryaBBoxDownloadActive);
    const loadingActive = Boolean(
        isLoadingLocalModel ||
        isLoadingLocalTextModel ||
        isLoadingLocalSuryaModel ||
        isLoadingLocalSuryaBBoxModel ||
        localModelStatus?.loading ||
        localTextModelStatus?.loading ||
        localSuryaModelStatus?.loading ||
        localSuryaBBoxModelStatus?.loading
    );

    const downloadPercent = Number.isFinite(localDownloadProgress) ? Math.round(localDownloadProgress) : null;
    const textDownloadPercent = Number.isFinite(localTextDownloadProgress) ? Math.round(localTextDownloadProgress) : null;
    const suryaDownloadPercent = Number.isFinite(localSuryaDownloadProgress) ? Math.round(localSuryaDownloadProgress) : null;
    const suryaBBoxDownloadPercent = Number.isFinite(localSuryaBBoxDownloadProgress) ? Math.round(localSuryaBBoxDownloadProgress) : null;

    const localDevice = localHealth?.device || localModelStatus?.device || localTextModelStatus?.device || localSuryaModelStatus?.device || localSuryaBBoxModelStatus?.device;
    const deviceLabel = localDevice
        ? String(localDevice).toUpperCase()
        : localHealth?.cuda_available
            ? "CUDA"
            : localHealth?.mps_available
                ? "MPS"
                : "CPU";
    const requestedBackend = localHealth?.requested_backend || localModelStatus?.requested_backend || localTextModelStatus?.requested_backend || localSuryaModelStatus?.requested_backend || localSuryaBBoxModelStatus?.requested_backend || "-";
    const activeBackend = localHealth?.active_backend || localModelStatus?.active_backend || localTextModelStatus?.active_backend || localSuryaModelStatus?.active_backend || localSuryaBBoxModelStatus?.active_backend || "-";
    const dtypeLabel = localSuryaModelStatus?.dtype || localSuryaBBoxModelStatus?.dtype || localModelStatus?.dtype || localTextModelStatus?.dtype || "-";
    const memoryLabel = localHealth?.gpu_memory_total_mb
        ? `${localHealth.gpu_memory_allocated_mb ?? 0}/${localHealth.gpu_memory_total_mb} MB`
        : "-";

    const firstDownloadPercent = downloadPercent ?? textDownloadPercent ?? suryaDownloadPercent ?? suryaBBoxDownloadPercent;
    let summaryLabel = "Modeles absents";
    if (isCheckingLocalConnection) {
        summaryLabel = "Connexion";
    } else if (connectionStatus === 'reconnecting') {
        summaryLabel = "Reconnexion";
    } else if (connectionStatus === 'offline') {
        summaryLabel = "Hors ligne";
    } else if (downloadActive) {
        summaryLabel = `Telechargement${firstDownloadPercent !== null ? ` ${firstDownloadPercent}%` : ""}`;
    } else if (loadingActive) {
        summaryLabel = "Chargement";
    } else if (localSuryaModelStatus?.ready) {
        summaryLabel = "Surya pret";
    } else if (localSuryaBBoxModelStatus?.ready) {
        summaryLabel = "Surya-BBox pret";
    } else if (localModelStatus?.ready && localTextModelStatus?.ready) {
        summaryLabel = "Batch pret";
    } else if (localModelStatus?.ready) {
        summaryLabel = "Poneglyph-BBox pret";
    } else if (localTextModelStatus?.ready) {
        summaryLabel = "Poneglyph pret";
    } else if (bboxLoaded || textLoaded || suryaLoaded || suryaBBoxLoaded) {
        summaryLabel = "Charge";
    } else if (localModelStatus?.installed || localTextModelStatus?.installed || localSuryaModelStatus?.installed || localSuryaBBoxModelStatus?.installed) {
        summaryLabel = "Installe";
    }

    const isOnline = ['online', 'degraded'].includes(connectionStatus);
    const isBusy = downloadActive || loadingActive || connectionStatus === 'checking' || connectionStatus === 'reconnecting';
    const statusTone = connectionStatus === 'offline'
        ? 'error'
        : connectionStatus === 'reconnecting' || connectionStatus === 'degraded'
            ? 'busy'
            : localModelStatus?.ready || localTextModelStatus?.ready || localSuryaModelStatus?.ready || localSuryaBBoxModelStatus?.ready
                ? 'ready'
                : 'idle';
    const statusDot = {
        ready: "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.85)]",
        busy: "bg-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.75)]",
        error: "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.75)]",
        idle: "bg-zinc-500"
    }[statusTone];
    const connectionBadge = connectionStatus === 'reconnecting'
        ? "Reconnexion"
        : connectionStatus === 'offline'
            ? "Hors ligne"
            : localHealth?.ok || isOnline
                ? "Serveur OK"
                : "Diagnostic";

    const canDownload = !localModelStatus?.installed && !bboxDownloadActive;
    const canLoad = localModelStatus?.installed && !localModelStatus?.ready && !isLoadingLocalModel && !bboxDownloadActive;
    const canDownloadText = !localTextModelStatus?.installed && !textDownloadActive;
    const canLoadText = localTextModelStatus?.installed && !localTextModelStatus?.ready && !isLoadingLocalTextModel && !textDownloadActive;
    const canDownloadSurya = !localSuryaModelStatus?.installed && !suryaDownloadActive;
    const canLoadSurya = localSuryaModelStatus?.installed && !localSuryaModelStatus?.ready && !isLoadingLocalSuryaModel && !suryaDownloadActive;
    const canDownloadSuryaBBox = !localSuryaBBoxModelStatus?.error && !localSuryaBBoxModelStatus?.installed && !suryaBBoxDownloadActive;
    const canLoadSuryaBBox = !localSuryaBBoxModelStatus?.error && localSuryaBBoxModelStatus?.installed && !localSuryaBBoxModelStatus?.ready && !isLoadingLocalSuryaBBoxModel && !suryaBBoxDownloadActive;

    return (
        <div className="group relative hidden sm:block">
            <button
                type="button"
                className={cn(
                    "relative inline-flex h-8 max-w-[220px] items-center gap-2 rounded-full border px-2.5 text-left transition-colors",
                    statusTone === 'ready'
                        ? "border-emerald-500/50 bg-slate-800 text-emerald-300 hover:bg-slate-700"
                        : statusTone === 'busy'
                            ? "border-sky-500/50 bg-slate-800 text-sky-300 hover:bg-slate-700"
                            : statusTone === 'error'
                                ? "border-amber-500/50 bg-slate-800 text-amber-300 hover:bg-slate-700"
                                : "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
                )}
                aria-label="Etat OCR local"
                title={`OCR local - ${summaryLabel} - ${deviceLabel}`}
            >
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", statusDot)} />
                {isBusy ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Cpu size={14} className="shrink-0" />}
                <span className="hidden min-w-0 flex-col leading-none xl:flex">
                    <span className="truncate text-[10px] font-bold uppercase tracking-wide">OCR local</span>
                    <span className="truncate text-[9px] font-semibold opacity-80">{summaryLabel}</span>
                </span>
            </button>

            <div className="pointer-events-none absolute left-0 top-full hidden w-[420px] pt-2 group-hover:block group-focus-within:block group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
                <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl shadow-black/40 ring-1 ring-black/20">
                    <div className="border-b border-slate-800 px-4 py-3">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                                    <Server size={13} />
                                    OCR local
                                </div>
                                <div className="mt-1 truncate text-lg font-bold tracking-tight text-slate-100">
                                    {summaryLabel} - {deviceLabel}
                                </div>
                            </div>
                            <span className={cn("shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide", toneClasses(statusTone))}>
                                {connectionBadge}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-4 p-4">
                        <div className="space-y-2">
                            <SectionLabel>Modèles</SectionLabel>
                            <div className="grid grid-cols-2 gap-2">
                                <ModelRow label="Poneglyph-BBox" status={localModelStatus} loaded={bboxLoaded} icon={Database} />
                                <ModelRow label="Poneglyph" status={localTextModelStatus} loaded={textLoaded} icon={Bot} />
                                <ModelRow label="Surya" status={localSuryaModelStatus} loaded={suryaLoaded} icon={Zap} />
                                <ModelRow label="Surya-BBox" status={localSuryaBBoxModelStatus} loaded={suryaBBoxLoaded} icon={Cpu} />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <SectionLabel>Performances</SectionLabel>
                            <div className="grid grid-cols-4 gap-2">
                                <StatTile icon={Wifi} label="CUDA" value={boolLabel(localHealth?.cuda_available)} tone={localHealth?.cuda_available ? "emerald" : "zinc"} />
                                <StatTile icon={Activity} label="Backend" value={activeBackend} tone={activeBackend !== '-' && activeBackend !== 'not_loaded' ? "sky" : "zinc"} />
                                <StatTile icon={Gauge} label="Dtype" value={dtypeLabel} />
                                <StatTile icon={HardDrive} label="VRAM" value={memoryLabel} />
                            </div>

                            <div className="grid grid-cols-3 gap-2 text-[10px] font-semibold text-slate-400">
                                <div className="truncate">Mode: <span className="font-bold text-slate-200">{requestedBackend}</span></div>
                                <div className="truncate">Port: <span className="font-bold text-slate-200">{localHealth?.port || "-"}</span></div>
                                <div className="truncate">Dernier OK: <span className="font-bold text-slate-200">{timeLabel(localConnectionState?.lastOkAt)}</span></div>
                            </div>

                            {(localHealth?.gpu_name || localHealth?.torch_version || localHealth?.cuda_version) && (
                                <div className="space-y-1 text-[11px] font-semibold text-slate-400">
                                    {localHealth?.gpu_name && <div className="truncate" title={localHealth.gpu_name}>GPU: <span className="font-bold text-slate-200">{localHealth.gpu_name}</span></div>}
                                    {localHealth?.torch_version && <div>Torch build: <span className="font-bold text-slate-200">{localHealth.torch_version}</span></div>}
                                    {localHealth?.cuda_version && <div>CUDA build: <span className="font-bold text-slate-200">{localHealth.cuda_version}</span></div>}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2 border-t border-slate-800 pt-3">
                            <SectionLabel>Téléchargements</SectionLabel>
                            <ProgressLine label="Téléchargement Poneglyph-BBox" active={bboxDownloadActive} state={localDownloadState} percent={downloadPercent} />
                            <ProgressLine label="Téléchargement Poneglyph" active={textDownloadActive} state={localTextDownloadState} percent={textDownloadPercent} />
                            <ProgressLine label="Téléchargement Surya" active={suryaDownloadActive} state={localSuryaDownloadState} percent={suryaDownloadPercent} />
                            <ProgressLine label="Téléchargement Surya-BBox" active={suryaBBoxDownloadActive} state={localSuryaBBoxDownloadState} percent={suryaBBoxDownloadPercent} />
                        </div>

                        {localError && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold leading-snug text-amber-300">
                                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                                <span className="break-words">{localError}</span>
                            </div>
                        )}

                        <div className="space-y-2 border-t border-slate-800 pt-3">
                            <SectionLabel>Actions</SectionLabel>
                            <div className="flex flex-wrap items-center gap-2">
                                <ActionButton onClick={refreshLocalDiagnostics} disabled={isCheckingLocalConnection}>
                                    <RefreshCw size={12} className={cn(isCheckingLocalConnection && "animate-spin")} />
                                    Actualiser
                                </ActionButton>
                                {canDownload && <ActionButton onClick={downloadLocalModel}><Download size={12} /> Poneglyph-BBox</ActionButton>}
                                {canLoad && <ActionButton onClick={loadLocalModel} variant="green"><CheckCircle2 size={12} /> Poneglyph-BBox</ActionButton>}
                                {canDownloadText && <ActionButton onClick={downloadLocalTextModel}><Download size={12} /> Poneglyph</ActionButton>}
                                {canLoadText && <ActionButton onClick={loadLocalTextModel} variant="green"><CheckCircle2 size={12} /> Poneglyph</ActionButton>}
                                {canDownloadSurya && <ActionButton onClick={downloadLocalSuryaModel}><Download size={12} /> Surya</ActionButton>}
                                {canLoadSurya && <ActionButton onClick={loadLocalSuryaModel} variant="green"><CheckCircle2 size={12} /> Surya</ActionButton>}
                                {canDownloadSuryaBBox && <ActionButton onClick={downloadLocalSuryaBBoxModel}><Download size={12} /> Surya-BBox</ActionButton>}
                                {canLoadSuryaBBox && <ActionButton onClick={loadLocalSuryaBBoxModel} variant="green"><CheckCircle2 size={12} /> Surya-BBox</ActionButton>}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
