import React, { useState } from 'react';
import { searchBubbles } from '../services/api';

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
    <div style={{ padding: '20px' }}>
      <h1>Recherche dans l'œuvre</h1>
      <form onSubmit={handleSearch}>
        <input 
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex: chapeau de paille"
          style={{ width: '300px', padding: '8px' }}
        />
        <button type="submit" style={{ padding: '8px' }} disabled={isLoading}>
          {isLoading ? 'Recherche...' : 'Rechercher'}
        </button>
      </form>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div style={{ marginTop: '20px' }}>
        {isLoading ? (
          <p>Chargement...</p>
        ) : (
          searched && results.length === 0 ? (
            <p>Aucun résultat trouvé pour "{query}".</p>
          ) : (
            results.map((bubble) => (
              <div key={bubble.id} style={{ border: '1px solid #ccc', padding: '10px', marginBottom: '10px' }}>
                <p><strong>"{bubble.texte_propose}"</strong></p>
                <small>
                  Source: Tome {bubble.numero_tome} - Chapitre {bubble.numero_chapitre}, Page {bubble.numero_page}
                </small>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );
};

export default SearchPage;