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

  const { render, PAGES, seoFor, RUNTIME_URL_PLACEHOLDER } = await import(
    pathToFileURL(resolve(ssrOut, 'entry-server.js')).href
  );

  // The client build's index.html already carries the hashed asset tags, so the
  // template is taken from there rather than reconstructed — otherwise every
  // cache-busting hash would have to be duplicated here and would go stale.
  const template = await readFile(resolve(root, 'dist/index.html'), 'utf8');

  if (!template.includes(SEO_MARKER)) {
    throw new Error(
      `index.html has no ${SEO_MARKER} marker — every page would ship without a canonical URL or any structured data.`,
    );
  }

  for (const page of PAGES) {
    const html = render(page.path);
    const document = template
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(page.title)}</title>`)
      .replace(
        /<meta\s+name="description"[\s\S]*?\/>/,
        `<meta name="description" content="${escapeHtml(page.description)}" />`,
      )
      .replace(SEO_MARKER, seoHead(page, seoFor(page.path), RUNTIME_URL_PLACEHOLDER))
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

/** Where in the template the per-page head content goes. */
const SEO_MARKER = '<!--seo-->';

/**
 * The per-page head: canonical, Open Graph, Twitter, JSON-LD.
 *
 * ── Why the canonical is relative and og:url is a placeholder ────────────────
 *
 * The build does not know the domain. `src/lib/origins.ts` resolves every surface from the
 * address bar at runtime so one image serves any host, and that is a decision worth keeping —
 * but it means an absolute URL written here would be a guess. A canonical pointing at the
 * wrong domain is not a missed opportunity, it is an instruction to Google that the real page
 * is elsewhere, and the honest outcome is deindexing.
 *
 * So: the canonical is relative, which the spec permits and Google resolves against the
 * document's own URL — correct on every host, with no configuration. The tags that CANNOT be
 * relative (`og:url`, `og:image` — the social crawlers require absolute) are emitted carrying
 * a placeholder, and `scripts/seo-runtime.sh` substitutes the real origin at container start.
 * If the container is never told a domain, that script strips those tags rather than shipping
 * a placeholder, because a broken og:url costs a link preview and a wrong one costs the page.
 */
function seoHead(page, seo, placeholder) {
  const canonicalPath = seo.canonical === '/' ? '/' : seo.canonical;
  const tags = [
    `<link rel="canonical" href="${escapeHtml(canonicalPath)}" />`,
    `<meta property="og:type" content="${escapeHtml(seo.ogType)}" />`,
    `<meta property="og:site_name" content="Nestled" />`,
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:locale" content="en" />`,
    // Substituted or stripped at container start — see the note above.
    `<meta property="og:url" content="${placeholder}${escapeHtml(canonicalPath === '/' ? '' : canonicalPath)}" />`,
    `<meta property="og:image" content="${placeholder}/icon-512.png" />`,
    // `summary_large_image` needs a wide (1.91:1) card to be worth asking for, and the only
    // image in the repository is a square icon. `summary` renders that correctly instead of
    // asking X to letterbox a logo into a banner.
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
  ];

  for (const block of seo.jsonLd) {
    tags.push(`<script type="application/ld+json">${block}</script>`);
  }
  return tags.map((tag) => `    ${tag}`).join('\n').trimStart();
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
