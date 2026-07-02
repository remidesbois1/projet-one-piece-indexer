"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    Activity,
    CheckCircle2,
    Clock3,
    CloudLightning,
    Crown,
    Database,
    DatabaseZap,
    ExternalLink,
    Play,
    RefreshCw,
    Rocket,
    Square,
    XCircle,
} from 'lucide-react';

import {
    cancelTrainingJob,
    createTrainingJob,
    getTrainingJob,
    getTrainingJobs,
    promoteModelVersion,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
const TRAINING_KINDS = [
    { value: 'surya_bubble_ocr', label: 'Surya bubble OCR' },
    { value: 'surya_bbox', label: 'Surya bbox OCR' },
    { value: 'lighton_ocr', label: 'LightOn OCR' },
    { value: 'lighton_bbox', label: 'LightOn bbox', disabled: true },
    { value: 'ppocrv6_bubble_line', label: 'YOLO26n + PP-OCRv6' },
];

const GPU_OPTIONS = ['L40S', 'A100-80GB', 'H100', 'H200', 'B200'];

const DEFAULT_HF_REPOS = {
    surya_bubble_ocr: 'Remidesbois/surya-bubble-ocr-poneglyph',
    surya_bbox: 'Remidesbois/surya-ocr-2-poneglyph-bbox',
    lighton_ocr: 'Remidesbois/LightonOCR-2-1b-poneglyph',
    ppocrv6_bubble_line: 'Remidesbois/pp-ocrv6-one-piece-bubble-line-rec',
};

const GPU_TRAINING_PRESETS = {
    surya_bubble_ocr: {
        L40S: { epochs: 6, batch_size: 2, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 96, eval_steps: 300, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
        'A100-80GB': { epochs: 6, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 128, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H100: { epochs: 6, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 160, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H200: { epochs: 6, batch_size: 6, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 192, eval_steps: 300, eval_batch_size: 3, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
        B200: { epochs: 6, batch_size: 8, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 224, eval_steps: 300, eval_batch_size: 4, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
    },
    surya_bbox: {
        L40S: { epochs: 6, batch_size: 1, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 24, eval_steps: 250, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
        'A100-80GB': { epochs: 6, batch_size: 2, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 32, eval_steps: 250, eval_batch_size: 1, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H100: { epochs: 6, batch_size: 2, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 40, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H200: { epochs: 6, batch_size: 3, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 48, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
        B200: { epochs: 6, batch_size: 4, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 64, eval_steps: 250, eval_batch_size: 2, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
    },
    lighton_ocr: {
        L40S: { epochs: 8, batch_size: 2, grad_accum: 8, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 96, eval_steps: 300, eval_batch_size: 1, dataloader_workers: 2, early_stopping_patience: 4, save_total_limit: 4 },
        'A100-80GB': { epochs: 8, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 64, max_eval_samples: 0, gen_eval_samples: 128, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H100: { epochs: 8, batch_size: 4, grad_accum: 4, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 160, eval_steps: 300, eval_batch_size: 2, dataloader_workers: 4, early_stopping_patience: 4, save_total_limit: 4 },
        H200: { epochs: 8, batch_size: 6, grad_accum: 3, learning_rate: 0.00005, lora_rank: 96, max_eval_samples: 0, gen_eval_samples: 192, eval_steps: 300, eval_batch_size: 3, dataloader_workers: 6, early_stopping_patience: 4, save_total_limit: 4 },
        B200: { epochs: 8, batch_size: 8, grad_accum: 2, learning_rate: 0.00005, lora_rank: 128, max_eval_samples: 0, gen_eval_samples: 224, eval_steps: 300, eval_batch_size: 4, dataloader_workers: 8, early_stopping_patience: 4, save_total_limit: 4 },
    },
    ppocrv6_bubble_line: {
        L40S: { epochs: 10, batch_size: 2, grad_accum: 8, learning_rate: 0.00002, lora_rank: 0, max_eval_samples: 0, gen_eval_samples: 0, eval_steps: 1, eval_batch_size: 1, dataloader_workers: 0, early_stopping_patience: 20, save_total_limit: 3, yolo_epochs: 120, yolo_batch_size: 16, yolo_imgsz: 960, yolo_patience: 30, yolo_workers: 2, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
        'A100-80GB': { epochs: 12, batch_size: 4, grad_accum: 4, learning_rate: 0.00002, lora_rank: 0, max_eval_samples: 0, gen_eval_samples: 0, eval_steps: 1, eval_batch_size: 1, dataloader_workers: 0, early_stopping_patience: 25, save_total_limit: 3, yolo_epochs: 140, yolo_batch_size: 24, yolo_imgsz: 1024, yolo_patience: 35, yolo_workers: 4, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
        H100: { epochs: 14, batch_size: 16, grad_accum: 1, learning_rate: 0.00002, lora_rank: 0, max_eval_samples: 0, gen_eval_samples: 0, eval_steps: 1, eval_batch_size: 1, dataloader_workers: 8, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 160, yolo_batch_size: 96, yolo_imgsz: 1024, yolo_patience: 40, yolo_workers: 8, image_width: 960, train_backbone: true, pin_memory: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
        H200: { epochs: 14, batch_size: 6, grad_accum: 3, learning_rate: 0.00002, lora_rank: 0, max_eval_samples: 0, gen_eval_samples: 0, eval_steps: 1, eval_batch_size: 1, dataloader_workers: 0, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 180, yolo_batch_size: 40, yolo_imgsz: 1024, yolo_patience: 45, yolo_workers: 8, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
        B200: { epochs: 16, batch_size: 8, grad_accum: 2, learning_rate: 0.00002, lora_rank: 0, max_eval_samples: 0, gen_eval_samples: 0, eval_steps: 1, eval_batch_size: 1, dataloader_workers: 0, early_stopping_patience: 30, save_total_limit: 3, yolo_epochs: 200, yolo_batch_size: 48, yolo_imgsz: 1280, yolo_patience: 50, yolo_workers: 8, image_width: 960, train_backbone: true, short_oversample: 3, short_loss_weight: 2.5, backbone_learning_rate: 0.000002, lr_scheduler: 'cosine', warmup_ratio: 0.05 },
    },
};

const STATUS_STYLES = {
    queued: 'border-slate-300 bg-slate-100 text-slate-700',
    preparing_dataset: 'border-sky-300 bg-sky-100 text-sky-700',
    dataset_ready: 'border-cyan-300 bg-cyan-100 text-cyan-700',
    starting_gpu: 'border-indigo-300 bg-indigo-100 text-indigo-700',
    running: 'border-blue-300 bg-blue-100 text-blue-700',
    benchmarking: 'border-violet-300 bg-violet-100 text-violet-700',
    uploading: 'border-amber-300 bg-amber-100 text-amber-800',
    completed: 'border-emerald-300 bg-emerald-100 text-emerald-700',
    failed: 'border-red-300 bg-red-100 text-red-700',
    cancelled: 'border-zinc-300 bg-zinc-100 text-zinc-700',
};

const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const LOG_TAIL_LINE_LIMIT = 600;

function formatDate(value) {
    if (!value) return '-';
    try {
        return new Intl.DateTimeFormat('fr-FR', {
            dateStyle: 'short',
            timeStyle: 'short',
        }).format(new Date(value));
    } catch {
        return value;
    }
}

function formatMetric(value) {
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'number') {
        if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2);
        if (Math.abs(value) < 1) return value.toFixed(4);
        return value.toFixed(2);
    }
    return String(value);
}

function stripAnsi(value = '') {
    return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function parseMetricValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
}

function parseLiveLogState(logText = '') {
    const state = { train: null, eval: null, latest: null, progress: null };

    for (const rawLine of String(logText || '').split(/\r?\n/)) {
        const line = stripAnsi(rawLine);
        const progressMatch = line.match(/(\d+)%\|.*?\|\s*(\d+)\/(\d+)\s*\[/);
        if (progressMatch) {
            state.progress = {
                percent: Number(progressMatch[1]),
                current: Number(progressMatch[2]),
                total: Number(progressMatch[3]),
            };
        }

        const markerIndex = line.indexOf('[LIVE]');
        if (markerIndex === -1) continue;

        const liveLine = line.slice(markerIndex);
        const stepMatch = liveLine.match(/step=(\d+)/);
        const payload = {
            step: stepMatch ? Number(stepMatch[1]) : null,
            metrics: {},
        };

        for (const match of liveLine.matchAll(/\|\s*([A-Za-z0-9_@.]+)=([^\s|]+)/g)) {
            payload.metrics[match[1]] = parseMetricValue(match[2]);
        }

        const isEval = Object.keys(payload.metrics).some(key => key.startsWith('eval_'));
        if (isEval) {
            state.eval = payload;
        } else {
            state.train = payload;
        }
        state.latest = payload;
    }

    return state;
}

function liveMetricEntries(liveState) {
    if (!liveState?.latest && !liveState?.progress) return [];
    const progress = liveState.progress
        ? `${liveState.progress.current}/${liveState.progress.total} (${liveState.progress.percent}%)`
        : null;

    return [
        ['Step', liveState.latest?.step],
        ['Progress', progress],
        ['Train loss', liveState.train?.metrics?.loss],
        ['LR', liveState.train?.metrics?.learning_rate],
        ['Eval loss', liveState.eval?.metrics?.eval_loss],
        ['CER', liveState.eval?.metrics?.eval_cer],
        ['WER', liveState.eval?.metrics?.eval_wer],
        ['Exact match', liveState.eval?.metrics?.eval_exact_match],
        ['Blank rate', liveState.eval?.metrics?.eval_blank_rate],
        ['Multiline', liveState.eval?.metrics?.eval_multiline_rate],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');
}

function hasMetricValues(metrics = {}) {
    return Object.values(metrics || {}).some(value => value !== null && value !== undefined && value !== '');
}

function logTail(logText = '', maxLines = LOG_TAIL_LINE_LIMIT) {
    const lines = String(logText || '').split(/\r?\n/);
    if (lines.length <= maxLines) return { text: logText || '', hiddenCount: 0 };
    return {
        text: lines.slice(-maxLines).join('\n'),
        hiddenCount: lines.length - maxLines,
    };
}

function defaultHfRepo(kind) {
    return DEFAULT_HF_REPOS[kind] || DEFAULT_HF_REPOS.surya_bubble_ocr;
}

function trainingPresetFor(kind, gpu) {
    return GPU_TRAINING_PRESETS[kind]?.[gpu] || GPU_TRAINING_PRESETS.surya_bubble_ocr.L40S;
}

function stringPreset(preset) {
    return Object.fromEntries(Object.entries(preset).map(([key, value]) => [key, String(value)]));
}

function metricEntries(kind, metrics = {}) {
    if (!metrics || typeof metrics !== 'object') return [];
    if (kind === 'ppocrv6_bubble_line') {
        return [
            ['YOLO mAP50', metrics.yolo?.map50 || metrics.yolo?.['metrics/mAP50(B)']],
            ['YOLO mAP50-95', metrics.yolo?.map50_95 || metrics.yolo?.['metrics/mAP50-95(B)']],
            ['Best val CER', metrics.ppocr?.best_val_cer],
            ['Val CER', metrics.ppocr?.val_cer],
            ['Exact match', metrics.ppocr?.val_exact_match],
            ['Short CER', metrics.ppocr?.val_short_cer],
            ['Dialogue CER', metrics.ppocr?.val_dialogue_cer],
            ['ONNX parity', metrics.onnx?.all_text_match],
        ];
    }
    if (kind === 'surya_bbox') {
        return [
            ['CER', metrics.cer],
            ['WER', metrics.wer],
            ['Mean IoU', metrics.mean_iou],
            ['Median IoU', metrics.median_iou],
            ['GIoU', metrics.mean_giou],
            ['F1 @ 0.5', metrics['f1@0_5']],
            ['Detection', metrics.avg_detection_rate],
            ['Avg inference', metrics.avg_inference_time],
            ['Score', metrics.combined_score],
        ];
    }
    return [
        ['CER', metrics.cer],
        ['WER', metrics.wer],
        ['Exact match', metrics.exact_match],
        ['Blank rate', metrics.blank_rate],
        ['Hallucination', metrics.hallucination_rate],
        ['Avg Levenshtein', metrics.avg_levenshtein],
    ];
}

function StatusBadge({ status }) {
    const Icon = status === 'completed' ? CheckCircle2 : status === 'failed' ? XCircle : Clock3;
    return (
        <Badge variant="outline" className={STATUS_STYLES[status] || STATUS_STYLES.queued}>
            <Icon className="h-3 w-3" />
            {status}
        </Badge>
    );
}

export default function TrainingJobManager() {
    const logsRef = useRef(null);
    const [jobs, setJobs] = useState([]);
    const [selectedJobId, setSelectedJobId] = useState(null);
    const [selectedJob, setSelectedJob] = useState(null);
    const [loading, setLoading] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [schemaError, setSchemaError] = useState(null);
    const [form, setForm] = useState({
        kind: 'surya_bubble_ocr',
        gpu: 'L40S',
        ...stringPreset(trainingPresetFor('surya_bubble_ocr', 'L40S')),
        hf_repo: '',
        skip_upload: false,
        shard_dataset: false,
    });

    const refreshJobs = useCallback(async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        try {
            const { data } = await getTrainingJobs({ limit: 50 });
            setSchemaError(null);
            setJobs(data || []);
            if (!selectedJobId && data?.length) {
                setSelectedJobId(data[0].id);
            }
        } catch (error) {
            if (error?.response?.status === 503) {
                setSchemaError(error.response.data);
                setJobs([]);
                setSelectedJobId(null);
                setSelectedJob(null);
                return;
            }
            toast.error("Erreur chargement fine-tunings.", {
                description: error?.response?.data?.details || error.message,
            });
        } finally {
            if (!silent) setLoading(false);
        }
    }, [selectedJobId]);

    const refreshSelectedJob = useCallback(async ({ silent = false } = {}) => {
        if (!selectedJobId) {
            setSelectedJob(null);
            return;
        }
        if (!silent) setDetailLoading(true);
        try {
            const { data } = await getTrainingJob(selectedJobId);
            setSchemaError(null);
            setSelectedJob(data);
        } catch (error) {
            if (error?.response?.status === 503) {
                setSchemaError(error.response.data);
                setSelectedJob(null);
                return;
            }
            toast.error("Erreur chargement du job.", {
                description: error?.response?.data?.details || error.message,
            });
        } finally {
            if (!silent) setDetailLoading(false);
        }
    }, [selectedJobId]);

    useEffect(() => {
        refreshJobs();
    }, [refreshJobs]);

    useEffect(() => {
        refreshSelectedJob();
    }, [refreshSelectedJob]);

    const selectedJobStatus = selectedJob?.status;

    useEffect(() => {
        const intervalMs = selectedJobStatus && !FINAL_STATUSES.has(selectedJobStatus) ? 3000 : 10000;
        const interval = window.setInterval(() => {
            refreshJobs({ silent: true });
            refreshSelectedJob({ silent: true });
        }, intervalMs);
        return () => window.clearInterval(interval);
    }, [refreshJobs, refreshSelectedJob, selectedJobStatus]);

    useEffect(() => {
        if (!logsRef.current) return;
        logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }, [selectedJob?.id, selectedJob?.logs_text]);

    const updateForm = (key, value) => {
        setForm(prev => {
            if (key === 'kind') {
                return { ...prev, kind: value, ...stringPreset(trainingPresetFor(value, prev.gpu)) };
            }
            if (key === 'gpu') {
                return { ...prev, gpu: value, ...stringPreset(trainingPresetFor(prev.kind, value)) };
            }
            return { ...prev, [key]: value };
        });
    };

    const submitJob = async () => {
        setSubmitting(true);
        try {
            const payload = {
                kind: form.kind,
                provider: 'modal',
                params: {
                    gpu: form.gpu,
                    epochs: form.epochs,
                    batch_size: form.batch_size,
                    grad_accum: form.grad_accum,
                    learning_rate: form.learning_rate,
                    lora_rank: form.lora_rank,
                    max_eval_samples: form.max_eval_samples,
                    gen_eval_samples: form.gen_eval_samples,
                    eval_steps: form.eval_steps,
                    eval_batch_size: form.eval_batch_size,
                    dataloader_workers: form.dataloader_workers,
                    early_stopping_patience: form.early_stopping_patience,
                    save_total_limit: form.save_total_limit,
                    yolo_epochs: form.yolo_epochs,
                    yolo_batch_size: form.yolo_batch_size,
                    yolo_imgsz: form.yolo_imgsz,
                    yolo_patience: form.yolo_patience,
                    yolo_workers: form.yolo_workers,
                    image_width: form.image_width,
                    short_oversample: form.short_oversample,
                    short_loss_weight: form.short_loss_weight,
                    backbone_learning_rate: form.backbone_learning_rate,
                    lr_scheduler: form.lr_scheduler,
                    warmup_ratio: form.warmup_ratio,
                    train_backbone: form.train_backbone,
                    pin_memory: form.pin_memory,
                    hf_repo: form.hf_repo || undefined,
                    skip_upload: form.skip_upload,
                    shard_dataset: form.shard_dataset,
                },
            };
            const { data } = await createTrainingJob(payload);
            setSchemaError(null);
            toast.success("Fine-tuning lancé.");
            setSelectedJobId(data.id);
            await refreshJobs({ silent: true });
        } catch (error) {
            if (error?.response?.status === 503) {
                setSchemaError(error.response.data);
            }
            toast.error("Lancement impossible.", {
                description: error?.response?.data?.details || error.message,
            });
        } finally {
            setSubmitting(false);
        }
    };

    const cancelJob = async (id) => {
        try {
            await cancelTrainingJob(id);
            toast.success("Job annulé.");
            await refreshJobs({ silent: true });
            await refreshSelectedJob({ silent: true });
        } catch (error) {
            toast.error("Annulation impossible.", {
                description: error?.response?.data?.details || error.message,
            });
        }
    };

    const promoteVersion = async (versionId) => {
        try {
            await promoteModelVersion(versionId);
            toast.success("Modèle promu actif.");
            await refreshSelectedJob({ silent: true });
        } catch {
            toast.error("Promotion impossible.");
        }
    };

    const metrics = selectedJob?.metrics_json || {};
    const liveState = parseLiveLogState(selectedJob?.logs_text || '');
    const liveEntries = liveMetricEntries(liveState);
    const hasFinalMetrics = hasMetricValues(metrics);
    const displayedLogs = logTail(selectedJob?.logs_text || selectedJob?.error_message || '');
    const modelVersions = selectedJob?.model_versions || [];

    return (
        <div className="space-y-6">
            <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
                <section className="rounded-2xl border border-white/12 bg-[#071625]/80 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.24)]">
                    <div className="mb-5 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <CloudLightning className="h-5 w-5 text-[#8dbbff]" />
                            <h3 className="text-lg font-bold text-white">Nouveau job</h3>
                        </div>
                        <Badge variant="outline" className="border-[#8dbbff]/35 bg-[#3d86ff]/12 text-[#bcd6ff]">
                            Modal
                        </Badge>
                    </div>

                    <div className="space-y-4">
                        <div className="grid gap-2">
                            <Label className="text-slate-300">Modèle</Label>
                            <Select value={form.kind} onValueChange={(value) => updateForm('kind', value)}>
                                <SelectTrigger className="w-full border-white/12 bg-white/[0.06] text-white">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {TRAINING_KINDS.map(kind => (
                                        <SelectItem key={kind.value} value={kind.value} disabled={kind.disabled}>
                                            {kind.label}{kind.disabled ? ' · bientôt' : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="grid gap-2">
                            <Label className="text-slate-300">GPU</Label>
                            <Select value={form.gpu} onValueChange={(value) => updateForm('gpu', value)}>
                                <SelectTrigger className="w-full border-white/12 bg-white/[0.06] text-white">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {GPU_OPTIONS.map(gpu => (
                                        <SelectItem key={gpu} value={gpu}>{gpu}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Epochs" value={form.epochs} onChange={(value) => updateForm('epochs', value)} />
                            <Field label="Batch" value={form.batch_size} onChange={(value) => updateForm('batch_size', value)} />
                            <Field label="Grad accum" value={form.grad_accum} onChange={(value) => updateForm('grad_accum', value)} />
                            <Field label="LoRA rank" value={form.lora_rank} onChange={(value) => updateForm('lora_rank', value)} />
                        </div>

                        <Field label="Learning rate" value={form.learning_rate} onChange={(value) => updateForm('learning_rate', value)} />
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Final eval" value={form.max_eval_samples} onChange={(value) => updateForm('max_eval_samples', value)} />
                            <Field label="Gen eval" value={form.gen_eval_samples} onChange={(value) => updateForm('gen_eval_samples', value)} />
                            <Field label="Eval steps" value={form.eval_steps} onChange={(value) => updateForm('eval_steps', value)} />
                            <Field label="Eval batch" value={form.eval_batch_size} onChange={(value) => updateForm('eval_batch_size', value)} />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                            <Field label="Workers" value={form.dataloader_workers} onChange={(value) => updateForm('dataloader_workers', value)} />
                            <Field label="Patience" value={form.early_stopping_patience} onChange={(value) => updateForm('early_stopping_patience', value)} />
                            <Field label="Checkpoints" value={form.save_total_limit} onChange={(value) => updateForm('save_total_limit', value)} />
                        </div>
                        {form.kind === 'ppocrv6_bubble_line' && (
                            <>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="YOLO epochs" value={form.yolo_epochs} onChange={(value) => updateForm('yolo_epochs', value)} />
                                    <Field label="YOLO batch" value={form.yolo_batch_size} onChange={(value) => updateForm('yolo_batch_size', value)} />
                                    <Field label="YOLO imgsz" value={form.yolo_imgsz} onChange={(value) => updateForm('yolo_imgsz', value)} />
                                    <Field label="YOLO patience" value={form.yolo_patience} onChange={(value) => updateForm('yolo_patience', value)} />
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Image width" value={form.image_width} onChange={(value) => updateForm('image_width', value)} />
                                    <Field label="Backbone LR" value={form.backbone_learning_rate} onChange={(value) => updateForm('backbone_learning_rate', value)} />
                                    <Field label="Short oversample" value={form.short_oversample} onChange={(value) => updateForm('short_oversample', value)} />
                                    <Field label="Short loss" value={form.short_loss_weight} onChange={(value) => updateForm('short_loss_weight', value)} />
                                </div>
                                <ToggleRow label="Train backbone" checked={Boolean(form.train_backbone)} onCheckedChange={(value) => updateForm('train_backbone', value)} />
                                <ToggleRow label="Pin memory" checked={Boolean(form.pin_memory)} onCheckedChange={(value) => updateForm('pin_memory', value)} />
                            </>
                        )}
                        <Field label="HF repo" value={form.hf_repo} placeholder={defaultHfRepo(form.kind)} onChange={(value) => updateForm('hf_repo', value)} />

                        <ToggleRow label="Skip upload" checked={form.skip_upload} onCheckedChange={(value) => updateForm('skip_upload', value)} />
                        <ToggleRow label="Shard manifest" checked={form.shard_dataset} onCheckedChange={(value) => updateForm('shard_dataset', value)} />

                        <Button className="h-10 w-full bg-[#3d86ff] text-white hover:bg-[#2f73dc]" onClick={submitJob} disabled={submitting}>
                            {submitting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            Lancer
                        </Button>
                    </div>
                </section>

                <section className="min-w-0 rounded-2xl border border-white/12 bg-[#071625]/80 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.24)]">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <Activity className="h-5 w-5 text-[#8dbbff]" />
                            <h3 className="text-lg font-bold text-white">Jobs</h3>
                        </div>
                        <Button variant="outline" size="sm" className="border-white/12 bg-white/[0.06] text-slate-200 hover:bg-white/12 hover:text-white" onClick={() => refreshJobs()} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                            Rafraîchir
                        </Button>
                    </div>

                    {schemaError && <SchemaNotice error={schemaError} />}

                    <div className="overflow-hidden rounded-xl border border-white/10">
                        <Table>
                            <TableHeader className="bg-white/[0.06]">
                                <TableRow className="border-white/10 hover:bg-transparent">
                                    <TableHead className="text-slate-300">Type</TableHead>
                                    <TableHead className="text-slate-300">Statut</TableHead>
                                    <TableHead className="text-slate-300">GPU</TableHead>
                                    <TableHead className="text-slate-300">Créé</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {jobs.map(job => (
                                    <TableRow
                                        key={job.id}
                                        onClick={() => setSelectedJobId(job.id)}
                                        className={`cursor-pointer border-white/10 hover:bg-white/[0.06] ${selectedJobId === job.id ? 'bg-[#3d86ff]/12' : ''}`}
                                    >
                                        <TableCell className="font-medium text-slate-100">{job.kind}</TableCell>
                                        <TableCell><StatusBadge status={job.status} /></TableCell>
                                        <TableCell className="text-slate-300">{job.params_json?.gpu || '-'}</TableCell>
                                        <TableCell className="text-slate-400">{formatDate(job.created_at)}</TableCell>
                                    </TableRow>
                                ))}
                                {jobs.length === 0 && (
                                    <TableRow className="border-white/10">
                                        <TableCell colSpan={4} className="py-10 text-center text-slate-400">
                                            Aucun job.
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </section>
            </div>

            <section className="rounded-2xl border border-white/12 bg-[#071625]/80 p-5 shadow-[0_18px_44px_rgba(0,0,0,0.24)]">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Database className="h-5 w-5 text-[#8dbbff]" />
                        <h3 className="truncate text-lg font-bold text-white">Détail</h3>
                        {selectedJob && <StatusBadge status={selectedJob.status} />}
                    </div>
                    {selectedJob && !FINAL_STATUSES.has(selectedJob.status) && (
                        <Button variant="destructive" size="sm" onClick={() => cancelJob(selectedJob.id)}>
                            <Square className="h-4 w-4" />
                            Annuler
                        </Button>
                    )}
                </div>

                {detailLoading ? (
                    <div className="flex justify-center py-12">
                        <RefreshCw className="h-6 w-6 animate-spin text-[#8dbbff]" />
                    </div>
                ) : selectedJob ? (
                    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="min-w-0 space-y-5">
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <InfoTile label="Provider" value={selectedJob.provider} />
                                <InfoTile label="Modal call" value={selectedJob.modal_call_id || '-'} />
                                <InfoTile label="HF repo" value={selectedJob.hf_repo || '-'} link={selectedJob.hf_repo ? `https://huggingface.co/${selectedJob.hf_repo}` : null} />
                                <InfoTile label="Volume" value={selectedJob.modal_volume_name || '-'} />
                            </div>

                            <div className="rounded-xl border border-white/10 bg-black/18 p-4">
                                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                                    <Rocket className="h-4 w-4 text-[#8dbbff]" />
                                    Métriques
                                </div>
                                {liveEntries.length > 0 && (
                                    <div className="mb-4">
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <p className="text-xs font-semibold uppercase tracking-wide text-[#8dbbff]">Temps reel</p>
                                            <p className="text-xs text-slate-500">Depuis les logs</p>
                                        </div>
                                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                                            {liveEntries.map(([label, value]) => (
                                                <div key={label} className="rounded-lg border border-[#3d86ff]/20 bg-[#3d86ff]/10 px-3 py-2">
                                                    <p className="text-xs text-slate-400">{label}</p>
                                                    <p className="mt-1 text-sm font-semibold text-white">{formatMetric(value)}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {hasFinalMetrics ? (
                                    <div>
                                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Final</p>
                                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                            {metricEntries(selectedJob.kind, metrics).map(([label, value]) => (
                                                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
                                                    <p className="text-xs text-slate-400">{label}</p>
                                                    <p className="mt-1 text-sm font-semibold text-white">{formatMetric(value)}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="rounded-lg border border-dashed border-white/12 px-3 py-2 text-sm text-slate-400">
                                        Les metriques finales seront disponibles apres le benchmark test.
                                    </p>
                                )}
                            </div>

                            <div className="rounded-xl border border-white/10 bg-black/18 p-4">
                                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                                    <Activity className="h-4 w-4 text-[#8dbbff]" />
                                    Logs
                                    {displayedLogs.hiddenCount > 0 && (
                                        <span className="ml-auto text-xs font-normal text-slate-500">
                                            {displayedLogs.hiddenCount} lignes masquees
                                        </span>
                                    )}
                                </div>
                                <pre
                                    ref={logsRef}
                                    className="h-[420px] max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-[#020713] p-3 font-mono text-xs leading-relaxed text-slate-200"
                                >
                                    {displayedLogs.text}
                                </pre>
                            </div>
                        </div>

                        <div className="space-y-5">
                            <div className="rounded-xl border border-white/10 bg-black/18 p-4">
                                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                                    <Crown className="h-4 w-4 text-amber-300" />
                                    Versions
                                </div>
                                <div className="space-y-3">
                                    {modelVersions.map(version => (
                                        <div key={version.id} className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-semibold text-white">{version.hf_repo}</p>
                                                    <p className="mt-1 text-xs text-slate-400">{formatDate(version.created_at)}</p>
                                                </div>
                                                {version.is_active ? (
                                                    <Badge className="bg-emerald-500 text-white">Actif</Badge>
                                                ) : (
                                                    <Badge variant="outline" className="border-amber-300 bg-amber-100 text-amber-800">Candidat</Badge>
                                                )}
                                            </div>
                                            <div className="mt-3 flex gap-2">
                                                <Button size="sm" variant="outline" className="border-white/12 bg-white/[0.06] text-slate-200 hover:bg-white/12 hover:text-white" asChild>
                                                    <a href={`https://huggingface.co/${version.hf_repo}`} target="_blank" rel="noreferrer">
                                                        <ExternalLink className="h-4 w-4" />
                                                        HF
                                                    </a>
                                                </Button>
                                                {!version.is_active && (
                                                    <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => promoteVersion(version.id)}>
                                                        <Crown className="h-4 w-4" />
                                                        Promouvoir
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                    {modelVersions.length === 0 && (
                                        <p className="rounded-lg border border-dashed border-white/12 p-4 text-sm text-slate-400">
                                            Aucune version candidate.
                                        </p>
                                    )}
                                </div>
                            </div>

                            <div className="rounded-xl border border-white/10 bg-black/18 p-4">
                                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-200">
                                    <Database className="h-4 w-4 text-[#8dbbff]" />
                                    Résumé
                                </div>
                                <pre className="max-h-[300px] overflow-auto rounded-lg bg-[#020713] p-3 text-xs text-slate-300">
                                    {JSON.stringify(selectedJob.summary_json || selectedJob.params_json || {}, null, 2)}
                                </pre>
                            </div>
                        </div>
                    </div>
                ) : (
                    <p className="py-10 text-center text-slate-400">Sélectionnez un job.</p>
                )}
            </section>
        </div>
    );
}

function Field({ label, value, onChange, placeholder }) {
    return (
        <div className="grid gap-2">
            <Label className="text-slate-300">{label}</Label>
            <Input
                value={value}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
                className="border-white/12 bg-white/[0.06] text-white placeholder:text-slate-500"
            />
        </div>
    );
}

function ToggleRow({ label, checked, onCheckedChange }) {
    return (
        <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
            <Label className="text-sm text-slate-300">{label}</Label>
            <Switch checked={checked} onCheckedChange={onCheckedChange} />
        </div>
    );
}

function InfoTile({ label, value, link }) {
    return (
        <div className="min-w-0 rounded-xl border border-white/10 bg-black/18 p-3">
            <p className="text-xs text-slate-400">{label}</p>
            {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="mt-1 flex min-w-0 items-center gap-1 text-sm font-semibold text-[#8dbbff] hover:text-white">
                    <span className="truncate">{value}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
            ) : (
                <p className="mt-1 truncate text-sm font-semibold text-white">{value}</p>
            )}
        </div>
    );
}

function SchemaNotice({ error }) {
    return (
        <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-50">
            <div className="flex items-start gap-3">
                <DatabaseZap className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                <div className="min-w-0">
                    <p className="font-semibold">{error?.error || 'Schema fine-tuning non installe'}</p>
                    <p className="mt-1 text-amber-100/85">
                        {error?.details || 'Appliquez la migration training_jobs/model_versions puis rechargez cette page.'}
                    </p>
                    <code className="mt-3 block overflow-x-auto rounded-lg border border-amber-200/20 bg-black/25 px-3 py-2 text-xs text-amber-50">
                        cd backend && npm run training:schema -- --check
                    </code>
                </div>
            </div>
        </div>
    );
}
