"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';

const TARGETS = [
    {
        key: 'production',
        label: 'poneglyph.fr',
        origin: 'https://poneglyph.fr',
        Icon: Globe
    },
    {
        key: 'local',
        label: 'Localhost',
        origin: 'http://localhost:3000',
        Icon: Monitor
    }
];

function currentTargetFromOrigin(origin) {
    if (!origin) return null;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return 'local';
    if (origin.includes('poneglyph.fr')) return 'production';
    return null;
}

function getCurrentPath() {
    if (typeof window === 'undefined') return '/';
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

async function resolveTauriInvoke() {
    if (typeof window === 'undefined') return null;

    const { invoke, isTauri } = await import('@tauri-apps/api/core');
    if (isTauri()) return invoke;

    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (window.__TAURI_INTERNALS__) return invoke;
    }

    return null;
}

export default function DesktopOriginSwitcher() {
    const [invoke, setInvoke] = useState(null);
    const [isTauri, setIsTauri] = useState(false);
    const [currentTarget, setCurrentTarget] = useState(() => {
        if (typeof window === 'undefined') return null;
        return currentTargetFromOrigin(window.location.origin);
    });
    const [pendingTarget, setPendingTarget] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;

        async function detectTauri() {
            const resolvedInvoke = await resolveTauriInvoke();
            if (cancelled) return;
            setInvoke(() => resolvedInvoke);
            setIsTauri(Boolean(resolvedInvoke));
            if (typeof window !== 'undefined') {
                setCurrentTarget(currentTargetFromOrigin(window.location.origin));
            }
        }

        detectTauri();
        return () => {
            cancelled = true;
        };
    }, []);

    const activeLabel = useMemo(() => {
        const target = TARGETS.find(item => item.key === currentTarget);
        return target?.label || 'Frontend';
    }, [currentTarget]);

    const switchTarget = useCallback(async (targetKey) => {
        if (!invoke || pendingTarget || targetKey === currentTarget) return;

        setPendingTarget(targetKey);
        setError(null);
        try {
            await invoke('switch_frontend_origin', {
                target: targetKey,
                path: getCurrentPath()
            });
        } catch (err) {
            setError(err?.message || String(err));
            setPendingTarget(null);
        }
    }, [currentTarget, invoke, pendingTarget]);

    if (!isTauri) return null;

    return (
        <div className="fixed bottom-3 right-3 z-[80] hidden max-w-[calc(100vw-1.5rem)] rounded-lg border border-slate-200 bg-white/95 p-1.5 text-slate-800 shadow-xl backdrop-blur sm:block">
            <div className="mb-1 flex items-center justify-between gap-2 px-1.5">
                <span className="truncate text-[10px] font-black uppercase tracking-wide text-slate-500">
                    {activeLabel}
                </span>
                {pendingTarget && <Loader2 size={12} className="animate-spin text-slate-500" />}
            </div>
            <div className="grid grid-cols-2 gap-1">
                {TARGETS.map(({ key, label, Icon }) => {
                    const active = currentTarget === key;
                    const pending = pendingTarget === key;
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => switchTarget(key)}
                            disabled={active || Boolean(pendingTarget)}
                            title={`Ouvrir ${label}`}
                            className={cn(
                                "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-bold transition-colors disabled:cursor-default",
                                active
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
                                pending && "border-blue-200 bg-blue-50 text-blue-700"
                            )}
                        >
                            {pending ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
                            <span className="truncate">{label}</span>
                        </button>
                    );
                })}
            </div>
            {error && (
                <div className="mt-1 max-w-[260px] rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-semibold leading-snug text-amber-800">
                    {error}
                </div>
            )}
        </div>
    );
}
