import '../index.css';
import { mountSupportWidget } from '../lib/supportWidget';

/**
 * Marketing islands.
 *
 * The pages are static HTML rendered at build time. This entry hydrates only the
 * elements marked `data-island` — and it imports React *dynamically*, so a
 * visitor to the landing page downloads a couple of kilobytes and no framework
 * at all. React arrives only on /pricing, the one page with something
 * interactive on it.
 *
 * That distinction is the whole point of prerendering here. Statically importing
 * the island would put React's 45 KB on every marketing page and quietly undo it.
 */
const target = document.querySelector<HTMLElement>('[data-island="pricing"]');

if (target) {
  void Promise.all([import('react-dom/client'), import('../site/PricingIsland')]).then(
    ([{ hydrateRoot }, { PricingIsland }]) => {
      hydrateRoot(target, <PricingIsland />);
    },
  );
}

// Someone reading the pricing page with a question is the single best moment to
// be reachable, so the marketing site carries the widget too. No identity here —
// they are anonymous by definition.
mountSupportWidget();
