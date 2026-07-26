import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPanel } from '../components/AdminPanel';
import '../index.css';
import { registerServiceWorker } from '../utils/registerSW';

// The customer team app is the installable PWA (Web Push, home screen). Only this
// entry registers the service worker — the widget and the ops panel never do.
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminPanel />
  </StrictMode>,
);
