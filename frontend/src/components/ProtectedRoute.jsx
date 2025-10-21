import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { session } = useAuth();
  const { profile, loading } = useUserProfile();

  if (loading) {
    return <div>Chargement de l'utilisateur...</div>;
  }

  if (!session) {
    return <Navigate to="/login" />;
  }

  if (allowedRoles && !allowedRoles.includes(profile?.role)) {
    return <Navigate to="/" />;
  }

  return children;
};

export default ProtectedRoute;