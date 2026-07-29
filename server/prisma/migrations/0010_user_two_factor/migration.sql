-- Two-step verification for customer accounts.
--
-- The platform (ops) side has had TOTP since phase 13, because staff there can reach
-- every tenant. Customers had nothing — and a workspace owner's account is the key to
-- their own inbox, their customers' conversations, and their billing. A password alone
-- is what everyone else in this market considers table stakes.
--
-- ── Why recovery codes are a table and not a column ─────────────────────────
--
-- The ops implementation has no recovery path on purpose: a locked-out staff member is
-- rescued by another superadmin or by someone with database access. Neither exists for
-- a customer. Somebody who loses their phone with no way back is locked out of their
-- own business's support inbox, and the only remedy left is a support ticket where we
-- try to establish identity over email — which is both a terrible experience and a
-- weaker check than the factor we are protecting.
--
-- So codes are single-use rows with a `used_at`, not a JSON array on `users`. The row
-- shape is what makes "seven of your ten codes are left" answerable and what makes a
-- used code un-reusable under a concurrent second attempt: `code_hash` is UNIQUE and
-- the consuming UPDATE is conditional on `used_at IS NULL`.
--
-- Codes are stored hashed with the same one-way function as every other opaque token
-- in this codebase (refresh, email verification, password reset, invite, proactive
-- claim). A recovery code IS a password equivalent — it skips the second factor — so
-- it gets password treatment at rest.

ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN totp_enrolled_at timestamptz;

-- The last accepted time step, so a code cannot be presented twice.
--
-- RFC 6238 §5.2 requires this: a code stays valid for the length of the acceptance
-- window, and without a record of what was already spent, anyone who observes one
-- (over someone's shoulder, through a proxy) can replay it inside that window. Bigint
-- because the step counter is defined as unsigned 64-bit.
ALTER TABLE users ADD COLUMN totp_last_step bigint;

-- A secret that was generated but never confirmed is not a factor. Enforcing the
-- pairing in the schema means a half-finished enrolment can never be read as an
-- enabled one by any future code path that forgets to check both.
ALTER TABLE users ADD CONSTRAINT users_totp_enabled_needs_secret
  CHECK (NOT totp_enabled OR totp_secret IS NOT NULL);

CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Partial: the only question ever asked of this table at login is "does this user have
-- an unused code with this hash", and the count shown on the security page is of
-- unused ones. Spent codes are kept for the audit trail but never scanned.
CREATE INDEX user_recovery_codes_unused_idx
  ON user_recovery_codes (user_id) WHERE used_at IS NULL;
