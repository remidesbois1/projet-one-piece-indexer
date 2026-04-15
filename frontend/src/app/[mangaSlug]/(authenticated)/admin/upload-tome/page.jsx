"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { getTomes, uploadPageToR2, batchCreatePages } from '@/lib/api';
import { initAlignmentWorker, alignPages, terminateAlignmentWorker, applyTransformOffscreen } from '@/lib/colorAlign';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    BookOpen,
    Trash2,
    Plus,
    Upload,
    CheckCircle2,
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Loader2,
    X,
    FileArchive,
    Layers,
    MousePointerClick,
    GripVertical,
    Palette,
    Merge,
    Unlink,
    Eye,
    EyeOff,
    RotateCcw,
    Check,
    ChevronDown,
    ChevronUp,
    Info,
} from "lucide-react";
import Link from 'next/link';
import { useParams } from 'next/navigation';

const CHAPTER_COLORS = [
    { bg: 'bg-blue-100', border: 'border-blue-400', text: 'text-blue-700', ribbon: 'bg-blue-500' },
    { bg: 'bg-emerald-100', border: 'border-emerald-400', text: 'text-emerald-700', ribbon: 'bg-emerald-500' },
    { bg: 'bg-amber-100', border: 'border-amber-400', text: 'text-amber-700', ribbon: 'bg-amber-500' },
    { bg: 'bg-purple-100', border: 'border-purple-400', text: 'text-purple-700', ribbon: 'bg-purple-500' },
    { bg: 'bg-rose-100', border: 'border-rose-400', text: 'text-rose-700', ribbon: 'bg-rose-500' },
    { bg: 'bg-cyan-100', border: 'border-cyan-400', text: 'text-cyan-700', ribbon: 'bg-cyan-500' },
    { bg: 'bg-orange-100', border: 'border-orange-400', text: 'text-orange-700', ribbon: 'bg-orange-500' },
    { bg: 'bg-indigo-100', border: 'border-indigo-400', text: 'text-indigo-700', ribbon: 'bg-indigo-500' },
];

// ── helpers ──────────────────────────────────────────────────────────────────

async function extractCbz(file, onProgress) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(file);
    const imageFiles = [];
    const validExtensions = /\.(jpg|jpeg|png|webp|avif|bmp)$/i;

    zip.forEach((relativePath, entry) => {
        if (!entry.dir && validExtensions.test(relativePath) && !relativePath.includes('__MACOSX')) {
            imageFiles.push({ path: relativePath, entry });
        }
    });

    imageFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

    const extracted = [];
    for (let i = 0; i < imageFiles.length; i++) {
        const blob = await imageFiles[i].entry.async('blob');
        extracted.push({
            filename: imageFiles[i].path.split('/').pop(),
            blob,
        });
        onProgress?.(Math.round(((i + 1) / imageFiles.length) * 100));
    }
    return extracted;
}

function createThumbnail(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            const thumbH = 300;
            const scale = thumbH / img.height;
            const thumbW = Math.round(img.width * scale);
            const canvas = document.createElement('canvas');
            canvas.width = thumbW;
            canvas.height = thumbH;
            canvas.getContext('2d').drawImage(img, 0, 0, thumbW, thumbH);

            let thumbBlob = await new Promise(r => canvas.toBlob(r, 'image/avif', 0.35));
            if (!thumbBlob) thumbBlob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.35));

            URL.revokeObjectURL(img.src);
            resolve(URL.createObjectURL(thumbBlob));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });
}

function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src = url;
    });
}

function imageToImageData(img, maxHeight = 1500) {
    const scale = maxHeight / img.height;
    const w = Math.round(img.width * scale);
    const h = maxHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
}

// ── component ────────────────────────────────────────────────────────────────

