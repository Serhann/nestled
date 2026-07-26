// Cross-tenant by definition: the whole point of this file is to answer "which
// customer is this?" from a fragment a support agent pasted out of a ticket.
// eslint-disable-next-line no-restricted-imports -- vendor plane, searches every workspace
import { unscopedPrisma } from '../../db/unscoped.js';

/**
 * One input, dispatched on the SHAPE of what was typed.
 *
 * This saves more support time than any dashboard on this panel, and the reason is
 * the workflow it replaces. A ticket arrives containing exactly one fact — an email
 * address, a domain, a widget key from a customer's page source, or a uuid copied
 * out of a stack trace. Without this, answering "who is this and what plan are they
 * on" means guessing which of six lists to open and pasting the fragment into each.
 * With it, there is one box and the answer is one keystroke away.
 *
 * The dispatch is on shape rather than a type selector because the support agent
 * frequently does not KNOW what they are holding: a uuid from a log line could be a
 * workspace, a conversation or a person, and being asked to choose is being asked a
 * question they came here to have answered. So a uuid queries all three in
 * parallel and reports whatever it finds.
 */

export type SearchKind =
  | 'workspace'
  | 'user'
  | 'website'
  | 'conversation'
  | 'person'
  | 'invoice';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  label: string;
  sublabel: string | null;
  /** The workspace this result belongs to, so the UI can always offer one hop. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** Why this row matched, shown in the result list. */
  matched: string;
}

