import React from 'react';
import { Link } from 'react-router-dom';
import AddTomeForm from '../components/AddTomeForm';
import AddChapterForm from '../components/AddChapterForm';
import styles from './AdminDashboard.module.css';

const AdminDashboard = () => {
  return (
    <div className={styles.container}>
      <div className={styles.subHeader}>
        <h1>Administration</h1>
      </div>

      <div className={styles.formSection}>
        <AddTomeForm />
      </div>

      <div className={styles.formSection}>
        <AddChapterForm />
      </div>
    </div>
  );
};

export default AdminDashboard;