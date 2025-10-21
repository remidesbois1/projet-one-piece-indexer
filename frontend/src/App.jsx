import React from 'react';
import { Routes, Route } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import AnnotatePage from './pages/AnnotatePage';
import SearchPage from './pages/SearchPage';
import ModerationPage from './pages/ModerationPage';
import ProtectedRoute from './components/ProtectedRoute';
import AdminDashboard from './pages/AdminDashboard';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route 
        path="/" 
        element={<ProtectedRoute><HomePage /></ProtectedRoute>} 
      />
      <Route 
        path="/annotate/:pageId" 
        element={<ProtectedRoute><AnnotatePage /></ProtectedRoute>} 
      />
      <Route 
        path="/admin" 
        element={
          <ProtectedRoute allowedRoles={['Admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        } 
      />
      <Route 
        path="/moderation" 
        element={
          <ProtectedRoute allowedRoles={['Admin', 'Modo']}>
            <ModerationPage />
          </ProtectedRoute>
        } 
      />
    </Routes>
  );
}

export default App;