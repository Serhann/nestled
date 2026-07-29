// The people graph is written from the presence socket and the widget plane with a
// workspace resolved from a signed token, and merges rewrite rows the caller never
// selected.
// eslint-disable-next-line no-restricted-imports -- graph merges for a caller-supplied workspace
import { unscopedPrisma as prisma } from '../db/unscoped.js';

/**
 * Cross-website people pool.
 *
 * A `visitor_id` is minted in each host page's first-party localStorage, so the
 * same human on two of a customer's sites arrives as two unrelated ids. They are
 * fused into one canonical *person* using device fingerprints (stable across
 * origins) and verified email.
 *
 * SECURITY, two parts:
 *  - The graph is WORKSPACE-SCOPED. A global graph would tell one customer that a
 *    visitor also chatted with another, and would fuse unrelated customers' people
 *    by device fingerprint. Cross-WEBSITE fusion inside one workspace is the
 *    legitimate feature, and is what this does.
 *  - It is agent-facing only. Nothing here is surfaced to a visitor endpoint: a
 *    visitor still reaches only the conversation they hold a token for.
 *    Fingerprints can collide or be spoofed, so they must never become a path into
 *    another visitor's history.
 */

export interface IdentitySignals {
  fingerprint?: string | null;
  email?: string | null;
  /** The website the visitor id was minted on (replaces the old site `mode`). */
  websiteId?: string | null;
}

function normEmail(email?: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e && e.includes('@') ? e : null;
}

function normFingerprint(fp?: string | null): string | null {
  const f = (fp ?? '').trim();
  // Reject junk and trivially-common values: an all-zero or 4-character
  // "fingerprint" would fuse every visitor who failed to compute one into a single
  // person, which is worse than no fusion at all.
  if (!f || f.length < 8 || /^0+$/.test(f)) return null;
  return f.slice(0, 128);
}

/**
 * Merge several persons into the oldest and return its id. Reassigns links and
 * signals, then deletes the emptied duplicates. Transactional, so a partial merge
 * never orphans rows — and scoped to one workspace, so a fingerprint collision
 * across customers can never merge their people.
 */
