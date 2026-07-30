-- Handing over an impersonation session without handing over a credential.
--
-- ── What this replaces ─────────────────────────────────────────────────────────
--
-- Starting a session used to return the signed access token to the ops panel, which
-- displayed it in a textarea with a Copy button and told the operator to paste it into
-- the customer app. The comment defending that said writing a staff-minted credential
-- into another origin's token store is "exactly the kind of convenience that makes an
-- audit trail arguable" — which is right about the risk and wrong about the remedy. What
-- it actually produced was a long-lived bearer token for somebody else's account sitting
-- in a clipboard, a textarea, and whatever the operator pasted it into next.
--
-- Now the panel gets a URL and opens it in a new tab. The URL carries a CLAIM CODE, not
-- the token:
--
--   * single use — `claimed_at` is set by the same conditional UPDATE that reads it, so
--     two tabs racing the same code produce one session and one failure,
--   * 60 seconds — long enough to open a tab, too short to be worth keeping,
--   * hashed at rest, like every other opaque token in this schema (refresh, email
--     verification, password reset, invite, the widget's proactive claim). A leaked
--     database backup must not contain anything that still works,
--   * useless on its own — exchanging it requires a POST, so the token never appears in
--     a URL, a browser history entry, an nginx access log or a Referer header.
--
-- The token itself is still minted with the session's exact lifetime and still has no
-- refresh token. What changed is who ever sees it: the impersonated tab, once.

ALTER TABLE impersonation_sessions ADD COLUMN claim_code_hash text;
ALTER TABLE impersonation_sessions ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE impersonation_sessions ADD COLUMN claimed_at timestamptz;

-- UNIQUE because the hash is the lookup key, and because two live sessions sharing one
-- code is a state with no correct interpretation. Partial, so the NULLs on every historic
-- row (and on every row after its code is spent) cost nothing.
CREATE UNIQUE INDEX impersonation_sessions_claim_idx
  ON impersonation_sessions (claim_code_hash)
  WHERE claim_code_hash IS NOT NULL;
