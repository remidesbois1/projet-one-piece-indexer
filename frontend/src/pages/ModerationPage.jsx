import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import styles from './ModerationPage.module.css';
import BubbleReviewList from '../components/BubbleReviewList';
import PageReviewList from '../components/PageReviewList';

const ModerationPage = () => {
  const [activeTab, setActiveTab] = useState('bubbles');

  return (
    <div className={styles.container}>
      
      <header className={styles.subHeader}>
        <h1>Page de Modération</h1>
      </header>
      
      <div className={styles.tabs}>
        <button onClick={() => setActiveTab('bubbles')} className={activeTab === 'bubbles' ? styles.activeTab : ''}>Bulles Individuelles</button>
        <button onClick={() => setActiveTab('pages')} className={activeTab === 'pages' ? styles.activeTab : ''}>Pages Complètes</button>
      </div>

      <div className={styles.tabContent}>
        {activeTab === 'bubbles' && <BubbleReviewList />}
        {activeTab === 'pages' && <PageReviewList />}
      </div>
    </div>
  );
};

export default ModerationPage;