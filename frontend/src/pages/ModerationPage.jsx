import React, { useState } from 'react';
import styles from './ModerationPage.module.css';
import BubbleReviewList from '../components/BubbleReviewList';
import PageReviewList from '../components/PageReviewList';

const ModerationPage = () => {
  const [activeTab, setActiveTab] = useState('bubbles');

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Espace Modération</h1>
        <p className={styles.description}>
          Vérifiez et validez les contributions.
        </p>
      </div>

      <div className={styles.tabsContainer}>
        <button 
          onClick={() => setActiveTab('bubbles')} 
          className={`${styles.tabButton} ${activeTab === 'bubbles' ? styles.activeTab : ''}`}
        >
          Bulles à valider
        </button>
        <button 
          onClick={() => setActiveTab('pages')} 
          className={`${styles.tabButton} ${activeTab === 'pages' ? styles.activeTab : ''}`}
        >
          Pages complètes
        </button>
      </div>

      <div className={styles.contentWrapper}>
        {activeTab === 'bubbles' && <BubbleReviewList />}
        {activeTab === 'pages' && <PageReviewList />}
      </div>
    </div>
  );
};

export default ModerationPage;