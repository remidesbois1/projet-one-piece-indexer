import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import { Link, useNavigate } from 'react-router-dom';
import { getTomes, getChapitres, getPages } from '../services/api';

const HomePage = () => {
  const { user, session, signOut } = useAuth();
  const { profile, loading: profileLoading } = useUserProfile();
  const navigate = useNavigate();

  const [tomes, setTomes] = useState([]);
  const [chapitres, setChapitres] = useState([]);
  const [pages, setPages] = useState([]);
  const [selectedTome, setSelectedTome] = useState('');
  const [selectedChapitre, setSelectedChapitre] = useState('');
  const [selectedPage, setSelectedPage] = useState('');

  const token = session?.access_token;

  useEffect(() => {
    if (token) {
      getTomes(token).then(response => setTomes(response.data)).catch(console.error);
    }
  }, [token]);

  useEffect(() => {
    if (selectedTome && token) {
      setChapitres([]);
      setPages([]);
      setSelectedChapitre('');
      getChapitres(selectedTome, token).then(response => setChapitres(response.data)).catch(console.error);
    }
  }, [selectedTome, token]);

  useEffect(() => {
    if (selectedChapitre && token) {
      setPages([]);
      getPages(selectedChapitre, token).then(response => setPages(response.data)).catch(console.error);
    }
  }, [selectedChapitre, token]);

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };
  
  const goToPage = () => {
    if(selectedPage) {
      navigate(`/annotate/${selectedPage}`);
    }
  }

  if (profileLoading) return <div>Chargement du profil...</div>;

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Interface de Saisie</h1>
        <div>
          {(profile?.role === 'Admin' || profile?.role === 'Modo') && (
            <Link to="/moderation" style={{ marginRight: '15px' }}>MODÉRATION</Link>
          )}
          <span>{user?.email}</span>
          <button onClick={handleLogout} style={{ marginLeft: '10px' }}>Se déconnecter</button>
        </div>
      </div>
      <hr />
      
      <h3>1. Sélectionner un Tome</h3>
      <select value={selectedTome} onChange={(e) => setSelectedTome(e.target.value)}>
        <option value="">-- Choisissez un tome --</option>
        {tomes.map(tome => (
          <option key={tome.id} value={tome.id}>Tome {tome.numero} - {tome.titre}</option>
        ))}
      </select>

      {chapitres.length > 0 && (
        <>
          <h3>2. Sélectionner un Chapitre</h3>
          <select value={selectedChapitre} onChange={(e) => setSelectedChapitre(e.target.value)}>
            <option value="">-- Choisissez un chapitre --</option>
            {chapitres.map(chapitre => (
              <option key={chapitre.id} value={chapitre.id}>Chapitre {chapitre.numero} - {chapitre.titre}</option>
            ))}
          </select>
        </>
      )}

      {pages.length > 0 && (
        <>
          <h3>3. Sélectionner une Page</h3>
          <select value={selectedPage} onChange={(e) => setSelectedPage(e.target.value)}>
            <option value="">-- Choisissez une page --</option>
            {pages.map(page => (
              <option key={page.id} value={page.id}>Page {page.numero_page}</option>
            ))}
          </select>
        </>
      )}
      
      {selectedPage && (
        <div style={{marginTop: '20px'}}>
            <button onClick={goToPage}>Aller à la page d'annotation</button>
        </div>
      )}
    </div>
  );
};

export default HomePage;