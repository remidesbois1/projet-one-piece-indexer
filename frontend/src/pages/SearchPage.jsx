import React, { useState } from 'react';
import { searchBubbles } from '../services/api';
import styles from './SearchPage.module.css';

const RESULTS_PER_PAGE = 10;

const SearchPage = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  const performSearch = async (pageToFetch) => {
    if (query.trim().length < 3) {
      setError("Veuillez saisir au moins 3 caractères pour lancer la recherche.");
      return;
    }
    setIsLoading(true);
    setError(null);
    setSearched(true);

    try {
      const response = await searchBubbles(query, pageToFetch);
      setResults(response.data.results);
      setTotalCount(response.data.totalCount);
      setCurrentPage(pageToFetch);
    } catch (err) {
      setError("Une erreur technique est survenue. Veuillez réessayer plus tard.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = (event) => {
    event.preventDefault();
    performSearch(1);
  };

  const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

  return (
    <div className={styles.container}>
      
      <header className={styles.header}>
        <h1 className={styles.title}>Bibliothèque de Recherche</h1>
        <p className={styles.subtitle}>Trouvez n'importe quelle réplique dans l'œuvre</p>
      </header>

      <form onSubmit={handleSearch} className={styles.searchForm}>
        <input 
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher une citation, un personnage..."
          className={styles.searchInput}
          autoFocus
        />
        <button type="submit" className={styles.searchButton} disabled={isLoading}>
          {isLoading ? '...' : 'Rechercher'}
        </button>
      </form>

      {error && <div className={styles.errorState}>{error}</div>}

      <div className={styles.resultsContainer}>
        {isLoading ? (
          <div className={styles.emptyState}>Recherche en cours...</div>
        ) : (
          searched && (
            <>
              {results.length === 0 ? (
                <div className={styles.emptyState}>
                  Aucun résultat trouvé pour "{query}".
                </div>
              ) : (
                <>
                  <div className={styles.resultsMeta}>
                    <span className={styles.resultsCount}>{totalCount}</span> résultat(s) trouvé(s)
                  </div>
                  
                  <div className={styles.resultsGrid}>
                    {results.map((bubble) => (
                      <div key={bubble.id} className={styles.resultCard}>
                        <p className={styles.resultText}>« {bubble.texte_propose} »</p>
                        
                        <div className={styles.cardFooter}>
                          <span className={styles.badge}>Tome {bubble.numero_tome}</span>
                          <span className={styles.badge}>Chapitre {bubble.numero_chapitre}</span>
                          <span className={styles.badge}>Page {bubble.numero_page}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )
        )}
      </div>

      {searched && totalPages > 1 && (
        <div className={styles.pagination}>
          <button 
            onClick={() => performSearch(currentPage - 1)} 
            disabled={currentPage === 1} 
            className={styles.pageButton}
          >
            &larr; Précédent
          </button>
          
          <span className={styles.pageInfo}>
            Page {currentPage} / {totalPages}
          </span>
          
          <button 
            onClick={() => performSearch(currentPage + 1)} 
            disabled={currentPage === totalPages} 
            className={styles.pageButton}
          >
            Suivant &rarr;
          </button>
        </div>
      )}
    </div>
  );
};

export default SearchPage;