import { renderToString } from 'react-dom/server';
import { PAGES, renderPage } from './pages';
import { RUNTIME_URL_PLACEHOLDER, seoFor } from './seo';

/**
 * The build-time renderer. Imported only by scripts/prerender.mjs — never by the
 * browser bundle.
 *
 * `seoFor` is re-exported here rather than imported by the script directly because the
 * script is plain `.mjs` and this module is the one already compiled for it. The head
 * metadata and the markup then come from the same build, so a page's structured data cannot
 * describe a version of the page that is no longer rendered.
 */
export { PAGES, seoFor, RUNTIME_URL_PLACEHOLDER };

export function render(path: string): string {
  return renderToString(renderPage(path));
}
