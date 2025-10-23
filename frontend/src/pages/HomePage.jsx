import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import { Link, useNavigate } from 'react-router-dom';
import { getTomes, getChapitres, getPages } from '../services/api';
import styles from './HomePage.module.css';
import Modal from '../components/Modal';

const HomePage = () => {
  const { user, session, signOut } = useAuth();
  const { profile, loading: profileLoading } = useUserProfile();
  const navigate = useNavigate();

  const [tomes, setTomes] = useState([]);
  const [selectedTome, setSelectedTome] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [isLoadingChapters, setIsLoadingChapters] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [pages, setPages] = useState([]);
  const [isLoadingPages, setIsLoadingPages] = useState(false);

  const token = session?.access_token;

  useEffect(() => {
    if (token) {
      getTomes(token).then(response => setTomes(response.data)).catch(console.error);
    }
  }, [token]);

  const handleTomeClick = (tome) => {
    setSelectedTome(tome);
    setIsLoadingChapters(true);
    getChapitres(tome.id, token)
      .then(response => setChapters(response.data))
      .catch(console.error)
      .finally(() => setIsLoadingChapters(false));
  };

  const handleChapterClick = (chapter) => {
    setSelectedChapter(chapter);
    setIsLoadingPages(true);
    getPages(chapter.id, token)
      .then(response => setPages(response.data))
      .catch(console.error)
      .finally(() => setIsLoadingPages(false));
  };

  const closeModal = () => {
    setSelectedTome(null);
    setChapters([]);
    setSelectedChapter(null);
    setPages([]);
  };

  const backToChapters = () => {
    setSelectedChapter(null);
    setPages([]);
  }

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  const getPageItemClass = (status) => {
    switch (status) {
      case 'pending_review':
        return styles.pageItemPending;
      case 'completed':
        return styles.pageItemCompleted;
      default:
        return '';
    }
  };

  if (profileLoading) return <div>Chargement du profil...</div>;

  return (
    <div className={styles.libraryContainer}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Bibliothèque One Piece</h1>
        <div>
          <Link to="/my-submissions" style={{ marginRight: '15px' }}>Mes Soumissions</Link>
          {profile?.role === 'Admin' && (
            <Link to="/admin" style={{ marginRight: '15px', fontWeight: 'bold', color: 'red' }}>ADMINISTRATION</Link>
          )}
          {(profile?.role === 'Admin' || profile?.role === 'Modo') && (
            <Link to="/moderation" style={{ marginRight: '15px' }}>MODÉRATION</Link>
          )}
          <span>{user?.email}</span>
          <button onClick={handleLogout} style={{ marginLeft: '10px' }}>Se déconnecter</button>
        </div>
      </header>
      
      <main>
        <h2>Tomes</h2>
        <div className={styles.tomeGrid}>
          {tomes.map(tome => (
            <div key={tome.id} className={styles.tomeItem} onClick={() => handleTomeClick(tome)}>
              <img 
                src={tome.cover_url || 'https://placehold.co/150x225?text=Pas+d\'image'} 
                alt={`Couverture du tome ${tome.numero}`} 
                className={styles.tomeCover}
              />
              <p className={styles.tomeTitle}>Tome {tome.numero}</p>
            </div>
          ))}
        </div>
      </main>

      <Modal isOpen={!!selectedTome} onClose={closeModal}>
        {selectedTome && (
          <div>
            {selectedChapter ? (
              <div>
                <button onClick={backToChapters}>&larr; Retour aux chapitres</button>
                <h4 style={{marginTop: '1rem'}}>Chapitre {selectedChapter.numero} - Pages</h4>
                <hr />
                {isLoadingPages ? <p>Chargement...</p> : (
                  <div className={styles.pageGrid}>
                    {pages.map(page => (
                      <div 
                        key={page.id} 
                        className={`${styles.pageItem} ${getPageItemClass(page.statut)}`} 
                        onClick={() => navigate(`/annotate/${page.id}`)}
                      >
                        {page.numero_page}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <h3>Tome {selectedTome.numero} - {selectedTome.titre}</h3>
                <hr />
                {isLoadingChapters ? <p>Chargement...</p> : (
                  <ul className={styles.chapterList}>
                    {chapters.map(chap => (
                      <li key={chap.id} onClick={() => handleChapterClick(chap)}>
                        Chapitre {chap.numero} - {chap.titre}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default HomePage;