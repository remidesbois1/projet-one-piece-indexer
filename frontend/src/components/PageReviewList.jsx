import React, { useState, useEffect } from 'react';
import { getPagesForReview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';

const PageReviewList = () => {
  const { session } = useAuth();
  const [pages, setPages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (session) {
      getPagesForReview(session.access_token)
        .then(response => setPages(response.data))
        .finally(() => setIsLoading(false));
    }
  }, [session]);

  if (isLoading) return <p>Chargement des pages à valider...</p>;

  return (
    <div>
      <p><strong>{pages.length} page(s)</strong> en attente de vérification finale.</p>
      {pages.length === 0 ? <p>Aucune page à vérifier.</p> : (
        <ul>
          {pages.map(page => (
            <li key={page.id}>
              <Link to={`/moderation/page/${page.id}`}>
                Tome {page.chapitres.tomes.numero}, Chapitre {page.chapitres.numero}, Page {page.numero_page}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PageReviewList;