-- Managed, data-driven quick actions.
CREATE TABLE "quick_actions" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "key"              TEXT NOT NULL,
  "label"            TEXT NOT NULL,
  "kind"             TEXT NOT NULL DEFAULT 'human',
  "visitor_template" TEXT NOT NULL DEFAULT '',
  "reply_template"   TEXT NOT NULL DEFAULT '',
  "suggestion"       TEXT,
  "fields"           JSONB NOT NULL DEFAULT '[]',
  "priority"         INTEGER NOT NULL DEFAULT 0,
  "is_active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "quick_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quick_actions_key_key" ON "quick_actions"("key");

-- Seed the built-in catalog so behaviour is unchanged and admins can edit it.
-- Available template placeholders: {order} {status} {eta} {restaurant}
-- {restaurant_clause} {eta_clause} {eta_paren} {order_about} + any field name.
INSERT INTO "quick_actions" ("key","label","kind","visitor_template","reply_template","suggestion","fields","priority") VALUES
 ('where','Where''s my order?','auto','Where is my order {order}?','Your order {order}{restaurant_clause} is {status}{eta_clause}. I''ll let you know the moment it''s nearby! 🛵','Share a live ETA update.','[]',10),
 ('status','Order status','auto','What''s the status of my order {order}?','Order {order} is currently: {status}{eta_paren}.','Confirm the current order status.','[]',20),
 ('late','Running late?','human','My order {order} seems late — can someone check?','Sorry about the wait! I''m connecting you with an agent to check on the delay — please hold on a moment.','Check the delay and offer a goodwill gesture if warranted.','[]',30),
 ('change_address','Change address','human','I need to change the delivery address for order {order}.','Sure — connecting you with an agent to update the delivery address. One moment please.','Verify identity, then update the delivery address.','[]',40),
 ('missing_item','Missing item','human','An item is missing from my order {order}.','I''m sorry about that. Connecting you with an agent to sort out the missing item — please hold on.','Confirm the missing item and refund or re-send it.','[]',50),
 ('wrong','Something was wrong','human','Something was wrong with my order {order}.','That''s not right — connecting you with an agent to help you fix this. One moment please.','Confirm what went wrong and arrange a fix or refund.','[]',60),
 ('refund','Request a refund','human','I''d like a refund for order {order}.','I''ve flagged your refund request — connecting you with an agent to review it. Please hold on a moment.','Review the order and approve an appropriate refund.','[]',70),
 ('tech_issue','Report a technical issue','human','I''m running into a technical issue — store {store} ({state}).','Thanks, {store} — got it. Connecting you with our support team for {state} now. A quick note on what you were doing helps us dig in. One moment please.','Reproduce the issue; gather details and file a bug if needed.','[{"name":"store","label":"Store name","required":true},{"name":"state","label":"State","required":true}]',80),
 ('billing','Account & billing','human','I have a question about my account or billing.','Happy to help with your account. Connecting you with someone who can look into billing and your plan — please hold on a moment.','Pull up the account and resolve the billing question.','[]',90),
 ('demo','Book a demo / trial','human','I''d like a demo or to start a free trial.','Awesome — I''d love to get you set up! Connecting you with our team to arrange a demo or kick off your trial. One moment please.','Qualify the lead and schedule a demo / kick off onboarding.','[]',100),
 ('pricing','Pricing & plans','auto','How does pricing work?','Great question! We offer flexible plans that scale with your team, plus a free trial to start. Tell me your team size and what you''re trying to do, and I''ll point you to the right plan — or I can connect you with our team for a tailored quote.','Answer pricing and, if a fit, hand off to sales.','[]',110),
 ('human','Talk to a human','human','I''d like to talk to an agent{order_about}.','Of course — connecting you with an agent now. Please hold on a moment.','Greet the customer and ask how you can help.','[]',120);
