/**
 * Cutting the quoted history off an email reply.
 *
 * Without this, the second message in an email conversation contains the first one,
 * the third contains both, and by message six the agent is scrolling past their own
 * words to find the one new sentence. It is the single most visible difference
 * between email that feels like a chat and email that feels like a mess.
 *
 * The approach is deliberately conservative, and the reason is worth stating: this
 * function DELETES part of a customer's message. Cutting one line too many can remove
 * the actual question. So it only cuts at markers that are unambiguous — a quote
 * prefix, a client's own attribution line, a signature delimiter — and if a cut would
 * leave nothing at all, it keeps the original instead.
 *
 * There is no perfect version of this. Every mail client invents its own attribution
 * line and localises it. What is here covers the common English and Turkish forms
 * plus the structural markers that are client-independent; anything past that belongs
 * in tests driven by real examples rather than in more guessed regexes.
 */

/**
 * Attribution lines: "On <date>, <someone> wrote:" and its relatives.
 *
 * Anchored to line start and required to end in a colon, because the words "wrote"
 * and "yazdı" appear in ordinary sentences and cutting on those would eat real text.
 */
const ATTRIBUTION = [
  // Gmail, Apple Mail, most clients
  /^\s*On .{6,120}\bwrote:\s*$/i,
  /^\s*El .{6,120}\bescribió:\s*$/i,
  /^\s*Le .{6,120}\ba écrit\s*:\s*$/i,
  /^\s*Am .{6,120}\bschrieb .{0,80}:\s*$/i,
  // Turkish clients: "... tarihinde ... şunları yazdı:"
  /^\s*.{6,120}\b(?:şunları\s+)?yazdı:\s*$/i,
  // Outlook's block header
  /^\s*-{2,}\s*(?:Original Message|Forwarded message|Özgün İleti|İletilen ileti)\s*-{2,}\s*$/i,
  // Outlook web / desktop
  /^\s*_{10,}\s*$/,
  /^\s*(?:From|Kimden|Von|De):\s*.{3,200}$/i,
];

/** `-- ` on its own line is the RFC 3676 signature delimiter. */
const SIGNATURE = /^--\s?$/;

export function stripQuotedReply(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const lines = text.split('\n');
  let cut = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (SIGNATURE.test(line)) {
      cut = i;
      break;
    }

    if (ATTRIBUTION.some((re) => re.test(line))) {
      cut = i;
      break;
    }

    // A run of quoted lines. One `>` line on its own is not enough — people quote a
    // single sentence deliberately, above their own reply — but two consecutive are
    // reliably the start of the history.
    if (/^\s*>/.test(line) && i + 1 < lines.length && /^\s*>/.test(lines[i + 1] ?? '')) {
      cut = i;
      break;
    }
  }

  const kept = lines.slice(0, cut).join('\n').trim();

  // The safety net, and the reason this is safe to run on every message: if the cut
  // removed everything, the markers were wrong about this mail and the original is
  // better than nothing. A top-posted reply loses a sentence; an over-eager cut loses
  // the customer's whole question.
  return kept || text;
}
