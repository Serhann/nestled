/**
 * Repairing a DATABASE_URL whose password was never URL-encoded.
 *
 * The compose files build DATABASE_URL by interpolating POSTGRES_PASSWORD into a
 * connection string, and the recipe we documented for generating that password —
 * `openssl rand -base64 48` — emits a `/` about two times in three, because `/`
 * is in the base64 alphabet. A `/`, `?` or `#` in the password ends the authority
 * component early, so what is left where the port belongs is a piece of the
 * password:
 *
 *   postgres://nestled:ab/cd@db:5432/nestled
 *                        └── authority ends here; port is now "ab"
 *
 * Prisma reports that as `P1013 … invalid port number in database URL`, naming
 * neither the password nor the character, and the stack trace it prints is our
 * migration runner. It cost a production deploy to read correctly, so the fix
 * belongs here rather than in a paragraph of DEPLOY.md nobody re-reads.
 *
 * Two rules keep this from becoming its own surprise:
 *
 *   1. A string that already resolves to a sane host is returned BYTE FOR BYTE.
 *      Nothing in here can change the meaning of a connection string that works
 *      today, which is what makes it safe to put on the boot path of a running
 *      deployment.
 *   2. Repair only ever rewrites the userinfo — the user and password between
 *      `://` and the `@`. Host, port, path and query are copied across
 *      untouched.
 *
 * "Resolves to a sane host" is doing real work in rule 1, because not every
 * unencoded password produces a parse error. These two are accepted by every URL
 * parser and are still wrong:
 *
 *   postgres://nestled:/leading@db:5432/nestled     → host "nestled", no port
 *   postgres://nestled:p@ss/word@db:5432/nestled    → host "ss",      no port
 *
 * In both, the authority ended inside the password and the rest of the URL —
 * `@db:5432/nestled` and all — became the path. A `#` in the password does the
 * same thing with the fragment. So an `@` left sitting in the PATH or the
 * FRAGMENT counts as a broken string too: a database name is `/nestled`, an `@`
 * in it is near-proof that the credentials swallowed the host, and a Postgres URL
 * has no business carrying a fragment at all. The alternative is connecting to a
 * server named after the username and reporting it as an unreachable database.
 */

export interface NormalizedDatabaseUrl {
  /** The connection string to hand to Prisma. */
  url: string;
  /** True when the userinfo had to be percent-encoded to make it parse. */
  repaired: boolean;
}

/**
 * A parseable connection string, percent-encoding the credentials if that is
 * what it takes. Throws with a redacted, diagnosable message if it cannot.
 */
export function normalizeDatabaseUrl(raw: string): NormalizedDatabaseUrl {
  const url = raw.trim();
  if (resolvesSanely(url)) return { url, repaired: false };

  const encoded = encodeUserinfo(url);
  if (encoded) return { url: encoded, repaired: true };

  throw new Error(
    `DATABASE_URL is not a valid connection string:\n` +
      `  ${redactDatabaseUrl(url)}\n` +
      `Expected postgres://USER:PASSWORD@HOST:PORT/DATABASE.\n` +
      `The usual cause is a password containing "/", "?" or "#" — each of those ends ` +
      `the host portion of a URL, and Prisma then reports "invalid port number" ` +
      `(P1013). Generate a URL-safe password with \`openssl rand -hex 32\`, or ` +
      `percent-encode it: / → %2F, ? → %3F, # → %23.`,
  );
}

/** The same string with the password replaced, for logs and error messages. */
export function redactDatabaseUrl(url: string): string {
  const scheme = url.indexOf('://');
  if (scheme === -1) return '(no scheme)';
  const rest = url.slice(scheme + 3);
  const at = rest.lastIndexOf('@');
  // With no `@` there is nowhere the credentials can end, so there is no safe
  // place to cut. A well-formed URL without an `@` carries no password at all —
  // but this function is called on malformed ones, and a redactor that guesses
  // wrong prints the secret it was called to hide.
  if (at === -1) return `${url.slice(0, scheme + 3)}***`;
  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(':');
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  // Everything between `://` and the last `@` goes, whether or not that `@` is
  // really the separator — if we guessed wrong, the part we are unsure about is
  // the part that might be the password.
  return `${url.slice(0, scheme + 3)}${user}:***@${rest.slice(at + 1)}`;
}

/**
 * Does this string parse AND land on a host the operator plausibly meant?
 *
 * An `@` in the path or the fragment is the tell that the authority ended early
 * inside an unencoded password (see the header). Note the query is exempt: a raw
 * `@` in `?options=…` is legal and common enough, and it says nothing about the
 * credentials.
 */
function resolvesSanely(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.hostname === '') return false;
  return !parsed.pathname.includes('@') && !parsed.hash.includes('@');
}

/**
 * Percent-encode the credentials, or null if this is broken some other way.
 *
 * Which `@` separates the credentials from the host is genuinely ambiguous once
 * the password may contain one, so candidates are tried RIGHT TO LEFT — the rule
 * every URL parser uses: the userinfo runs to the last `@` in the authority.
 *
 * A candidate is only accepted if the text after its `@` carries a port or a
 * database path. Without that check, `…?opts=a@b` — a raw `@` in the query — has
 * its query mistaken for the authority, and the result parses cleanly while
 * pointing at a host named `b`. A connection string that silently addresses the
 * wrong server is worse than the crash this function exists to prevent.
 */
function encodeUserinfo(url: string): string | null {
  const scheme = url.indexOf('://');
  if (scheme === -1) return null;
  const prefix = url.slice(0, scheme + 3);
  const rest = url.slice(scheme + 3);

  for (let at = rest.lastIndexOf('@'); at > 0; at = rest.lastIndexOf('@', at - 1)) {
    const userinfo = rest.slice(0, at);
    const host = rest.slice(at + 1);

    // The FIRST `:` splits user from password: the password is the half allowed
    // to contain one.
    const colon = userinfo.indexOf(':');
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const password = colon === -1 ? null : userinfo.slice(colon + 1);

    const candidate =
      password === null
        ? `${prefix}${encodeURIComponent(user)}@${host}`
        : `${prefix}${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}`;

    if (!resolvesSanely(candidate)) continue;
    const parsed = new URL(candidate);
    const hasDatabase = parsed.pathname.replace(/^\/+/, '') !== '';
    if (parsed.port !== '' || hasDatabase) return candidate;
  }
  return null;
}
