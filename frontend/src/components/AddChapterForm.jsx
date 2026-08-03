import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { getChapterImport, getTomes, uploadChapter } from '@/lib/api';
import { chapterUploadFieldsSchema } from '@/lib/inputSchemas';

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2, UploadCloud, FileArchive, CheckCircle2, AlertCircle } from "lucide-react";

const STORAGE_VERSION = 1;
const DEFAULT_POLL_DELAY_MS = 1500;
const MIN_POLL_DELAY_MS = 500;
const MAX_POLL_DELAY_MS = 10_000;
const MAX_POLL_ERROR_DELAY_MS = 15_000;
const ACTIVE_JOB_STATUSES = new Set(['receiving', 'queued', 'processing']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

function getStorageKey(userId, mangaSlug) {
    if (!userId || !mangaSlug) return null;
    return `chapter-import:${userId}:${mangaSlug}`;
}

function getFileMetadata(file) {
    return {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || '',
    };
}

function buildRequestFingerprint(fields, fileMetadata) {
    return JSON.stringify({
        tome_id: fields.tome_id,
        numero: fields.numero,
        titre: fields.titre.trim(),
        file: {
            name: fileMetadata.name,
            size: fileMetadata.size,
            lastModified: fileMetadata.lastModified,
        },
    });
}

function readPendingImport(storageKey) {
    if (!storageKey || typeof window === 'undefined') return null;
    try {
        const value = JSON.parse(window.localStorage.getItem(storageKey));
        if (
            value?.version !== STORAGE_VERSION
            || typeof value.idempotencyKey !== 'string'
            || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
            || typeof value.fingerprint !== 'string'
            || !value.fields
            || !value.file
            || (value.jobId !== null && value.jobId !== undefined && !UUID_PATTERN.test(value.jobId))
        ) {
            return null;
        }
        return value;
    } catch {
        return null;
    }
}

function normalizePollDelay(value, fallback = DEFAULT_POLL_DELAY_MS) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MAX_POLL_DELAY_MS, Math.max(MIN_POLL_DELAY_MS, parsed));
}

function isCancelledRequest(error) {
    return error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError';
}

function uploadErrorMessage(error) {
    const serverMessage = error?.response?.data?.error;
    switch (error?.response?.status) {
        case 400:
            return serverMessage || "Les données de l'import sont invalides.";
        case 409:
            return serverMessage || 'Un import existe déjà pour ce chapitre ou cette clé ne correspond plus au fichier.';
        case 413:
            return serverMessage || "L'archive dépasse la taille maximale autorisée.";
        case 415:
            return serverMessage || "Le fichier n'est pas une archive CBZ ou ZIP valide.";
        case 422:
            return serverMessage || "L'archive contient des données invalides ou dépasse les limites autorisées.";
        case 503:
            return serverMessage || "Le service d'import n'est pas disponible pour le moment.";
        default:
            return serverMessage || "L'envoi a été interrompu. Vous pouvez le relancer sans créer de doublon.";
    }
}

function processingLabel(phase, job, uploadPercent) {
    if (phase === 'uploading') {
        return uploadPercent === null
            ? "Envoi de l'archive…"
            : `Envoi de l'archive ${uploadPercent} %`;
    }
    if (phase === 'receiving') return "Réception de l'archive par le serveur…";
    if (phase === 'queued') return 'Archive validée, import en attente…';
    if (phase === 'offline') return 'Suivi suspendu hors connexion…';
    if (phase === 'processing') {
        const processed = Number(job?.progress?.processed) || 0;
        const total = Number(job?.progress?.total) || 0;
        return total > 0 ? `Traitement des pages ${processed}/${total}` : 'Traitement des pages…';
    }
    return '';
}

