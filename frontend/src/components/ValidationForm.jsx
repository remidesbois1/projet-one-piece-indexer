import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { updateBubbleText } from '../services/api';
import styles from './ValidationForm.module.css';

const ValidationForm = ({ bubble, onValidationSuccess }) => {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (bubble) {
      if (bubble.texte_propose === '<REJET>') {
        setText('');
        setIsAiFailure(true);
      } else {
        setText(bubble.texte_propose || '');
        setIsAiFailure(false);
      }
    }
  }, [bubble]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (text.trim() === '') {
        alert("Le texte ne peut pas être vide.");
        return;
    }
    setIsSubmitting(true);
    try {
      await updateBubbleText(bubble.id, text, session.access_token);
      alert("Annotation envoyée pour validation !");
      onValidationSuccess();
    } catch (error) {
      console.error("Erreur lors de la soumission", error);
      alert("Une erreur est survenue lors de la soumission.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!bubble) return null;

  const containerClasses = `${styles.formContainer} ${isAiFailure ? styles.failure : styles.success}`;

  return (
    <div className={containerClasses}>
      <form onSubmit={handleSubmit}>
        <div className={styles.formGroup}>
          <h3>
            {isAiFailure 
              ? "L'analyse a échoué, veuillez saisir le texte manuellement" 
              : "Vérifier le texte et valider"
            }
          </h3>
          <textarea 
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Saisir le texte de la bulle ici..."
            className={styles.textarea}
          />
        </div>
        <button type="submit" disabled={isSubmitting} className={styles.submitButton}>
          {isSubmitting ? 'Envoi...' : 'Envoyer pour validation'}
        </button>
      </form>
    </div>
  );
};

export default ValidationForm;