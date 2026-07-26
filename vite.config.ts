import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

/**
 * Multi-page app. Each surface is its own Rollup entry, and that boundary is the
 * enforcement mechanism — not a convention:
 *
 *   index.html   marketing        no router (Phase 14 prerenders src/site/pages/*)
 *   app.html     customer app     react-router, TanStack Query (Phase 4)
 *   ops.html     platform panel   separate origin, separate token store (Phase 13)
 *   widget.html  visitor widget   a payload budget, not an app — see widgetBundleGuard
 *   sandbox.html dev-only fake host page for the widget (excluded from prod)
 *
 * In production these are served from separate subdomains (nestled.chat, app.,
 * ops., widget.); in dev they collapse onto localhost:5173 under path prefixes.
 */

/**
 * Dev parity with the nginx SPA fallback. Vite's htmlFallbackMiddleware maps
 * `/app` → `app.html`, but NOT `/app/w/acme/inbox/123` — so deep links 404 in dev
 * while working in prod. This rewrites any sub-path back onto its entry document.
 */
function devSpaFallback(routes: Record<string, string>): Plugin {
  return {
    name: 'nestled-dev-spa-fallback',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '/';
        const path = url.split('?')[0];
        for (const [prefix, entry] of Object.entries(routes)) {
          if (path === prefix || path.startsWith(`${prefix}/`)) {
            // Leave real files (assets, /app/manifest.json) alone.
            if (/\.[a-z0-9]+$/i.test(path)) break;
            req.url = `/${entry}${url.slice(path.length)}`;
            break;
          }
        }
        next();
      });
    },
  };
}

/**
 * The widget ships to arbitrary third-party pages, so its bundle is a budget. This
 * fails the build if widget code reaches for app-sized dependencies — enforcing at
 * build time what would otherwise be a code-review rule everyone forgets.
 */
function widgetBundleGuard(opts: { maxKb: number; forbid: RegExp[] }): Plugin {
  return {
    name: 'nestled-widget-bundle-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry || chunk.name !== 'widget') continue;

        const offenders = chunk.moduleIds.filter((id) =>
          opts.forbid.some((re) => re.test(id.replace(/\\/g, '/'))),
        );
        if (offenders.length) {
          this.error(
            `widget bundle imports forbidden modules:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
          );
        }

        const kb = Buffer.byteLength(chunk.code, 'utf8') / 1024;
        if (kb > opts.maxKb) {
          this.error(`widget bundle is ${kb.toFixed(1)} KB raw, over the ${opts.maxKb} KB budget`);
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  appType: 'mpa',
  plugins: [
    react(),
    devSpaFallback({ '/app': 'app.html', '/ops': 'ops.html', '/widget': 'widget.html' }),
    widgetBundleGuard({
      // Raw (pre-gzip) ceiling; the plan's 60 KB gz target lands well under this.
      maxKb: 220,
      forbid: [/node_modules\/react-router/, /node_modules\/@tanstack/, /\/src\/ui\//, /\/src\/ops\//],
    }),
  ],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    rollupOptions: {
      input: {
        site: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        ops: resolve(__dirname, 'ops.html'),
        widget: resolve(__dirname, 'widget.html'),
        // Dev/preview aid only — never shipped to production.
        ...(mode === 'production' ? {} : { sandbox: resolve(__dirname, 'sandbox.html') }),
      },
    },
  },
  server: {
    // Dev proxy so the app talks to the backend same-origin (no CORS juggling):
    // browser → localhost:5173 → Nestled server on :4000.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
}));
