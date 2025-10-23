import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { createBubble, updateBubbleText } from '../services/api';
import styles from './ValidationForm.module.css';

const ValidationForm = ({ annotationData, onValidationSuccess }) => {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const isEditing = annotationData && annotationData.id; // On détermine si on est en mode édition

  useEffect(() => {
    if (annotationData) {
      if (annotationData.texte_propose === '<REJET>') {
        setText('');
        setIsAiFailure(true);
      } else {
        setText(annotationData.texte_propose || '');
        setIsAiFailure(false);
      }
    }
  }, [annotationData]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (text.trim() === '') {
        alert("Le texte ne peut pas être vide.");
        return;
    }
    setIsSubmitting(true);
    try {
      if (isEditing) {
        // Mode MISE À JOUR
        await updateBubbleText(annotationData.id, text, session.access_token);
        alert("Annotation mise à jour !");
      } else {
        // Mode CRÉATION
        const finalBubbleData = {
            id_page: annotationData.id_page,
            x: annotationData.x, y: annotationData.y,
            w: annotationData.w, h: annotationData.h,
            texte_propose: text,
        };
        await createBubble(finalBubbleData, session.access_token);
        alert("Annotation envoyée pour validation !");
      }
      onValidationSuccess();
    } catch (error) {
      console.error("Erreur lors de la soumission", error);
      alert("Une erreur est survenue lors de la soumission.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!annotationData) return null;

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h3 className={styles.title}>
        {isEditing 
            ? "Éditer le texte de la bulle" 
            : isAiFailure 
                ? "L'analyse a échoué, veuillez saisir le texte" 
                : "Vérifier le texte et valider"
        }
      </h3>
      <textarea 
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Saisir le texte de la bulle ici..."
        className={styles.textarea}
      />
      <button type="submit" disabled={isSubmitting} className={styles.submitButton}>
        {isSubmitting ? 'Envoi...' : (isEditing ? 'Sauvegarder les changements' : 'Envoyer pour validation')}
      </button>
    </form>
  );
};

export default ValidationForm;