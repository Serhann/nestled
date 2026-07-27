import crypto from 'node:crypto';
import { settings } from '../platform/settings.js';
import type { DeliveryResult } from './types.js';

/**
 * Twilio adapter.
 *
 * Three things in here are not obvious and each one is a real outage if missed.
 *
 * **Signature verification.** The inbound webhook URL is public and its payload is
 * form-encoded text. Without verifying `X-Twilio-Signature` anyone who learns the
 * URL can inject messages into any customer's inbox from any phone number they care
 * to claim. The scheme is unusual — the signed string is the full URL with the
 * sorted POST parameters concatenated onto it — so it is implemented here rather
 * than approximated.
 *
 * **STOP is not optional.** In most jurisdictions honouring an opt-out keyword is a
 * legal requirement, not a courtesy, and Twilio blocks further messages to a number
 * that has replied STOP whether or not we notice. So we must notice: the agent needs
 * to see that this person cannot be replied to, rather than typing into a channel
 * that silently discards.
 *
 * **Segments.** An SMS is 160 GSM-7 characters, or 70 if any character forces UCS-2 —
 * one emoji or one Turkish "ş" in a 500-character reply triples its price. The agent
 * is shown the count before they send.
 */

const TIMEOUT_MS = 10_000;

/** Keywords Twilio itself treats as opt-out. Matching their list keeps us in step. */
const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN = new Set(['start', 'yes', 'unstop']);

export function isOptOut(text: string): boolean {
  return OPT_OUT.has(text.trim().toLowerCase().replace(/[.!]$/, ''));
}
export function isOptIn(text: string): boolean {
  return OPT_IN.has(text.trim().toLowerCase().replace(/[.!]$/, ''));
}

/**
 * GSM-7 is not ASCII. Notably it has no `[`, `\`, `]`, `^`, `{`, `}`, `|`, `~` in the
 * base set — those cost two characters — and anything outside it forces the whole
 * message to UCS-2 at 70 characters per segment.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

export function smsSegments(text: string): { segments: number; encoding: 'GSM-7' | 'UCS-2' } {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXTENDED.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    // UCS-2 counts UTF-16 code units, so an emoji outside the BMP costs two.
    const unitCount = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return {
      segments: unitCount <= 70 ? 1 : Math.ceil(unitCount / 67),
      encoding: 'UCS-2',
    };
  }
  return { segments: units <= 160 ? 1 : Math.ceil(units / 153), encoding: 'GSM-7' };
}

/**
 * Verify Twilio's request signature.
 *
 * The signed string is the exact URL Twilio requested, followed by every POST
 * parameter as `key + value`, sorted by key. Anything else — the raw body, the
 * params unsorted, the URL without its query — produces a mismatch that looks like a
 * credential problem and is not.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
  authToken: string | null,
): boolean {
  if (!signature || !authToken) return false;
  const signed =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(signed, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Constant time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send an SMS. Reports failure rather than throwing — an agent is waiting. */
export async function sendSms(args: {
  from: string;
  to: string;
  text: string;
}): Promise<DeliveryResult> {
  const { accountSid, authToken } = settings().sms;
  if (!accountSid || !authToken) {
    return { ok: false, error: 'SMS is not configured on this installation', retryable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: args.from, To: args.to, Body: args.text }).toString(),
        signal: controller.signal,
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { sid?: string; message?: string; code?: number }
      | null;

    if (!res.ok) {
      // 21610 is "recipient has opted out", which is the recipient's decision and
      // will never succeed on retry. 5xx and 429 are ours and will.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      return {
        ok: false,
        error: body?.message ?? `Twilio returned ${res.status}`,
        retryable: !permanent,
      };
    }
    return { ok: true, externalId: body?.sid ?? null };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).name === 'AbortError' ? 'Timed out reaching Twilio' : (err as Error).message,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
