"use client";

import React, { useState, useEffect, useRef } from 'react';
import { searchBubbles, getMetadataSuggestions, getTomes, submitSearchFeedback } from '@/lib/api';
import { getProxiedImageUrl, cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuth } from '@/context/AuthContext';
import Link from 'next/link';
import { useManga } from '@/context/MangaContext';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { Search, X, Loader2, Sparkles, BookOpen, MapPin, Quote, Info, ArrowRight, Settings, Filter, XCircle, Check, ChevronRight } from "lucide-react";

const RESULTS_PER_PAGE = 24;

const PONEGLYPH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateSlots(count, seed = 0) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const s = (seed + i) * 2654435761;
        const hash = (v) => ((s * (v + 1)) >>> 0) / 4294967296;
        slots.push({
            x: 2 + hash(1) * 96,
            y: 2 + hash(2) * 96,
            size: 20 + Math.floor(hash(3) * 30),
            rotate: Math.floor(hash(4) * 80) - 40,
            char: PONEGLYPH_LETTERS[Math.floor(hash(5) * 26)],
            opacity: 0,
        });
    }
    return slots;
}

function PoneglyphHeaderGlyphs({ count = 15, color = "#2F7AAF" }) {
    const [glyphs, setGlyphs] = useState(() => generateSlots(count, Math.random()));

    useEffect(() => {
        const timers = [];
        glyphs.forEach((_, i) => {
            const cycle = () => {
                const delay = 500 + Math.random() * 3000;
                const fadeIn = setTimeout(() => {
                    setGlyphs(prev => prev.map((g, idx) =>
                        idx === i ? { ...g, opacity: 1, char: PONEGLYPH_LETTERS[Math.floor(Math.random() * 26)] } : g
                    ));
                    const stayDuration = 2000 + Math.random() * 4000;
                    const fadeOut = setTimeout(() => {
                        setGlyphs(prev => prev.map((g, idx) =>
                            idx === i ? { ...g, opacity: 0 } : g
                        ));
                        const nextTimer = setTimeout(cycle, 1000 + Math.random() * 2000);
                        timers.push(nextTimer);
                    }, stayDuration);
                    timers.push(fadeOut);
                }, delay);
                timers.push(fadeIn);
            };
            cycle();
        });
        return () => timers.forEach(t => clearTimeout(t));
    }, []);

    return (
        <div className="absolute inset-x-0 top-0 h-64 overflow-hidden pointer-events-none opacity-100">
            {glyphs.map((g, i) => (
                <span
                    key={i}
                    className="absolute select-none transition-all duration-1000"
                    style={{
                        fontFamily: "'Poneglyph', serif",
                        fontSize: `${g.size}px`,
                        left: `${g.x}%`,
                        top: `${g.y * 0.6}%`,
                        transform: `rotate(${g.rotate}deg)`,
                        opacity: g.opacity * 0.25,
                        color,
                        lineHeight: 1,
                    }}
                >
                    {g.char}
                </span>
            ))}
        </div>
    );
}

