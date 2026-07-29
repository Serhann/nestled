import { build } from 'vite';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Turn the marketing surface into real HTML documents.
 *
 * Run after `vite build`. It performs a second, SSR-only build of
 * src/site/entry-server.tsx, renders each page to a string, and injects the
 * result into the client build's `index.html` — producing `dist/index.html`,
 * `dist/pricing.html` and the rest as documents that contain their own text.
 *
 * Why bother, when the rest of the product is a single-page app: this is the page
 * people ARRIVE on. A crawler, a link preview and someone on a bad connection all
 * need the words without executing anything, and no amount of client-side speed
 * substitutes for markup that is already there. The interactive part — the
 * pricing table — hydrates as an island, so the landing page ships kilobytes of
 * JavaScript rather than the whole application.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ssrOut = resolve(root, 'dist-ssr');

async function main() {
  await build({
    root,
    logLevel: 'warn',
    build: {
      ssr: resolve(root, 'src/site/entry-server.tsx'),
      outDir: 'dist-ssr',
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'entry-server.js' } },
    },
  });

  const { render, PAGES } = await import(pathToFileURL(resolve(ssrOut, 'entry-server.js')).href);

  // The client build's index.html already carries the hashed asset tags, so the
  // template is taken from there rather than reconstructed — otherwise every
  // cache-busting hash would have to be duplicated here and would go stale.
  const template = await readFile(resolve(root, 'dist/index.html'), 'utf8');

  for (const page of PAGES) {
    const html = render(page.path);
    const document = template
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
      .replace(
        /<meta\s+name="description"[\s\S]*?\/>/,
        `<meta name="description" content="${escapeHtml(page.description)}" />`,
      )
      .replace('<div id="site-root"></div>', `<div id="site-root">${html}</div>`);

    // A page with no island will never load React, so the modulepreload hints
    // Vite emits for the island's dependency graph are pure waste there — the
    // browser fetches them and nothing ever executes them. On the landing page
    // that was 3.4 KB of framework runtime nobody asked for, which is most of the
    // reason to prerender in the first place.
    const finished = html.includes('data-island')
      ? document
      : document.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');

    if (!finished.includes('id="site-root"')) {
      throw new Error(
        'index.html has no <div id="site-root"></div> to render into — prerender would silently ship an empty page.',
      );
    }

    await writeFile(resolve(root, 'dist', page.file), finished, 'utf8');
    // eslint-disable-next-line no-console
    console.log(
      `[prerender] dist/${page.file}  (${(finished.length / 1024).toFixed(1)} KB${
        html.includes('data-island') ? ', hydrates' : ', static'
      })`,
    );
  }

  await rm(ssrOut, { recursive: true, force: true });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[prerender] failed', err);
  process.exit(1);
});
