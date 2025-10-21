import React from 'react';
import { Routes, Route } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import AnnotatePage from './pages/AnnotatePage';
import SearchPage from './pages/SearchPage';
import ProtectedRoute from './components/ProtectedRoute';

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
    </Routes>
  );
}

export default App;