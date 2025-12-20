import React, { useState, useEffect, useRef } from 'react';
import { searchBubbles } from '../services/api';
import { useDebounce } from '../hooks/useDebounce';

// Shadcn Components
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Icons
import { Search, X, Loader2, BookOpen } from "lucide-react";

const RESULTS_PER_PAGE = 20;

const SearchPage = () => {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 400);

  const [results, setResults] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const abortControllerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    // Focus sur l'input au chargement
    if (inputRef.current) inputRef.current.focus();
  }, []);

  useEffect(() => {
    if (debouncedQuery.trim().length >= 3) {
      setResults([]);
      setPage(1);
      setTotalCount(0);
      fetchResults(debouncedQuery, 1, true);
    } else {
      setResults([]);
      setTotalCount(0);
    }
  }, [debouncedQuery]);

  const fetchResults = async (searchTerm, pageToFetch, isNewSearch) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsLoading(true);

    try {
      const response = await searchBubbles(searchTerm, pageToFetch, RESULTS_PER_PAGE);

      const newResults = response.data.results;
      const total = response.data.totalCount;

      setResults(prev => isNewSearch ? newResults : [...prev, ...newResults]);
      setTotalCount(total);
      setHasMore(results.length + newResults.length < total);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error("Erreur recherche", err);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchResults(debouncedQuery, nextPage, false);
  };

  return (
    <div className="container max-w-4xl mx-auto py-10 px-4 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* HEADER */}
      <header className="text-center mb-10 space-y-4">
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 lg:text-5xl">
          Bibliothèque de Recherche
        </h1>
        <p className="text-lg text-slate-500 max-w-2xl mx-auto">
          Explorez l'histoire à travers les dialogues. Tapez n'importe quel mot-clé, nom ou réplique culte.
        </p>
      </header>

      {/* SEARCH BAR */}
      <div className="relative max-w-2xl mx-auto mb-12">
        <div className="relative">
            <Search className="absolute left-4 top-3.5 h-5 w-5 text-slate-400 pointer-events-none" />
            <Input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ex: 'Le roi des pirates', 'Zoro sabre'..."
                className="pl-12 pr-12 h-12 text-lg rounded-full shadow-sm border-slate-200 focus-visible:ring-offset-2 focus-visible:ring-slate-400"
            />
            {query && (
                <button
                    onClick={() => setQuery('')}
                    className="absolute right-4 top-3.5 text-slate-400 hover:text-slate-600 transition-colors"
                >
                    <X className="h-5 w-5" />
                </button>
            )}
        </div>
      </div>

      {/* RESULTS AREA */}
      <div className="space-y-6">
        
        {/* Compteur de résultats */}
        {query.length >= 3 && !isLoading && results.length > 0 && (
          <div className="text-sm font-medium text-slate-500 border-b border-slate-100 pb-2 mb-6">
            <span className="text-slate-900 font-bold">{totalCount}</span> résultat(s) trouvé(s)
          </div>
        )}

        {/* Grille de résultats */}
        <div className="grid gap-4">
          {results.map((bubble, index) => (
            <Card 
                key={`${bubble.id}-${index}`} 
                className="overflow-hidden border-l-4 border-l-amber-400 hover:shadow-md transition-shadow duration-200"
            >
              <CardContent className="pt-6 pb-2">
                <p className="text-lg text-slate-700 italic font-serif leading-relaxed">
                  "{highlightText(bubble.texte_propose, debouncedQuery)}"
                </p>
              </CardContent>
              <CardFooter className="bg-slate-50/50 py-3 px-6 flex flex-wrap gap-2 items-center text-xs text-slate-500">
                 <BookOpen className="h-3 w-3 mr-1" />
                 <Badge variant="secondary" className="bg-white border-slate-200 text-slate-600 hover:bg-white">
                    Tome {bubble.numero_tome}
                 </Badge>
                 <Badge variant="secondary" className="bg-white border-slate-200 text-slate-600 hover:bg-white">
                    Chap. {bubble.numero_chapitre}
                 </Badge>
                 <Badge variant="secondary" className="bg-white border-slate-200 text-slate-600 hover:bg-white">
                    Page {bubble.numero_page}
                 </Badge>
              </CardFooter>
            </Card>
          ))}
        </div>

        {/* Loader */}
        {isLoading && (
            <div className="flex justify-center py-12">
                <div className="flex items-center gap-2 text-slate-500">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span>Recherche en cours...</span>
                </div>
            </div>
        )}

        {/* Pas de résultats */}
        {!isLoading && results.length === 0 && debouncedQuery.length >= 3 && (
            <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50 text-slate-500">
                <p>Aucun résultat pour "{debouncedQuery}".</p>
            </div>
        )}

        {/* Load More */}
        {!isLoading && hasMore && (
          <div className="flex justify-center pt-8 pb-4">
            <Button 
                variant="outline" 
                onClick={loadMore}
                className="min-w-[200px]"
            >
              Charger les résultats suivants 👇
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

// Helper pour surligner le texte
const highlightText = (text, highlight) => {
  if (!highlight.trim()) return text;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase()
          ? <strong key={i} className="text-red-600 bg-red-50 px-0.5 rounded">{part}</strong>
          : part
      )}
    </span>
  );
};

export default SearchPage;