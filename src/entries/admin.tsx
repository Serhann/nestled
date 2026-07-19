import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPanel } from '../components/AdminPanel';
import '../index.css';
import { registerServiceWorker } from '../utils/registerSW';

// The admin app is the installable PWA (Web Push, home-screen). Only this route
// registers the service worker — the widget (/chat) and demo never do.
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminPanel />
  </StrictMode>,
);
