"use client";
import React, { createContext, useContext, useEffect, useState } from 'react';
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
                .single();

            if (error || !data) {
                console.error("Manga not found:", slug);
                router.push('/'); // Redirect to home if invalid manga
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

    return (
        <MangaContext.Provider value={{ mangaSlug, currentManga, loading }}>
            {children}
        </MangaContext.Provider>
    );
}

export function useManga() {
    return useContext(MangaContext);
}
