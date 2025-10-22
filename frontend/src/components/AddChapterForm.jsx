import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getTomes, uploadChapter } from '../services/api';
import styles from './AddChapterForm.module.css';

const AddChapterForm = () => {
  const { session } = useAuth();
  const [tomes, setTomes] = useState([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const fetchTomes = async () => {
      try {
        const response = await getTomes(session.access_token);
        setTomes(response.data);
      } catch (error) {
        console.error("Impossible de charger les tomes", error);
      }
    };
    if (session) {
      fetchTomes();
    }
  }, [session]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage('Upload en cours...');
    const formData = new FormData(event.target);
    
    try {
      const token = session?.access_token;
      const response = await uploadChapter(formData, token);
      setMessage(response.data.message);
      event.target.reset();
    } catch (error) {
      const errorMessage = error.response?.data?.error || "Une erreur est survenue.";
      setMessage(errorMessage);
    }
  };

  return (
    <div className={styles.formContainer}>
      <h3>2. Ajouter un Chapitre (via .cbz)</h3>
      <form onSubmit={handleSubmit}>
        <div className={styles.formGroup}>
          <label htmlFor="chap-tome">Appartient au Tome :</label>
          <select id="chap-tome" name="tome_id" required className={styles.formInput}>
            <option value="">-- Sélectionner un tome --</option>
            {tomes.map(tome => (
              <option key={tome.id} value={tome.id}>Tome {tome.numero} - {tome.titre}</option>
            ))}
          </select>
        </div>
        <div className={styles.formGroup}>
          <label htmlFor="chap-numero">Numéro du chapitre :</label>
          <input id="chap-numero" type="number" name="numero" required className={styles.formInput} />
        </div>
        <div className={styles.formGroup}>
          <label htmlFor="chap-titre">Titre du chapitre :</label>
          <input id="chap-titre" type="text" name="titre" required className={styles.formInput} />
        </div>
        <div className={styles.formGroup}>
          <label htmlFor="chap-file">Fichier .cbz :</label>
          <input id="chap-file" type="file" name="cbzFile" accept=".cbz,.zip" required className={styles.formInput} />
        </div>
        <button type="submit" className={styles.submitButton}>Ajouter le Chapitre</button>
      </form>
      {message && <p className={styles.message}>{message}</p>}
    </div>
  );
};

export default AddChapterForm;