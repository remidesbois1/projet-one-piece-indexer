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
import MySubmissionsPage from './pages/MySubmissionsPage';
import Layout from './components/Layout';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/annotate/:pageId" element={<AnnotatePage />} />
        <Route path="/my-submissions" element={<MySubmissionsPage />} />
        
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
        <Route 
          path="/moderation/page/:pageId" 
          element={
            <ProtectedRoute allowedRoles={['Admin', 'Modo']}>
              <PageReview />
            </ProtectedRoute>
          } 
        />
      </Route>

      {/* Define routes outside the Layout if they shouldn't have the header, like LoginPage */}
      
    </Routes>
  );
}

export default App;