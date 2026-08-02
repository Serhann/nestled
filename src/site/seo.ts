import { FAQS } from './faqs';

/**
 * Head metadata and structured data for the marketing pages.
 *
 * ── The constraint that shapes everything here: we do not know the domain ────
 *
 * `lib/origins.ts` resolves every surface from the address bar at RUNTIME, on purpose, so
 * one container image serves `example.com`, `chat.example.com` or a tunnel without being
 * rebuilt. That decision is documented at length there, and it means the build cannot write
 * an absolute URL.
 *
 * Which matters, because a WRONG absolute URL is far more damaging than a missing one. A
 * canonical tag pointing at a domain the site is not served from tells Google the real page
 * is somewhere else, and the honest outcome of that is deindexing. So the split is:
 *
 *   Here, at build time — everything that is domain-independent: titles, descriptions,
 *   RELATIVE canonicals (permitted, and resolved against the document's own URL), og:title,
 *   og:description, og:type, twitter:card, and the JSON-LD that carries no URLs.
 *
 *   At container start — the artifacts that cannot be relative at all: sitemap.xml, the
 *   `Sitemap:` line in robots.txt, `og:url` and `og:image`. `scripts/seo-runtime.sh` writes
 *   those from the domain the container was actually given, and if it is not given one it
 *   writes nothing rather than guessing.
 */

/** Absolute-URL SEO is filled in at container start; this marks the slots for it. */
export const RUNTIME_URL_PLACEHOLDER = '__SITE_ORIGIN__';

export interface PageSeo {
  /** Site-root-relative canonical, e.g. `/pricing`. Never a filename — see below. */
  canonical: string;
  /** Open Graph type. `website` for everything here; `article` if a blog ever lands. */
  ogType: 'website';
  /** JSON-LD blocks for this page, already stringified. */
  jsonLd: string[];
}

const ORGANIZATION_ID = '#organization';
const SOFTWARE_ID = '#software';

/**
 * The publisher.
 *
 * `@id` is a bare fragment rather than an absolute IRI for the same reason as the canonicals:
 * it has to be stable and it cannot contain a domain. A fragment resolves against the
 * document, which is exactly the identity we want — "the organization described by this
 * site".
 */
function organization(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: 'Nestled',
    description:
      'Live chat, live visitor view and an AI assistant that answers from a business’s own knowledge base.',
    logo: '/icon-512.png',
  };
}

/**
 * The product, as a SoftwareApplication with its price range.
 *
 * `BusinessApplication` and a `priceRange` rather than individual `Offer`s per plan: the plan
 * prices live in the server's plan catalog and are rendered into /pricing by an island, so
 * duplicating exact figures here would create a second source that goes stale the first time
 * pricing changes — and stale prices in structured data are worse than none, because Google
 * may show them.
 */
function software(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': SOFTWARE_ID,
    name: 'Nestled',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    publisher: { '@id': ORGANIZATION_ID },
    description:
      'Live chat for websites, with a shared inbox, a live list of who is on the site, and an assistant that answers from your own knowledge base and hands over rather than guessing.',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      // A free trial is the offer we can state without pinning a figure that lives elsewhere.
      lowPrice: '0',
      offerCount: '4',
    },
  };
}

/**
 * The visible FAQ, as FAQPage.
 *
 * Built from the SAME array the page renders (see faqs.ts). Google's policy is that this
 * markup must match content visible on the page; a hand-maintained copy would drift on the
 * first reworded answer, and the penalty for drift is a manual action rather than a missing
 * rich result.
 */
function faqPage(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map(([question, answer]) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

/** Where this page sits, so Google can render a path instead of a bare URL. */
function breadcrumbs(trail: Array<{ name: string; path: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      item: step.path,
    })),
  };
}

const HOME = { name: 'Home', path: '/' };

/**
 * SEO for one page path.
 *
 * The canonical is the CLEAN path, never the `.html` file. nginx serves both — its
 * `try_files $uri $uri.html` means `/pricing` and `/pricing.html` both return the same
 * document — and two URLs serving identical content is the textbook duplicate-content
 * problem. Naming one of them canonical is the whole fix, and it is why every page here
 * carries the tag even though the content is unique.
 */
export function seoFor(path: string): PageSeo {
  const base: PageSeo = { canonical: path, ogType: 'website', jsonLd: [] };

  switch (path) {
    case '/':
      return {
        ...base,
        // Organization and the product on the page people arrive on and link to, plus the
        // FAQ, which is the only one of the three that can produce a visible rich result.
        jsonLd: [organization(), software(), faqPage()].map(stringify),
      };
    case '/features':
      return {
        ...base,
        jsonLd: [breadcrumbs([HOME, { name: 'What it does', path: '/features' }])].map(stringify),
      };
    case '/pricing':
      return {
        ...base,
        jsonLd: [
          software(),
          breadcrumbs([HOME, { name: 'Pricing', path: '/pricing' }]),
        ].map(stringify),
      };
    case '/compare':
      return {
        ...base,
        jsonLd: [breadcrumbs([HOME, { name: 'Compare', path: '/compare' }])].map(stringify),
      };
    case '/privacy':
      return {
        ...base,
        jsonLd: [breadcrumbs([HOME, { name: 'Privacy', path: '/privacy' }])].map(stringify),
      };
    case '/terms':
      return {
        ...base,
        jsonLd: [breadcrumbs([HOME, { name: 'Terms', path: '/terms' }])].map(stringify),
      };
    default:
      return base;
  }
}

/**
 * JSON-LD is embedded in a `<script>`, where the parser looks for `</script` before it looks
 * for JSON. Escaping the sequence is what stops a copy change from ending the script element
 * early and dumping the rest of the payload into the document as text.
 */
function stringify(value: object): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}
