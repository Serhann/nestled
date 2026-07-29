import { renderToString } from 'react-dom/server';
import { PAGES, renderPage } from './pages';

/**
 * The build-time renderer. Imported only by scripts/prerender.mjs — never by the
 * browser bundle.
 */
export { PAGES };

export function render(path: string): string {
  return renderToString(renderPage(path));
}
