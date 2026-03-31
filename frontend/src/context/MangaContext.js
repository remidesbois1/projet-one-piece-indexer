"use client";
import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const MangaContext = createContext();

export function MangaProvider({ children }) {
    const params = useParams();
    const [mangaSlug, setMangaSlug] = useState(null);
    const [currentManga, setCurrentManga] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (params?.mangaSlug) {
            setMangaSlug(params.mangaSlug);
            fetchMangaDetails(params.mangaSlug);
        } else {
            setLoading(false);
        }
    }, [params]);

    const router = useRouter();

    const fetchMangaDetails = async (slug) => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('mangas')
                .select('*')
                .eq('slug', slug)
                .eq('enabled', true)
                .single();

            if (error || !data) {
                console.error("Manga not found:", slug);
                router.push('/'); 
                return;
            }
            setCurrentManga(data);
        } catch (error) {
            console.error("Error fetching manga:", error);
            router.push('/');
        } finally {
            setLoading(false);
        }
    };

    const value = useMemo(() => ({ mangaSlug, currentManga, loading }), [mangaSlug, currentManga, loading]);

    return (
        <MangaContext.Provider value={value}>
            {children}
        </MangaContext.Provider>
    );
}

export function useManga() {
    return useContext(MangaContext);
}
