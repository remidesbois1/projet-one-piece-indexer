import React from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';

const Layout = () => {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Header Sticky en haut */}
      <Header />
      
      {/* Main prend tout l'espace restant */}
      <main className="flex-1 w-full">
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;