const AddChapterForm = () => {
    const { mangaSlug } = useManga();
    const { user } = useAuth();
    const [tomes, setTomes] = useState([]);
    const [selectedTome, setSelectedTome] = useState('');
    const [chapterNumber, setChapterNumber] = useState('');
    const [chapterTitle, setChapterTitle] = useState('');
    const [selectedFile, setSelectedFile] = useState(null);
    const [phase, setPhase] = useState('idle');
    const [uploadPercent, setUploadPercent] = useState(null);
    const [job, setJob] = useState(null);
    const [trackedJobId, setTrackedJobId] = useState(null);
    const [pendingImport, setPendingImport] = useState(null);
    const [feedback, setFeedback] = useState({ type: null, message: '' });

    const fileInputRef = useRef(null);
    const uploadControllerRef = useRef(null);
    const submissionIdRef = useRef(0);
    const pendingImportRef = useRef(null);
    const storageKey = useMemo(() => getStorageKey(user?.id, mangaSlug), [mangaSlug, user?.id]);

    const savePendingImport = useCallback((record) => {
        const normalized = {
            ...record,
            version: STORAGE_VERSION,
            updatedAt: Date.now(),
        };
        pendingImportRef.current = normalized;
        setPendingImport(normalized);
        if (!storageKey || typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(storageKey, JSON.stringify(normalized));
        } catch {
            // The in-memory state still keeps retries idempotent for this tab.
        }
    }, [storageKey]);

    const clearPendingImport = useCallback(() => {
        pendingImportRef.current = null;
        setPendingImport(null);
        if (!storageKey || typeof window === 'undefined') return;
        try {
            window.localStorage.removeItem(storageKey);
        } catch {
            // Storage can be unavailable in hardened browser modes.
        }
    }, [storageKey]);

    const resetFields = useCallback(() => {
        setSelectedTome('');
        setChapterNumber('');
        setChapterTitle('');
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const finishCompletedImport = useCallback((completedJob) => {
        setTrackedJobId(null);
        setJob(completedJob);
        setPhase('completed');
        setUploadPercent(null);
        setFeedback({
            type: 'success',
            message: `Chapitre ${completedJob.chapter_number} importé avec succès.`,
        });
        clearPendingImport();
        resetFields();
    }, [clearPendingImport, resetFields]);

    const finishFailedImport = useCallback((failedJob) => {
        setTrackedJobId(null);
        setJob(failedJob);
        setPhase('failed');
        setUploadPercent(null);
        const current = pendingImportRef.current;
        if (current) {
            savePendingImport({
                ...current,
                jobId: failedJob.id,
                status: failedJob.status,
                job: failedJob,
            });
        }
        setFeedback({
            type: 'error',
            message: failedJob.error?.message
                || (failedJob.status === 'cancelled' ? "L'import a été annulé." : "L'import du chapitre a échoué."),
        });
    }, [savePendingImport]);

    useEffect(() => {
        const fetchTomes = async () => {
            if (!mangaSlug) return;
            try {
                const response = await getTomes(mangaSlug);
                setTomes([...(response.data || [])].sort((a, b) => b.numero - a.numero));
            } catch (error) {
                console.error('Impossible de charger les tomes', error);
            }
        };
        fetchTomes();
    }, [mangaSlug]);

    useEffect(() => {
        pendingImportRef.current = null;
        setPendingImport(null);
        setTrackedJobId(null);
        setJob(null);
        setPhase('idle');
        setUploadPercent(null);
        setFeedback({ type: null, message: '' });
        resetFields();
        if (!storageKey) return;

        const stored = readPendingImport(storageKey);
        if (!stored) {
            try {
                window.localStorage.removeItem(storageKey);
            } catch {
                // Ignore unavailable storage.
            }
            return;
        }

        pendingImportRef.current = stored;
        setPendingImport(stored);
        setSelectedTome(String(stored.fields.tome_id ?? ''));
        setChapterNumber(String(stored.fields.numero ?? ''));
        setChapterTitle(String(stored.fields.titre ?? ''));
        setJob(stored.job || null);

        if (stored.jobId) {
            setPhase(ACTIVE_JOB_STATUSES.has(stored.status) ? stored.status : 'queued');
            setFeedback({ type: 'info', message: "Reprise du suivi de l'import en cours…" });
            setTrackedJobId(stored.jobId);
        } else {
            setPhase('interrupted');
            setFeedback({
                type: 'info',
                message: "L'envoi précédent a été interrompu. Resélectionnez la même archive pour le reprendre sans doublon.",
            });
        }
    }, [resetFields, storageKey]);

    useEffect(() => {
        if (!trackedJobId) return undefined;

        let stopped = false;
        let timerId = null;
        let controller = null;
        let inFlight = false;
        let consecutiveErrors = 0;

        const schedule = (delay) => {
            if (stopped) return;
            if (timerId !== null) window.clearTimeout(timerId);
            timerId = window.setTimeout(poll, Math.max(0, delay));
        };

        const poll = async () => {
            if (stopped || inFlight) return;
            timerId = null;

            if (window.navigator.onLine === false) {
                setPhase('offline');
                setFeedback({ type: 'info', message: 'Connexion perdue. Le suivi reprendra automatiquement.' });
                schedule(DEFAULT_POLL_DELAY_MS);
                return;
            }

            inFlight = true;
            controller = new AbortController();
            try {
                const response = await getChapterImport(trackedJobId, { signal: controller.signal });
                if (stopped) return;
                const nextJob = response.data?.job;
                if (!nextJob || nextJob.id !== trackedJobId) {
                    clearPendingImport();
                    setTrackedJobId(null);
                    setPhase('failed');
                    setFeedback({ type: 'error', message: "Le serveur a renvoyé un état d'import invalide." });
                    return;
                }

                consecutiveErrors = 0;
                setJob(nextJob);
                const current = pendingImportRef.current;
                if (current) {
                    savePendingImport({
                        ...current,
                        jobId: nextJob.id,
                        status: nextJob.status,
                        job: nextJob,
                    });
                }

                if (nextJob.status === 'completed') {
                    finishCompletedImport(nextJob);
                    return;
                }
                if (nextJob.status === 'failed' || nextJob.status === 'cancelled') {
                    finishFailedImport(nextJob);
                    return;
                }
                if (!ACTIVE_JOB_STATUSES.has(nextJob.status)) {
                    clearPendingImport();
                    setTrackedJobId(null);
                    setPhase('failed');
                    setFeedback({ type: 'error', message: `État d'import inconnu : ${nextJob.status || 'absent'}.` });
                    return;
                }

                setPhase(nextJob.status);
                setFeedback({
                    type: 'info',
                    message: nextJob.status === 'processing'
                        ? "Le chapitre est en cours de traitement. Vous pouvez quitter puis revenir sur cette page."
                        : "L'archive a été reçue et attend son traitement.",
                });
                schedule(normalizePollDelay(response.data?.poll_after_ms));
            } catch (error) {
                if (stopped || isCancelledRequest(error)) return;
                const status = error?.response?.status;
                if (status === 401 || status === 403) {
                    setTrackedJobId(null);
                    setPhase('failed');
                    setFeedback({ type: 'error', message: "Votre session ne permet plus de suivre cet import. Reconnectez-vous pour reprendre." });
                    return;
                }
                if (status === 400 || status === 404) {
                    clearPendingImport();
                    setTrackedJobId(null);
                    setPhase('failed');
                    setFeedback({ type: 'error', message: "Cet import n'existe plus. Vous pouvez relancer l'envoi." });
                    return;
                }

                consecutiveErrors += 1;
                setFeedback({
                    type: 'info',
                    message: "Impossible d'actualiser l'import. Nouvelle tentative automatique…",
                });
                const retryDelay = Math.min(
                    MAX_POLL_ERROR_DELAY_MS,
                    DEFAULT_POLL_DELAY_MS * (2 ** Math.min(consecutiveErrors, 3))
                );
                schedule(retryDelay);
            } finally {
                inFlight = false;
            }
        };

        const wakePolling = () => {
            if (stopped || inFlight) return;
            schedule(0);
        };

        window.addEventListener('online', wakePolling);
        window.addEventListener('focus', wakePolling);
        schedule(0);

        return () => {
            stopped = true;
            if (timerId !== null) window.clearTimeout(timerId);
            controller?.abort();
            window.removeEventListener('online', wakePolling);
            window.removeEventListener('focus', wakePolling);
        };
    }, [clearPendingImport, finishCompletedImport, finishFailedImport, savePendingImport, trackedJobId]);

    useEffect(() => () => {
        submissionIdRef.current += 1;
        uploadControllerRef.current?.abort();
    }, []);

    const isBusy = phase === 'uploading'
        || phase === 'offline'
        || ACTIVE_JOB_STATUSES.has(phase);

    const clearPendingDraftIfChanged = useCallback(() => {
        if (pendingImportRef.current && !isBusy) clearPendingImport();
    }, [clearPendingImport, isBusy]);

    const handleFileChange = (event) => {
        const file = event.target.files?.[0] || null;
        setSelectedFile(file);
        const current = pendingImportRef.current;
        if (!current || !file || isBusy) return;

        const fields = chapterUploadFieldsSchema.safeParse({
            tome_id: selectedTome,
            numero: chapterNumber,
            titre: chapterTitle,
        });
        if (!fields.success) return;
        const fingerprint = buildRequestFingerprint(fields.data, getFileMetadata(file));
        if (fingerprint !== current.fingerprint) clearPendingImport();
    };

    const handleSubmit = async (event) => {
        event.preventDefault();
        if (isBusy) return;
        setFeedback({ type: null, message: '' });

        const fields = chapterUploadFieldsSchema.safeParse({
            tome_id: selectedTome,
            numero: chapterNumber,
            titre: chapterTitle,
        });
        if (!fields.success) {
            setFeedback({ type: 'error', message: fields.error.issues[0]?.message || 'Données du chapitre invalides.' });
            return;
        }
        if (!selectedFile) {
            setFeedback({ type: 'error', message: 'Sélectionnez une archive CBZ ou ZIP.' });
            return;
        }

        const fileMetadata = getFileMetadata(selectedFile);
        const fingerprint = buildRequestFingerprint(fields.data, fileMetadata);
        const previous = pendingImportRef.current;
        const canReuseKey = previous
            && previous.fingerprint === fingerprint
            && !TERMINAL_JOB_STATUSES.has(previous.status);
        const idempotencyKey = canReuseKey ? previous.idempotencyKey : crypto.randomUUID();
        const pending = {
            idempotencyKey,
            fingerprint,
            fields: fields.data,
            file: fileMetadata,
            jobId: canReuseKey ? previous.jobId || null : null,
            status: 'uploading',
            job: canReuseKey ? previous.job || null : null,
        };
        savePendingImport(pending);

        const formData = new FormData();
        formData.set('tome_id', String(fields.data.tome_id));
        formData.set('numero', String(fields.data.numero));
        formData.set('titre', fields.data.titre);
        formData.set('cbzFile', selectedFile);

        uploadControllerRef.current?.abort();
        const controller = new AbortController();
        uploadControllerRef.current = controller;
        const submissionId = ++submissionIdRef.current;
        setTrackedJobId(null);
        setJob(pending.job);
        setPhase('uploading');
        setUploadPercent(null);

        try {
            const response = await uploadChapter(formData, {
                idempotencyKey,
                signal: controller.signal,
                onUploadProgress: ({ loaded, total }) => {
                    if (submissionIdRef.current !== submissionId || controller.signal.aborted) return;
                    const numericTotal = Number(total);
                    setUploadPercent(numericTotal > 0
                        ? Math.min(100, Math.round((Number(loaded) / numericTotal) * 100))
                        : null);
                },
            });
            if (submissionIdRef.current !== submissionId || controller.signal.aborted) return;

            const acceptedJob = response.data?.job;
            if (!acceptedJob?.id || !acceptedJob.status) {
                throw new Error("Réponse d'import invalide.");
            }
            const accepted = {
                ...pending,
                jobId: acceptedJob.id,
                status: acceptedJob.status,
                job: acceptedJob,
            };
            savePendingImport(accepted);
            setJob(acceptedJob);
            setUploadPercent(null);

            if (acceptedJob.status === 'completed') {
                finishCompletedImport(acceptedJob);
                return;
            }
            if (acceptedJob.status === 'failed' || acceptedJob.status === 'cancelled') {
                finishFailedImport(acceptedJob);
                return;
            }
            if (!ACTIVE_JOB_STATUSES.has(acceptedJob.status)) {
                throw new Error(`État d'import inconnu : ${acceptedJob.status}`);
            }

            setPhase(acceptedJob.status);
            setFeedback({
                type: 'info',
                message: "Archive reçue. L'import continue en arrière-plan.",
            });
            setTrackedJobId(acceptedJob.id);
        } catch (error) {
            if (submissionIdRef.current !== submissionId || isCancelledRequest(error)) return;
            setPhase('failed');
            setUploadPercent(null);
            setFeedback({ type: 'error', message: uploadErrorMessage(error) });

            const status = error?.response?.status;
            if ([400, 409, 413, 415, 422].includes(status)) {
                clearPendingImport();
            } else {
                const current = pendingImportRef.current;
                if (current) savePendingImport({ ...current, status: 'upload_failed' });
            }
        } finally {
            if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
        }
    };

    const progressValue = phase === 'uploading'
        ? (uploadPercent ?? 0)
        : (Number(job?.progress?.percent) || 0);
    const progressText = processingLabel(phase, job, uploadPercent);
    const canResumeTracking = Boolean(pendingImport?.jobId && !trackedJobId && phase === 'failed');
    const retryingUpload = Boolean(pendingImport && !pendingImport.jobId && phase === 'failed');
    const startingNewAttempt = Boolean(
        pendingImport?.jobId && TERMINAL_JOB_STATUSES.has(pendingImport.status) && phase === 'failed'
    );

    return (
        <form
            onSubmit={handleSubmit}
            className="flex flex-col rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md"
        >
            <div className="mb-4 flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-500/12">
                    <FileArchive className="h-4 w-4 text-amber-300" />
                </div>
                <div>
                    <h3 className="font-semibold leading-tight text-white">Nouveau Chapitre</h3>
                    <p className="text-xs text-slate-400">Importez un .cbz ou .zip.</p>
                </div>
            </div>

            <div className="flex-1 space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="chap-tome" className="text-xs text-slate-400">Tome</Label>
                        <Select value={selectedTome} onValueChange={(value) => {
                            clearPendingDraftIfChanged();
                            setSelectedTome(value);
                        }} disabled={isBusy}>
                            <SelectTrigger id="chap-tome" className="w-full">
                                <SelectValue placeholder="-- Sélectionner --" />
                            </SelectTrigger>
                            <SelectContent>
                                {tomes.map(tome => (
                                    <SelectItem key={tome.id} value={String(tome.id)}>
                                        Tome {tome.numero} — {tome.titre}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="chap-numero" className="text-xs text-slate-400">Numéro</Label>
                        <Input
                            id="chap-numero"
                            type="number"
                            name="numero"
                            value={chapterNumber}
                            onChange={(event) => {
                                clearPendingDraftIfChanged();
                                setChapterNumber(event.target.value);
                            }}
                            placeholder="Ex: 1054"
                            required
                            disabled={isBusy}
                        />
                    </div>
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="chap-titre" className="text-xs text-slate-400">Titre</Label>
                    <Input
                        id="chap-titre"
                        type="text"
                        name="titre"
                        value={chapterTitle}
                        onChange={(event) => {
                            clearPendingDraftIfChanged();
                            setChapterTitle(event.target.value);
                        }}
                        placeholder="Ex: L'empereur des flammes"
                        required
                        disabled={isBusy}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="chap-file" className="text-xs text-slate-400">Fichier source (.cbz / .zip)</Label>
                    <Input
                        ref={fileInputRef}
                        id="chap-file"
                        type="file"
                        name="cbzFile"
                        accept=".cbz,.zip"
                        required
                        disabled={isBusy}
                        onChange={handleFileChange}
                        className="cursor-pointer file:mr-4 file:rounded-full file:border-0 file:bg-[#3d86ff]/18 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-[#bdd6ff] hover:file:bg-[#3d86ff]/28"
                    />
                    {!selectedFile && pendingImport?.file?.name && !isBusy && (
                        <p className="text-xs text-amber-200/80">
                            Archive à resélectionner : {pendingImport.file.name}
                        </p>
                    )}
                </div>

                {progressText && (
                    <div className="space-y-2 rounded-xl border border-[#3d86ff]/25 bg-[#3d86ff]/8 p-3">
                        <div className="flex items-center justify-between gap-3 text-xs text-[#bdd6ff]">
                            <span>{progressText}</span>
                            {phase === 'processing' && <span>{progressValue} %</span>}
                        </div>
                        <Progress
                            value={progressValue}
                            aria-label={progressText}
                            className={phase === 'uploading' && uploadPercent === null ? 'animate-pulse' : ''}
                        />
                    </div>
                )}

                {feedback.message && (
                    <div
                        role={feedback.type === 'error' ? 'alert' : 'status'}
                        aria-live={feedback.type === 'error' ? 'assertive' : 'polite'}
                        className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${feedback.type === 'error'
                            ? 'border-rose-400/30 bg-rose-500/10 text-rose-200'
                            : feedback.type === 'success'
                                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                                : 'border-sky-400/30 bg-sky-500/10 text-sky-100'
                            }`}
                    >
                        {feedback.type === 'error'
                            ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            : feedback.type === 'success'
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                        }
                        <span>{feedback.message}</span>
                    </div>
                )}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
                {canResumeTracking && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                            setPhase(ACTIVE_JOB_STATUSES.has(pendingImport.status) ? pendingImport.status : 'queued');
                            setFeedback({ type: 'info', message: "Reprise du suivi de l'import…" });
                            setTrackedJobId(pendingImport.jobId);
                        }}
                    >
                        Reprendre le suivi
                    </Button>
                )}
                <Button
                    type="submit"
                    disabled={isBusy}
                    className="min-w-[160px] bg-[#3d86ff] hover:bg-[#2f73dc]"
                >
                    {isBusy ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Import en cours…</>
                    ) : (
                        <><UploadCloud className="mr-2 h-4 w-4" /> {
                            retryingUpload
                                ? "Réessayer l'envoi"
                                : startingNewAttempt
                                    ? 'Nouvel essai'
                                    : 'Ajouter le Chapitre'
                        }</>
                    )}
                </Button>
            </div>
        </form>
    );
};

export default AddChapterForm;
