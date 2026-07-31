-- Offline data alerts: telling the team, off-platform, that a visitor left details
-- while nobody was there to read them.
--
-- The gap this closes: a bot flow collects a name, an email and a question at 02:00, and
-- the only places that say so are the inbox nobody has open and a web push nobody has
-- granted. The details sit there until morning. Email and SMS are the two channels that
-- reach somebody who is not looking at our app, which is the entire point.
--
-- ── Why the recipients are LISTS and not the member table ──────────────────────
--
-- We hold no phone numbers. `users` has no phone column, and adding one would drag in
-- verification, "whose number is visible to whom", and the question of whether all twenty
-- agents should be woken at 03:00. A per-workspace on-call list answers that last question
-- the only way it can be answered correctly — by the customer, explicitly.
--
-- `offline_alert_notify_agents` keeps the easy case easy for email, where we DO hold
-- addresses: on, and the alert goes to the same members a web push would have gone to.
ALTER TABLE workspace_private_settings
  ADD COLUMN offline_alert_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN offline_alert_notify_agents BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN offline_alert_emails TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN offline_alert_phones TEXT[] NOT NULL DEFAULT '{}';

-- One alert per conversation, enforced by the database rather than by remembering to check.
--
-- The trigger is "data was collected", and data arrives a field at a time — a name, then an
-- email, then the question. Without this stamp a five-field bot flow is five SMS messages
-- about one visitor, which is how a team learns to ignore the alerts. The claim is written
-- with a conditional UPDATE (`WHERE offline_alert_at IS NULL`), so two fields collected in
-- the same instant still produce one alert.
--
-- Deliberately NOT reset when the conversation is answered or resolved: the record is "we
-- have already told them about this one", and re-alerting a thread an agent has since read
-- would be a second interruption for old news.
ALTER TABLE conversations ADD COLUMN offline_alert_at TIMESTAMPTZ;
