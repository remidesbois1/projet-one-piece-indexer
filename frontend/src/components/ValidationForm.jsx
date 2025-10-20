import React, { useState, useEffect } from 'react';

const ValidationForm = ({ bubble, onValidate }) => {
  const [text, setText] = useState('');

  useEffect(() => {
    if (bubble) {
      setText(bubble.texte_propose || '');
    }
  }, [bubble]);

  const handleSubmit = (event) => {
    event.preventDefault();
    console.log("Validation soumise avec le texte :", text);
    // onValidate(bubble.id, text);
    alert("Soumission finale à implémenter !");
  };

  if (!bubble) return null;

  return (
    <div style={{ textAlign: 'center', marginTop: '10px', background: 'lightblue', padding: '10px' }}>
      <h3>Vérifier le texte et valider</h3>
      <form onSubmit={handleSubmit}>
        <textarea 
          value={text}
          onChange={(e) => setText(e.target.value)}
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