async function mergePersons(workspaceId: string, personIds: string[]): Promise<string> {
  const persons = await prisma.persons.findMany({
    where: { id: { in: personIds }, workspace_id: workspaceId },
    orderBy: { created_at: 'asc' },
    select: { id: true, display_name: true, primary_email: true },
  });
  const canonical = persons[0];
  if (!canonical) return personIds[0] as string;
  if (persons.length === 1) return canonical.id;

  const losers = persons.slice(1).map((p) => p.id);
  const donorName = persons.find((p) => p.display_name)?.display_name ?? null;
  const donorEmail = persons.find((p) => p.primary_email)?.primary_email ?? null;

  await prisma.$transaction([
    prisma.visitor_links.updateMany({
      where: { person_id: { in: losers }, workspace_id: workspaceId },
      data: { person_id: canonical.id },
    }),
    prisma.person_signals.updateMany({
      where: { person_id: { in: losers }, workspace_id: workspaceId },
      data: { person_id: canonical.id },
    }),
    prisma.conversations.updateMany({
      where: { person_id: { in: losers }, workspace_id: workspaceId },
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
    prisma.persons.deleteMany({ where: { id: { in: losers }, workspace_id: workspaceId } }),
  ]);
  return canonical.id;
}

/**
 * Resolve (and fuse) the person behind a visitor id. Returns the person id, or
 * null on any failure — identity resolution is an enrichment, so it must never
 * break the conversation it is enriching.
 */
export async function resolveIdentity(
  workspaceId: string,
  visitorId: string,
  signals: IdentitySignals,
): Promise<string | null> {
  if (!workspaceId || !visitorId) return null;
  try {
    const fingerprint = normFingerprint(signals.fingerprint);
    const email = normEmail(signals.email);
    const sigPairs: { kind: string; value: string }[] = [];
    if (fingerprint) sigPairs.push({ kind: 'fingerprint', value: fingerprint });
    if (email) sigPairs.push({ kind: 'email', value: email });

    const [existingLink, matchedSignals] = await Promise.all([
      prisma.visitor_links.findUnique({
        where: { workspace_id_visitor_id: { workspace_id: workspaceId, visitor_id: visitorId } },
        select: { person_id: true },
      }),
      sigPairs.length
        ? prisma.person_signals.findMany({
            where: {
              workspace_id: workspaceId,
              OR: sigPairs.map((s) => ({ kind: s.kind, value: s.value })),
            },
            select: { person_id: true },
          })
        : Promise.resolve([] as { person_id: string }[]),
    ]);

    const candidates = new Set<string>();
    if (existingLink) candidates.add(existingLink.person_id);
    for (const m of matchedSignals) candidates.add(m.person_id);

    let personId: string;
    if (candidates.size === 0) {
      const person = await prisma.persons.create({
        data: { workspace_id: workspaceId },
        select: { id: true },
      });
      personId = person.id;
    } else if (candidates.size === 1) {
      personId = [...candidates][0] as string;
    } else {
      personId = await mergePersons(workspaceId, [...candidates]);
    }

    const now = new Date();
    await prisma.visitor_links.upsert({
      where: { workspace_id_visitor_id: { workspace_id: workspaceId, visitor_id: visitorId } },
      create: {
        workspace_id: workspaceId,
        visitor_id: visitorId,
        person_id: personId,
        website_id: signals.websiteId ?? null,
      },
      update: {
        person_id: personId,
        ...(signals.websiteId ? { website_id: signals.websiteId } : {}),
      },
    });

    for (const s of sigPairs) {
      await prisma.person_signals
        .upsert({
          where: {
            workspace_id_kind_value: { workspace_id: workspaceId, kind: s.kind, value: s.value },
          },
          create: { workspace_id: workspaceId, person_id: personId, kind: s.kind, value: s.value },
          update: { person_id: personId, hits: { increment: 1 } },
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
  /** Distinct websites this person has been seen on, within the workspace. */
  website_ids: string[];
  emails: string[];
  fingerprints: number;
  conversations: {
    id: string;
    visitor_id: string;
    visitor_name: string | null;
    status: string;
    website_id: string;
    message_count: number;
    updated_at: Date;
  }[];
  ips: { ip: string; geo: unknown; hits: number; last_seen: Date }[];
}

/**
 * The full profile for a person: every visitor id, website, email, IP and
 * conversation fused under this identity. Agent-facing, and never reachable
 * without a `workspaceId` the caller's membership was verified against.
 */
export async function getPersonProfile(
  workspaceId: string,
  personId: string,
): Promise<PersonProfile | null> {
  const person = await prisma.persons.findFirst({
    where: { id: personId, workspace_id: workspaceId },
    select: {
      id: true,
      display_name: true,
      primary_email: true,
      created_at: true,
      visitor_links: { select: { visitor_id: true, website_id: true } },
      person_signals: { select: { kind: true, value: true } },
    },
  });
  if (!person) return null;

  const visitorIds = person.visitor_links.map((v) => v.visitor_id);
  const websiteIds = [...new Set(person.visitor_links.map((v) => v.website_id).filter(Boolean))] as string[];
  const emails = person.person_signals.filter((s) => s.kind === 'email').map((s) => s.value);
  const fingerprints = person.person_signals.filter((s) => s.kind === 'fingerprint').length;

  const [conversations, ips] = await Promise.all([
    visitorIds.length
      ? prisma.conversations.findMany({
          where: { workspace_id: workspaceId, visitor_id: { in: visitorIds } },
          orderBy: { updated_at: 'desc' },
          take: 50,
          select: {
            id: true,
            visitor_id: true,
            visitor_name: true,
            status: true,
            website_id: true,
            message_count: true,
            updated_at: true,
          },
        })
      : Promise.resolve([]),
    visitorIds.length
      ? prisma.visitor_ips.findMany({
          where: { workspace_id: workspaceId, visitor_id: { in: visitorIds } },
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
    website_ids: websiteIds,
    emails,
    fingerprints,
    conversations,
    ips,
  };
}

/** The person a visitor id currently resolves to within a workspace, or null. */
export async function personIdForVisitor(
  workspaceId: string,
  visitorId: string,
): Promise<string | null> {
  const link = await prisma.visitor_links.findUnique({
    where: { workspace_id_visitor_id: { workspace_id: workspaceId, visitor_id: visitorId } },
    select: { person_id: true },
  });
  return link?.person_id ?? null;
}
