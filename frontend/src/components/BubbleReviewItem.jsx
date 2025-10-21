import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getBubbleCrop } from '../services/api';

const API_BASE_URL = 'http://localhost:3001';

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
    <div style={{ display: 'flex', alignItems: 'center', border: '1px solid #ccc', padding: '10px', marginBottom: '10px' }}>
      {isLoading ? (
        <div style={{ width: '150px', height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid black', marginRight: '15px' }}>
          <small>Chargement...</small>
        </div>
      ) : (
        <img 
          src={imageSrc} 
          alt="Aperçu de la bulle" 
          style={{ border: '1px solid black', marginRight: '15px', maxWidth: '300px' }} 
        />
      )}
      <div style={{ flexGrow: 1 }}>
        <p><strong>Texte proposé :</strong></p>
        <p>"{bubble.texte_propose}"</p>
      </div>
      <div>
        <button onClick={() => onAction('validate', bubble.id)} style={{ background: 'lightgreen', marginRight: '5px' }}>Valider</button>
        <button onClick={() => onAction('reject', bubble.id)} style={{ background: 'lightcoral' }}>Rejeter</button>
      </div>
    </div>
  );
};

export default BubbleReviewItem;