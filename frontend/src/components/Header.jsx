import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
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

  // Helper pour appliquer la classe active proprement
  const getNavLinkClass = ({ isActive }) => 
    isActive ? `${styles.navLink} ${styles.activeLink}` : styles.navLink;

  return (
    <header className={styles.header}>
      {/* Le container gère les marges et le centrage */}
      <div className={styles.container}>
        
        <div className={styles.brand}>
          <Link to="/">Projet Poneglyph</Link>
        </div>

        <nav className={styles.nav}>
          <NavLink to="/" className={getNavLinkClass} end>
            Bibliothèque
          </NavLink>
          <NavLink to="/search" className={getNavLinkClass}>
            Recherche
          </NavLink>
          <NavLink to="/my-submissions" className={getNavLinkClass}>
            Mes Soumissions
          </NavLink>
          {(isAdmin || isModo) && (
            <NavLink to="/moderation" className={getNavLinkClass}>
              Modération
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/admin" className={getNavLinkClass}>
              Administration
            </NavLink>
          )}
        </nav>

        <div className={styles.userSection}>
          {user ? (
            <>
              <span className={styles.userEmail}>{user.email}</span>
              <button onClick={handleLogout} className={styles.logoutButton}>
                Déconnexion
              </button>
            </>
          ) : (
            <Link to="/login" className={styles.loginLink}>Connexion</Link>
          )}
        </div>

      </div>
    </header>
  );
};

export default Header;