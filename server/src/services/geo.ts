import { existsSync } from 'node:fs';
import maxmind, { type Reader, type CityResponse, type CountryResponse } from 'maxmind';
import { env } from '../env.js';

export interface GeoLocation {
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
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
    const path = env.GEOLITE2_DB_PATH;
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

const maxmindEnabled = Boolean(env.MAXMIND_ACCOUNT_ID && env.MAXMIND_LICENSE_KEY);

/** Per-IP lookup via the MaxMind GeoIP web service (Basic auth). Best-effort. */
async function lookupGeoWeb(ip: string): Promise<GeoLocation | null> {
  const auth = Buffer.from(`${env.MAXMIND_ACCOUNT_ID}:${env.MAXMIND_LICENSE_KEY}`).toString('base64');
  const url = `${env.MAXMIND_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(ip)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (!warned) {
        // eslint-disable-next-line no-console
        console.warn(`[geo] MaxMind web service returned ${res.status}`);
        warned = true;
      }
      return null;
    }
    const data = (await res.json()) as CityResponse;
    return {
      country: pickName(data.country?.names),
      country_code: data.country?.iso_code ?? null,
      city: pickName(data.city?.names),
      region: pickName(data.subdivisions?.[0]?.names),
    };
  } catch {
    return null; // network/timeout/parse — degrade to no geo
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupGeo(ip: string): Promise<GeoLocation | null> {
  if (!ip || ip === 'unknown') return null;
  if (cache.has(ip)) return cache.get(ip) ?? null;

  // Prefer the MaxMind web service when configured (skip un-geolocatable IPs).
  if (maxmindEnabled) {
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
      result = {
        country: pickName(city.country?.names),
        country_code: city.country?.iso_code ?? null,
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

/** Extract the client IP, honoring the first hop in X-Forwarded-For. */
export function clientIp(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const fwd = headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return fallback;
}
