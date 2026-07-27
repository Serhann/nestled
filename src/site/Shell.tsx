import type { ReactNode } from 'react';
import { ORIGINS } from '../lib/origins';

/**
 * The marketing frame.
 *
 * Everything under src/site/ is rendered to static HTML at build time, which has
 * a pleasant consequence: icons, layout and copy cost the visitor no JavaScript
 * at all. They arrive as markup. That is why these pages can afford to be
 * generous with detail — the only script the landing page loads is the support
 * chat loader, and even that waits for an idle moment.
 */

const APP = ORIGINS.app;

export function Shell({ current, children }: { current: string; children: ReactNode }) {
  const links = [
    { href: '/features', label: 'What it does' },
    { href: '/compare', label: 'Compare' },
    { href: '/pricing', label: 'Pricing' },
  ];

  return (
    <div className="min-h-dvh flex flex-col bg-canvas text-gray-800">
      <header className="sticky top-0 z-20 border-b border-gray-200/60 bg-canvas/85 backdrop-blur">
        <nav className="max-w-6xl mx-auto flex items-center gap-6 px-5 h-16" aria-label="Main">
          <a href="/" className="flex items-center gap-2 font-display text-xl shrink-0">
            <span className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center">
              n
            </span>
            Nestled
          </a>
          <div className="hidden sm:flex items-center gap-5 text-sm font-medium ml-2">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={
                  current === link.href ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'
                }
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm font-semibold">
            <a href={`${APP}/login`} className="text-gray-600 hover:text-gray-900">
              Sign in
            </a>
            <a
              href={`${APP}/signup`}
              className="bg-blue-600 text-white rounded-full px-4 py-2 hover:bg-blue-700 transition"
            >
              Try it free
            </a>
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-gray-200/60 bg-cream">
        <div className="max-w-6xl mx-auto px-5 py-10 grid gap-8 sm:grid-cols-[2fr_1fr_1fr]">
          <div>
            <p className="flex items-center gap-2 font-display text-lg">
              <span className="w-7 h-7 rounded-lg bg-blue-600 text-white text-sm flex items-center justify-center">
                n
              </span>
              Nestled
            </p>
            <p className="mt-2 text-sm text-gray-500 max-w-xs">
              Live chat for people who would rather be running their business than
              answering the same question again.
            </p>
          </div>
          <FooterColumn
            title="Product"
            links={[
              ['What it does', '/features'],
              ['Compare', '/compare'],
              ['Pricing', '/pricing'],
              ['Sign in', `${APP}/login`],
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              ['Privacy', '/privacy'],
              ['Terms', '/terms'],
            ]}
          />
        </div>
        <div className="max-w-6xl mx-auto px-5 pb-8 text-xs text-gray-400">
          © {new Date().getFullYear()} Nestled
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map(([label, href]) => (
          <li key={href}>
            <a href={href} className="text-gray-600 hover:text-gray-900">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A full-width band, so sections alternate without every page repeating the markup. */
export function Band({
  tone = 'canvas',
  children,
}: {
  tone?: 'canvas' | 'cream' | 'ink';
  children: ReactNode;
}) {
  const tones = {
    canvas: 'bg-canvas',
    cream: 'bg-cream',
    ink: 'bg-gray-900 text-gray-100',
  } as const;
  return (
    <section className={tones[tone]}>
      <div className="max-w-6xl mx-auto px-5 py-16 sm:py-20">{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  center = true,
  dark = false,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  center?: boolean;
  dark?: boolean;
}) {
  return (
    <div className={`${center ? 'text-center max-w-2xl mx-auto' : 'max-w-2xl'} mb-10`}>
      {eyebrow && (
        <p
          className={`text-xs font-semibold uppercase tracking-widest ${
            dark ? 'text-blue-300' : 'text-blue-700'
          }`}
        >
          {eyebrow}
        </p>
      )}
      <h2
        className={`font-display text-3xl sm:text-4xl mt-2 text-balance ${dark ? 'text-white' : 'text-gray-800'}`}
      >
        {title}
      </h2>
      {lead && (
        <p className={`mt-3 text-lg text-pretty ${dark ? 'text-gray-300' : 'text-gray-600'}`}>{lead}</p>
      )}
    </div>
  );
}

export function PrimaryCta({ label = 'Try it free', sub }: { label?: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap gap-3 justify-center">
        <a
          href={`${APP}/signup`}
          className="bg-blue-600 text-white rounded-full px-7 py-3.5 font-semibold hover:bg-blue-700 transition shadow-sm"
        >
          {label}
        </a>
        <a
          href="/features"
          className="bg-white border border-gray-200 rounded-full px-7 py-3.5 font-semibold hover:bg-gray-50 transition"
        >
          See everything it does
        </a>
      </div>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}
