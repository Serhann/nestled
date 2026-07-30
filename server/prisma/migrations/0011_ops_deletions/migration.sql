-- Reversible deletion from the ops panel, and plans that are not Stripe's.
--
-- ── Why deletion needed its own ledger ──────────────────────────────────────────
--
-- Three tables already carried `deleted_at`: workspaces, users, websites. What they
-- did not carry is any record of WHO removed something, WHY, or — the part that makes
-- reversal possible at all — WHICH ROWS one act of deletion touched.
--
-- That last one is the whole problem. Deleting a workspace has to take its websites
-- and conversations with it, or the widget on a deleted customer's site keeps
-- answering. But some of those websites may have been deleted weeks earlier by the
-- customer themselves, and undoing the workspace must not resurrect those. Without a
-- record, "restore" can only mean "clear every deleted_at underneath", which silently
-- reverses decisions nobody asked to reverse.
--
-- So each act of deletion writes ONE `deletion_events` row naming exactly the rows it
-- flipped. Restore clears precisely those. Ninety days later, whatever was never
-- restored is deleted for real.
--
-- ── Why the 90-day sweep is allowed to hard delete ──────────────────────────────
--
-- services/billing/lifecycle.ts says hard removal is "a deliberate operator action on
-- the platform surface, not something a cron job does at 3am", and that stays true:
-- the sweep added here only ever hard-deletes rows that appear in a `deletion_events`
-- row — that is, rows a named operator deleted on purpose, with a stated reason, at
-- least ninety days ago. A workspace soft-deleted by the billing purge has no such
-- event and is never touched by it. The cron job is not deciding anything; it is
-- carrying out a decision whose reversal window has closed.

-- ── Conversations join the soft-delete convention ───────────────────────────────
--
-- The only one of the four deletable types that did not have this column. Every read
-- path that lists or counts conversations filters it; the ones that must NOT are the
-- ops panel (support looks at what was deleted) and the sweeps.
ALTER TABLE conversations ADD COLUMN deleted_at timestamptz;

-- Partial, and ordered the way the inbox actually reads. Every tenant query is "this
-- workspace's conversations that are not deleted, newest activity first", so the index
-- that serves it is restricted to live rows — a plain index on deleted_at would be a
-- large index of NULLs answering a question nobody asks. This mirrors the existing
-- (workspace_id, status, updated_at DESC) index, minus the status column, because the
-- unfiltered inbox views do not constrain status.
CREATE INDEX conversations_live_idx ON conversations (workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- And the sweep's question, which is the opposite one.
CREATE INDEX conversations_deleted_idx ON conversations (deleted_at) WHERE deleted_at IS NOT NULL;

-- ── The ledger ─────────────────────────────────────────────────────────────────
CREATE TABLE deletion_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who. Denormalised rather than joined: the point of this table is to still read
  -- correctly after the staff account that acted on it has been removed.
  actor_type   text NOT NULL CHECK (actor_type IN ('platform_user', 'user', 'system')),
  actor_id     uuid,
  actor_email  text,

  -- What. `workspace_id` is SET NULL rather than CASCADE on purpose: purging a
  -- workspace must not delete the record that says we purged it. `target_label` is the
  -- name/slug/email captured at deletion time, so the log still names the thing after
  -- the row it pointed at is gone.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  target_type  text NOT NULL CHECK (target_type IN ('workspace', 'website', 'user', 'conversation')),
  target_id    uuid NOT NULL,
  target_label text,

  -- Why. Mandatory, like every other lever on the platform surface: a deletion with
  -- no stated reason is a mystery to whoever finds it ninety days later, and by then
  -- the person who did it may not be reachable.
  reason       text NOT NULL,

  -- Exactly which rows this act flipped, as [{"table": "...", "ids": [...]}, ...].
  -- Restore reverses this list and nothing else.
  targets      jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),
  -- When the reversal window closes. Stored rather than computed so that changing the
  -- window never moves the deadline of a deletion already waiting — a shortened window
  -- must not make pending deletions permanent retroactively.
  purge_after  timestamptz NOT NULL,

  restored_at  timestamptz,
  restored_by  uuid,
  purged_at    timestamptz,

  -- Restored and purged are mutually exclusive outcomes, and the schema is the only
  -- place that can promise it: a restore racing the sweep would otherwise be able to
  -- record both, leaving a row that claims the data is both back and gone.
  CONSTRAINT deletion_events_one_outcome CHECK (restored_at IS NULL OR purged_at IS NULL)
);

-- The ops list: newest first, optionally filtered to one workspace.
CREATE INDEX deletion_events_recent_idx ON deletion_events (created_at DESC);
CREATE INDEX deletion_events_workspace_idx ON deletion_events (workspace_id, created_at DESC);
-- The sweep's question, and the only rows it ever needs to see.
CREATE INDEX deletion_events_pending_idx ON deletion_events (purge_after)
  WHERE restored_at IS NULL AND purged_at IS NULL;
-- "Has this thing already been deleted?" — asked before every delete, so a second
-- click cannot open a second event over the same rows.
CREATE INDEX deletion_events_target_idx ON deletion_events (target_type, target_id)
  WHERE restored_at IS NULL AND purged_at IS NULL;

-- ── Plans that Stripe does not own ─────────────────────────────────────────────
--
-- `workspaces.plan_id` is documented as written only by the Stripe webhook and the
-- trial/dunning job. Bank transfer, an invoice paid by purchase order, a partner
-- arrangement, a plan granted while a payment problem is sorted out — none of those
-- has a Stripe subscription to mirror, and setting the plan by hand without saying so
-- means the next webhook or the nightly sweep quietly reverts it.
--
-- `manual` is therefore a state, not a one-off edit: while it is set, the webhook does
-- not mirror plan or status onto this workspace, the trial and dunning sweeps skip it,
-- and the customer's billing page stops offering checkout — a customer paying us by
-- transfer must not be shown a Subscribe button that would charge them twice.
ALTER TABLE workspaces ADD COLUMN billing_mode text NOT NULL DEFAULT 'stripe'
  CHECK (billing_mode IN ('stripe', 'manual'));

-- Read by both sweeps on every pass, and the manual rows are the rare ones.
CREATE INDEX workspaces_manual_billing_idx ON workspaces (billing_mode) WHERE billing_mode = 'manual';
