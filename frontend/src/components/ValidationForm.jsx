import React, { useState, useEffect } from 'react';

const ValidationForm = ({ bubble, onValidate }) => {
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);

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

  const handleSubmit = (event) => {
    event.preventDefault();
    if (text.trim() === '') {
        alert("Le texte ne peut pas être vide.");
        return;
    }
    console.log("Validation soumise avec le texte :", text);
    alert("Soumission finale à implémenter !");
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
        <div style={{ marginTop: '10px' }}>
          <button type="submit">Valider la bulle</button>
        </div>
      </form>
    </div>
  );
};

export default ValidationForm;