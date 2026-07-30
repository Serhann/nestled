import { existsSync } from 'node:fs';
import maxmind, { type Reader, type CityResponse, type CountryResponse } from 'maxmind';
import { settings } from './platform/settings.js';

export interface GeoLocation {
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
  isp?: string | null; // from GeoIP2 Precision/ISP traits (web service only)
  org?: string | null;
}

// Partial shape of a MaxMind GeoIP2 web-service response (only what we read).
interface MaxmindResponse {
  country?: { iso_code?: string; names?: Record<string, string> };
  registered_country?: { iso_code?: string; names?: Record<string, string> };
  city?: { names?: Record<string, string> };
  subdivisions?: Array<{ names?: Record<string, string> }>;
  traits?: {
    isp?: string;
    organization?: string;
    autonomous_system_organization?: string;
  };
}

/**
 * Server-side geo-IP using a local MaxMind GeoLite2 database (free, offline, no
 * per-request API). Replaces the old ipapi.co calls that leaked visitor IPs to a
 * third party and blew the free tier. Lookups are cached by IP.
 *
 * If GEOLITE2_DB_PATH is unset or the file is missing, geo is disabled and every
 * lookup returns null — the app still works, just without location data.
 */

let readerPromise: Promise<Reader<CityResponse | CountryResponse> | null> | null = null;
let warned = false;

// Small bounded cache; geo for an IP doesn't change within a session.
const cache = new Map<string, GeoLocation | null>();
const CACHE_MAX = 5000;

async function getReader(): Promise<Reader<CityResponse | CountryResponse> | null> {
  if (readerPromise) return readerPromise;
  readerPromise = (async () => {
    const path = settings().geo.dbPath;
    if (!path || !existsSync(path)) {
      if (!warned) {
        // eslint-disable-next-line no-console
        console.warn('[geo] GEOLITE2_DB_PATH not set or file missing — geo disabled');
        warned = true;
      }
      return null;
    }
    try {
      return await maxmind.open<CityResponse | CountryResponse>(path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[geo] failed to open GeoLite2 DB', err);
      return null;
    }
  })();
  return readerPromise;
}

function pickName(names?: unknown): string | null {
  if (!names || typeof names !== 'object') return null;
  const n = names as Record<string, string | undefined>;
  return n.en ?? Object.values(n).find((v): v is string => typeof v === 'string') ?? null;
}

/** Private / loopback / link-local IPs never have public geo — skip the lookup. */
function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^(fc|fd|fe80)/i.test(ip)
  );
}

/**
 * Evaluated per call rather than once at import: credentials now come from the
 * ops panel, so an operator pasting a licence key must not have to restart the
 * process to have it noticed.
 */
function maxmindEnabled(): boolean {
  const { maxmindAccountId, maxmindLicenseKey } = settings().geo;
  return Boolean(maxmindAccountId && maxmindLicenseKey);
}
let webErrorLogs = 0;

/**
 * Per-IP lookup via the MaxMind GeoIP web service (Basic auth). Best-effort:
 * returns null on any error but logs the reason (first few times) so misconfig
 * (401 auth, wrong endpoint) is visible in the app logs.
 */
async function lookupGeoWeb(ip: string): Promise<GeoLocation | null> {
  const { maxmindAccountId, maxmindLicenseKey, maxmindEndpoint } = settings().geo;
  const auth = Buffer.from(`${maxmindAccountId}:${maxmindLicenseKey}`).toString('base64');
  // Base endpoint, tolerant of a trailing slash or a copied `?pretty` query.
  const base = maxmindEndpoint.split('?')[0]!.replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(ip)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (webErrorLogs < 5) {
        webErrorLogs++;
        // eslint-disable-next-line no-console
        console.warn(`[geo] MaxMind ${res.status} for ${ip}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    const data = (await res.json()) as MaxmindResponse;
    // Anycast/hosting IPs may only carry registered_country — fall back to it.
    const c = data.country ?? data.registered_country;
    return {
      country: pickName(c?.names),
      country_code: c?.iso_code ?? null,
      city: pickName(data.city?.names),
      region: pickName(data.subdivisions?.[0]?.names),
      isp: data.traits?.isp ?? data.traits?.autonomous_system_organization ?? null,
      org: data.traits?.organization ?? null,
    };
  } catch (err) {
    if (webErrorLogs < 5) {
      webErrorLogs++;
      // eslint-disable-next-line no-console
      console.warn(`[geo] MaxMind request failed for ${ip}: ${(err as Error).message}`);
    }
    return null; // network/timeout/parse — degrade to no geo
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupGeo(ip: string): Promise<GeoLocation | null> {
  if (!ip || ip === 'unknown') return null;
  if (cache.has(ip)) return cache.get(ip) ?? null;

  // Prefer the MaxMind web service when configured (skip un-geolocatable IPs).
  if (maxmindEnabled()) {
    const result = isPrivateIp(ip) ? null : await lookupGeoWeb(ip);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(ip, result);
    return result;
  }

  const reader = await getReader();
  if (!reader) {
    cache.set(ip, null);
    return null;
  }

  let result: GeoLocation | null = null;
  try {
    const record = reader.get(ip);
    if (record) {
      const city = record as CityResponse;
      const c = city.country ?? city.registered_country;
      result = {
        country: pickName(c?.names),
        country_code: c?.iso_code ?? null,
        city: pickName(city.city?.names),
        region: pickName(city.subdivisions?.[0]?.names),
      };
    }
  } catch {
    result = null; // invalid IP (e.g. private/localhost) — just no geo
  }

  if (cache.size >= CACHE_MAX) cache.clear(); // simple bound; rebuild lazily
  cache.set(ip, result);
  return result;
}

// Extracting the client IP used to live here, reading X-Forwarded-For only. It
// moved to lib/clientIp.ts as `req.clientIp` when this install went behind
// Cloudflare, where XFF is a chain of edge addresses and the visitor is in a
// header of its own. Geo looks up an address; deciding whose address it is turned
// out to be a separate concern with its own trust rules.
