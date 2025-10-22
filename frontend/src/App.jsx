import React from 'react';
import { Routes, Route } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import AnnotatePage from './pages/AnnotatePage';
import SearchPage from './pages/SearchPage';
import AdminDashboard from './pages/AdminDashboard';
import ModerationPage from './pages/ModerationPage';
import PageReview from './pages/PageReview';
import ProtectedRoute from './components/ProtectedRoute';

function App() {
  return (
    <Routes>
      {/* Routes Publiques */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/search" element={<SearchPage />} />

      {/* Routes Privées */}
      <Route 
        path="/" 
        element={<ProtectedRoute><HomePage /></ProtectedRoute>} 
      />
      <Route 
        path="/annotate/:pageId" 
        element={<ProtectedRoute><AnnotatePage /></ProtectedRoute>} 
      />
      
      {/* Routes Admin */}
      <Route 
        path="/admin" 
        element={
          <ProtectedRoute allowedRoles={['Admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        } 
      />
      
      {/* Routes Modération */}
      <Route 
        path="/moderation" 
        element={
          <ProtectedRoute allowedRoles={['Admin', 'Modo']}>
            <ModerationPage />
          </ProtectedRoute>
        } 
      />
      <Route 
        path="/moderation/page/:pageId" 
        element={
          <ProtectedRoute allowedRoles={['Admin', 'Modo']}>
            <PageReview />
          </ProtectedRoute>
        } 
      />
    </Routes>
  );
}

export default App;