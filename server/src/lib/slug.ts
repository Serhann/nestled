// Slug uniqueness is GLOBAL — the whole point is checking a name nobody else in
// any workspace has taken, which a scoped client cannot see.
// eslint-disable-next-line no-restricted-imports -- slug uniqueness is global
import { unscopedPrisma } from '../db/unscoped.js';

/** Workspace slugs appear in URLs (/w/<slug>), so keep them short and unambiguous. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Reserved because they either collide with a real app route or would let someone
 * mint a workspace that impersonates us (`/w/admin`, `/w/support`).
 */
const RESERVED = new Set([
  'admin', 'api', 'app', 'ops', 'www', 'mail', 'support', 'help', 'billing',
  'settings', 'account', 'login', 'signup', 'setup', 'new', 'workspaces',
  'nestled', 'status', 'docs', 'blog', 'pricing', 'static', 'assets', 'widget',
]);

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents so "Şirket" -> "sirket"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return base || 'workspace';
}

export function slugIsValid(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED.has(slug);
}

/** True if the slug is well-formed, unreserved and unclaimed. */
export async function slugIsAvailable(slug: string): Promise<boolean> {
  if (!slugIsValid(slug)) return false;
  const existing = await unscopedPrisma.workspaces.findUnique({
    where: { slug },
    select: { id: true },
  });
  return !existing;
}

/**
 * A free slug derived from `name`, suffixing -2, -3, … on collision. Bounded so a
 * pathological name can't spin: after 50 tries fall back to a random suffix.
 */
export async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const candidate = slugIsValid(base) ? base : `${base}-1`;
  if (await slugIsAvailable(candidate)) return candidate;
  for (let i = 2; i <= 50; i++) {
    const next = `${base.slice(0, 36)}-${i}`;
    if (await slugIsAvailable(next)) return next;
  }
  return `${base.slice(0, 32)}-${Math.random().toString(36).slice(2, 8)}`;
}