export default function UploadTomePage() {
    const { session } = useAuth();
    const { currentManga, mangaSlug } = useManga();
    const params = useParams();

    // ─ general state ─
    const [step, setStep] = useState(1);
    const [tomes, setTomes] = useState([]);
    const [selectedTome, setSelectedTome] = useState('');
    const [error, setError] = useState('');

    // ─ extraction state ─
    const [extracting, setExtracting] = useState(false);
    const [extractProgress, setExtractProgress] = useState(0);
    const [extractLabel, setExtractLabel] = useState('');

    // ─ B&W pages ─
    const [pages, setPages] = useState([]);
    const [selectedPages, setSelectedPages] = useState(new Set());
    const [lastClickedIndex, setLastClickedIndex] = useState(null);

    // ─ Color pages ─
    const [colorPages, setColorPages] = useState([]);       // raw extracted color pages (may be > pages.length)
    const [colorMapping, setColorMapping] = useState([]);    // colorMapping[bwIndex] = { colorIndices: [i], merged: false, transform, stats, validated }
    const [showColorPanel, setShowColorPanel] = useState(true);

    // ─ Alignment state ─
    const [aligningPageId, setAligningPageId] = useState(null);
    const [alignmentProgress, setAlignmentProgress] = useState({});

    // ─ chapters ─
    const [chapters, setChapters] = useState([]);
    const [assigningChapter, setAssigningChapter] = useState(null);
    const [rangeStart, setRangeStart] = useState(null);

    // ─ upload ─
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadResult, setUploadResult] = useState(null);

    // ─ alignment preview ─
    const [previewPageIndex, setPreviewPageIndex] = useState(null);
    const [previewMode, setPreviewMode] = useState('side'); // 'side' | 'overlay' | 'difference'
    const previewCanvasRef = useRef(null);

    useEffect(() => {
        if (session && mangaSlug) {
            getTomes(mangaSlug).then(res => {
                setTomes(res.data.sort((a, b) => b.numero - a.numero));
            }).catch(() => { });
        }
    }, [session, mangaSlug]);

    // cleanup alignment worker on unmount
    useEffect(() => () => terminateAlignmentWorker(), []);

    // ── STEP 1: Extraction ──────────────────────────────────────────────────

    const handleBwFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setExtracting(true);
        setExtractProgress(0);
        setExtractLabel('Extraction N&B...');
        setError('');

        try {
            const raw = await extractCbz(file, p => setExtractProgress(p));

            setExtractLabel('Génération des miniatures N&B...');
            const extracted = [];
            for (let i = 0; i < raw.length; i++) {
                const thumbUrl = await createThumbnail(raw[i].blob);
                extracted.push({
                    id: crypto.randomUUID(),
                    index: i,
                    filename: raw[i].filename,
                    thumbUrl,
                    blob: raw[i].blob,
                    chapterId: null,
                });
                setExtractProgress(Math.round(((i + 1) / raw.length) * 100));
            }

            setPages(extracted);
        } catch (err) {
            console.error(err);
            setError("Erreur lors de l'extraction du fichier N&B. Vérifiez que c'est un CBZ/ZIP valide.");
        } finally {
            setExtracting(false);
            setExtractLabel('');
        }
    };

    const handleColorFileSelect = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setExtracting(true);
        setExtractProgress(0);
        setExtractLabel('Extraction couleur...');
        setError('');

        try {
            const raw = await extractCbz(file, p => setExtractProgress(p));

            setExtractLabel('Génération des miniatures couleur...');
            const extracted = [];
            for (let i = 0; i < raw.length; i++) {
                const thumbUrl = await createThumbnail(raw[i].blob);
                extracted.push({
                    id: crypto.randomUUID(),
                    index: i,
                    filename: raw[i].filename,
                    thumbUrl,
                    blob: raw[i].blob,
                });
                setExtractProgress(Math.round(((i + 1) / raw.length) * 100));
            }

            setColorPages(extracted);

            // Auto-mapping: 1:1 by position
            buildAutoMapping(pages, extracted);
        } catch (err) {
            console.error(err);
            setError("Erreur lors de l'extraction du fichier couleur.");
        } finally {
            setExtracting(false);
            setExtractLabel('');
        }
    };

    const buildAutoMapping = useCallback((bwPages, colPages) => {
        if (!bwPages.length || !colPages.length) return;

        const mapping = [];
        let colorIdx = 0;

        for (let bwIdx = 0; bwIdx < bwPages.length; bwIdx++) {
            if (colorIdx < colPages.length) {
                mapping.push({
                    colorIndices: [colorIdx],
                    merged: false,
                    transform: null,
                    stats: null,
                    validated: false,
                });
                colorIdx++;
            } else {
                mapping.push(null); // no color for this B&W page
            }
        }

        // If there are leftover color pages, they're probably split double pages
        // Store them as "unassigned" at the end
        if (colorIdx < colPages.length) {
            const remaining = colPages.length - colorIdx;
            // We'll handle these in the merge UI
            mapping._unassignedColorStart = colorIdx;
            mapping._unassignedColorCount = remaining;
        }

        setColorMapping(mapping);
    }, []);

    // rebuild mapping when B&W pages change (and color is already loaded)
    useEffect(() => {
        if (colorPages.length > 0 && pages.length > 0 && colorMapping.length === 0) {
            buildAutoMapping(pages, colorPages);
        }
    }, [pages, colorPages, colorMapping.length, buildAutoMapping]);

    const canProceedToStep2 = pages.length > 0;

    const goToStep2 = () => {
        if (canProceedToStep2) setStep(2);
    };

    // ── STEP 2: Organisation ────────────────────────────────────────────────

    const handlePageClick = useCallback((pageIndex, e) => {
        if (assigningChapter !== null) {
            if (rangeStart === null) {
                setRangeStart(pageIndex);
            } else {
                const start = Math.min(rangeStart, pageIndex);
                const end = Math.max(rangeStart, pageIndex);
                setPages(prev => prev.map((p, i) => {
                    if (i >= start && i <= end) return { ...p, chapterId: assigningChapter };
                    return p;
                }));
                setRangeStart(null);
                setAssigningChapter(null);
            }
            return;
        }

        setSelectedPages(prev => {
            const next = new Set(prev);
            if (e.shiftKey && lastClickedIndex !== null) {
                const start = Math.min(lastClickedIndex, pageIndex);
                const end = Math.max(lastClickedIndex, pageIndex);
                for (let i = start; i <= end; i++) next.add(i);
            } else if (e.ctrlKey || e.metaKey) {
                if (next.has(pageIndex)) next.delete(pageIndex);
                else next.add(pageIndex);
            } else {
                next.clear();
                next.add(pageIndex);
            }
            return next;
        });
        setLastClickedIndex(pageIndex);
    }, [assigningChapter, rangeStart, lastClickedIndex]);

    const handleDeleteSelected = () => {
        if (selectedPages.size === 0) return;
        const deletedIndices = new Set(selectedPages);
        setPages(prev => prev.filter((_, i) => !deletedIndices.has(i)));
        // Adjust color mapping
        setColorMapping(prev => prev.filter((_, i) => !deletedIndices.has(i)));
        setSelectedPages(new Set());
        setLastClickedIndex(null);
    };

    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key === 'Delete' && selectedPages.size > 0 && step === 2) {
                e.preventDefault();
                handleDeleteSelected();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedPages, step]);

    // ─ Chapters ─

    const addChapter = () => {
        const maxNum = chapters.reduce((max, c) => Math.max(max, c.numero), 0);
        setChapters(prev => [...prev, {
            id: crypto.randomUUID(),
            numero: maxNum + 1,
            titre: `Chapitre ${maxNum + 1}`,
            colorIndex: prev.length % CHAPTER_COLORS.length,
        }]);
    };

    const removeChapter = (chapterId) => {
        setChapters(prev => prev.filter(c => c.id !== chapterId));
        setPages(prev => prev.map(p => p.chapterId === chapterId ? { ...p, chapterId: null } : p));
        if (assigningChapter === chapterId) {
            setAssigningChapter(null);
            setRangeStart(null);
        }
    };

    const updateChapter = (chapterId, field, value) => {
        setChapters(prev => prev.map(c => c.id === chapterId ? { ...c, [field]: value } : c));
    };

    const startAssigning = (chapterId) => {
        if (assigningChapter === chapterId) {
            setAssigningChapter(null);
            setRangeStart(null);
        } else {
            setAssigningChapter(chapterId);
            setRangeStart(null);
        }
    };

    const getChapterForPage = (page) => {
        if (!page.chapterId) return null;
        return chapters.find(c => c.id === page.chapterId);
    };

    // ─ Color merge / unmerge ─

    const mergeColorPages = (bwIndex) => {
        setColorMapping(prev => {
            const next = [...prev];
            const current = next[bwIndex];
            if (!current) return prev;

            // Find next B&W page that has a color mapping
            let nextColorIdx = null;
            for (let i = bwIndex + 1; i < next.length; i++) {
                if (next[i] && next[i].colorIndices.length > 0) {
                    nextColorIdx = i;
                    break;
                }
            }
            if (nextColorIdx === null) return prev;

            // Merge: take the next page's color indices and append them
            const stolen = next[nextColorIdx].colorIndices;
            next[bwIndex] = {
                ...current,
                colorIndices: [...current.colorIndices, ...stolen],
                merged: true,
                transform: null,
                stats: null,
                validated: false,
            };

            // Remove the donated mapping, shift everything down
            next[nextColorIdx] = null;

            // Re-compact: shift remaining color mappings up to fill the gap
            // But we don't shift B&W pages themselves, only the color associations
            // Actually: we set next[nextColorIdx] to null, meaning that B&W page loses its color
            // Then shift all subsequent mappings down by 1 to re-align
            const compacted = [];
            for (let i = 0; i < next.length; i++) {
                if (i === nextColorIdx) continue; // skip the donated slot
                compacted.push(next[i]);
            }
            // Pad back to pages.length
            while (compacted.length < pages.length) compacted.push(null);

            return compacted;
        });
    };

    const unmergeColorPages = (bwIndex) => {
        setColorMapping(prev => {
            const next = [...prev];
            const current = next[bwIndex];
            if (!current || current.colorIndices.length < 2) return prev;

            // Split: keep first color index, push second back
            const [first, ...rest] = current.colorIndices;
            next[bwIndex] = {
                ...current,
                colorIndices: [first],
                merged: false,
                transform: null,
                stats: null,
                validated: false,
            };

            // Insert the rest back as a new mapping after this index
            const newMapping = {
                colorIndices: rest,
                merged: rest.length > 1,
                transform: null,
                stats: null,
                validated: false,
            };

            next.splice(bwIndex + 1, 0, newMapping);

            // Trim to pages.length (might have one extra now)
            if (next.length > pages.length) {
                // There's now an extra color mapping, which is fine
                // We allow colorMapping to be >= pages.length temporarily
            }

            return next;
        });
    };

    // ─ Alignment ─

    const runAlignment = async (bwIndex) => {
        const mapping = colorMapping[bwIndex];
        if (!mapping || mapping.colorIndices.length === 0) return;

        const pageId = pages[bwIndex].id;
        setAligningPageId(pageId);

        try {
            await initAlignmentWorker();

            // Load B&W image
            const bwImg = await loadImageFromBlob(pages[bwIndex].blob);
            const bwImageData = imageToImageData(bwImg, 1500);

            // Load color image (merge if needed)
            let colorBlob;
            if (mapping.merged && mapping.colorIndices.length > 1) {
                colorBlob = await mergeColorBlobs(mapping.colorIndices.map(i => colorPages[i].blob));
            } else {
                colorBlob = colorPages[mapping.colorIndices[0]].blob;
            }
            const colorImg = await loadImageFromBlob(colorBlob);
            const colorImageData = imageToImageData(colorImg, 1500);

            const result = await alignPages(bwImageData, colorImageData, pageId, (progress) => {
                setAlignmentProgress(prev => ({ ...prev, [pageId]: progress }));
            });

            setColorMapping(prev => {
                const next = [...prev];
                next[bwIndex] = {
                    ...next[bwIndex],
                    transform: result.transform,
                    stats: result.stats,
                    validated: false,
                };
                return next;
            });
        } catch (err) {
            console.error('Alignment error:', err);
            setError(`Erreur alignement page ${bwIndex + 1}: ${err.message}`);
        } finally {
            setAligningPageId(null);
        }
    };

    const validateAlignment = (bwIndex) => {
        setColorMapping(prev => {
            const next = [...prev];
            if (next[bwIndex]) {
                next[bwIndex] = { ...next[bwIndex], validated: true };
            }
            return next;
        });
    };

    async function mergeColorBlobs(blobs) {
        const images = await Promise.all(blobs.map(b => loadImageFromBlob(b)));
        const totalW = images.reduce((sum, img) => sum + img.width, 0);
        const maxH = Math.max(...images.map(img => img.height));

        const canvas = document.createElement('canvas');
        canvas.width = totalW;
        canvas.height = maxH;
        const ctx = canvas.getContext('2d');

        let x = 0;
        for (const img of images) {
            ctx.drawImage(img, x, 0);
            x += img.width;
        }

        return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }

    // ─ Run alignment for all pages ─
    const runAllAlignments = async () => {
        for (let i = 0; i < pages.length; i++) {
            const mapping = colorMapping[i];
            if (mapping && mapping.colorIndices.length > 0 && !mapping.transform) {
                await runAlignment(i);
            }
        }
    };

    // ── STEP 2→3: Process & Upload ──────────────────────────────────────────

    const processAndUpload = async () => {
        const unassigned = pages.filter(p => !p.chapterId);
        if (unassigned.length > 0) {
            setError(`${unassigned.length} page(s) non assignée(s) à un chapitre.`);
            return;
        }
        if (!selectedTome) {
            setError("Veuillez sélectionner un tome.");
            return;
        }

        setUploading(true);
        setUploadProgress(0);
        setError('');

        // Count total work: for each page, process BW + maybe color, then upload BW + maybe color, then 1 DB call
        const colorCount = colorMapping.filter(m => m && m.colorIndices.length > 0).length;
        const totalSteps = pages.length + colorCount + (pages.length + colorCount) + 1;
        let currentStep = 0;

        try {
            const processedPages = [];
            setUploadStatus('Traitement des images N&B...');

            // Detect AVIF support once
            const testCanvas = document.createElement('canvas');
            testCanvas.width = 1; testCanvas.height = 1;
            const supportsAvif = await new Promise(resolve => {
                testCanvas.toBlob(b => resolve(!!b), 'image/avif', 0.35);
            });
            const ext = supportsAvif ? 'avif' : 'webp';
            const mime = supportsAvif ? 'image/avif' : 'image/webp';
            const quality = supportsAvif ? 0.82 : 0.85;

            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                const img = await loadImageFromBlob(page.blob);

                const targetHeight = 1500;
                const scale = targetHeight / img.height;
                const targetWidth = Math.round(img.width * scale);

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));

                const chapter = chapters.find(c => c.id === page.chapterId);
                const pageNumInChapter = pages
                    .filter(p => p.chapterId === page.chapterId)
                    .indexOf(page) + 1;

                const key = `tome-${selectedTome}/chapitre-${chapter.numero}/${pageNumInChapter}.${ext}`;

                const processed = {
                    bwBlob: blob,
                    bwKey: key,
                    contentType: mime,
                    chapterId: page.chapterId,
                    pageNum: pageNumInChapter,
                    bwWidth: targetWidth,
                    bwHeight: targetHeight,
                    colorBlob: null,
                    colorKey: null,
                    colorCropData: null,
                    colorSourcePages: null,
                };

                // Process color variant if available
                const mapping = colorMapping[i];
                if (mapping && mapping.colorIndices.length > 0) {
                    setUploadStatus(`Traitement couleur page ${i + 1}...`);

                    let colorBlobSrc;
                    if (mapping.merged && mapping.colorIndices.length > 1) {
                        colorBlobSrc = await mergeColorBlobs(mapping.colorIndices.map(idx => colorPages[idx].blob));
                    } else {
                        colorBlobSrc = colorPages[mapping.colorIndices[0]].blob;
                    }

                    const colorImg = await loadImageFromBlob(colorBlobSrc);

                    let colorCanvas;
                    if (mapping.transform) {
                        // Apply the affine transform: warp color to match B&W dimensions
                        const bitmap = await createImageBitmap(colorBlobSrc);
                        colorCanvas = applyTransformOffscreen(bitmap, mapping.transform, targetWidth, targetHeight);
                    } else {
                        // No alignment: just resize to same height, center-crop width
                        const colScale = targetHeight / colorImg.height;
                        const colW = Math.round(colorImg.width * colScale);
                        colorCanvas = document.createElement('canvas');
                        colorCanvas.width = targetWidth;
                        colorCanvas.height = targetHeight;
                        const cCtx = colorCanvas.getContext('2d');
                        const offsetX = Math.round((colW - targetWidth) / 2);
                        cCtx.drawImage(colorImg, -offsetX, 0, colW, targetHeight);
                    }

                    const colorProcessedBlob = await new Promise(resolve => {
                        if (colorCanvas instanceof OffscreenCanvas) {
                            colorCanvas.convertToBlob({ type: mime, quality }).then(resolve);
                        } else {
                            colorCanvas.toBlob(resolve, mime, quality);
                        }
                    });

                    const colorKey = `tome-${selectedTome}/chapitre-${chapter.numero}/${pageNumInChapter}-color.${ext}`;

                    processed.colorBlob = colorProcessedBlob;
                    processed.colorKey = colorKey;
                    processed.colorCropData = mapping.transform ? {
                        affine: mapping.transform,
                        manual_offset_x: 0,
                        manual_offset_y: 0,
                    } : null;
                    processed.colorSourcePages = mapping.colorIndices.map(idx => ({
                        cbz_index: idx,
                        filename: colorPages[idx].filename,
                    }));

                    currentStep++;
                }

                processedPages.push(processed);
                currentStep++;
                setUploadProgress(Math.round((currentStep / totalSteps) * 100));
            }

            // Upload to R2
            setUploadStatus('Téléversement vers le stockage...');
            const uploadedUrls = {};
            const CONCURRENCY = 3;

            // Collect all upload jobs
            const uploadJobs = [];
            for (const p of processedPages) {
                uploadJobs.push({ blob: p.bwBlob, key: p.bwKey, contentType: p.contentType });
                if (p.colorBlob) {
                    uploadJobs.push({ blob: p.colorBlob, key: p.colorKey, contentType: p.contentType });
                }
            }

            for (let i = 0; i < uploadJobs.length; i += CONCURRENCY) {
                const batch = uploadJobs.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (job) => {
                    const formData = new FormData();
                    formData.append('file', job.blob, `page.${job.contentType.split('/')[1]}`);
                    formData.append('key', job.key);
                    const { data } = await uploadPageToR2(formData);
                    uploadedUrls[job.key] = data.url;
                }));
                currentStep += batch.length;
                setUploadProgress(Math.round((currentStep / totalSteps) * 100));
            }

            // Create DB entries
            setUploadStatus('Création des entrées en base de données...');

            const chaptersPayload = chapters.map(chapter => {
                const chapterPages = processedPages
                    .filter(p => p.chapterId === chapter.id)
                    .map(p => {
                        const pageData = {
                            numero_page: p.pageNum,
                            url_image: uploadedUrls[p.bwKey],
                        };
                        if (p.colorKey && uploadedUrls[p.colorKey]) {
                            pageData.url_image_color = uploadedUrls[p.colorKey];
                            pageData.color_crop_data = p.colorCropData;
                            pageData.color_validated = !!p.colorCropData;
                            pageData.color_source_pages = p.colorSourcePages;
                        }
                        return pageData;
                    });

                return {
                    numero: chapter.numero,
                    titre: chapter.titre,
                    pages: chapterPages,
                };
            });

            const { data: result } = await batchCreatePages({
                tome_id: selectedTome,
                chapters: chaptersPayload,
            });

            setUploadProgress(100);
            setUploadResult(result);
            setStep(3);
        } catch (err) {
            console.error('Upload error:', err);
            setError(err.response?.data?.error || err.message || "Erreur lors du téléversement.");
        } finally {
            setUploading(false);
        }
    };

    // ── Derived values ──────────────────────────────────────────────────────

    const selectedTomeObj = tomes.find(t => String(t.id) === selectedTome);
    const assignedCount = pages.filter(p => p.chapterId).length;
    const assigningChapterObj = chapters.find(c => c.id === assigningChapter);
    const hasColor = colorPages.length > 0;
    const colorPagesAligned = colorMapping.filter(m => m && m.transform).length;
    const colorPagesValidated = colorMapping.filter(m => m && m.validated).length;
    const colorPagesTotal = colorMapping.filter(m => m && m.colorIndices.length > 0).length;
    const unassignedColorCount = colorMapping._unassignedColorCount || 0;

    // ── RENDER ──────────────────────────────────────────────────────────────

    return (
        <div className="container max-w-7xl mx-auto py-10 px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Header */}
            <div className="flex items-center gap-4 pb-6 border-b border-slate-200">
                <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                    <Button variant="ghost" size="icon" className="shrink-0">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
                        Upload Tome
                    </h1>
                    <p className="text-slate-500 mt-1">
                        Importez un tome complet (.cbz), avec variante couleur optionnelle.
                    </p>
                </div>
            </div>

            {/* Step indicators */}
            <div className="flex items-center gap-2 mb-8">
                {[1, 2, 3].map(s => (
                    <React.Fragment key={s}>
                        <div className={`flex items-center justify-center w-10 h-10 rounded-full font-bold text-sm transition-all duration-300 ${step >= s
                            ? 'bg-slate-900 text-white shadow-lg shadow-slate-900/20'
                            : 'bg-slate-100 text-slate-400'
                            }`}>
                            {step > s ? <CheckCircle2 className="h-5 w-5" /> : s}
                        </div>
                        <span className={`text-sm font-medium ${step >= s ? 'text-slate-700' : 'text-slate-400'}`}>
                            {s === 1 && 'Extraction'}
                            {s === 2 && 'Organisation'}
                            {s === 3 && 'Terminé'}
                        </span>
                        {s < 3 && <div className={`flex-1 h-0.5 rounded ${step > s ? 'bg-slate-900' : 'bg-slate-200'}`} />}
                    </React.Fragment>
                ))}
            </div>

            {error && (
                <Alert variant="destructive" className="animate-in fade-in slide-in-from-top-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {/* ═══════════ STEP 1: Extraction ═══════════ */}
            {step === 1 && (
                <div className="space-y-6">
                    <Card className="border-slate-200 shadow-xl shadow-slate-200/50">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-2xl">
                                <FileArchive className="h-6 w-6 text-slate-700" />
                                Fichiers source
                            </CardTitle>
                            <CardDescription>
                                Sélectionnez le CBZ noir & blanc (obligatoire) et le CBZ couleur (optionnel).
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* Tome selector */}
                            <div className="space-y-2">
                                <Label>Tome cible</Label>
                                <Select value={selectedTome} onValueChange={setSelectedTome}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="-- Sélectionner un tome --" />
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

                            {/* Two file inputs side by side */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* B&W file */}
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                        <div className="w-3 h-3 rounded-full bg-slate-800" />
                                        <Label className="text-base font-semibold">Version N&B (français)</Label>
                                    </div>
                                    <Input
                                        type="file"
                                        accept=".cbz,.zip"
                                        onChange={handleBwFileSelect}
                                        disabled={extracting || !selectedTome}
                                        className="cursor-pointer file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                                    />
                                    {pages.length > 0 && (
                                        <div className="flex items-center gap-2 text-sm text-emerald-600">
                                            <CheckCircle2 className="h-4 w-4" />
                                            {pages.length} pages extraites
                                        </div>
                                    )}
                                </div>

                                {/* Color file */}
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                        <Palette className="w-4 h-4 text-rose-500" />
                                        <Label className="text-base font-semibold">Version Couleur (japonais, optionnel)</Label>
                                    </div>
                                    <Input
                                        type="file"
                                        accept=".cbz,.zip"
                                        onChange={handleColorFileSelect}
                                        disabled={extracting || !selectedTome || pages.length === 0}
                                        className="cursor-pointer file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-rose-50 file:text-rose-700 hover:file:bg-rose-100"
                                    />
                                    {colorPages.length > 0 && (
                                        <div className="flex items-center gap-2 text-sm">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                            <span className="text-emerald-600">{colorPages.length} pages couleur extraites</span>
                                            {colorPages.length !== pages.length && (
                                                <span className="text-amber-600 text-xs">
                                                    ({colorPages.length > pages.length ? `+${colorPages.length - pages.length} pages de plus` : `${pages.length - colorPages.length} pages manquantes`})
                                                </span>
                                            )}
                                        </div>
                                    )}
                                    {pages.length === 0 && (
                                        <p className="text-xs text-slate-400">Importez d'abord le CBZ N&B.</p>
                                    )}
                                </div>
                            </div>

                            {/* Extraction progress */}
                            {extracting && (
                                <div className="space-y-2">
                                    <div className="flex justify-between text-sm text-slate-500">
                                        <span>{extractLabel || 'Extraction en cours...'}</span>
                                        <span>{extractProgress}%</span>
                                    </div>
                                    <Progress value={extractProgress} className="h-2" />
                                </div>
                            )}

                            {/* Mapping preview */}
                            {pages.length > 0 && colorPages.length > 0 && (
                                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 space-y-3">
                                    <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                                        <Info className="h-4 w-4" />
                                        Association automatique
                                    </h3>
                                    <p className="text-xs text-slate-500">
                                        Les pages couleur ont été associées aux pages N&B par position (1:1).
                                        {unassignedColorCount > 0 && (
                                            <span className="text-amber-600 font-medium">
                                                {' '}{unassignedColorCount} page(s) couleur en excès (probablement des doubles pages séparées).
                                                Vous pourrez les fusionner à l'étape suivante.
                                            </span>
                                        )}
                                    </p>

                                    {/* Small preview grid: first 8 pairs */}
                                    <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                                        {pages.slice(0, 8).map((page, i) => {
                                            const mapping = colorMapping[i];
                                            const colorPage = mapping && mapping.colorIndices.length > 0
                                                ? colorPages[mapping.colorIndices[0]]
                                                : null;
                                            return (
                                                <div key={page.id} className="space-y-1">
                                                    <div className="relative aspect-[2/3] rounded overflow-hidden border border-slate-200">
                                                        <img src={page.thumbUrl} alt="" className="w-full h-full object-cover" />
                                                    </div>
                                                    {colorPage && (
                                                        <div className="relative aspect-[2/3] rounded overflow-hidden border border-rose-200">
                                                            <img src={colorPage.thumbUrl} alt="" className="w-full h-full object-cover" />
                                                        </div>
                                                    )}
                                                    <p className="text-[10px] text-slate-400 text-center">{i + 1}</p>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {pages.length > 8 && (
                                        <p className="text-xs text-slate-400 text-center">...et {pages.length - 8} pages de plus</p>
                                    )}
                                </div>
                            )}

                            {/* Go to step 2 */}
                            <Button
                                className="w-full bg-slate-900 hover:bg-slate-800 text-white shadow-lg"
                                size="lg"
                                disabled={!canProceedToStep2 || extracting}
                                onClick={goToStep2}
                            >
                                <ArrowRight className="h-4 w-4 mr-2" />
                                Organiser les pages ({pages.length} N&B{hasColor ? ` + ${colorPages.length} couleur` : ''})
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* ═══════════ STEP 2: Organisation ═══════════ */}
            {step === 2 && (
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6">
                    <div className="space-y-4">
                        {/* Header bar */}
                        <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-3">
                                <h2 className="text-xl font-bold text-slate-900">
                                    Pages ({pages.length})
                                </h2>
                                {assignedCount < pages.length && (
                                    <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-1 rounded-full border border-amber-200">
                                        {pages.length - assignedCount} non assignée(s)
                                    </span>
                                )}
                                {hasColor && (
                                    <span className="text-xs font-medium text-rose-700 bg-rose-50 px-2 py-1 rounded-full border border-rose-200">
                                        {colorPagesTotal} couleur ({colorPagesAligned} alignées, {colorPagesValidated} validées)
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {hasColor && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setShowColorPanel(v => !v)}
                                        className="text-xs"
                                    >
                                        <Palette className="h-3.5 w-3.5 mr-1" />
                                        {showColorPanel ? 'Masquer couleur' : 'Afficher couleur'}
                                    </Button>
                                )}
                                {hasColor && colorPagesTotal > 0 && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={runAllAlignments}
                                        disabled={aligningPageId !== null}
                                        className="text-xs"
                                    >
                                        {aligningPageId ? (
                                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                        ) : (
                                            <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                        )}
                                        Aligner tout
                                    </Button>
                                )}
                                {selectedPages.size > 0 && (
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        onClick={handleDeleteSelected}
                                        className="animate-in fade-in zoom-in-95"
                                    >
                                        <Trash2 className="h-4 w-4 mr-1" />
                                        Supprimer ({selectedPages.size})
                                    </Button>
                                )}
                            </div>
                        </div>

                        {/* Assigning banner */}
                        {assigningChapter && (
                            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].border
                                } ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].bg} animate-in fade-in slide-in-from-top-2`}>
                                <MousePointerClick className={`h-5 w-5 ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].text}`} />
                                <p className={`text-sm font-medium ${CHAPTER_COLORS[assigningChapterObj?.colorIndex || 0].text}`}>
                                    {rangeStart === null
                                        ? `Cliquez sur la première page pour "${assigningChapterObj?.titre}"`
                                        : `Cliquez sur la dernière page du range (début: page ${rangeStart + 1})`
                                    }
                                </p>
                                <Button variant="ghost" size="sm" onClick={() => { setAssigningChapter(null); setRangeStart(null); }}>
                                    <X className="h-4 w-4" /> Annuler
                                </Button>
                            </div>
                        )}

                        {/* Page grid */}
                        <div className={`grid gap-3 ${hasColor && showColorPanel
                            ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'
                            : 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6'
                            }`}>
                            {pages.map((page, index) => {
                                const chapter = getChapterForPage(page);
                                const colorSet = chapter ? CHAPTER_COLORS[chapter.colorIndex] : null;
                                const isSelected = selectedPages.has(index);
                                const isRangeStart = assigningChapter && rangeStart === index;
                                const mapping = colorMapping[index];
                                const colorPage = mapping && mapping.colorIndices.length > 0
                                    ? colorPages[mapping.colorIndices[0]]
                                    : null;
                                const isAligning = aligningPageId === page.id;
                                const hasTransform = mapping && mapping.transform;
                                const isValidated = mapping && mapping.validated;

                                return (
                                    <div key={page.id} className="space-y-1">
                                        {/* B&W Page */}
                                        <div
                                            onClick={(e) => handlePageClick(index, e)}
                                            className={`relative group cursor-pointer rounded-xl overflow-hidden border-2 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 ${isRangeStart
                                                ? 'border-yellow-400 ring-2 ring-yellow-300 shadow-lg shadow-yellow-100'
                                                : isSelected
                                                    ? 'border-blue-500 ring-2 ring-blue-300 shadow-lg shadow-blue-100'
                                                    : colorSet
                                                        ? `${colorSet.border} ${colorSet.bg}`
                                                        : 'border-slate-200 hover:border-slate-300'
                                                }`}
                                        >
                                            {colorSet && (
                                                <div className={`absolute top-0 left-0 right-0 h-1 ${colorSet.ribbon} z-10`} />
                                            )}

                                            <div className="aspect-[2/3] bg-slate-50 relative overflow-hidden">
                                                <img
                                                    src={page.thumbUrl}
                                                    alt={`Page ${index + 1}`}
                                                    className="w-full h-full object-cover"
                                                    loading="lazy"
                                                />
                                                <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                            </div>

                                            <div className="px-2 py-1.5 bg-white/90 backdrop-blur-sm">
                                                <p className="text-xs font-semibold text-slate-700 text-center truncate">
                                                    {index + 1}
                                                    {chapter && (
                                                        <span className={`ml-1 ${colorSet.text}`}>
                                                            · Ch.{chapter.numero}
                                                        </span>
                                                    )}
                                                </p>
                                            </div>

                                            {isSelected && (
                                                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold shadow-lg">
                                                    ✓
                                                </div>
                                            )}
                                        </div>

                                        {/* Color variant */}
                                        {hasColor && showColorPanel && (
                                            <div className={`relative rounded-lg overflow-hidden border-2 transition-all ${isValidated
                                                ? 'border-emerald-400 bg-emerald-50'
                                                : hasTransform
                                                    ? 'border-amber-300 bg-amber-50'
                                                    : colorPage
                                                        ? 'border-rose-200 bg-rose-50'
                                                        : 'border-dashed border-slate-200 bg-slate-50'
                                                }`}>
                                                {colorPage ? (
                                                    <>
                                                        <div className="aspect-[2/3] relative overflow-hidden">
                                                            <img
                                                                src={colorPage.thumbUrl}
                                                                alt={`Color ${index + 1}`}
                                                                className="w-full h-full object-cover"
                                                                loading="lazy"
                                                            />
                                                            {isAligning && (
                                                                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                                                    <Loader2 className="h-6 w-6 text-white animate-spin" />
                                                                </div>
                                                            )}
                                                            {/* Status indicator */}
                                                            <div className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold ${isValidated
                                                                ? 'bg-emerald-500'
                                                                : hasTransform
                                                                    ? 'bg-amber-500'
                                                                    : 'bg-slate-400'
                                                                }`}>
                                                                {isValidated ? '✓' : hasTransform ? '~' : '?'}
                                                            </div>
                                                            {/* Merged indicator */}
                                                            {mapping?.merged && (
                                                                <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-purple-500 text-white text-[9px] font-bold rounded">
                                                                    2→1
                                                                </div>
                                                            )}
                                                        </div>
                                                        {/* Color page actions */}
                                                        <div className="flex items-center gap-0.5 p-1 bg-white/90">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6"
                                                                onClick={(e) => { e.stopPropagation(); runAlignment(index); }}
                                                                disabled={isAligning}
                                                                title="Aligner"
                                                            >
                                                                <RotateCcw className="h-3 w-3" />
                                                            </Button>
                                                            {hasTransform && !isValidated && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-6 w-6 text-emerald-600"
                                                                    onClick={(e) => { e.stopPropagation(); validateAlignment(index); }}
                                                                    title="Valider l'alignement"
                                                                >
                                                                    <Check className="h-3 w-3" />
                                                                </Button>
                                                            )}
                                                            {!mapping?.merged && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-6 w-6 text-purple-600"
                                                                    onClick={(e) => { e.stopPropagation(); mergeColorPages(index); }}
                                                                    title="Fusionner avec la page couleur suivante"
                                                                >
                                                                    <Merge className="h-3 w-3" />
                                                                </Button>
                                                            )}
                                                            {mapping?.merged && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-6 w-6 text-orange-600"
                                                                    onClick={(e) => { e.stopPropagation(); unmergeColorPages(index); }}
                                                                    title="Séparer les pages fusionnées"
                                                                >
                                                                    <Unlink className="h-3 w-3" />
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </>
                                                ) : (
                                                    <div className="aspect-[2/3] flex items-center justify-center">
                                                        <span className="text-[10px] text-slate-400">Pas de couleur</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ─ Sidebar: Chapters ─ */}
                    <div className="space-y-4">
                        <Card className="border-slate-200 shadow-lg sticky top-24 max-h-[calc(100vh-8rem)] flex flex-col">
                            <CardHeader className="pb-4">
                                <CardTitle className="flex items-center gap-2 text-lg">
                                    <Layers className="h-5 w-5 text-slate-600" />
                                    Chapitres
                                </CardTitle>
                                <CardDescription className="text-sm">
                                    Définissez les chapitres et assignez-leur des plages de pages.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 overflow-y-auto flex-1">
                                {selectedTomeObj && (
                                    <div className="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                                        Tome {selectedTomeObj.numero} — {selectedTomeObj.titre}
                                    </div>
                                )}

                                {chapters.length === 0 && (
                                    <div className="text-center py-6 text-slate-400">
                                        <Layers className="h-8 w-8 mx-auto mb-2 opacity-50" />
                                        <p className="text-sm">Aucun chapitre défini</p>
                                    </div>
                                )}

                                {chapters.map(chapter => {
                                    const colorSet = CHAPTER_COLORS[chapter.colorIndex];
                                    const chapterPages = pages.filter(p => p.chapterId === chapter.id);
                                    const isAssigning = assigningChapter === chapter.id;

                                    return (
                                        <div
                                            key={chapter.id}
                                            className={`rounded-xl border-2 p-3 space-y-2 transition-all ${isAssigning
                                                ? `${colorSet.border} ${colorSet.bg} shadow-md`
                                                : 'border-slate-200 hover:border-slate-300'
                                                }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <div className={`w-3 h-3 rounded-full ${colorSet.ribbon}`} />
                                                <Input
                                                    value={chapter.numero}
                                                    onChange={(e) => updateChapter(chapter.id, 'numero', parseInt(e.target.value) || 0)}
                                                    className="w-16 h-8 text-xs font-bold text-center"
                                                    type="number"
                                                />
                                                <Input
                                                    value={chapter.titre}
                                                    onChange={(e) => updateChapter(chapter.id, 'titre', e.target.value)}
                                                    className="flex-1 h-8 text-xs"
                                                    placeholder="Titre"
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 text-slate-400 hover:text-red-500"
                                                    onClick={() => removeChapter(chapter.id)}
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>

                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-slate-500">
                                                    {chapterPages.length} page(s)
                                                </span>
                                                <Button
                                                    variant={isAssigning ? "default" : "outline"}
                                                    size="sm"
                                                    className={`h-7 text-xs ${isAssigning ? colorSet.ribbon + ' text-white' : ''}`}
                                                    onClick={() => startAssigning(chapter.id)}
                                                >
                                                    <MousePointerClick className="h-3 w-3 mr-1" />
                                                    {isAssigning ? 'Assignation...' : 'Assigner pages'}
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}

                                <Button
                                    variant="outline"
                                    className="w-full border-dashed border-slate-300 hover:border-slate-400"
                                    onClick={addChapter}
                                >
                                    <Plus className="h-4 w-4 mr-2" />
                                    Ajouter un chapitre
                                </Button>

                                {/* Color summary in sidebar */}
                                {hasColor && (
                                    <div className="bg-rose-50 rounded-lg p-3 border border-rose-200 space-y-1">
                                        <p className="text-xs font-semibold text-rose-700 flex items-center gap-1">
                                            <Palette className="h-3.5 w-3.5" />
                                            Variantes couleur
                                        </p>
                                        <div className="text-xs text-rose-600 space-y-0.5">
                                            <p>{colorPagesTotal} / {pages.length} pages avec couleur</p>
                                            <p>{colorPagesAligned} alignées · {colorPagesValidated} validées</p>
                                        </div>
                                    </div>
                                )}

                                <div className="pt-4 border-t border-slate-200">
                                    <Button
                                        className="w-full bg-slate-900 hover:bg-slate-800 text-white shadow-lg"
                                        size="lg"
                                        disabled={uploading || chapters.length === 0 || assignedCount < pages.length}
                                        onClick={processAndUpload}
                                    >
                                        {uploading ? (
                                            <>
                                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                {uploadStatus}
                                            </>
                                        ) : (
                                            <>
                                                <Upload className="h-4 w-4 mr-2" />
                                                Traiter & Uploader ({pages.length} pages{hasColor ? ` + ${colorPagesTotal} couleur` : ''})
                                            </>
                                        )}
                                    </Button>

                                    {uploading && (
                                        <div className="mt-3 space-y-1">
                                            <Progress value={uploadProgress} className="h-2" />
                                            <p className="text-xs text-slate-500 text-center">{uploadProgress}%</p>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ═══════════ STEP 3: Done ═══════════ */}
            {step === 3 && (
                <Card className="border-slate-200 shadow-xl max-w-2xl mx-auto">
                    <CardContent className="py-12 text-center space-y-6">
                        <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-slate-900">Upload terminé !</h2>
                            <p className="text-slate-500 mt-2">
                                {uploadResult?.message || "Toutes les pages ont été traitées et uploadées avec succès."}
                            </p>
                        </div>

                        {uploadResult?.results && (
                            <div className="text-left bg-slate-50 rounded-xl p-4 space-y-2">
                                {uploadResult.results.map((r, i) => (
                                    <div key={i} className="flex items-center justify-between text-sm">
                                        <span className="font-medium text-slate-700">Chapitre {r.numero}</span>
                                        {r.error ? (
                                            <span className="text-red-500 text-xs">{r.error}</span>
                                        ) : (
                                            <span className="text-emerald-600">
                                                {r.pages} pages
                                                {r.color_pages > 0 && ` + ${r.color_pages} couleur`}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex gap-3 justify-center pt-4">
                            <Link href={`/${params.mangaSlug}/admin?tab=content`}>
                                <Button variant="outline">
                                    <ArrowLeft className="h-4 w-4 mr-2" />
                                    Retour admin
                                </Button>
                            </Link>
                            <Button onClick={() => {
                                setStep(1); setPages([]); setChapters([]); setUploadResult(null);
                                setSelectedTome(''); setColorPages([]); setColorMapping([]);
                            }}>
                                <Plus className="h-4 w-4 mr-2" />
                                Nouveau tome
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
