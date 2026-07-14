import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Widget from './pages/Widget';

// A component to toggle body classes based on route
function RouteStyler() {
  const location = useLocation();
  
  useEffect(() => {
    if (location.pathname === '/widget') {
      document.body.classList.add('widget-mode');
    } else {
      document.body.classList.remove('widget-mode');
    }
  }, [location]);

  return null;
}

function App() {
  return (
    <HashRouter>
      <RouteStyler />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/widget" element={<Widget />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
