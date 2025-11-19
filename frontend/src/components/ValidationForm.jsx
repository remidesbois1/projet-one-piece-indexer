import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { createBubble, updateBubbleText } from '../services/api';
import styles from './ValidationForm.module.css';

const ValidationForm = ({ annotationData, onValidationSuccess, onCancel }) => {
  const { session } = useAuth();
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef(null);

  const isEditing = annotationData && annotationData.id; 

  // Focus automatique sur le textarea à l'ouverture
  useEffect(() => {
    if (textareaRef.current) {
        textareaRef.current.focus();
    }
  }, []);

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
      } else {
        // Mode CRÉATION
        const finalBubbleData = {
            id_page: annotationData.id_page,
            x: annotationData.x, y: annotationData.y,
            w: annotationData.w, h: annotationData.h,
            texte_propose: text,
        };
        await createBubble(finalBubbleData, session.access_token);
      }
      // On appelle le succès seulement après la fin de l'await pour fermer la modale proprement
      onValidationSuccess();
    } catch (error) {
      console.error("Erreur soumission", error);
      alert("Une erreur est survenue. Veuillez réessayer.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!annotationData) return null;

  return (
    <form onSubmit={handleSubmit} className={styles.formContainer}>
      
      <div className={styles.header}>
        <h3 className={styles.title}>
            {isEditing ? "Édition de la bulle" : "Nouvelle annotation"}
        </h3>
        <p className={styles.subtitle}>
            {isAiFailure 
                ? "L'IA n'a pas pu lire le texte. Veuillez le transcrire manuellement." 
                : "Vérifiez ou corrigez le texte détecté ci-dessous."}
        </p>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.label}>Texte de la bulle</label>
        <textarea 
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Saisissez le texte ici..."
            className={styles.textarea}
        />
      </div>

      <div className={styles.footer}>
        {/* Bouton Annuler optionnel si onCancel est passé */}
        {onCancel && (
            <button 
                type="button" 
                onClick={onCancel} 
                className={`${styles.button} ${styles.cancelButton}`}
                disabled={isSubmitting}
            >
                Annuler
            </button>
        )}
        
        <button 
            type="submit" 
            disabled={isSubmitting} 
            className={`${styles.button} ${styles.submitButton}`}
        >
            {isSubmitting 
                ? 'Enregistrement...' 
                : (isEditing ? 'Mettre à jour' : 'Valider et créer')
            }
        </button>
      </div>
    </form>
  );
};

export default ValidationForm;