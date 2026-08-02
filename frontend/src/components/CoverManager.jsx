"use client";

import React, { useState, useEffect } from 'react';
import { useManga } from '@/context/MangaContext';
import { getCovers, uploadCover } from '@/lib/api';
import { Loader2, Image as ImageIcon, Upload, CheckCircle2 } from "lucide-react";
import { getCoverThumbnailUrl } from "@/lib/utils";

const CoverManager = () => {
    const { mangaSlug } = useManga();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [uploading, setUploading] = useState(null);

    const fetchCovers = async () => {
        try {
            setLoading(true);
            const res = await getCovers(mangaSlug);
            setData(res.data);
        } catch (error) {
            console.error("Error fetching covers:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (mangaSlug) {
            fetchCovers();
        }
    }, [mangaSlug]);

    const handleUpload = async (type, id, file) => {
        if (!file) return;
        const formData = new FormData();
        formData.append('type', type);
        formData.append('id', id);
        formData.append('cover', file);

        try {
            setUploading(id);
            await uploadCover(formData);
            await fetchCovers();
        } catch (error) {
            console.error("Upload failed:", error);
            alert("Erreur lors de l'upload.");
        } finally {
            setUploading(null);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[#8dbbff]" />
            </div>
        );
    }

    if (!data) return null;

    return (
        <div className="space-y-6">
            {/* Section header */}
            <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#3d86ff]/25 bg-[#3d86ff]/12">
                    <ImageIcon className="h-4 w-4 text-[#8dbbff]" />
                </div>
                <div>
                    <h2 className="font-semibold text-white">Identité Visuelle</h2>
                    <p className="text-xs text-slate-400">Couvertures du manga et des volumes.</p>
                </div>
            </div>

            {/* Manga cover */}
            <Section title="Couverture du Manga">
                <div className="flex items-start gap-6">
                    <CoverTile
                        src={data.manga.cover_url}
                        alt={data.manga.titre}
                        large
                        onUpload={(file) => handleUpload('manga', data.manga.id, file)}
                        uploading={uploading === data.manga.id}
                    />
                    <div className="flex flex-1 flex-col justify-between">
                        <div>
                            <p className="font-medium text-slate-100">{data.manga.titre}</p>
                            <p className="mt-1 text-xs text-slate-500">Format recommandé : Portrait (2:3)</p>
                        </div>
                        {data.manga.cover_url && (
                            <span className="mt-4 flex items-center text-xs font-medium text-emerald-400">
                                <CheckCircle2 className="mr-1 h-3 w-3" /> Configuré
                            </span>
                        )}
                    </div>
                </div>
            </Section>

            {/* Tome covers */}
            <Section title={`Couvertures des Tomes (${data.tomes.length})`}>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {data.tomes.map((tome) => (
                        <div key={tome.id} className="flex flex-col items-center gap-2">
                            <CoverTile
                                src={tome.cover_url}
                                alt={`Tome ${tome.numero}`}
                                onUpload={(file) => handleUpload('tome', tome.id, file)}
                                uploading={uploading === tome.id}
                                label={`Tome ${tome.numero}`}
                            />
                            <div className="text-center">
                                <p className="text-sm font-medium text-slate-200">Tome {tome.numero}</p>
                                <p className="max-w-[120px] truncate text-[10px] text-slate-500">{tome.titre}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
};

function Section({ title, children }) {
    return (
        <div className="rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h3>
            {children}
        </div>
    );
}

function CoverTile({ src, alt, large, onUpload, uploading }) {
    const size = large ? "w-32 h-48" : "w-full aspect-[2/3]";
    return (
        <div className={`group relative ${size} shrink-0 overflow-hidden rounded-xl border border-white/12 bg-[#040d18]`}>
            {src ? (
                <img src={getCoverThumbnailUrl(src, large ? 512 : 360)} alt={alt} className="h-full w-full object-cover" />
            ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-600">
                    <ImageIcon className="h-8 w-8" />
                </div>
            )}
            <label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-900 shadow-xl transition-transform group-hover:scale-105">
                    {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                </div>
                <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => onUpload(e.target.files[0])}
                    disabled={uploading}
                />
            </label>
        </div>
    );
}

export default CoverManager;
