import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Multi-page app: each route is a real, separate HTML document (no client-side
// SPA routing). Vite serves them at clean paths in dev (htmlFallbackMiddleware
// maps /admin → admin.html, /chat → chat.html, /demo → demo.html). There is no
// landing page: the root `/` is intentionally a 404 (see the plugin below and
// nginx.conf) so the deployment surfaces nothing at its bare domain.
export default defineConfig({
  appType: 'mpa',
  plugins: [
    react(),
    {
      // Dev parity with nginx: return 404 at the bare root instead of any page.
      name: 'jetchat-root-404',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url || '').split('?')[0];
          if (path === '/' || path === '/index.html') {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          next();
        });
      },
    },
  ],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      input: {
        admin: resolve(__dirname, 'admin.html'),
        chat: resolve(__dirname, 'chat.html'),
        demo: resolve(__dirname, 'demo.html'),
        tryjet: resolve(__dirname, 'tryjet.html'),
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
