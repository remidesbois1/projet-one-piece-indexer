import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import styles from './ModerationPage.module.css';
import BubbleReviewList from '../components/BubbleReviewList';
import PageReviewList from '../components/PageReviewList';

const ModerationPage = () => {
  const [activeTab, setActiveTab] = useState('bubbles');

  return (
    <div className={styles.container}>
      
      {/* En-tête fixe */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h1>Espace Modération</h1>
          <span>Validez les contributions de la communauté</span>
        </div>
        <Link to="/" className={styles.linkBack}>
          Retour Accueil
        </Link>
      </header>

      {/* Zone principale */}
      <div className={styles.contentWrapper}>
        
        {/* Barre d'onglets */}
        <div className={styles.tabsContainer}>
          <button 
            onClick={() => setActiveTab('bubbles')} 
            className={`${styles.tabButton} ${activeTab === 'bubbles' ? styles.activeTab : ''}`}
          >
            Bulles à valider
            {/* Exemple de badge statique, à connecter aux données réelles si possible */}
            {/* <span className={styles.countBadge}>12</span> */}
          </button>
          
          <button 
            onClick={() => setActiveTab('pages')} 
            className={`${styles.tabButton} ${activeTab === 'pages' ? styles.activeTab : ''}`}
          >
            Pages complètes
          </button>
        </div>

        {/* Contenu défilable */}
        <div className={styles.tabContent}>
            <div className={styles.innerScrollContainer}>
                {activeTab === 'bubbles' && <BubbleReviewList />}
                {activeTab === 'pages' && <PageReviewList />}
            </div>
        </div>

      </div>
    </div>
  );
};

export default ModerationPage;