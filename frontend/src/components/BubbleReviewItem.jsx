import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getBubbleCrop } from '../services/api';
import styles from './BubbleReviewItem.module.css';

const BubbleReviewItem = ({ bubble, onAction }) => {
  const { session } = useAuth();
  const [imageSrc, setImageSrc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = session?.access_token;
    let isMounted = true;

    if (token) {
      setIsLoading(true);
      getBubbleCrop(bubble.id, token)
        .then(response => {
          if (isMounted) {
            const localUrl = URL.createObjectURL(response.data);
            setImageSrc(localUrl);
          }
        })
        .catch(err => console.error("Erreur chargement image crop", err))
        .finally(() => {
          if (isMounted) setIsLoading(false);
        });
    }

    return () => {
      isMounted = false;
      if (imageSrc) {
        URL.revokeObjectURL(imageSrc);
      }
    };
  }, [bubble.id, session]);

  return (
    <div className={styles.itemContainer}>
      <div className={styles.imageContainer}>
        {isLoading ? (
          <span className={styles.loadingText}>Chargement...</span>
        ) : imageSrc ? (
          <img 
            src={imageSrc} 
            alt="Contexte" 
            className={styles.cropImage} 
          />
        ) : (
          <span className={styles.loadingText}>Image indisponible</span>
        )}
      </div>
      
      <div className={styles.content}>
        <div className={styles.label}>Proposition de texte</div>
        <p className={styles.textProposal}>{bubble.texte_propose}</p>
      </div>
      
      <div className={styles.actions}>
        <button 
            onClick={() => onAction('validate', bubble.id)} 
            className={`${styles.actionButton} ${styles.validate}`}
            title="Valider cette proposition"
        >
            ✓ Valider
        </button>
        <button 
            onClick={() => onAction('reject', bubble.id)} 
            className={`${styles.actionButton} ${styles.reject}`}
            title="Rejeter cette proposition"
        >
            ✕ Rejeter
        </button>
      </div>
    </div>
  );
};

export default BubbleReviewItem;