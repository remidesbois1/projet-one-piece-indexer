import React, { useState, useEffect, useRef } from 'react';
import { searchBubbles } from '../services/api';
import { useDebounce } from '../hooks/useDebounce';
import { Link } from 'react-router-dom';

// Shadcn UI Components
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// Custom Components
import ApiKeyForm from '../components/ApiKeyForm'; // Assurez-vous que le chemin est bon

// Icons
import { Search, X, Loader2, Sparkles, BookOpen, MapPin, Quote, Info, ArrowRight, Settings } from "lucide-react";

const RESULTS_PER_PAGE = 24;

// --- Composant d'affichage d'image (Crop vs Full) ---
const ResultImage = ({ url, coords, type }) => {
    if (type === 'semantic' || !coords) {
        return (
            <div className="w-full aspect-[2/3] bg-slate-100 overflow-hidden relative group">
                <img
                    src={url}
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
                    src={url}
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

// --- Page Principale ---
const SearchPage = () => {
    const [query, setQuery] = useState('');
    const debouncedQuery = useDebounce(query, 400);

    const [results, setResults] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);

    // Settings & Modal
    const [useSemantic, setUseSemantic] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false); // État pour la modale

    const abortControllerRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        const key = localStorage.getItem('google_api_key');
        setHasApiKey(!!key);
        if (key) setUseSemantic(false);
        if (inputRef.current) inputRef.current.focus();
    }, []);

    // --- LOGIQUE MODALE & CLÉ ---
    const handleSaveApiKey = (key) => {
        localStorage.setItem('google_api_key', key);
        setHasApiKey(true);
        setShowApiKeyModal(false);
        setUseSemantic(true); // On active le mode sémantique automatiquement
        // Optionnel : Re-focus sur l'input
        setTimeout(() => inputRef.current?.focus(), 100);
    };

    // --- LOGIQUE DE DÉCLENCHEMENT ---
    useEffect(() => {
        if (useSemantic) return; // Mode manuel pour sémantique

        if (debouncedQuery.trim().length >= 2) {
            setPage(1);
            fetchResults(debouncedQuery, 1, true);
        } else {
            setResults([]);
            setTotalCount(0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedQuery, useSemantic]);

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
        if (isNewSearch) setResults([]);

        try {
            const response = await searchBubbles(searchTerm, pageToFetch, RESULTS_PER_PAGE);
            const newResults = response.data.results;
            const total = response.data.totalCount;

            setResults(prev => isNewSearch ? newResults : [...prev, ...newResults]);
            setTotalCount(total);
            setHasMore((isNewSearch ? newResults.length : results.length + newResults.length) < total);
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

    return (
        <div className="min-h-screen bg-slate-50/30 pb-20">

            {/* --- HERO HEADER --- */}
            <div className="bg-white border-b border-slate-200 pt-10 pb-8 px-4 shadow-sm relative overflow-hidden">

                <div className="container max-w-4xl mx-auto text-center space-y-6 relative z-10">
                    <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-slate-900">
                        Moteur de Recherche One Piece
                    </h1>

                    {/* SEARCH INPUT AREA */}
                    <div className="relative max-w-2xl mx-auto">
                        <div className="relative flex items-center shadow-lg rounded-full group focus-within:ring-2 focus-within:ring-indigo-500/50 transition-all">

                            <Input
                                ref={inputRef}
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={useSemantic ? "Décrivez une scène (ex: 'Luffy mange de la viande', 'Zoro perdu')..." : "Mots exacts (ex: 'Roi des pirates', 'Gomu Gomu')..."}
                                className={`pl-6 pr-28 h-14 text-lg rounded-full border-slate-200 transition-all ${useSemantic ? "focus-visible:ring-indigo-500 bg-indigo-50/10 border-indigo-200 placeholder:text-indigo-300" : "focus-visible:ring-amber-500"}`}
                            />

                            {/* Right Actions */}
                            <div className="absolute right-2 flex items-center gap-2">
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
                                    className={`rounded-full h-10 w-10 shadow-sm transition-all ${useSemantic
                                        ? "bg-indigo-600 hover:bg-indigo-700 text-white"
                                        : "bg-slate-900 hover:bg-slate-800 text-white"
                                        }`}
                                    onClick={handleManualSearch}
                                    disabled={isLoading || query.length < 2}
                                >
                                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* CONTROLS & INFO */}
                    <div className="flex flex-col items-center gap-4">
                        <div className="flex items-center space-x-2 bg-slate-100/50 px-4 py-2 rounded-full border border-slate-200">
                            <Switch
                                id="semantic-mode"
                                checked={useSemantic}
                                onCheckedChange={setUseSemantic}
                                disabled={!hasApiKey}
                                className="data-[state=checked]:bg-indigo-600"
                            />
                            <Label
                                htmlFor="semantic-mode"
                                className={`font-medium cursor-pointer select-none flex items-center gap-2 ${!hasApiKey ? "text-slate-400" : "text-slate-700"}`}
                            >
                                <Sparkles className={`h-4 w-4 ${useSemantic ? "text-indigo-500 fill-indigo-100" : "text-slate-400"}`} />
                                Recherche Sémantique (IA)
                            </Label>
                        </div>

                        <div className="h-8 flex items-center justify-center">
                            {useSemantic ? (
                                <div className="animate-in fade-in slide-in-from-top-1 duration-300 flex items-center gap-2 text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-md border border-indigo-100 max-w-md text-left">
                                    <Info className="h-3.5 w-3.5 flex-shrink-0" />
                                    <span>
                                        <strong>Mode Conceptuel :</strong> Décrivez l'action, l'ambiance ou les personnages présents. Appuyez sur <strong>Entrée</strong> pour lancer l'analyse.
                                    </span>
                                </div>
                            ) : (
                                <div className="animate-in fade-in slide-in-from-top-1 duration-300 flex items-center gap-2 text-xs text-slate-500 px-3 py-1.5">
                                    <Quote className="h-3.5 w-3.5" />
                                    <span>
                                        <strong>Mode Textuel :</strong> Cherche les mots exacts dans les bulles. Recherche instantanée.
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* MODIFICATION ICI : Bouton pour ouvrir la modale si pas de clé */}
                        {!hasApiKey && (
                            <button
                                onClick={() => setShowApiKeyModal(true)}
                                className="text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 hover:text-amber-800 transition-colors inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-amber-200 cursor-pointer shadow-sm"
                            >
                                <Settings className="h-3 w-3" />
                                Configurez votre clé API Google pour activer l'IA
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* --- RESULTS AREA --- */}
            <div className="container max-w-7xl mx-auto px-4 py-8">

                {/* Count */}
                {results.length > 0 && (
                    <div className="mb-6 flex items-baseline gap-2 text-slate-500 border-b border-slate-200 pb-2">
                        <span className="text-xl font-bold text-slate-900">{totalCount}</span>
                        <span>résultats trouvés</span>
                        {useSemantic && <Badge variant="secondary" className="ml-2 text-[10px] bg-indigo-100 text-indigo-700 hover:bg-indigo-200">Triés par pertinence</Badge>}
                    </div>
                )}

                {/* Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {results.map((item, index) => {
                        const isSemantic = item.type === 'semantic';

                        return (
                            <Link
                                key={`${item.id}-${index}`}
                                to={`/annotate/${item.page_id}`}
                                className="group block h-full outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 rounded-lg"
                            >
                                <Card className="h-full flex flex-col overflow-hidden border-slate-200 hover:shadow-xl hover:-translate-y-1 transition-all duration-300">

                                    {/* Image Header */}
                                    <ResultImage
                                        url={item.url_image}
                                        coords={item.coords}
                                        type={item.type}
                                    />

                                    <CardContent className="flex-1 p-5 flex flex-col gap-3">
                                        {/* Metadata Badges */}
                                        <div className="flex flex-wrap gap-1.5 mb-1">
                                            <Badge variant="outline" className="text-[10px] text-slate-500 border-slate-200 bg-slate-50 font-normal">
                                                Tome {item.context.match(/Tome (\d+)/)?.[1] || '?'}
                                            </Badge>
                                            <Badge variant="outline" className="text-[10px] text-slate-500 border-slate-200 bg-slate-50 font-normal">
                                                Ch. {item.context.match(/Chap\. (\d+)/)?.[1] || '?'}
                                            </Badge>
                                        </div>

                                        <Separator className="bg-slate-100" />

                                        {/* Content Text */}
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

                                    <CardFooter className="bg-slate-50 px-5 py-3 border-t border-slate-100">
                                        <div className="flex items-center justify-between w-full text-xs text-slate-400 group-hover:text-indigo-600 transition-colors font-medium">
                                            <span className="flex items-center gap-1.5">
                                                <MapPin className="h-3 w-3" />
                                                Page {item.context.match(/Page (\d+)/)?.[1] || '?'}
                                            </span>
                                            {item.similarity > 0 && (
                                                <span className={`font-mono px-1.5 py-0.5 rounded ${item.similarity > 0.8 ? "bg-green-100 text-green-700" : "bg-slate-100"}`}>
                                                    {(item.similarity * 100).toFixed(0)}%
                                                </span>
                                            )}
                                        </div>
                                    </CardFooter>
                                </Card>
                            </Link>
                        );
                    })}
                </div>

                {/* --- LOADING & EMPTY --- */}
                {isLoading && (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                        <p className="text-slate-500 text-sm font-medium animate-pulse">
                            {useSemantic ? "L'IA analyse les concepts..." : "Recherche dans les archives..."}
                        </p>
                    </div>
                )}

                {!isLoading && results.length === 0 && query.length >= 2 && (
                    <div className="flex flex-col items-center justify-center py-20 text-center max-w-md mx-auto">
                        <div className="bg-slate-100 p-4 rounded-full mb-4">
                            <BookOpen className="h-8 w-8 text-slate-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-slate-900 mb-2">Aucun résultat trouvé</h3>
                        <p className="text-slate-500 text-sm mb-6">
                            Nous n'avons rien trouvé pour "{query}".
                            {!useSemantic && hasApiKey && " Essayez d'activer la recherche sémantique pour une recherche plus conceptuelle."}
                        </p>
                        {!useSemantic && hasApiKey && (
                            <Button onClick={() => setUseSemantic(true)} variant="outline" className="border-indigo-200 text-indigo-600 hover:bg-indigo-50">
                                <Sparkles className="h-4 w-4 mr-2" />
                                Activer l'IA
                            </Button>
                        )}
                    </div>
                )}

                {!isLoading && hasMore && (
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
                )}
            </div>

            {/* --- MODALE API KEY --- */}
            <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Configuration API IA</DialogTitle>
                        <DialogDescription>
                            Ajoutez votre clé pour activer la recherche sémantique.
                        </DialogDescription>
                    </DialogHeader>
                    <ApiKeyForm onSave={handleSaveApiKey} />
                </DialogContent>
            </Dialog>
        </div>
    );
};

// Helper pour surligner le texte
const highlightText = (text, highlight) => {
    if (!text) return "";
    if (!highlight || !highlight.trim()) return text;

    const cleanText = text.replace(/^\[Concept\]\s*/, '');
    const escapedHighlight = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export default SearchPage;