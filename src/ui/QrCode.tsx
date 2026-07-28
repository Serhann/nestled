import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * A QR code, drawn as SVG.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two decisions worth stating.
 *
 * **It is generated here, not fetched.** The obvious shortcut for a QR is an image
 * URL from a public chart service — and that would send the otpauth:// URI, which
 * contains the TOTP SECRET, to a third party on every enrolment. The whole point of
 * the second factor is that nobody else has that string. So the encoder is a
 * dependency (one package, no transitive ones) rather than a network call.
 *
 * **SVG rather than canvas.** It scales to whatever the layout gives it, prints, and
 * survives a dark background without a white box around it — and it needs no ref, no
 * effect and no device-pixel-ratio arithmetic.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function QrCode({
  value,
  size = 176,
  className = '',
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const path = useMemo(() => {
    // Type 0 = pick the smallest version that fits. 'M' recovers ~15% — enough for a
    // screen, and it keeps the modules large enough to scan from a laptop display.
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [value]);

  return (
    <svg
      // The quiet zone is part of the spec, not padding: scanners need four clear
      // modules around the symbol, and a QR flush against a dark panel often will
      // not read at all.
      viewBox={`-4 -4 ${path.count + 8} ${path.count + 8}`}
      width={size}
      height={size}
      className={`rounded-lg bg-white ${className}`}
      role="img"
      aria-label="QR code for your authenticator app"
      shapeRendering="crispEdges"
    >
      <rect x={-4} y={-4} width={path.count + 8} height={path.count + 8} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
