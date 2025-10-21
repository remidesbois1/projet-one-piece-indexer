import React from 'react';
import { Link } from 'react-router-dom';
import AddTomeForm from '../components/AddTomeForm';
import AddChapterForm from '../components/AddChapterForm';

const AdminDashboard = () => {
  return (
    <div style={{ padding: '20px' }}>
      <div style={{display: 'flex', justifyContent: 'space-between'}}>
        <h1>Dashboard Administrateur</h1>
        <Link to="/">Retour à l'accueil</Link>
      </div>
      <hr />
      
      <AddTomeForm />
      <AddChapterForm />
    </div>
  );
};

export default AdminDashboard;