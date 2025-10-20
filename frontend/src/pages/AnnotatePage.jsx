import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getPageById } from '../services/api';

const AnnotatePage = () => {
  const { pageId } = useParams();
  
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    getPageById(pageId)
      .then(response => {
        setPage(response.data);
      })
      .catch(error => {
        console.error("Erreur de chargement de la page", error);
        setError("Impossible de charger la page.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [pageId]);

  if (loading) {
    return <div>Chargement de la page...</div>;
  }

  if (error) {
    return (
      <div>
        <p style={{color: 'red'}}>{error}</p>
        <Link to="/">Retour à l'accueil</Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: '10px', background: '#f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Annotation - Page {page.numero_page}</h2>
        <Link to="/">Retour à la sélection</Link>
      </div>
      
      <div style={{ textAlign: 'center', marginTop: '20px' }}>
        {/* L'élément img affiche l'image de la page du manga */}
        <img 
          src={page.url_image} 
          alt={`Page ${page.numero_page}`} 
          style={{ maxWidth: '90%', maxHeight: '80vh', border: '1px solid black' }}
        />
      </div>
    </div>
  );
};

export default AnnotatePage;