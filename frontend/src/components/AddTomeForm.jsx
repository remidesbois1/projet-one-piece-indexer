import React from 'react';
import { useAuth } from '../context/AuthContext';
import { createTome } from '../services/api';
import styles from './AddTomeForm.module.css';

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
      if (onTomeAdded) onTomeAdded();
    } catch (error) {
      const errorMessage = error.response?.data?.error || "Une erreur est survenue.";
      alert(errorMessage);
    }
  };

  return (
    <div className={styles.formContainer}>
      <h3>1. Créer un Nouveau Tome</h3>
      <form onSubmit={handleSubmit}>
        <div className={styles.formGroup}>
          <label htmlFor="tome-numero">Numéro :</label>
          <input id="tome-numero" type="number" name="numero" required className={styles.formInput} />
        </div>
        <div className={styles.formGroup}>
          <label htmlFor="tome-titre">Titre :</label>
          <input id="tome-titre" type="text" name="titre" required className={styles.formInput} />
        </div>
        <button type="submit" className={styles.submitButton}>Créer le Tome</button>
      </form>
    </div>
  );
};

export default AddTomeForm;