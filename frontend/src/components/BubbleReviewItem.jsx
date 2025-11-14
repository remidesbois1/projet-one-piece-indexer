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
    if (token) {
      setIsLoading(true);
      getBubbleCrop(bubble.id, token)
        .then(response => {
          const localUrl = URL.createObjectURL(response.data);
          setImageSrc(localUrl);
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }

    return () => {
      if (imageSrc) {
        URL.revokeObjectURL(imageSrc);
      }
    };
  }, [bubble.id, session]);

  return (
    <div className={styles.itemContainer}>
      <div className={styles.imageContainer}>
        {isLoading ? (
          <small className={styles.loadingText}>Chargement...</small>
        ) : (
          <img 
            src={imageSrc} 
            alt="Aperçu de la bulle" 
            className={styles.cropImage} 
          />
        )}
      </div>
      <div className={styles.content}>
        <p>"{bubble.texte_propose}"</p>
      </div>
      <div className={styles.actions}>
        <button onClick={() => onAction('validate', bubble.id)} className={`${styles.actionButton} ${styles.validate}`}>Valider</button>
        <button onClick={() => onAction('reject', bubble.id)} className={`${styles.actionButton} ${styles.reject}`}>Rejeter</button>
      </div>
    </div>
  );
};

export default BubbleReviewItem;