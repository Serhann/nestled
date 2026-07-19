import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Multi-page app: each route is a real, separate HTML document (no client-side
// SPA routing). Vite serves them at clean paths in dev (htmlFallbackMiddleware
// maps /admin → admin.html, /chat → chat.html, /demo → demo.html, / → index.html).
export default defineConfig({
  appType: 'mpa',
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
        chat: resolve(__dirname, 'chat.html'),
        demo: resolve(__dirname, 'demo.html'),
      },
    },
  },
  server: {
    // Dev proxy so the app talks to the backend same-origin (no CORS juggling):
    // browser → localhost:5173 → JetChat server on :4000.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
});
