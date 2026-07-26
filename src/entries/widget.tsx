import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatWidget } from '../components/ChatWidget';
import '../index.css';

// The bare visitor widget. This is the page the embed iframes
// (<iframe src="/widget">) and it's intentionally minimal — no service worker, no
// app code. Config arrives via query params (api, vid, href, pos, identity), set
// by embed.js.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatWidget />
  </StrictMode>,
);
