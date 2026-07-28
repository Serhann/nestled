-- A second round of widget appearance controls.
--
-- The rule this codebase keeps re-learning: a setting only exists if it reaches the
-- place that renders it. Two of these four affect the IFRAME rather than the document
-- inside it, so they travel to embed.js in `nestled:placement` as well — panel width
-- because the host page owns the frame, and the pulse because the frame has to be big
-- enough to contain the animation or it is clipped into a square.

-- The visitor's own messages: the brand colour, or neutral grey.
--
-- Brand-coloured is what shipped and it is the right default, but on a saturated or
-- very light brand it makes the customer's own words the loudest thing in the
-- transcript. Neutral keeps the colour for buttons and the header only.
ALTER TABLE "website_settings" ADD COLUMN "bubble_style" TEXT NOT NULL DEFAULT 'brand';
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_bubble_style_check"
  CHECK ("bubble_style" IN ('brand', 'neutral'));

-- How wide the open panel is. Bounded: below ~320 the composer and a message bubble
-- stop fitting side by side, and above ~520 it stops being a chat widget and starts
-- covering the page it is supposed to be helping with.
ALTER TABLE "website_settings" ADD COLUMN "panel_width" INTEGER NOT NULL DEFAULT 384;
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_panel_width_check"
  CHECK ("panel_width" BETWEEN 320 AND 520);

-- A slow pulse on the closed launcher.
--
-- OFF by default, deliberately. It is the single most effective way to get noticed and
-- the single most effective way to be irritating, and a default that animates on every
-- page of every customer's site is a decision we should not make for them.
ALTER TABLE "website_settings" ADD COLUMN "launcher_pulse" BOOLEAN NOT NULL DEFAULT false;

-- An optional different brand colour for dark mode.
--
-- NULL means "use the same one". This exists because the contrast warning on the
-- appearance screen is computed against ONE background: a colour that reads perfectly
-- on white can be unreadable on a dark surface, and a customer who supports both had
-- no way to fix that without compromising the light theme.
ALTER TABLE "website_settings" ADD COLUMN "primary_color_dark" TEXT;
