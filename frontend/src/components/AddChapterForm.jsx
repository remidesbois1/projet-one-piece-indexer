import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getTomes, uploadChapter } from '../services/api';

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
    <div style={{ border: '1px solid #ccc', padding: '20px', marginTop: '20px' }}>
      <h3>2. Ajouter un Chapitre (via .cbz)</h3>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '10px' }}>
          <label>Appartient au Tome : </label>
          <select name="tome_id" required>
            <option value="">-- Sélectionner un tome --</option>
            {tomes.map(tome => (
              <option key={tome.id} value={tome.id}>Tome {tome.numero} - {tome.titre}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label>Numéro du chapitre : </label>
          <input type="number" name="numero" required />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label>Titre du chapitre : </label>
          <input type="text" name="titre" required style={{ width: '300px' }} />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label>Fichier .cbz : </label>
          <input type="file" name="cbzFile" accept=".cbz,.zip" required />
        </div>
        <button type="submit">Ajouter le Chapitre</button>
      </form>
      {message && <p>{message}</p>}
    </div>
  );
};

export default AddChapterForm;