const ResultImage = ({ url, pageId, token, coords, type }) => {
    if (type === 'semantic' || !coords) {
        return (
            <div className="w-full aspect-[2/3] bg-slate-100 overflow-hidden relative group">
                <img
                    src={getProxiedImageUrl(url, pageId, token)}
                    crossOrigin="anonymous"
                    alt="Page preview"
                    className="w-full h-full object-cover object-top transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex flex-col justify-end p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <p className="text-white text-[10px] uppercase tracking-widest font-bold opacity-70">Aperçu Complet</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-56 bg-slate-50 overflow-hidden relative flex items-center justify-center border-b border-slate-100 group">
            <div className="absolute inset-0 bg-slate-100/50 pattern-grid-lg opacity-20" />

            <div
                className="relative shadow-2xl rounded-lg overflow-hidden border border-slate-200 bg-white transition-all duration-300 group-hover:scale-[1.03] group-hover:rotate-1"
                style={{
                    width: Math.min(coords.w, 240),
                    height: Math.min(coords.h, 180),
                    maxWidth: '85%',
                    maxHeight: '85%'
                }}
            >
                <img
                    src={getProxiedImageUrl(url, pageId, token)}
                    crossOrigin="anonymous"
                    alt="Bubble crop"
                    className="max-w-none"
                    style={{
                        position: 'absolute',
                        left: `-${coords.x}px`,
                        top: `-${coords.y}px`,
                    }}
                />
            </div>

            <Badge variant="secondary" className="absolute bottom-3 right-3 bg-white/95 text-slate-800 backdrop-blur shadow-md gap-1 font-bold border-slate-200">
                <Quote className="h-3 w-3" /> Bulle
            </Badge>
        </div>
    );
};

export default function SearchPage() {
    const { session } = useAuth();
    const { mangaSlug, currentManga } = useManga();
    const getSavedState = () => {
        if (typeof window === 'undefined') return {};
        try {
            const saved = sessionStorage.getItem(`search_state_${mangaSlug}`);
            return saved ? JSON.parse(saved) : {};
        } catch (e) { return {}; }
    };

    const savedState = getSavedState();

    const [query, setQuery] = useState(savedState.query || '');
    const debouncedQuery = useDebounce(query, 400);

    const [results, setResults] = useState(savedState.results || []);
    const [totalCount, setTotalCount] = useState(savedState.totalCount || 0);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(savedState.page || 1);
    const [hasMore, setHasMore] = useState(savedState.hasMore || false);
    const [useSemantic, setUseSemantic] = useState(savedState.useSemantic || false);
    const [feedbackGiven, setFeedbackGiven] = useState({});

    const [selectedCharacters, setSelectedCharacters] = useState(savedState.selectedCharacters || []);
    const [selectedArc, setSelectedArc] = useState(savedState.selectedArc || 'all');
    const [selectedTome, setSelectedTome] = useState(savedState.selectedTome || 'all');
    const [showFilters, setShowFilters] = useState(savedState.showFilters || false);

    const [characterSuggestions, setCharacterSuggestions] = useState([]);
    const [arcSuggestions, setArcSuggestions] = useState([]);
    const [tomes, setTomes] = useState([]);
    const [charPopoverOpen, setCharPopoverOpen] = useState(false);

    const abortControllerRef = useRef(null);
    const inputRef = useRef(null);
    const isFirstRun = useRef(true);

    // Persistence Effect
    useEffect(() => {
        if (!mangaSlug) return;
        const state = {
            query, results, totalCount, page, hasMore, useSemantic,
            selectedCharacters, selectedArc, selectedTome, showFilters
        };
        sessionStorage.setItem(`search_state_${mangaSlug}`, JSON.stringify(state));
    }, [query, results, totalCount, page, hasMore, useSemantic, selectedCharacters, selectedArc, selectedTome, showFilters, mangaSlug]);

    useEffect(() => {
        if (inputRef.current) inputRef.current.focus();

        const fetchMetadata = async () => {
            try {
                const [metadataRes, tomesRes] = await Promise.all([
                    getMetadataSuggestions(mangaSlug),
                    getTomes(mangaSlug)
                ]);
                setCharacterSuggestions(metadataRes.data.characters || []);
                setArcSuggestions(metadataRes.data.arcs || []);
                setTomes(tomesRes.data || []);
            } catch (err) {
                console.error('Erreur chargement metadata:', err);
            }
        };
        fetchMetadata();
    }, [mangaSlug]);

    useEffect(() => {
        if (useSemantic) return;

        if (isFirstRun.current) {
            isFirstRun.current = false;
            // Si on a déjà des résultats restaurés, on ne déclenche pas la recherche initiale
            if (results.length > 0) return;
        }

        if (debouncedQuery.trim().length >= 2) {
            setPage(1);
            fetchResults(debouncedQuery, 1, true);
        } else {
            setResults([]);
            setTotalCount(0);
        }
    }, [debouncedQuery, useSemantic, selectedCharacters, selectedArc, selectedTome]);

    const handleManualSearch = () => {
        if (query.trim().length < 2) return;
        setPage(1);
        fetchResults(query, 1, true);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleManualSearch();
        }
    };

    const fetchResults = async (searchTerm, pageToFetch, isNewSearch) => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        abortControllerRef.current = new AbortController();

        setIsLoading(true);
        if (isNewSearch) {
            setResults([]);
            setFeedbackGiven({});
        }

        try {
            const filters = {
                characters: selectedCharacters,
                arc: selectedArc !== 'all' ? selectedArc : '',
                tome: selectedTome !== 'all' ? selectedTome : ''
            };
            const response = await searchBubbles(
                searchTerm,
                pageToFetch,
                RESULTS_PER_PAGE,
                useSemantic ? 'semantic' : 'keyword',
                filters,
                useSemantic
            );

            let newResults = response.data.results;
            const total = response.data.totalCount;

            setResults(prev => isNewSearch ? newResults : [...prev, ...newResults]);

            if (useSemantic && pageToFetch === 1) {
                setTotalCount(newResults.length);
                setHasMore(false);
            } else {
                setTotalCount(total);
                setHasMore((isNewSearch ? newResults.length : results.length + newResults.length) < total);
            }
        } catch (err) {
            if (err.name !== 'AbortError') console.error("Erreur recherche", err);
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = () => {
        const nextPage = page + 1;
        setPage(nextPage);
        fetchResults(query, nextPage, false);
    };

    const handleFeedback = async (e, item, isRelevant) => {
        e.preventDefault();
        e.stopPropagation();

        if (feedbackGiven[item.id]) {
            toast.info("Déjà voté.");
            return;
        }

        try {
            await submitSearchFeedback({
                query: debouncedQuery,
                doc_id: item.id,
                doc_text: item.content,
                is_relevant: isRelevant,
                model_provider: 'dual'
            });

            setFeedbackGiven(prev => ({ ...prev, [item.id]: true }));
            toast.success("Merci pour votre retour !");
        } catch (err) {
            console.error("Feedback error", err);
        }
    };

    const accentColor = useSemantic ? "#A11010" : "#2f7aaf";

    return (
        <div className="min-h-screen pb-20 bg-slate-50/30">
            <div className="bg-white border-b border-slate-200 pt-12 pb-10 px-4 -mx-4 sm:-mx-8 relative overflow-hidden">
                <PoneglyphHeaderGlyphs color={accentColor} />

                <div className="container max-w-5xl mx-auto space-y-8 relative z-10">
                    <div className="text-center space-y-2">
                        <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-slate-900">
                            Voix de Toute Chose
                        </h1>
                        <p className="text-slate-500 font-medium text-sm sm:text-base max-w-xl mx-auto">
                            {useSemantic
                                ? "Rio Poneglyph : Déchiffrer l'histoire à travers les concepts et les souvenirs."
                                : "Poneglyph Classique : Retrouver les traces écrites et les paroles exactes."
                            }
                        </p>
                    </div>

                    <div className="flex flex-col items-center gap-6">
                        <Tabs
                            defaultValue="keyword"
                            value={useSemantic ? "semantic" : "keyword"}
                            onValueChange={(v) => {
                                setUseSemantic(v === "semantic");
                                setResults([]);
                                setTotalCount(0);
                                setHasMore(false);
                            }}
                            className="w-full max-w-md"
                        >
                            <TabsList className="grid w-full grid-cols-2 h-12 p-1 bg-slate-100 rounded-xl border border-slate-200">
                                <TabsTrigger
                                    value="keyword"
                                    className="rounded-lg font-bold text-xs uppercase tracking-wider data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-[#2F7AAF]"
                                >
                                    <Quote className="h-3.5 w-3.5 mr-2 opacity-60" />
                                    Textuel
                                </TabsTrigger>
                                <TabsTrigger
                                    value="semantic"
                                    className="rounded-lg font-bold text-xs uppercase tracking-wider data-[state=active]:bg-[#A11010] data-[state=active]:text-white"
                                >
                                    <Sparkles className="h-3.5 w-3.5 mr-2" />
                                    Sémantique
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>

                        <div className="relative w-full max-w-2xl group">
                            <div className={cn(
                                "relative flex items-center transition-all duration-1000 rounded-2xl bg-white border shadow-sm group-focus-within:shadow-xl group-focus-within:ring-4",
                                useSemantic
                                    ? "border-red-200 group-focus-within:border-red-500/50 group-focus-within:ring-[#A11010]/5"
                                    : "border-slate-200 group-focus-within:border-sky-400/50 group-focus-within:ring-[#2F7AAF]/5"
                            )}>
                                <Input
                                    ref={inputRef}
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder={useSemantic ? "Ex: Luffy utilise le Gear 4 contre Doflamingo..." : "Cherchez un dialogue exact..."}
                                    className="pl-6 pr-24 h-14 sm:h-16 text-base sm:text-lg rounded-2xl border-none ring-0 focus-visible:ring-0 shadow-none placeholder:text-slate-400"
                                />

                                <div className="absolute right-2 flex items-center gap-1">
                                    {query && (
                                        <button
                                            onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
                                            className="p-2 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}

                                    <Button
                                        size="icon"
                                        className={cn(
                                            "rounded-xl h-10 w-10 sm:h-12 sm:w-12 shadow-lg transition-all duration-1000",
                                            useSemantic ? "bg-[#A11010] hover:bg-[#820d0d]" : "bg-[#2F7AAF] hover:bg-[#26628c]"
                                        )}
                                        onClick={handleManualSearch}
                                        disabled={isLoading || query.length < 2}
                                    >
                                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-wrap justify-center gap-3">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowFilters(!showFilters)}
                                className={cn(
                                    "rounded-xl font-bold h-9 px-4 gap-2 border-slate-200 shadow-sm transition-all",
                                    showFilters ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 hover:border-slate-300"
                                )}
                            >
                                <Filter className="h-3.5 w-3.5" />
                                Filtres
                                {(selectedCharacters.length > 0 || selectedArc !== 'all' || selectedTome !== 'all') && (
                                    <span className={cn(
                                        "flex items-center justify-center text-white text-[10px] h-4 w-4 rounded-full ml-1 transition-colors duration-1000",
                                        useSemantic ? "bg-[#A11010]" : "bg-[#2F7AAF]"
                                    )}>
                                        {selectedCharacters.length + (selectedArc !== 'all' ? 1 : 0) + (selectedTome !== 'all' ? 1 : 0)}
                                    </span>
                                )}
                            </Button>

                            {(selectedCharacters.length > 0 || selectedArc !== 'all' || selectedTome !== 'all') && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setSelectedCharacters([]);
                                        setSelectedArc('all');
                                        setSelectedTome('all');
                                    }}
                                    className="text-[11px] font-bold text-slate-400 hover:text-red-600 h-9 transition-colors"
                                >
                                    Tout réinitialiser
                                </Button>
                            )}
                        </div>
                    </div>

                    {showFilters && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6 border border-slate-100 rounded-3xl bg-slate-50/50 shadow-inner animate-in slide-in-from-top-4 fade-in duration-300 max-w-4xl mx-auto">
                            <div className="space-y-2 opacity-50 grayscale select-none">
                                <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-[2px] mb-1.5 block">Personnages</Label>
                                <Popover open={charPopoverOpen} onOpenChange={setCharPopoverOpen}>
                                    <PopoverTrigger asChild>
                                        <Button disabled variant="outline" className="w-full justify-between h-10 text-xs font-bold bg-white rounded-xl border-slate-200">
                                            {selectedCharacters.length > 0 ? `${selectedCharacters.length} persos.` : "Indisponible"}
                                            <ChevronRight className={cn("h-4 w-4 transition-transform", charPopoverOpen && "rotate-90")} />
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-[300px] p-0 rounded-2xl shadow-2xl border-slate-100" align="start">
                                        <Command className="rounded-2xl">
                                            <CommandInput placeholder="Rechercher..." className="h-11" />
                                            <CommandEmpty>Aucun résultat.</CommandEmpty>
                                            <CommandGroup className="max-h-64 overflow-auto p-2">
                                                {characterSuggestions.map((char) => (
                                                    <CommandItem
                                                        key={char}
                                                        className="rounded-lg h-9 text-xs mb-0.5"
                                                        onSelect={() => {
                                                            setSelectedCharacters(prev =>
                                                                prev.includes(char) ? prev.filter(c => c !== char) : [...prev, char]
                                                            );
                                                        }}
                                                    >
                                                        <div className={cn("mr-2 h-4 w-4 rounded-sm border border-slate-300 flex items-center justify-center transition-colors", selectedCharacters.includes(char) && "bg-indigo-600 border-indigo-600")}>
                                                            <Check className={cn("h-3 w-3 text-white transition-opacity", selectedCharacters.includes(char) ? "opacity-100" : "opacity-0")} />
                                                        </div>
                                                        {char}
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </Command>
                                    </PopoverContent>
                                </Popover>
                                <div className="flex flex-wrap gap-1.5 py-1">
                                    {selectedCharacters.map(char => (
                                        <Badge key={char} className="bg-white border-slate-200 text-slate-600 text-[10px] font-bold h-6 pr-1 shadow-sm">
                                            {char}
                                            <button
                                                type="button"
                                                className="ml-1 p-0.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-red-500 transition-colors pointer-events-auto"
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setSelectedCharacters(prev => prev.filter(c => c !== char));
                                                }}
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </Badge>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-2 opacity-50 grayscale select-none">
                                <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-[2px] mb-1.5 block">Arc narratif</Label>
                                <Select value={selectedArc} onValueChange={setSelectedArc} disabled>
                                    <SelectTrigger className="h-10 text-xs font-bold bg-white rounded-xl border-slate-200 shadow-sm">
                                        <SelectValue placeholder="Indisponible" />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-2xl border-slate-100">
                                        <SelectItem value="all" className="text-xs">Tous les arcs</SelectItem>
                                        {arcSuggestions.map(arc => <SelectItem key={arc} value={arc} className="text-xs">{arc}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-[10px] font-bold text-slate-400 uppercase tracking-[2px] mb-1.5 block">Tome</Label>
                                <Select value={selectedTome} onValueChange={setSelectedTome}>
                                    <SelectTrigger className="h-10 text-xs font-bold bg-white rounded-xl border-slate-200 shadow-sm">
                                        <SelectValue placeholder="Tous les tomes" />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-64 rounded-2xl border-slate-100">
                                        <SelectItem value="all" className="text-xs">Tous les tomes</SelectItem>
                                        {tomes.map(tome => (
                                            <SelectItem key={tome.numero} value={tome.numero.toString()} className="text-xs">
                                                Tome {tome.numero} {tome.titre && `· ${tome.titre}`}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className="container max-w-7xl mx-auto px-4 mt-12">
                {results.length > 0 && (
                    <div className="flex items-center gap-3 mb-8 px-2 animate-in fade-in duration-500">
                        <div className={cn("h-10 w-1 rounded-full transition-colors duration-1000", useSemantic ? "bg-[#A11010]" : "bg-[#2F7AAF]")} />
                        <div>
                            <span className="text-2xl font-black text-slate-900 tracking-tight">{totalCount}</span>
                            <span className="ml-2 text-slate-500 font-bold text-sm uppercase tracking-wider">Résultats trouvés</span>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-8">
                    {results.map((item, index) => {
                        const isSemantic = item.type === 'semantic';
                        return (
                            <Link
                                key={`${item.id}-${index}`}
                                href={`/${mangaSlug}/annotate/${item.page_id}?from=search`}
                                prefetch={false}
                                className={cn(
                                    "group block focus-visible:outline-none focus-visible:ring-2 rounded-3xl",
                                    useSemantic ? "focus-visible:ring-[#A11010]" : "focus-visible:ring-[#2F7AAF]"
                                )}
                            >
                                <Card className={cn(
                                    "h-full flex flex-col overflow-hidden border-slate-200/60 bg-white hover:shadow-2xl transition-all duration-500 rounded-3xl shadow-sm",
                                    useSemantic ? "hover:border-red-200" : "hover:border-[#2F7AAF]/30"
                                )}>
                                    <ResultImage
                                        url={item.url_image}
                                        pageId={item.page_id}
                                        token={session?.access_token}
                                        coords={item.coords}
                                        type={item.type}
                                    />

                                    <CardContent className="flex-1 p-4 sm:p-6 flex flex-col gap-4">
                                        <div className="flex flex-wrap gap-2">
                                            <Badge variant="secondary" className="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-500 rounded-md border-none">
                                                Vol.{item.context.match(/Tome (\d+)/)?.[1]} | Ch.{item.context.match(/Chap\. (\d+)/)?.[1]}
                                            </Badge>
                                            {item.similarity > 0 && (
                                                <Badge className={cn(
                                                    "text-[10px] font-black uppercase tracking-wider border-none",
                                                    item.similarity > 0.8 ? "bg-emerald-100 text-emerald-700" : "bg-indigo-100 text-indigo-700"
                                                )}>
                                                    {(item.similarity * 100).toFixed(0)}% Match
                                                </Badge>
                                            )}
                                        </div>

                                        {!isSemantic && item.content && (
                                            <div className={cn(
                                                "text-sm font-medium text-slate-700 leading-relaxed italic border-l-2 pl-3 py-1",
                                                useSemantic ? "border-red-200" : "border-[#2F7AAF]/30"
                                            )}>
                                                "{highlightText(item.content, query)}"
                                            </div>
                                        )}

                                        <div className="mt-auto flex items-center justify-between pt-2">
                                            <div className="flex items-center gap-1.5 text-[11px] font-black text-slate-400 uppercase tracking-widest">
                                                <MapPin className={cn("h-3 w-3 transition-colors duration-1000", useSemantic ? "text-[#A11010]" : "text-[#2F7AAF]")} />
                                                Page {item.context.match(/Page (\d+)/)?.[1]}
                                            </div>
                                            <div className="p-1.5 rounded-full bg-slate-50 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <ChevronRight className="h-4 w-4 text-slate-400" />
                                            </div>
                                        </div>
                                    </CardContent>

                                    {useSemantic && (
                                        <CardFooter className="px-6 py-4 bg-slate-50/50 border-t border-slate-100/60 flex items-center justify-between" onClick={(e) => e.preventDefault()}>
                                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Utile ?</span>
                                            <div className="flex gap-2">
                                                {feedbackGiven[item.id] ? (
                                                    <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1 uppercase">
                                                        <Check className="h-3 w-3" /> Merci
                                                    </span>
                                                ) : (
                                                    <>
                                                        <Button variant="outline" size="icon" className="h-7 w-7 rounded-lg border-slate-200 bg-white hover:bg-emerald-50 hover:text-emerald-600 transition-colors" onClick={(e) => handleFeedback(e, item, true)}>
                                                            <div className="text-xs">👍</div>
                                                        </Button>
                                                        <Button variant="outline" size="icon" className="h-7 w-7 rounded-lg border-slate-200 bg-white hover:bg-red-50 hover:text-red-600 transition-colors" onClick={(e) => handleFeedback(e, item, false)}>
                                                            <div className="text-xs">👎</div>
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        </CardFooter>
                                    )}
                                </Card>
                            </Link>
                        );
                    })}

                    {isLoading && Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="flex flex-col gap-4">
                            <Skeleton className="aspect-[2/3] w-full rounded-3xl" />
                            <div className="space-y-2 px-2">
                                <Skeleton className="h-4 w-1/2 rounded-full" />
                                <Skeleton className="h-3 w-3/4 rounded-full" />
                            </div>
                        </div>
                    ))}
                </div>

                {!isLoading && results.length === 0 && query.length >= 2 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto animate-in fade-in duration-700">
                        <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
                            <BookOpen className="h-10 w-10 text-slate-300" />
                        </div>
                        <h3 className="text-xl font-black text-slate-900 mb-2 uppercase tracking-tight">Zone Inconnue</h3>
                        <p className="text-slate-500 font-medium text-sm mb-8 leading-relaxed">
                            Aucune occurrence de "{query}" dans nos archives.
                            {!useSemantic && " L'IA pourrait vous aider par analogie."}
                        </p>
                        {!useSemantic && (
                            <Button
                                onClick={() => setUseSemantic(true)}
                                className="rounded-2xl h-12 px-8 bg-[#A11010] shadow-xl shadow-red-900/20 gap-2 font-bold uppercase tracking-widest text-xs transition-all active:scale-95 text-white"
                            >
                                <Sparkles className="h-4 w-4" />
                                Rechercher par Concept
                            </Button>
                        )}
                    </div>
                )}

                {!isLoading && hasMore && (
                    <div className="flex justify-center mt-16 mb-20">
                        <Button
                            variant="outline"
                            onClick={loadMore}
                            className="rounded-2xl h-12 px-10 font-black uppercase tracking-widest text-xs border-slate-200 hover:bg-slate-900 hover:text-white transition-all shadow-xl shadow-slate-200/50"
                        >
                            Déchiffrer la suite
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

const highlightText = (text, highlight) => {
    if (!text) return "";
    if (!highlight || !highlight.trim()) return text;
    const cleanText = text.replace(/^\[Concept\]\s*/, '');
    const escapedHighlight = highlight.replace(/[.*+?^${ }()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedHighlight})`, 'gi');
    const parts = cleanText.split(regex);
    return parts.map((part, i) =>
        regex.test(part) ? <span key={i} className="bg-indigo-100 text-indigo-900 px-0.5 rounded font-bold underline decoration-indigo-300 underline-offset-2">{part}</span> : part
    );
};

