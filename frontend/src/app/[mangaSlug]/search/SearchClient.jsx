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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";



import { Search, X, Loader2, Sparkles, BookOpen, MapPin, Quote, Info, ArrowRight, Settings, Filter, XCircle, Check } from "lucide-react";

const RESULTS_PER_PAGE = 24;

const ResultImage = ({ url, pageId, token, coords, type }) => {
    if (type === 'semantic' || !coords) {
        return (
            <div className="w-full aspect-[2/3] bg-slate-100 overflow-hidden relative group">
                <img
                    src={getProxiedImageUrl(url, pageId, token)}
                    crossOrigin="anonymous"
                    alt="Page preview"
                    className="w-full h-full object-cover object-top transition-transform duration-700 group-hover:scale-105"
                    loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-80" />
            </div>
        );
    }

    return (
        <div className="w-full h-56 bg-slate-50 overflow-hidden relative flex items-center justify-center border-b border-slate-100 group">
            <div className="absolute inset-0 bg-slate-100/50 pattern-grid-lg opacity-20" />

            <div
                className="relative shadow-xl rounded-sm overflow-hidden border border-slate-200 bg-white transition-transform duration-300 group-hover:scale-105"
                style={{
                    width: Math.min(coords.w, 280),
                    height: Math.min(coords.h, 200),
                    maxWidth: '90%',
                    maxHeight: '90%'
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

            <Badge variant="secondary" className="absolute bottom-3 right-3 bg-white/90 text-slate-700 backdrop-blur-sm shadow-sm gap-1">
                <Quote className="h-3 w-3" /> Bulle
            </Badge>
        </div>
    );
};

export default function SearchPage() {
    const { session } = useAuth();
    const { mangaSlug, currentManga } = useManga();
    const [query, setQuery] = useState('');

    const pageTitle = currentManga ? `Recherche : ${currentManga.titre}` : "Recherche";
    const debouncedQuery = useDebounce(query, 400);

    const [results, setResults] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);

    const [useSemantic, setUseSemantic] = useState(false);




    const [feedbackGiven, setFeedbackGiven] = useState({});



    const [selectedCharacters, setSelectedCharacters] = useState([]);
    const [selectedArc, setSelectedArc] = useState('all');
    const [selectedTome, setSelectedTome] = useState('all');
    const [showFilters, setShowFilters] = useState(false);


    const [characterSuggestions, setCharacterSuggestions] = useState([]);
    const [arcSuggestions, setArcSuggestions] = useState([]);
    const [tomes, setTomes] = useState([]);
    const [charPopoverOpen, setCharPopoverOpen] = useState(false);

    const abortControllerRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) inputRef.current.focus();

        const fetchMetadata = async () => {
            try {
                const [metadataRes, tomesRes] = await Promise.all([
                    getMetadataSuggestions(),
                    getTomes()
                ]);
                setCharacterSuggestions(metadataRes.data.characters || []);
                setArcSuggestions(metadataRes.data.arcs || []);
                setTomes(tomesRes.data || []);
            } catch (err) {
                console.error('Erreur chargement metadata:', err);
            }
        };
        fetchMetadata();
    }, []);



    useEffect(() => {
        if (useSemantic) return;


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
            toast.info("Vous avez déjà donné votre avis sur ce résultat.");
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
            toast.success("Feedback enregistré !");
        } catch (err) {
            console.error("Feedback error", err);
            toast.error("Erreur lors de l'envoi du feedback");
        }
    };

    return (
        <div className="min-h-screen pb-20">
            <div className="bg-white border-b border-slate-200 pt-10 pb-8 px-4 shadow-sm -mx-4 sm:-mx-8 mb-8">
                <div className="container max-w-4xl mx-auto text-center space-y-4 sm:space-y-8 relative z-10">
                    <h1 className="text-2xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-slate-900">
                        Moteur de Recherche
                    </h1>


                    <div className="relative max-w-2xl mx-auto">
                        <div className="relative flex items-center shadow-lg rounded-full group focus-within:ring-2 focus-within:ring-indigo-500/50 transition-all bg-white border border-slate-200">
                            <Input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={useSemantic ? "Décrivez une scène..." : "Mots exacts..."}
                                className={cn(
                                    "pl-5 sm:pl-6 pr-20 sm:pr-28 h-12 sm:h-16 text-base sm:text-lg rounded-full border-none ring-0 focus-visible:ring-0 shadow-none",
                                    useSemantic && "bg-indigo-50/20"
                                )}
                            />

                            <div className="absolute right-1.5 sm:right-2 flex items-center gap-0.5 sm:gap-2">
                                {query && (
                                    <button
                                        onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
                                        className="p-1.5 sm:p-2.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                                    >
                                        <X className="h-4 w-4 sm:h-5 sm:w-5" />
                                    </button>
                                )}

                                <Button
                                    size="icon"
                                    className={cn(
                                        "rounded-full h-9 w-9 sm:h-12 sm:w-12 shadow-sm transition-all",
                                        useSemantic ? "bg-indigo-600 hover:bg-indigo-700" : "bg-slate-900 hover:bg-slate-800"
                                    )}
                                    onClick={handleManualSearch}
                                    disabled={isLoading || query.length < 2}
                                >
                                    {isLoading ? <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin" /> : <Search className="h-4 w-4 sm:h-5 sm:w-5" />}
                                </Button>
                            </div>
                        </div>
                    </div>


                    <div className="flex flex-col items-center gap-4 sm:gap-6">
                        <div className="flex flex-col gap-4 w-full sm:w-auto items-center">

                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-4 bg-slate-100/80 p-1 sm:p-1.5 rounded-2xl sm:rounded-full border border-slate-200 shadow-inner w-full sm:w-auto">
                                <div className="flex items-center justify-between sm:justify-start space-x-3 px-3 py-2 sm:py-0">
                                    <Label
                                        htmlFor="semantic-mode"
                                        className="font-bold cursor-pointer select-none flex items-center gap-2 text-xs sm:text-sm text-slate-700"
                                    >
                                        <div className={cn("p-1.5 rounded-lg transition-colors", useSemantic ? "bg-indigo-100 text-indigo-600" : "bg-slate-200 text-slate-400")}>
                                            <Sparkles className="h-3.5 w-3.5" />
                                        </div>
                                        Recherche Sémantique
                                    </Label>
                                    <Switch
                                        id="semantic-mode"
                                        checked={useSemantic}
                                        onCheckedChange={(checked) => {
                                            setUseSemantic(checked);
                                        }}
                                        className="data-[state=checked]:bg-indigo-600"
                                    />
                                </div>
                            </div>
                        </div>


                        <div className="flex flex-col gap-2 max-w-lg mx-auto w-full px-2">
                            {useSemantic ? (
                                <div className="animate-in fade-in slide-in-from-top-1 duration-300 flex items-center gap-3 text-xs text-indigo-700 bg-indigo-50/50 px-4 py-2.5 rounded-xl border border-indigo-100 shadow-sm text-left">
                                    <Info className="h-4 w-4 flex-shrink-0 text-indigo-500" />
                                    <p>
                                        <strong>Mode Sémantique :</strong> Voyage + Gemini multimodal analysent le sens et l'image de votre recherche simultanément.
                                    </p>
                                </div>
                            ) : (
                                <div className="animate-in fade-in slide-in-from-top-1 duration-300 flex items-center gap-3 text-xs text-slate-600 bg-slate-50 px-4 py-2.5 rounded-xl border border-slate-200 text-left">
                                    <Quote className="h-4 w-4 flex-shrink-0 text-slate-400" />
                                    <p>
                                        <strong>Mode Textuel :</strong> Recherche directe des mots dans les dialogues. Plus rapide et précis pour des citations.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>


                </div>


                <div className="mt-4 sm:mt-8 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowFilters(!showFilters)}
                            className={cn(
                                "gap-2 h-10 w-full sm:w-auto shadow-sm transition-all",
                                showFilters ? "bg-slate-100 border-slate-300" : "bg-white"
                            )}
                        >
                            <Filter className="h-4 w-4" />
                            <span className="font-bold">Filtres avancés</span>
                            {(selectedCharacters.length > 0 || selectedArc !== 'all' || selectedTome !== 'all') && (
                                <Badge className="ml-1 bg-indigo-600">
                                    {selectedCharacters.length + (selectedArc !== 'all' ? 1 : 0) + (selectedTome !== 'all' ? 1 : 0)}
                                </Badge>
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
                                className="text-xs font-bold text-slate-500 hover:text-red-600 h-8 self-end sm:self-auto"
                            >
                                <XCircle className="h-3.5 w-3.5 mr-1.5" />
                                Tout effacer
                            </Button>
                        )}
                    </div>

                    {showFilters && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5 sm:p-6 border border-slate-200 rounded-2xl bg-slate-50/80 shadow-inner animate-in slide-in-from-top-4 duration-300">
                            <div className="flex flex-col gap-2">
                                <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Personnages</Label>
                                <Popover open={charPopoverOpen} onOpenChange={setCharPopoverOpen}>
                                    <PopoverTrigger asChild>
                                        <Button
                                            variant="outline"
                                            role="combobox"
                                            className="w-full justify-between text-left font-normal"
                                        >
                                            {selectedCharacters.length > 0
                                                ? `${selectedCharacters.length} sélectionné${selectedCharacters.length > 1 ? 's' : ''}`
                                                : "Tous les personnages"}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-[calc(100vw-32px)] sm:w-[300px] p-0">
                                        <Command>
                                            <CommandInput placeholder="Rechercher un personnage..." />
                                            <CommandEmpty>Aucun personnage trouvé.</CommandEmpty>
                                            <CommandGroup className="max-h-64 overflow-auto">
                                                {characterSuggestions.map((char) => (
                                                    <CommandItem
                                                        key={char}
                                                        onSelect={() => {
                                                            setSelectedCharacters(prev =>
                                                                prev.includes(char)
                                                                    ? prev.filter(c => c !== char)
                                                                    : [...prev, char]
                                                            );
                                                        }}
                                                    >
                                                        <Check
                                                            className={`mr-2 h-4 w-4 ${selectedCharacters.includes(char) ? "opacity-100" : "opacity-0"}`}
                                                        />
                                                        {char}
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        </Command>
                                    </PopoverContent>
                                </Popover>
                                {selectedCharacters.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-2">
                                        {selectedCharacters.map(char => (
                                            <Badge
                                                key={char}
                                                variant="secondary"
                                                className="text-xs bg-indigo-100 text-indigo-700 gap-1 cursor-pointer hover:bg-indigo-200"
                                                onClick={() => setSelectedCharacters(prev => prev.filter(c => c !== char))}
                                            >
                                                {char}
                                                <X className="h-3 w-3" />
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs font-medium text-slate-700">Arc narratif</Label>
                                <Select value={selectedArc} onValueChange={setSelectedArc}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Tous les arcs" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">Tous les arcs</SelectItem>
                                        {arcSuggestions.map((arc) => (
                                            <SelectItem key={arc} value={arc}>
                                                {arc}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs font-medium text-slate-700">Tome</Label>
                                <Select value={selectedTome} onValueChange={setSelectedTome}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Tous les tomes" />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-64">
                                        <SelectItem value="all">Tous les tomes</SelectItem>
                                        {tomes.map((tome) => (
                                            <SelectItem key={tome.numero} value={tome.numero.toString()}>
                                                Tome {tome.numero} {tome.titre && `- ${tome.titre}`}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    )}


                    {(selectedCharacters.length > 0 || selectedArc !== 'all' || selectedTome !== 'all') && (
                        <div className="flex flex-wrap items-center gap-2 text-sm pt-2">
                            <span className="text-slate-400 text-xs font-bold uppercase tracking-wider mr-2">Filtres :</span>
                            {selectedCharacters.map(char => (
                                <Badge key={char} variant="secondary" className="gap-1.5 py-1 px-3 bg-white border border-slate-200 shadow-sm text-slate-700 rounded-lg">
                                    {char}
                                    <X className="h-3.5 w-3.5 cursor-pointer hover:text-red-500 transition-colors" onClick={() => setSelectedCharacters(prev => prev.filter(c => c !== char))} />
                                </Badge>
                            ))}
                            {selectedArc !== 'all' && (
                                <Badge variant="secondary" className="gap-1.5 py-1 px-3 bg-white border border-slate-200 shadow-sm text-slate-700 rounded-lg">
                                    <MapPin size={12} className="text-indigo-500" />
                                    {selectedArc}
                                    <X className="h-3.5 w-3.5 cursor-pointer hover:text-red-500 transition-colors" onClick={() => setSelectedArc('all')} />
                                </Badge>
                            )}
                            {selectedTome !== 'all' && (
                                <Badge variant="secondary" className="gap-1.5 py-1 px-3 bg-white border border-slate-200 shadow-sm text-slate-700 rounded-lg">
                                    <BookOpen size={12} className="text-amber-500" />
                                    Tome {selectedTome}
                                    <X className="h-3.5 w-3.5 cursor-pointer hover:text-red-500 transition-colors" onClick={() => setSelectedTome('all')} />
                                </Badge>
                            )}
                        </div>
                    )}
                </div>
                {results.length > 0 && (
                    <div className="mb-6 flex items-baseline gap-2 text-slate-500 border-b border-slate-200 pb-2">
                        <span className="text-xl font-bold text-slate-900">{totalCount}</span>
                        <span>résultats trouvés</span>
                        {useSemantic && <Badge variant="secondary" className="ml-2 text-[10px] bg-indigo-100 text-indigo-700 hover:bg-indigo-200">Sémantique (Dual IA)</Badge>}
                    </div>
                )}


                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
                    {results.map((item, index) => {
                        const isSemantic = item.type === 'semantic';

                        return (
                            <Link
                                key={`${item.id}-${index}`}
                                href={`/${mangaSlug}/annotate/${item.page_id}`}
                                prefetch={false}
                                className="group block h-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 rounded-2xl"
                            >
                                <Card className="h-full flex flex-col overflow-hidden border-slate-200 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 rounded-2xl shadow-sm bg-white">


                                    <ResultImage
                                        url={item.url_image}
                                        pageId={item.page_id}
                                        token={session?.access_token}
                                        coords={item.coords}
                                        type={item.type}
                                    />

                                    <CardContent className="flex-1 p-4 sm:p-5 flex flex-col gap-3">

                                        <div className="flex flex-wrap gap-1.5 mb-1">
                                            <Badge variant="secondary" className="text-[10px] text-slate-500 bg-slate-100 font-bold px-2 py-0.5 border-none">
                                                Tome {item.context.match(/Tome (\d+)/)?.[1] || '?'}
                                            </Badge>
                                            <Badge variant="secondary" className="text-[10px] text-slate-500 bg-slate-100 font-bold px-2 py-0.5 border-none">
                                                Ch. {item.context.match(/Chap\. (\d+)/)?.[1] || '?'}
                                            </Badge>
                                        </div>

                                        <Separator className="bg-slate-100" />


                                        <div className={`text-sm leading-relaxed line-clamp-4 ${isSemantic ? "text-slate-600" : "text-slate-800 font-serif"}`}>
                                            {isSemantic ? (
                                                highlightText(item.content, query)
                                            ) : (
                                                <span className="relative inline-block pl-2">
                                                    <span className="absolute -left-1 -top-1 text-2xl text-slate-200 font-serif select-none">“</span>
                                                    <span className="italic relative z-10">
                                                        {highlightText(item.content, query)}
                                                    </span>
                                                    <span className="absolute -bottom-3 text-2xl text-slate-200 font-serif select-none ml-1">”</span>
                                                </span>
                                            )}
                                        </div>
                                    </CardContent>

                                    <CardFooter className="bg-slate-50/50 px-4 sm:px-5 py-3 border-t border-slate-100 flex flex-col gap-3">
                                        <div className="flex items-center justify-between w-full text-xs text-slate-500 group-hover:text-indigo-600 transition-colors font-bold">
                                            <span className="flex items-center gap-1.5">
                                                <div className="p-1 bg-white rounded shadow-sm border border-slate-200">
                                                    <MapPin className="h-3 w-3 text-indigo-500" />
                                                </div>
                                                Page {item.context.match(/Page (\d+)/)?.[1] || '?'}
                                            </span>
                                            {item.similarity > 0 && (
                                                <span className={cn(
                                                    "px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-extrabold",
                                                    item.similarity > 0.8 ? "bg-green-100 text-green-700" : "bg-slate-200 text-slate-600"
                                                )}>
                                                    {(item.similarity * 100).toFixed(0)}% Match
                                                </span>
                                            )}
                                        </div>

                                        {useSemantic && (
                                            <div className="w-full flex items-center justify-end gap-3 pt-2 border-t border-slate-200/60 mt-2" onClick={(e) => e.preventDefault()}>
                                                {feedbackGiven[item.id] ? (
                                                    <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                                                        <Check className="h-3 w-3" />
                                                        <span>Feedback envoyé</span>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <span className="text-[11px] font-medium text-slate-500 mr-auto">Proposer une amélioration</span>
                                                        <Button
                                                            variant="outline" size="sm"
                                                            className="h-7 w-8 p-0 border-slate-200 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200 transition-all"
                                                            onClick={(e) => handleFeedback(e, item, true)}
                                                        >
                                                            <div className="text-sm">👍</div>
                                                        </Button>
                                                        <Button
                                                            variant="outline" size="sm"
                                                            className="h-7 w-8 p-0 border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all"
                                                            onClick={(e) => handleFeedback(e, item, false)}
                                                        >
                                                            <div className="text-sm">👎</div>
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </CardFooter>
                                </Card>
                            </Link>
                        );
                    })}
                </div>


                {
                    isLoading && (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                            <p className="text-slate-500 text-sm font-medium animate-pulse">
                                {useSemantic ? "L'IA analyse les concepts..." : "Recherche dans les archives..."}
                            </p>
                        </div>
                    )
                }

                {
                    !isLoading && results.length === 0 && query.length >= 2 && (
                        <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto">
                            <div className="bg-slate-100 p-4 rounded-full mb-4">
                                <BookOpen className="h-8 w-8 text-slate-400" />
                            </div>
                            <h3 className="text-lg font-semibold text-slate-900 mb-2">Aucun résultat trouvé</h3>
                            <p className="text-slate-500 text-sm mb-6">
                                Nous n'avons rien trouvé pour "{query}".
                                {!useSemantic && " Essayez d'activer la recherche sémantique pour une recherche plus conceptuelle."}
                            </p>
                            {!useSemantic && (
                                <Button onClick={() => setUseSemantic(true)} variant="outline" className="border-indigo-200 text-indigo-600 hover:bg-indigo-50">
                                    <Sparkles className="h-4 w-4 mr-2" />
                                    Activer la recherche sémantique
                                </Button>
                            )}
                        </div>
                    )
                }

                {
                    !isLoading && hasMore && (
                        <div className="flex justify-center pt-8 pb-12">
                            <Button
                                variant="outline"
                                onClick={loadMore}
                                className="group min-w-[150px] shadow-sm hover:border-indigo-300 hover:text-indigo-600 transition-all"
                            >
                                Charger la suite
                                <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                            </Button>
                        </div>
                    )
                }
            </div >



        </div >
    );
}

const highlightText = (text, highlight) => {
    if (!text) return "";
    if (!highlight || !highlight.trim()) return text;

    const cleanText = text.replace(/^\[Concept\]\s*/, '');
    const escapedHighlight = highlight.replace(/[.*+?^${ }()|[\]\\]/g, '\\$&');
    const parts = cleanText.split(new RegExp(`(${escapedHighlight})`, 'gi'));

    return (
        <>
            {parts.map((part, i) =>
                part.toLowerCase() === highlight.toLowerCase() ? (
                    <span
                        key={i}
                        className="bg-yellow-200 text-slate-900 px-0.5 rounded-sm font-semibold decoration-clone"
                    >
                        {part}
                    </span>
                ) : (
                    part
                )
            )}
        </>
    );
};
