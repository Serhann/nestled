-- Response-time targets: a promise, a clock that only runs in open hours, and an
-- escalation before the customer notices rather than a report afterwards.
--
-- The problem this solves is the one support teams actually get judged on: a message
-- gets missed and nobody finds out until the customer complains. Reviewers of other
-- chat tools name it three separate ways — no response-time analysis, unreliable
-- notifications causing missed requests, and no way to mark a conversation unread —
-- which are all the same complaint wearing different hats.
--
-- ── The one design decision worth explaining ────────────────────────────────
--
-- `response_due_at` is a STORED ABSOLUTE INSTANT, computed once when the clock starts,
-- not a target duration evaluated on read.
--
-- Storing the deadline means the at-risk queue is one indexed range scan
-- (`response_due_at < now()`), which is a query an inbox can run on every poll. The
-- alternative — keep `first_response_minutes` and work out per row whether it has been
-- that many OPEN minutes — cannot be indexed, cannot be sorted by urgency, and would
-- re-run business-hours arithmetic for every conversation on every request.
--
-- The cost, stated plainly: change your opening hours and the deadlines already on the
-- clock keep the old ones. That is arguably correct anyway — a promise made under
-- Monday's schedule was made under Monday's schedule — and it is why the settings page
-- says so.

CREATE TABLE "website_response_targets" (
    "website_id"   UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "enabled"      BOOLEAN NOT NULL DEFAULT false,

    -- NULL means "no target for this", which is different from 0. A team may promise a
    -- first reply and promise nothing about follow-ups.
    "first_response_minutes" INTEGER,
    "next_response_minutes"  INTEGER,

    -- Whether the clock pauses when the business is closed. Default true, because the
    -- opposite is what makes a team stop believing the numbers.
    "business_hours_only" BOOLEAN NOT NULL DEFAULT true,

    -- Escalation, at the moment a target is breached. Reassignment is what actually
    -- gets a conversation answered; a notification alone is another thing to miss.
    "escalate_enabled"     BOOLEAN NOT NULL DEFAULT false,
    "escalate_to_member_id" UUID,
    "notify_owners"        BOOLEAN NOT NULL DEFAULT true,

    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "website_response_targets_pkey" PRIMARY KEY ("website_id")
);

ALTER TABLE "website_response_targets"
  ADD CONSTRAINT "website_response_targets_minutes_check"
  CHECK (
    ("first_response_minutes" IS NULL OR "first_response_minutes" BETWEEN 1 AND 100000) AND
    ("next_response_minutes"  IS NULL OR "next_response_minutes"  BETWEEN 1 AND 100000)
  );

CREATE INDEX "website_response_targets_workspace_id_idx"
  ON "website_response_targets" ("workspace_id");

-- Required by Prisma to express the 1:1 back-relation from websites. Harmless: the
-- primary key on website_id already guarantees one row per website.
CREATE UNIQUE INDEX "website_response_targets_workspace_id_website_id_key"
  ON "website_response_targets" ("workspace_id", "website_id");

ALTER TABLE "website_response_targets" ADD CONSTRAINT "website_response_targets_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite FK, like every other website-scoped child.
ALTER TABLE "website_response_targets" ADD CONSTRAINT "website_response_targets_website_fkey"
  FOREIGN KEY ("workspace_id", "website_id") REFERENCES "websites"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Escalating to a member who has since been removed must not block the deletion.
ALTER TABLE "website_response_targets" ADD CONSTRAINT "website_response_targets_escalate_to_fkey"
  FOREIGN KEY ("escalate_to_member_id") REFERENCES "workspace_members"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── The clock, on the conversation ──────────────────────────────────────────

-- When the customer last said something that is still unanswered. NULL means the ball
-- is not in our court: nobody is waiting, so there is nothing to be late for.
ALTER TABLE "conversations" ADD COLUMN "awaiting_reply_since" TIMESTAMPTZ(6);

-- The deadline. NULL when there is no target, when the schedule never opens, or when
-- nobody is waiting.
ALTER TABLE "conversations" ADD COLUMN "response_due_at" TIMESTAMPTZ(6);

-- Stamped once, the first time a deadline passes. Kept after the reply lands so the
-- report can count it — a breach that disappears when someone finally answers is a
-- breach nobody learns from.
ALTER TABLE "conversations" ADD COLUMN "response_breached_at" TIMESTAMPTZ(6);

-- Set when the escalation fired, so the sweep escalates once rather than every minute.
ALTER TABLE "conversations" ADD COLUMN "escalated_at" TIMESTAMPTZ(6);

-- Deliberately marked unread by an agent. A verbatim request from reviewers of the
-- competition: "no option to mark conversations as unread, which causes support
-- departments to miss requests".
ALTER TABLE "conversations" ADD COLUMN "unread_at" TIMESTAMPTZ(6);

-- THE index the at-risk queue rides on. Partial, because the overwhelming majority of
-- conversations have nobody waiting and do not belong in it.
CREATE INDEX "conversations_response_due_idx"
  ON "conversations" ("workspace_id", "response_due_at")
  WHERE "response_due_at" IS NOT NULL;

-- The sweep's own query: due, and not yet escalated, across all workspaces.
CREATE INDEX "conversations_response_sweep_idx"
  ON "conversations" ("response_due_at")
  WHERE "response_due_at" IS NOT NULL AND "escalated_at" IS NULL;
