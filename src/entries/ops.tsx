import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OpsPlaceholder } from '../ops/OpsPlaceholder';
import '../index.css';

// The vendor (platform staff) surface. Deliberately a separate build entry on a
// separate origin: it shares no auth state, no token store and no query cache with
// the customer app, so a customer-side XSS can never reach staff sessions.
//
// Phase 13 fills this in (staff auth + TOTP, workspace list/detail, plan control,
// usage, global search, impersonation). No service worker here — ops is not a PWA.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OpsPlaceholder />
  </StrictMode>,
);
