import React from 'react';
import { useAuth } from '../context/AuthContext';
import { createTome } from '../services/api';

const AddTomeForm = ({ onTomeAdded }) => {
  const { session } = useAuth();

  const handleSubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const numero = formData.get('numero');
    const titre = formData.get('titre');

    try {
      const token = session?.access_token;
      await createTome({ numero, titre }, token);
      alert(`Le tome ${numero} a été créé !`);
      event.target.reset();
      if (onTomeAdded) onTomeAdded(); // Pour rafraîchir la liste des tomes dans le futur
    } catch (error) {
      const errorMessage = error.response?.data?.error || "Une erreur est survenue.";
      alert(errorMessage);
    }
  };

  return (
    <div style={{ border: '1px solid #ccc', padding: '20px', marginTop: '20px' }}>
      <h3>1. Créer un Nouveau Tome</h3>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '10px' }}>
          <label>Numéro : </label>
          <input type="number" name="numero" required />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label>Titre : </label>
          <input type="text" name="titre" required style={{ width: '300px' }}/>
        </div>
        <button type="submit">Créer le Tome</button>
      </form>
    </div>
  );
};

export default AddTomeForm;