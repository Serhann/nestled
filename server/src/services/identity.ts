import { prisma } from '../db/prisma.js';

/**
 * Cross-site people pool.
 *
 * A `visitor_id` is minted in each host page's first-party localStorage, so the
 * same human on two customer sites (different origins) arrives as two unrelated
 * ids. We fuse them into one canonical *person* from device fingerprints (stable
 * across origins) and email.
 *
 * SECURITY: this graph is admin-only. Nothing here is ever surfaced to a visitor
 * endpoint — a visitor can still only reach a conversation they hold the token
 * for. Fingerprints can collide or be spoofed, so they must never be a path to
 * another visitor's history (security rule #7).
 */

export interface IdentitySignals {
  fingerprint?: string | null;
  email?: string | null;
  mode?: string | null;
}

function normEmail(email?: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e && e.includes('@') ? e : null;
}

function normFingerprint(fp?: string | null): string | null {
  const f = (fp ?? '').trim();
  // Guard against junk / trivially-common values (all-zero, too short).
  if (!f || f.length < 8 || /^0+$/.test(f)) return null;
  return f.slice(0, 128);
}

/**
 * Merge several persons into the oldest one and return its id. Reassigns all
 * visitor links and signals; deletes the now-empty duplicates. Runs in a
 * transaction so a partial merge never orphans rows.
 */
async function mergePersons(personIds: string[]): Promise<string> {
  const persons = await prisma.persons.findMany({
    where: { id: { in: personIds } },
    orderBy: { created_at: 'asc' },
    select: { id: true, display_name: true, primary_email: true },
  });
  const canonical = persons[0];
  if (!canonical) return personIds[0] as string;
  if (persons.length === 1) return canonical.id;

  const losers = persons.slice(1).map((p) => p.id);
  // Fill canonical's name/email from a loser if it is missing one.
  const donorName = persons.find((p) => p.display_name)?.display_name ?? null;
  const donorEmail = persons.find((p) => p.primary_email)?.primary_email ?? null;

  await prisma.$transaction([
    prisma.visitor_links.updateMany({
      where: { person_id: { in: losers } },
      data: { person_id: canonical.id },
    }),
    prisma.person_signals.updateMany({
      where: { person_id: { in: losers } },
      data: { person_id: canonical.id },
    }),
    prisma.persons.update({
      where: { id: canonical.id },
      data: {
        display_name: canonical.display_name ?? donorName,
        primary_email: canonical.primary_email ?? donorEmail,
        updated_at: new Date(),
      },
    }),
    prisma.persons.deleteMany({ where: { id: { in: losers } } }),
  ]);
  return canonical.id;
}

/**
 * Resolve a visitor id (+ any identity signals) to a canonical person id,
 * creating / linking / merging as needed. Best-effort: returns null on failure
 * rather than throwing into the request path.
 */
export async function resolveIdentity(
  visitorId: string | null | undefined,
  signals: IdentitySignals = {},
): Promise<string | null> {
  if (!visitorId) return null;
  try {
    const fingerprint = normFingerprint(signals.fingerprint);
    const email = normEmail(signals.email);
    const sigPairs: { kind: string; value: string }[] = [];
    if (fingerprint) sigPairs.push({ kind: 'fingerprint', value: fingerprint });
    if (email) sigPairs.push({ kind: 'email', value: email });

    // Persons implied by (a) this visitor's existing link and (b) the signals.
    const [existingLink, matchedSignals] = await Promise.all([
      prisma.visitor_links.findUnique({
        where: { visitor_id: visitorId },
        select: { person_id: true },
      }),
      sigPairs.length
        ? prisma.person_signals.findMany({
            where: { OR: sigPairs.map((s) => ({ kind: s.kind, value: s.value })) },
            select: { person_id: true },
          })
        : Promise.resolve([] as { person_id: string }[]),
    ]);

    const candidates = new Set<string>();
    if (existingLink) candidates.add(existingLink.person_id);
    for (const m of matchedSignals) candidates.add(m.person_id);

    let personId: string;
    if (candidates.size === 0) {
      const person = await prisma.persons.create({ data: {}, select: { id: true } });
      personId = person.id;
    } else if (candidates.size === 1) {
      personId = [...candidates][0] as string;
    } else {
      personId = await mergePersons([...candidates]);
    }

    const now = new Date();
    await prisma.visitor_links.upsert({
      where: { visitor_id: visitorId },
      create: { visitor_id: visitorId, person_id: personId, mode: signals.mode ?? null },
      update: { person_id: personId, last_seen: now, ...(signals.mode ? { mode: signals.mode } : {}) },
    });

    for (const s of sigPairs) {
      await prisma.person_signals
        .upsert({
          where: { kind_value: { kind: s.kind, value: s.value } },
          create: { person_id: personId, kind: s.kind, value: s.value },
          update: { person_id: personId, hits: { increment: 1 }, last_seen: now },
        })
        .catch(() => undefined);
    }

    if (email) {
      await prisma.persons
        .update({ where: { id: personId }, data: { primary_email: email, updated_at: now } })
        .catch(() => undefined);
    }
    return personId;
  } catch {
    return null;
  }
}

