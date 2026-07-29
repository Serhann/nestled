import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ops/App';
import '../index.css';

// The vendor (platform staff) surface. Deliberately a separate build entry on a
// separate origin: it shares no auth state, no token store and no query cache with
// the customer app, so a customer-side XSS can never reach staff sessions.
//
// Everything it needs lives under src/ops/ — nothing from src/lib, src/ui, src/app
// or src/components is imported here. No service worker either: ops is not a PWA,
// and a cached staff shell is a liability rather than a feature.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
