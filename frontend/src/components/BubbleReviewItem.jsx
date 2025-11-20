import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getBubbleCrop } from '../services/api';
import styles from './BubbleReviewItem.module.css';

const BubbleReviewItem = ({ bubble, onAction, onEdit }) => {
  const { session } = useAuth();
  const [imageSrc, setImageSrc] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // État pour l'animation : 'idle', 'validating', 'rejecting'
  const [animState, setAnimState] = useState('idle');

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

  // Gestionnaire avec délai pour laisser le temps à l'animation de se jouer
  const handleActionWithAnim = (type) => {
    if (animState !== 'idle') return; // Anti-spam clic

    setAnimState(type === 'validate' ? 'validating' : 'rejecting');

    // On attend 600ms (temps de l'animation) avant d'envoyer la requête
    setTimeout(() => {
        onAction(type, bubble.id);
    }, 600);
  };

  // Classe dynamique selon l'état
  const containerClass = `${styles.itemContainer} ${animState !== 'idle' ? styles[animState] : ''}`;

  return (
    <div className={containerClass}>
      
      {/* Overlay du Tampon (visible seulement pendant l'animation) */}
      {animState !== 'idle' && (
          <div className={`${styles.stamp} ${styles[animState + 'Stamp']}`}>
              {animState === 'validating' ? 'VALIDÉ' : 'REJETÉ'}
          </div>
      )}

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
            onClick={() => onEdit(bubble)} 
            className={`${styles.actionButton} ${styles.edit}`}
            title="Corriger le texte avant validation"
            disabled={animState !== 'idle'}
        >
            ✏️ Éditer
        </button>
        
        <div className={styles.separator}></div>

        <button 
            onClick={() => handleActionWithAnim('validate')} 
            className={`${styles.actionButton} ${styles.validate}`}
            title="Valider cette proposition"
            disabled={animState !== 'idle'}
        >
            ✓ Valider
        </button>
        <button 
            onClick={() => handleActionWithAnim('reject')} 
            className={`${styles.actionButton} ${styles.reject}`}
            title="Rejeter cette proposition"
            disabled={animState !== 'idle'}
        >
            ✕ Rejeter
        </button>
      </div>
    </div>
  );
};

export default BubbleReviewItem;