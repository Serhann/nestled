-- Scope-based permissions for staff accounts, and a way to add one.
--
-- ── Why the four roles were not enough ─────────────────────────────────────────
--
-- `platform_users.role` is one of superadmin / support / billing / readonly, and
-- `platformRoleAllows` returned true for a superadmin whatever was asked. Every request
-- for something between two roles therefore had exactly two answers: make them
-- superadmin, which grants everything including deleting customers' data, or add a
-- fifth role. Both are how a permission model stops describing the organisation.
--
-- So the role becomes a named BUNDLE of scopes (permissions.ts), and an account can be
-- adjusted either way on top of it:
--
--   granted_scopes   scopes this account has beyond its role
--   denied_scopes    scopes its role would give it, removed
--
-- Deny wins, including over superadmin. That is what makes "administers the install but
-- does not read customer conversations" expressible, and it is one row.
--
-- Arrays rather than a join table: these are read on EVERY request as part of session
-- resolution, they are short, and they are never queried across accounts. A join table
-- would buy referential integrity over a list of string constants that live in code —
-- which is why unknown values are ignored at read time (see platformCapabilitiesFor)
-- rather than constrained here. A scope removed in a later release must not stop
-- somebody logging in.

ALTER TABLE platform_users ADD COLUMN granted_scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE platform_users ADD COLUMN denied_scopes text[] NOT NULL DEFAULT '{}';

-- ── The credential handover problem ────────────────────────────────────────────
--
-- Staff accounts are created by another staff member who sets the initial password, and
-- there is no email-based reset on this plane (see routes/platform/auth.ts). Left there,
-- the person who created an account knows its password permanently — which quietly
-- undermines every audit row that account writes, because "my colleague who created my
-- login could have done that" is true.
--
-- So a created account is flagged, the panel says so until it is cleared, and clearing
-- it requires the account's own current password. Not a hard block on signing in: this
-- plane already refuses every write until a TOTP factor is enrolled, and locking a new
-- admin out of the panel before they can enrol one would be the wrong order.
ALTER TABLE platform_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
