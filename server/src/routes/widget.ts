import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { clientIp, lookupGeo } from '../services/geo.js';
import { anyAgentOnline } from '../realtime/hub.js';

/**
 * Public widget configuration. Anonymous, read-only, and — crucially — sourced
 * ONLY from public_settings. There is no code path here that can reach the
 * secret columns in private_settings, so the old "anon reads the API key" bug
 * cannot recur. Active triggers are also served here for the embed to evaluate.
 */
/** Does a host match any allowlist pattern? A bare domain also matches its
 *  subdomains; `*.x` matches x and any subdomain. */
function hostMatches(host: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!p) return false;
    const base = p.startsWith('*.') ? p.slice(2) : p;
    return host === base || host.endsWith(`.${base}`);
  });
}

/** Record (per site) a domain the widget was loaded on. Best-effort. */
async function recordSiteDomain(siteKey: string, host: string, authorized: boolean): Promise<void> {
  try {
    const existing = await prisma.site_domains.findUnique({
      where: { site_key_host: { site_key: siteKey, host } },
      select: { id: true },
    });
    if (existing) {
      await prisma.site_domains.update({
        where: { id: existing.id },
        data: { hits: { increment: 1 }, last_seen: new Date(), authorized },
      });
    } else {
      await prisma.site_domains.create({ data: { site_key: siteKey, host, authorized } });
    }
  } catch {
    /* tracking is best-effort */
  }
}

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/widget-config', async (req, reply) => {
    const settings = await prisma.public_settings.findUnique({
      where: { id: 1 },
      select: {
        widget_title: true,
        welcome_message: true,
        primary_color: true,
        widget_position: true,
        widget_avatar_url: true,
        ai_enabled: true,
        pre_chat_enabled: true,
        pre_chat_fields: true,
        auto_welcome_enabled: true,
        auto_welcome_message: true,
        auto_welcome_delay: true,
        notification_sound_enabled: true,
        magic_browse_enabled: true,
      },
    });

    // Per-site overrides (Site manager): if the embed passes ?site=<key>, merge
    // that site's appearance overrides onto the global settings and attach its
    // configured quick actions. Only active sites apply.
    let quick_actions: unknown[] = [];
    let authorized = true;
    let enforce = false;
    const { site: siteKey, href } = req.query as { site?: string; href?: string };
    // The host page's domain (the embed forwards its URL as ?href=).
    let host = '';
    try {
      if (href) host = new URL(href).hostname.toLowerCase();
    } catch {
      /* href not a URL */
    }
    if (settings && siteKey) {
      const site = await prisma.sites.findUnique({ where: { key: siteKey } });
      if (site && site.is_active) {
        // Domain allowlist: authorize + record where the widget is running.
        if (host) {
          authorized = site.allowed_domains.length === 0 || hostMatches(host, site.allowed_domains);
          enforce = site.enforce_domains;
          void recordSiteDomain(siteKey, host, authorized);
        }
        if (site.primary_color) settings.primary_color = site.primary_color;
        if (site.widget_title) settings.widget_title = site.widget_title;
        if (site.welcome_message) settings.welcome_message = site.welcome_message;
        if (site.widget_position === 'left' || site.widget_position === 'right') {
          settings.widget_position = site.widget_position;
        }
        // Per-site pre-chat (lead capture): null = inherit global; true = ask the
        // site's fields; false = no pre-chat on this site.
        if (site.pre_chat_enabled === true) {
          settings.pre_chat_enabled = true;
          settings.pre_chat_fields = (Array.isArray(site.pre_chat_fields) ? site.pre_chat_fields : []) as typeof settings.pre_chat_fields;
        } else if (site.pre_chat_enabled === false) {
          settings.pre_chat_enabled = false;
        }
        // Resolve the site's chosen action keys against the managed quick_actions
        // catalog so the widget gets each action's label, kind and intake fields.
        const chosen = (Array.isArray(site.quick_actions) ? site.quick_actions : []) as { intent: string; label?: string }[];
        if (chosen.length > 0) {
          const defs = await prisma.quick_actions.findMany({
            where: { key: { in: chosen.map((c) => c.intent) }, is_active: true },
            select: { key: true, label: true, kind: true, fields: true },
          });
          const byKey = new Map(defs.map((d) => [d.key, d]));
          quick_actions = chosen
            .map((c) => {
              const d = byKey.get(c.intent);
              if (!d) return null;
              return { intent: d.key, label: c.label || d.label, kind: d.kind, fields: d.fields ?? [] };
            })
            .filter(Boolean);
        }
      }
    }
    return reply.send({
      settings: settings ? { ...settings, quick_actions, authorized, enforce_domains: enforce } : settings,
    });
  });

  // Server-side country detection for the trigger engine — replaces the client
  // ipapi.co call (which would blow the free tier at one request per pageload).
  // Uses the local GeoLite2 DB; returns null country when geo is unavailable.
  app.get('/api/geo', async (req, reply) => {
    const geo = await lookupGeo(clientIp(req.headers, req.ip));
    return reply.send({ country_code: geo?.country_code ?? null, country: geo?.country ?? null });
  });

  // Whether any agent is currently online (drives the widget's online/offline
  // header and the "leave a message" fallback before a conversation exists).
  app.get('/api/agent-status', async (_req, reply) => {
    return reply.send({ online: anyAgentOnline() });
  });
}
