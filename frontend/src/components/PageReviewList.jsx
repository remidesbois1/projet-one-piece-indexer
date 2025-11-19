import React, { useState, useEffect } from 'react';
import { getPagesForReview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import styles from './PageReviewList.module.css';

const PageReviewList = () => {
  const { session } = useAuth();
  const [pages, setPages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (session) {
      getPagesForReview(session.access_token)
        .then(response => setPages(response.data))
        .catch(err => console.error("Erreur chargement pages", err))
        .finally(() => setIsLoading(false));
    }
  }, [session]);

  if (isLoading) return <div style={{padding:'2rem', color:'#666'}}>Chargement des pages...</div>;

  return (
    <div>
      <div style={{marginBottom: '1.5rem', color: '#4b5563'}}>
        <strong>{pages.length} page(s)</strong> complétée(s) en attente de vérification finale.
      </div>
      
      <div className={styles.gridContainer}>
        {pages.length === 0 ? (
            <div className={styles.emptyMessage}>
                Toutes les pages ont été vérifiées. Bon travail !
            </div>
        ) : (
          pages.map(page => (
            <div key={page.id} className={styles.pageCard}>
                <div className={styles.cardHeader}>
                    <h3 className={styles.cardTitle}>Chapitre {page.chapitres.numero}</h3>
                    <div className={styles.cardSubtitle}>
                        Tome {page.chapitres.tomes.numero} • Page {page.numero_page}
                    </div>
                </div>
                <Link to={`/moderation/page/${page.id}`} className={styles.reviewButton}>
                    Examiner la page
                </Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default PageReviewList;