export interface PersonProfile {
  id: string;
  display_name: string | null;
  primary_email: string | null;
  created_at: Date;
  visitor_ids: string[];
  sites: string[]; // distinct modes / site keys seen
  emails: string[];
  fingerprints: number; // count of distinct device signals
  conversations: {
    id: string;
    visitor_id: string;
    visitor_name: string | null;
    status: string;
    mode: string | null;
    message_count: number;
    updated_at: Date;
  }[];
  ips: { ip: string; geo: unknown; hits: number; last_seen: Date }[];
}

/**
 * Full cross-site profile for a person — every visitor id, site, email, IP and
 * conversation fused under this identity. Admin-only.
 */
export async function getPersonProfile(personId: string): Promise<PersonProfile | null> {
  const person = await prisma.persons.findUnique({
    where: { id: personId },
    select: {
      id: true,
      display_name: true,
      primary_email: true,
      created_at: true,
      visitors: { select: { visitor_id: true, mode: true } },
      signals: { select: { kind: true, value: true } },
    },
  });
  if (!person) return null;

  const visitorIds = person.visitors.map((v) => v.visitor_id);
  const sites = [...new Set(person.visitors.map((v) => v.mode).filter(Boolean) as string[])];
  const emails = [
    ...new Set(person.signals.filter((s) => s.kind === 'email').map((s) => s.value)),
  ];
  const fingerprints = person.signals.filter((s) => s.kind === 'fingerprint').length;

  const [conversations, ips] = await Promise.all([
    visitorIds.length
      ? prisma.conversations.findMany({
          where: { visitor_id: { in: visitorIds } },
          orderBy: { updated_at: 'desc' },
          take: 100,
          select: {
            id: true,
            visitor_id: true,
            visitor_name: true,
            status: true,
            message_count: true,
            updated_at: true,
            metadata: true,
          },
        })
      : Promise.resolve([]),
    visitorIds.length
      ? prisma.visitor_ips.findMany({
          where: { visitor_id: { in: visitorIds } },
          orderBy: { last_seen: 'desc' },
          take: 50,
          select: { ip: true, geo: true, hits: true, last_seen: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    id: person.id,
    display_name: person.display_name,
    primary_email: person.primary_email,
    created_at: person.created_at,
    visitor_ids: visitorIds,
    sites,
    emails,
    fingerprints,
    conversations: conversations.map((c) => ({
      id: c.id,
      visitor_id: c.visitor_id,
      visitor_name: c.visitor_name,
      status: c.status,
      mode: ((c.metadata as Record<string, unknown> | null)?.widget_mode as string) ?? null,
      message_count: c.message_count,
      updated_at: c.updated_at,
    })),
    ips,
  };
}

/** Look up the person a given visitor id currently resolves to (or null). */
export async function personIdForVisitor(visitorId: string): Promise<string | null> {
  const link = await prisma.visitor_links.findUnique({
    where: { visitor_id: visitorId },
    select: { person_id: true },
  });
  return link?.person_id ?? null;
}
