-- The assistant's instructions, above the customer's own prompt.
--
-- A website's `system_prompt` says who the business is. What nobody could say was the
-- layer underneath it: that this is first-line support in a chat window, and WHEN to stop
-- trying and fetch a human. That layer was three string constants in the server, so
-- "hand off sooner for this customer" meant editing code and shipping a release.
--
-- Both columns are OVERRIDES and both are nullable, which is the point: NULL falls back to
-- the next tier (website → install → the default in code), so an improvement to the
-- default wording still reaches everyone who never touched theirs. Storing the resolved
-- text instead would freeze every install at the wording it was created with.
--
-- Neither is customer-writable. They carry the action protocol — `{{tag}}` writes the
-- labels a customer's reports group by, `{{resolve}}` closes their conversations — so the
-- editor is the ops panel, guarded by `ai:prompt`.

ALTER TABLE platform_settings ADD COLUMN ai_preamble TEXT;

ALTER TABLE website_settings ADD COLUMN ai_preamble TEXT;
