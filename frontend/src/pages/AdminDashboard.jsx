import React from 'react';
import { Link } from 'react-router-dom';
import AddTomeForm from '../components/AddTomeForm';
import AddChapterForm from '../components/AddChapterForm';
import styles from './AdminDashboard.module.css';

const AdminDashboard = () => {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Dashboard Administrateur</h1>
        <Link to="/">Retour à l'accueil</Link>
      </header>
      
      <AddTomeForm />
      <AddChapterForm />
    </div>
  );
};

export default AdminDashboard;