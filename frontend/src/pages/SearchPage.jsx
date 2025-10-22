import React, { useState } from 'react';
import { searchBubbles } from '../services/api';
import styles from './SearchPage.module.css';

const SearchPage = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (event) => {
    event.preventDefault();
    if (query.length < 3) {
      setError("La recherche doit contenir au moins 3 caractères.");
      return;
    }
    setIsLoading(true);
    setError(null);
    setSearched(true);

    try {
      const response = await searchBubbles(query);
      setResults(response.data);
    } catch (err) {
      setError("Une erreur est survenue lors de la recherche.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Recherche dans l'œuvre</h1>
      </header>

      <form onSubmit={handleSearch} className={styles.searchForm}>
        <input 
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex: chapeau de paille"
          className={styles.searchInput}
        />
        <button type="submit" className={styles.searchButton} disabled={isLoading}>
          {isLoading ? 'Recherche...' : 'Rechercher'}
        </button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div>
        {isLoading ? (
          <p>Chargement...</p>
        ) : (
          searched && results.length === 0 ? (
            <p>Aucun résultat trouvé pour "{query}".</p>
          ) : (
            results.map((bubble) => (
              <div key={bubble.id} className={styles.resultItem}>
                <p className={styles.resultText}>"{bubble.texte_propose}"</p>
                <p className={styles.resultSource}>
                  Tome {bubble.numero_tome} - Chapitre {bubble.numero_chapitre}, Page {bubble.numero_page}
                </p>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );
};

export default SearchPage;