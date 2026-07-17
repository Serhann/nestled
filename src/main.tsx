import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerServiceWorker } from './utils/registerSW';

// The widget runs inside an iframe on customer sites and needs no service
// worker (push is an admin-only concern). Only register it for the admin app.
if (!new URLSearchParams(window.location.search).get('view')?.includes('widget')) {
  registerServiceWorker();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
