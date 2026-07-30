import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nothing an end user reads may explain our plumbing to them.
 *
 * This exists because of one banner. A workspace owner whose address could not be
 * confirmed was told: "this installation has no mail server set up … an operator can
 * add SMTP in the ops panel under Settings → Email." Every word of that is true and
 * none of it is theirs: it hands a customer our internal vocabulary, our admin
 * console, and a task they cannot perform — and it reads as though they misconfigured
 * something.
 *
 * The rule this pins: on the two END-USER surfaces — the customer panel (`src/app`)
 * and the visitor widget (`src/widget`) — copy describes what happened to THEM and
 * what they can do. Causes that live on our side are named in logs, in
 * `outbound_emails.error`, and on ops → Health, where the person who can act on them
 * is looking. `src/ops` is deliberately not scanned: that surface IS the operator.
 *
 * Comments are stripped before scanning, so a comment may still explain why a
 * sentence is worded the way it is — which is where this reasoning belongs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', '..', '..', 'src');
const SURFACES = ['app', 'widget'];

/**
 * Files on an end-user surface whose READER is staff, each with its reason.
 *
 * The rule is about audience, not directory. This page lives under `src/app` because it
 * has to be served from the customer ORIGIN — that is where the session it creates belongs
 * — but a customer never reaches it: it is opened by the ops panel, in a new tab, by the
 * operator who just started the session. Telling them to go back to the ops panel is the
 * correct instruction for the only person who will ever read it.
 *
 * Keep this list at one or two entries. A third is a sign the rule is being worked around
 * rather than applied.
 */
const STAFF_AUDIENCE: Record<string, string> = {
  'app/routes/auth/Impersonate.tsx':
    'opened only by the ops panel, in a new tab, for the operator who started the session',
};

/**
 * Each entry is a phrase that only makes sense to whoever runs the install. They are
 * matched case-insensitively against comment-stripped source.
 */
const BANNED = [
  'ops panel',
  'smtp',
  'this installation',
  'an operator',
  'your operator',
  'the operator',
  'self-hosted',
  'mail server',
  'database',
  'env var',
];

test('no end-user copy explains our own plumbing', async () => {
  const files: string[] = [];
  for (const surface of SURFACES) {
    // Skipped rather than failed when the frontend is absent: the server image ships
    // without it, and a test that cannot see the files it judges must not claim they
    // passed either. There is no third state in node:test, so `collect` returning
    // nothing is reported below.
    files.push(...(await collect(join(FRONTEND, surface))));
  }
  assert.ok(files.length > 0, `no source files found under ${FRONTEND} — is this a source checkout?`);

  const offences: string[] = [];
  for (const file of files) {
    if (STAFF_AUDIENCE[relative(FRONTEND, file).split(sep).join('/')]) continue;
    const source = stripComments(await readFile(file, 'utf8'));
    source.split('\n').forEach((line, index) => {
      const haystack = line.toLowerCase();
      for (const phrase of BANNED) {
        if (haystack.includes(phrase)) {
          offences.push(`${relative(FRONTEND, file)}:${index + 1}  "${phrase}"  ${line.trim().slice(0, 100)}`);
        }
      }
    });
  }

  assert.deepEqual(
    offences,
    [],
    `end-user copy must not mention our internals:\n${offences.join('\n')}\n\n` +
      `If one of these is an identifier rather than copy, rename it. If it is copy, ` +
      `rewrite it for the person reading it and put the cause in a log. If the file's only ` +
      `reader is staff, add it to STAFF_AUDIENCE above with the reason.`,
  );
});

async function collect(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // surface not present in this checkout
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Remove `/* … *\/` and `// …` so the ban applies to what ships, not to the notes
 * explaining it. Deliberately naive — it does not track string literals, so a `//`
 * inside a URL string truncates that line. That costs a false NEGATIVE on the rest
 * of the line and never a false positive, which is the right way round for a rule
 * that fails a build.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
