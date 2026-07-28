-- More of the widget under the customer's control.
--
-- Every one of these is PRESENTATION ONLY and travels the same route as the rest of
-- the theme: website_settings -> /boot -> the widget. The two that affect the frame
-- rather than the document (launcher size) also travel to embed.js in the placement
-- message, because the iframe is sized on the host page and a setting that stops at
-- the widget is a setting that does nothing — which has now been true of five
-- controls on this screen, so it is worth stating rather than remembering.

-- 48 / 60 / 72. A number rather than an enum so a future size needs no migration,
-- bounded so a customer cannot put a 400px button on their own site by accident.
ALTER TABLE "website_settings" ADD COLUMN "launcher_size" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_launcher_size_check"
  CHECK ("launcher_size" BETWEEN 40 AND 96);

-- Which glyph sits in the launcher. A curated list, not a URL: an arbitrary image
-- would need upload, moderation and a CDN, and every one of these has to look right
-- at 20px on both light and dark.
ALTER TABLE "website_settings" ADD COLUMN "launcher_icon" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_launcher_icon_check"
  CHECK ("launcher_icon" IN ('chat', 'question', 'sparkle', 'envelope', 'wave'));

-- How heavy the panel header is.
--
-- 'solid' is what shipped: a full-bleed block of the brand colour. It is loud, and on
-- a saturated brand it is the first thing anyone criticises. 'soft' tints it, 'minimal'
-- drops the fill entirely and keeps a hairline — so a customer whose brand colour is
-- bright can still use it without a slab of it at the top of every conversation.
ALTER TABLE "website_settings" ADD COLUMN "header_style" TEXT NOT NULL DEFAULT 'solid';
ALTER TABLE "website_settings" ADD CONSTRAINT "website_settings_header_style_check"
  CHECK ("header_style" IN ('solid', 'soft', 'minimal'));

-- A picture at the top of the conversation. A URL the customer already hosts, not an
-- upload: uploads bring storage quota, moderation and a delete path, and none of that
-- is needed to let somebody point at the logo already on their own website.
ALTER TABLE "website_settings" ADD COLUMN "brand_avatar_url" TEXT;
