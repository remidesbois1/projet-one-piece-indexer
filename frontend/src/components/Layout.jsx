import React from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';

const Layout = () => {
  return (
    <div>
      <Header />
      <main style={{ padding: '2rem' }}>
        <Outlet />
      </main>
      {/* Add a Footer component here if needed later */}
    </div>
  );
};

export default Layout;