import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import styles from './Header.module.css';

const Header = () => {
  const { user, signOut } = useAuth();
  const { profile } = useUserProfile();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  const isAdmin = profile?.role === 'Admin';
  const isModo = profile?.role === 'Modo';

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <Link to="/">Projet Poneglyph</Link>
      </div>
      <nav className={styles.nav}>
        <Link to="/">Bibliothèque</Link>
        <Link to="/search">Recherche</Link>
        <Link to="/bounties">Primes</Link>
        <Link to="/my-submissions">Mes Soumissions</Link>
        {(isAdmin || isModo) && <Link to="/moderation">Modération</Link>}
        {isAdmin && <Link to="/admin">Administration</Link>}
      </nav>
      <div className={styles.userSection}>
        {user ? (
          <>
            <span>{user.email}</span>
            <button onClick={handleLogout} className={styles.logoutButton}>
              Déconnexion
            </button>
          </>
        ) : (
          <Link to="/login">Connexion</Link>
        )}
      </div>
    </header>
  );
};

export default Header;