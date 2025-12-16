import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import { useNavigate } from 'react-router-dom';
import { getTomes, getChapitres, getPages } from '../services/api';
import styles from './HomePage.module.css';

const HomePage = () => {
  const { session } = useAuth();
  const { loading: profileLoading } = useUserProfile();
  const navigate = useNavigate();

  const [tomes, setTomes] = useState([]);
  
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedTome, setSelectedTome] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(null);
  
  const [chapters, setChapters] = useState([]);
  const [pages, setPages] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);

  const token = session?.access_token;

  useEffect(() => {
    if (token) {
      getTomes(token).then(res => setTomes(res.data)).catch(console.error);
    }
  }, [token]);

  const openTome = async (tome) => {
    setSelectedTome(tome);
    setIsDrawerOpen(true);
    setIsLoadingData(true);
    setSelectedChapter(null);
    setPages([]);
    
    try {
      const res = await getChapitres(tome.id, token);
      setChapters(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingData(false);
    }
  };

  const openChapter = async (chapter) => {
    setSelectedChapter(chapter);
    setIsLoadingData(true);
    try {
      const res = await getPages(chapter.id, token);
      setPages(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingData(false);
    }
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setTimeout(() => {
      setSelectedTome(null);
      setSelectedChapter(null);
    }, 350);
  };

  const getHeatmapClass = (status) => {
    switch (status) {
      case 'pending_review': return styles.statusPending;
      case 'completed': return styles.statusCompleted;
      case 'rejected': return styles.statusRejected;
      default: return '';
    }
  };

  if (profileLoading) return null;

  return (
    <div className={styles.libraryContainer}>
      
      <header className={styles.headerBar}>
        <h1 className={styles.headerTitle}>
          Poneglyph Archives
          <span className={styles.headerStats}>{tomes.length} VOL</span>
        </h1>
      </header>

      <div className={styles.tomeGrid}>
        {tomes.map(tome => (
          <div key={tome.id} className={styles.tomeItem} onClick={() => openTome(tome)}>
            <div className={styles.tomeCoverWrapper}>
               <img 
                src={tome.cover_url || 'https://placehold.co/300x450/f7fafc/cbd5e0?text=Tome'} 
                alt="" 
                className={styles.tomeCover}
              />
            </div>
            <div className={styles.tomeInfo}>
              <p className={styles.tomeTitle}>Tome {tome.numero}</p>
            </div>
          </div>
        ))}
      </div>

      
      <div 
        className={`${styles.drawerOverlay} ${isDrawerOpen ? styles.open : ''}`} 
        onClick={closeDrawer}
      />

      <div className={`${styles.drawer} ${isDrawerOpen ? styles.open : ''}`}>
        {selectedTome && (
          <>
            <div className={styles.drawerHeader}>
              <div className={styles.navBreadcrumb}>
                {selectedChapter ? (
                  <>
                    <span 
                      className={styles.navBackLink} 
                      onClick={() => setSelectedChapter(null)}
                    >
                      &larr; Tome {selectedTome.numero}
                    </span>
                    <h3 className={styles.drawerTitle}>Chapitre {selectedChapter.numero}</h3>
                  </>
                ) : (
                  <>
                    <span className={styles.navBackLink} style={{cursor: 'default', opacity: 0.5}}>
                      SÉLECTION
                    </span>
                    <h3 className={styles.drawerTitle}>Tome {selectedTome.numero}</h3>
                  </>
                )}
              </div>
              
              <button onClick={closeDrawer} className={styles.closeButton} title="Fermer">
                &times;
              </button>
            </div>

            <div className={styles.drawerContent}>
              {selectedChapter ? (
                <div className={styles.heatmapContainer}>
                  {isLoadingData ? (
                    <div className={styles.loader}>Chargement des pages...</div>
                  ) : (
                    <div className={styles.heatmapGrid}>
                      {pages.map(page => (
                        <div 
                          key={page.id} 
                          className={`${styles.heatmapItem} ${getHeatmapClass(page.statut)}`}
                          onClick={() => navigate(`/annotate/${page.id}`)}
                          title={`Page ${page.numero_page} - ${page.statut || 'À faire'}`}
                        >
                          {page.numero_page}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                isLoadingData ? (
                   <div className={styles.loader}>Chargement de l'index...</div>
                ) : (
                  <ul className={styles.chapterList}>
                    {chapters.map(chap => (
                      <li key={chap.id} className={styles.chapterItem} onClick={() => openChapter(chap)}>
                        <span className={styles.chapterNum}>{chap.numero}</span>
                        <span className={styles.chapterTitle}>{chap.titre || 'Sans titre'}</span>
                        <span className={styles.chapterArrow}>›</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default HomePage;