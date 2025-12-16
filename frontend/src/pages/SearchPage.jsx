import React, { useState, useEffect, useRef, useCallback } from 'react';
import { searchBubbles } from '../services/api';
import { useDebounce } from '../hooks/useDebounce';
import styles from './SearchPage.module.css';

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
    <div className={styles.container}>

      <header className={styles.header}>
        <h1 className={styles.title}>Bibliothèque de Recherche</h1>
        <p className={styles.subtitle}>Tapez pour explorer l'histoire en temps réel</p>
      </header>

      <div className={styles.searchForm}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex: 'Le roi des pirates', 'Zoro sabre'..."
          className={styles.searchInput}
          autoFocus
        />
        {query && (
          <button
            className={styles.searchButton}
            onClick={() => setQuery('')}
            style={{padding: '0 1.5rem'}}
          >
            ✕
          </button>
        )}
      </div>

      <div className={styles.resultsContainer}>
        {query.length >= 3 && !isLoading && results.length > 0 && (
          <div className={styles.resultsMeta}>
            <span className={styles.resultsCount}>{totalCount}</span> résultat(s) trouvé(s)
          </div>
        )}

        <div className={styles.resultsGrid}>
          {results.map((bubble, index) => (
            <div key={`${bubble.id}-${index}`} className={styles.resultCard}>
              <p className={styles.resultText}>
                {highlightText(bubble.texte_propose, debouncedQuery)}
              </p>
              <div className={styles.cardFooter}>
                <span className={styles.badge}>Tome {bubble.numero_tome}</span>
                <span className={styles.badge}>Chap. {bubble.numero_chapitre}</span>
                <span className={styles.badge}>Page {bubble.numero_page}</span>
              </div>
            </div>
          ))}
        </div>

        {isLoading && (
            <div className={styles.emptyState} style={{border:'none'}}>Recherche en cours...</div>
        )}

        {!isLoading && results.length === 0 && debouncedQuery.length >= 3 && (
            <div className={styles.emptyState}>Aucun résultat pour "{debouncedQuery}".</div>
        )}

        {!isLoading && hasMore && (
          <div className={styles.pagination}>
            <button onClick={loadMore} className={styles.pageButton}>
              Charger les résultats suivants 👇
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const highlightText = (text, highlight) => {
  if (!highlight.trim()) return text;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase()
          ? <strong key={i} style={{color: '#d90429'}}>{part}</strong>
          : part
      )}
    </span>
  );
};

export default SearchPage;