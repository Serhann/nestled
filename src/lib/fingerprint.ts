/**
 * Cross-site device fingerprint (widget side).
 *
 * When embedded, the host page's embed.js computes this and passes it as the
 * `fp` URL param — we just read it so presence + conversation agree with the
 * host page. When the widget is opened standalone (/chat directly, no embed) we
 * compute it here. Device-level signals only (identical across origins); the
 * server never sees anything but the hash. Mirrors public/embed.js.
 */

function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function canvasSignal(): string {
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Nestled fp', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('Nestled fp', 4, 17);
    return c.toDataURL();
  } catch {
    return '';
  }
}

function webglSignal(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') ||
      c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return String(vendor) + '~' + String(renderer);
  } catch {
    return '';
  }
}

function compute(): string {
  try {
    const n = navigator as Navigator & { deviceMemory?: number };
    const s = window.screen;
    let tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      /* no Intl */
    }
    const parts = [
      n.userAgent || '',
      (n.languages || [n.language]).join(','),
      n.platform || '',
      n.hardwareConcurrency || '',
      n.deviceMemory || '',
      n.maxTouchPoints || '',
      s ? `${s.width}x${s.height}x${s.colorDepth}` : '',
      window.devicePixelRatio || '',
      tz,
      new Date().getTimezoneOffset(),
      canvasSignal(),
      webglSignal(),
    ];
    return cyrb53(parts.join('||'));
  } catch {
    return '';
  }
}

let cached: string | null = null;

/** The device fingerprint: the embed-supplied `fp` param, else computed here. */
export function getFingerprint(): string {
  if (cached !== null) return cached;
  try {
    const fromParam = new URLSearchParams(window.location.search).get('fp');
    cached = fromParam || compute();
  } catch {
    cached = compute();
  }
  return cached;
}
