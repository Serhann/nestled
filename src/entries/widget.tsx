import { createRoot } from 'react-dom/client';
import { useWidgetConfig } from '../widget/state/useWidgetConfig';
import { Widget } from '../widget/Widget';
import '../widget/widget.css';

/**
 * The visitor widget's entry point — the document embed.js iframes.
 *
 * No StrictMode. Its double-invoked effects exist to surface impure setup, but
 * here every effect is a network call against a customer's production site: a
 * second mount mints a second widget session, opens a second WebSocket and can
 * create a duplicate conversation. The pattern StrictMode is meant to catch is
 * cheaper to find by reading `state/` than by paying for it on every dev load.
 *
 * It also imports NOTHING from src/app, src/ui or src/ops — the Rollup entry is
 * the isolation boundary, and vite.config.ts fails the build if that is broken.
 */
function Root() {
  const config = useWidgetConfig();
  // Loading and disabled render the same nothing: an unpaid, unauthorized or
  // not-yet-booted widget must never flash a launcher onto a customer's page.
  if (config.status !== 'ready') return null;
  return (
    <Widget
      params={config.params}
      api={config.api}
      boot={config.boot}
      copy={config.copy}
      theme={config.theme}
    />
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
