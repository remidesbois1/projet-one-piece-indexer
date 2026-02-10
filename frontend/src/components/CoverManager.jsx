"use client";

import React, { useState, useEffect } from 'react';
import { useManga } from '@/context/MangaContext';
import { getCovers, uploadCover } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Image as ImageIcon, Upload, CheckCircle2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const CoverManager = () => {
    const { mangaSlug } = useManga();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [uploading, setUploading] = useState(null); // id of item being uploaded

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
            <div className="flex justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
            </div>
        );
    }

    if (!data) return null;

    return (
        <Card className="border-none shadow-none bg-slate-50/50 overflow-hidden">
            <CardHeader className="bg-transparent border-none">
                <CardTitle className="flex items-center gap-2 text-2xl font-bold">
                    <ImageIcon className="h-6 w-6 text-indigo-600" />
                    Identité Visuelle
                </CardTitle>
                <CardDescription className="text-base text-slate-500 mt-2">
                    Personnalisez les couvertures du manga et de ses différents volumes.
                </CardDescription>
            </CardHeader>

            <CardContent className="p-6 space-y-8">
                {/* Manga Cover */}
                <div className="space-y-4">
                    <h3 className="font-semibold text-slate-900">Couverture du Manga</h3>
                    <div className="flex items-start gap-6">
                        <div className="w-32 h-48 bg-slate-100 rounded-lg flex-shrink-0 overflow-hidden border border-slate-200 group relative">
                            {data.manga.cover_url ? (
                                <img src={data.manga.cover_url} alt={data.manga.titre} className="w-full h-full object-cover" />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-slate-400">
                                    <ImageIcon className="h-8 w-8" />
                                </div>
                            )}
                        </div>
                        <div className="space-y-4 flex-1">
                            <div>
                                <p className="font-medium text-slate-700">{data.manga.titre}</p>
                                <p className="text-xs text-slate-500 mt-1">Format recommandé : Portrait (2:3)</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="relative cursor-pointer"
                                    disabled={uploading === data.manga.id}
                                    asChild
                                >
                                    <label>
                                        {uploading === data.manga.id ? (
                                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                                        ) : (
                                            <Upload className="h-4 w-4 mr-2" />
                                        )}
                                        {data.manga.cover_url ? 'Changer' : 'Ajouter'}
                                        <input
                                            type="file"
                                            className="hidden"
                                            accept="image/*"
                                            onChange={(e) => handleUpload('manga', data.manga.id, e.target.files[0])}
                                        />
                                    </label>
                                </Button>
                                {data.manga.cover_url && (
                                    <span className="text-emerald-600 flex items-center text-xs font-medium">
                                        <CheckCircle2 className="h-3 w-3 mr-1" /> Configuré
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                <Separator className="bg-slate-100" />

                {/* Tome Covers */}
                <div className="space-y-4">
                    <h3 className="font-semibold text-slate-900">Couvertures des Tomes</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                        {data.tomes.map((tome) => (
                            <div key={tome.id} className="group flex flex-col items-center gap-3 p-3 rounded-xl border border-slate-100 hover:border-slate-200 transition-all bg-white shadow-sm hover:shadow-md">
                                <div className="w-full aspect-[2/3] bg-slate-50 rounded-lg overflow-hidden border border-slate-100 relative group-hover:bg-slate-100 transition-colors">
                                    {tome.cover_url ? (
                                        <img src={tome.cover_url} alt={`Tome ${tome.numero}`} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-300">
                                            <ImageIcon className="h-8 w-8" />
                                        </div>
                                    )}
                                    <label className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer">
                                        <div className="bg-white p-2 rounded-full text-slate-900 shadow-xl transform scale-90 group-hover:scale-100 transition-transform">
                                            {uploading === tome.id ? (
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                            ) : (
                                                <Upload className="h-5 w-5" />
                                            )}
                                        </div>
                                        <input
                                            type="file"
                                            className="hidden"
                                            accept="image/*"
                                            onChange={(e) => handleUpload('tome', tome.id, e.target.files[0])}
                                            disabled={uploading === tome.id}
                                        />
                                    </label>
                                </div>
                                <div className="text-center">
                                    <p className="font-bold text-sm text-slate-800">Tome {tome.numero}</p>
                                    <p className="text-[10px] text-slate-400 truncate max-w-[120px]">{tome.titre}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
};

export default CoverManager;
