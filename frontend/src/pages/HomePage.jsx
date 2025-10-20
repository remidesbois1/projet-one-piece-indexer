import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const HomePage = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div>
      <h1>Bienvenue !</h1>
      <p>Connecté en tant que : {user?.email}</p>
      <button onClick={handleLogout}>Se déconnecter</button>
    </div>
  );
};

export default HomePage;