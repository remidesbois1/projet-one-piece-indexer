import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { updateBubbleText } from '../services/api';

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

  return (
    <div style={{ textAlign: 'center', marginTop: '10px', background: isAiFailure ? '#FFDDC1' : 'lightblue', padding: '10px' }}>
      <h3>
        {isAiFailure 
          ? "L'analyse a échoué, veuillez saisir le texte manuellement" 
          : "Vérifier le texte et valider"
        }
      </h3>
      <form onSubmit={handleSubmit}>
        <textarea 
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Saisir le texte de la bulle ici..."
          style={{ width: '80%', minHeight: '80px' }}
        />
        <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Envoi...' : 'Envoyer pour validation'}
      </button>
      </form>
    </div>
  );
};

export default ValidationForm;