export interface SearchResponse {
  query: string;
  /** How the input was read. Surfaced so a wrong guess is visible, not mysterious. */
  interpretedAs: 'email' | 'website_key' | 'domain' | 'uuid' | 'text';
  results: SearchResult[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "nst_" + 24 base64url characters, so `-` and `_` are part of the alphabet — see
// the generator in routes/v1/workspaces.ts. Restricting this to [A-Za-z0-9] would
// silently misread roughly a third of real keys as free text.
const WEBSITE_KEY = /^nst_[A-Za-z0-9_-]+$/;
// A bare hostname: at least one dot, no scheme, no path, no spaces. Deliberately
// loose — a support agent pastes "acme.com", "www.acme.com" and "acme.co.uk", and
// a strict TLD list would reject the third for no benefit.
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function classify(raw: string): SearchResponse['interpretedAs'] {
  const q = raw.trim();
  if (UUID.test(q)) return 'uuid';
  if (EMAIL.test(q)) return 'email';
  if (WEBSITE_KEY.test(q)) return 'website_key';
  if (DOMAIN.test(stripUrl(q))) return 'domain';
  return 'text';
}

/** Accept a pasted URL where a hostname was meant — that is how links arrive. */
function stripUrl(q: string): string {
  const withoutScheme = q.replace(/^[a-z]+:\/\//i, '');
  return withoutScheme.split('/')[0]!.split('?')[0]!.split('#')[0]!.toLowerCase();
}

const LIMIT = 10;

export async function globalSearch(raw: string): Promise<SearchResponse> {
  const q = raw.trim();
  const interpretedAs = classify(q);
  if (q.length < 2) return { query: q, interpretedAs, results: [] };

  const results =
    interpretedAs === 'uuid'
      ? await byUuid(q)
      : interpretedAs === 'email'
        ? await byEmail(q.toLowerCase())
        : interpretedAs === 'website_key'
          ? await byWebsiteKey(q)
          : interpretedAs === 'domain'
            ? await byDomain(stripUrl(q))
            : await byText(q);

  return { query: q, interpretedAs, results };
}

/**
 * A uuid is ambiguous, so every table it could name is queried at once. Five small
 * indexed point-lookups in parallel is cheaper than making a human guess wrong
 * twice.
 */
async function byUuid(id: string): Promise<SearchResult[]> {
  const [workspace, conversation, person, website, user, invoice] = await Promise.all([
    unscopedPrisma.workspaces.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true, subscription_status: true, deleted_at: true },
    }),
    unscopedPrisma.conversations.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        visitor_name: true,
        visitor_email: true,
        created_at: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    unscopedPrisma.persons.findUnique({
      where: { id },
      select: {
        id: true,
        display_name: true,
        primary_email: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    unscopedPrisma.websites.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        primary_domain: true,
        public_key: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    unscopedPrisma.users.findUnique({
      where: { id },
      select: { id: true, name: true, email: true },
    }),
    unscopedPrisma.invoices.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        status: true,
        amount_due: true,
        currency: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
  ]);

  const out: SearchResult[] = [];
  if (workspace) {
    out.push({
      kind: 'workspace',
      id: workspace.id,
      label: workspace.name,
      sublabel: `/w/${workspace.slug} · ${workspace.deleted_at ? 'deleted' : workspace.subscription_status}`,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      matched: 'workspace id',
    });
  }
  if (conversation) {
    out.push({
      kind: 'conversation',
      id: conversation.id,
      label: conversation.visitor_name ?? conversation.visitor_email ?? 'Anonymous visitor',
      sublabel: `${conversation.status} · ${conversation.created_at.toISOString().slice(0, 10)}`,
      workspaceId: conversation.workspace.id,
      workspaceName: conversation.workspace.name,
      matched: 'conversation id',
    });
  }
  if (person) {
    out.push({
      kind: 'person',
      id: person.id,
      label: person.display_name ?? person.primary_email ?? 'Unnamed person',
      sublabel: person.primary_email,
      workspaceId: person.workspace.id,
      workspaceName: person.workspace.name,
      matched: 'person id',
    });
  }
  if (website) {
    out.push({
      kind: 'website',
      id: website.id,
      label: website.name,
      sublabel: website.primary_domain ?? website.public_key,
      workspaceId: website.workspace.id,
      workspaceName: website.workspace.name,
      matched: 'website id',
    });
  }
  if (user) {
    out.push({
      kind: 'user',
      id: user.id,
      label: user.name,
      sublabel: user.email,
      workspaceId: null,
      workspaceName: null,
      matched: 'user id',
    });
  }
  if (invoice) {
    out.push({
      kind: 'invoice',
      id: invoice.id,
      label: invoice.number ?? invoice.id,
      sublabel: `${invoice.status} · ${(invoice.amount_due / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
      workspaceId: invoice.workspace.id,
      workspaceName: invoice.workspace.name,
      matched: 'invoice id',
    });
  }
  return out;
}

/**
 * An email may be a customer's login, a visitor who left an address in a chat, or a
 * resolved person. All three are looked up, because a support agent pasting an
 * address from a ticket has no idea which one it is — and the answer to "we have no
 * account for you" is frequently "you have three conversations under that address".
 */
async function byEmail(email: string): Promise<SearchResult[]> {
  const [user, persons, conversations] = await Promise.all([
    unscopedPrisma.users.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        deleted_at: true,
        memberships: {
          where: { status: 'active' },
          select: { role: true, workspace: { select: { id: true, name: true, slug: true } } },
        },
      },
    }),
    unscopedPrisma.persons.findMany({
      where: { primary_email: email },
      take: LIMIT,
      select: {
        id: true,
        display_name: true,
        primary_email: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    unscopedPrisma.conversations.findMany({
      where: { visitor_email: email },
      take: LIMIT,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        status: true,
        visitor_name: true,
        created_at: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
  ]);

  const out: SearchResult[] = [];
  if (user) {
    out.push({
      kind: 'user',
      id: user.id,
      label: user.name,
      sublabel: user.deleted_at
        ? 'deleted account'
        : user.memberships.length === 0
          ? 'no workspace membership'
          : user.memberships.map((m) => `${m.workspace.name} (${m.role})`).join(', '),
      workspaceId: user.memberships[0]?.workspace.id ?? null,
      workspaceName: user.memberships[0]?.workspace.name ?? null,
      matched: 'account email',
    });
    // Each membership is its own hop — an agency user in three workspaces should
    // not force a second search to reach the second one.
    for (const m of user.memberships) {
      out.push({
        kind: 'workspace',
        id: m.workspace.id,
        label: m.workspace.name,
        sublabel: `/w/${m.workspace.slug} · ${m.role}`,
        workspaceId: m.workspace.id,
        workspaceName: m.workspace.name,
        matched: 'member of',
      });
    }
  }
  for (const p of persons) {
    out.push({
      kind: 'person',
      id: p.id,
      label: p.display_name ?? p.primary_email ?? email,
      sublabel: 'known visitor',
      workspaceId: p.workspace.id,
      workspaceName: p.workspace.name,
      matched: 'person email',
    });
  }
  for (const c of conversations) {
    out.push({
      kind: 'conversation',
      id: c.id,
      label: c.visitor_name ?? email,
      sublabel: `${c.status} · ${c.created_at.toISOString().slice(0, 10)}`,
      workspaceId: c.workspace.id,
      workspaceName: c.workspace.name,
      matched: 'conversation email',
    });
  }
  return out;
}

async function byWebsiteKey(key: string): Promise<SearchResult[]> {
  const website = await unscopedPrisma.websites.findUnique({
    where: { public_key: key },
    select: {
      id: true,
      name: true,
      primary_domain: true,
      public_key: true,
      is_active: true,
      deleted_at: true,
      workspace: { select: { id: true, name: true } },
    },
  });
  if (!website) return [];
  return [
    {
      kind: 'website',
      id: website.id,
      label: website.name,
      sublabel: `${website.primary_domain ?? 'no primary domain'} · ${
        website.deleted_at ? 'deleted' : website.is_active ? 'active' : 'inactive'
      }`,
      workspaceId: website.workspace.id,
      workspaceName: website.workspace.name,
      matched: 'widget public key',
    },
  ];
}

/**
 * A domain is matched three ways, because a customer's site can be recorded in
 * three places and the support agent only has the one they saw in a browser:
 * `primary_domain` (what they told us), `allowed_domains` (what they configured)
 * and `website_domains` (where the widget has actually been seen loading).
 */
async function byDomain(host: string): Promise<SearchResult[]> {
  const bare = host.replace(/^www\./, '');
  const candidates = [host, bare, `www.${bare}`];

  const [websites, observed] = await Promise.all([
    unscopedPrisma.websites.findMany({
      where: {
        OR: [
          { primary_domain: { in: candidates, mode: 'insensitive' } },
          { allowed_domains: { hasSome: candidates } },
        ],
      },
      take: LIMIT,
      select: {
        id: true,
        name: true,
        primary_domain: true,
        public_key: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    unscopedPrisma.website_domains.findMany({
      where: { host: { in: candidates, mode: 'insensitive' } },
      take: LIMIT,
      orderBy: { hits: 'desc' },
      select: {
        host: true,
        hits: true,
        authorized: true,
        website: {
          select: {
            id: true,
            name: true,
            public_key: true,
            workspace: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const w of websites) {
    seen.add(w.id);
    out.push({
      kind: 'website',
      id: w.id,
      label: w.name,
      sublabel: `${w.primary_domain ?? w.public_key}`,
      workspaceId: w.workspace.id,
      workspaceName: w.workspace.name,
      matched: 'configured domain',
    });
  }
  for (const d of observed) {
    if (seen.has(d.website.id)) continue;
    seen.add(d.website.id);
    out.push({
      kind: 'website',
      id: d.website.id,
      label: d.website.name,
      // An unauthorized host with hits is the single most useful support signal
      // here: it means the widget is loading somewhere the customer never listed.
      sublabel: `${d.host} · ${d.hits} loads · ${d.authorized ? 'authorized' : 'NOT authorized'}`,
      workspaceId: d.website.workspace.id,
      workspaceName: d.website.workspace.name,
      matched: 'observed loading',
    });
  }
  return out;
}

/** The fallback: a name or slug fragment, across workspaces, users and websites. */
async function byText(q: string): Promise<SearchResult[]> {
  const contains = { contains: q, mode: 'insensitive' } as const;
  const [workspaces, users, websites] = await Promise.all([
    unscopedPrisma.workspaces.findMany({
      where: { OR: [{ name: contains }, { slug: contains }] },
      take: LIMIT,
      orderBy: { created_at: 'desc' },
      select: { id: true, name: true, slug: true, subscription_status: true, deleted_at: true },
    }),
    unscopedPrisma.users.findMany({
      where: { OR: [{ name: contains }, { email: contains }] },
      take: LIMIT,
      orderBy: { created_at: 'desc' },
      select: { id: true, name: true, email: true },
    }),
    unscopedPrisma.websites.findMany({
      where: { OR: [{ name: contains }, { primary_domain: contains }] },
      take: LIMIT,
      select: {
        id: true,
        name: true,
        primary_domain: true,
        public_key: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
  ]);

  return [
    ...workspaces.map((w): SearchResult => ({
      kind: 'workspace',
      id: w.id,
      label: w.name,
      sublabel: `/w/${w.slug} · ${w.deleted_at ? 'deleted' : w.subscription_status}`,
      workspaceId: w.id,
      workspaceName: w.name,
      matched: 'workspace name',
    })),
    ...users.map((u): SearchResult => ({
      kind: 'user',
      id: u.id,
      label: u.name,
      sublabel: u.email,
      workspaceId: null,
      workspaceName: null,
      matched: 'user name',
    })),
    ...websites.map((w): SearchResult => ({
      kind: 'website',
      id: w.id,
      label: w.name,
      sublabel: w.primary_domain ?? w.public_key,
      workspaceId: w.workspace.id,
      workspaceName: w.workspace.name,
      matched: 'website name',
    })),
  ];
}
