#!/bin/sh
# Fill in the SEO artifacts that cannot exist without knowing the domain.
#
# ── Why this runs at container start and not at build time ────────────────────
#
# `src/lib/origins.ts` resolves every surface from the address bar at runtime, on purpose, so
# one image serves example.com, chat.example.com or a tunnel without being rebuilt. The build
# therefore cannot write an absolute URL — and three SEO artifacts have no relative form:
#
#   sitemap.xml           every <loc> must be absolute, and on the sitemap's own host
#   robots.txt Sitemap:   must be absolute
#   og:url / og:image     the social crawlers do not resolve relative URLs
#
# Canonical tags are NOT in that list: they are emitted relative at build time, which the
# spec permits and Google resolves against the document. So the pages are correct on any host
# before this script runs; what it adds is discovery and link previews.
#
# ── The failure mode this is written around ───────────────────────────────────
#
# Given no domain, this writes NOTHING and strips the placeholders. That is deliberate. A
# guessed domain in a canonical or a sitemap is not a missed opportunity — it tells Google the
# real page is on another host, and the honest outcome of that is the site dropping out of
# the index. Missing og:url costs a link preview. Wrong og:url costs the page. Silence is the
# safe side of that trade, so an operator who forgets to set the variable loses a feature
# rather than their rankings.
set -eu

ROOT="${SEO_ROOT:-/usr/share/nginx/html}"
PLACEHOLDER='__SITE_ORIGIN__'

# Coolify injects SERVICE_FQDN_WEB_80 with the scheme included (see docker-compose.production
# .yml). SITE_URL is the portable name for anyone deploying by other means, and wins when both
# are set — an explicit value should beat a platform's magic one.
RAW="${SITE_URL:-${SERVICE_FQDN_WEB_80:-}}"

# Strip any trailing slash so `${ORIGIN}/pricing` never becomes a double slash, which is a
# different URL to a crawler and would fight the canonical it is supposed to agree with.
ORIGIN="$(printf '%s' "$RAW" | sed 's#/*$##')"

if [ -z "$ORIGIN" ]; then
  echo "[seo] no SITE_URL or SERVICE_FQDN_WEB_80 — leaving sitemap and og:url out rather than guessing a domain."
  # The placeholder must not reach a browser: a literal __SITE_ORIGIN__/icon-512.png is a
  # broken image in every link preview. Removing the two tags leaves the page valid.
  find "$ROOT" -maxdepth 1 -name '*.html' -exec \
    sed -i "/${PLACEHOLDER}/d" {} +
  exit 0
fi

case "$ORIGIN" in
  http://*|https://*) ;;
  *)
    # A bare hostname would produce <loc>example.com/pricing</loc>, which is not a URL. Https
    # rather than http: this is a value an operator set for a site they are serving publicly.
    echo "[seo] '$ORIGIN' has no scheme — assuming https://"
    ORIGIN="https://$ORIGIN"
    ;;
esac

echo "[seo] using $ORIGIN"

# og:url and og:image, in every prerendered document.
find "$ROOT" -maxdepth 1 -name '*.html' -exec \
  sed -i "s#${PLACEHOLDER}#${ORIGIN}#g" {} +

# The sitemap. Only the marketing pages: the app and ops shells have nothing to index and are
# disallowed in robots.txt, and listing a disallowed URL in a sitemap is a Search Console
# warning rather than a page.
#
# No <lastmod>. A date that is really "when the container started" is worse than none — it
# tells a crawler the page changed when it did not, and a source that lies about freshness is
# a source whose freshness signals get discounted.
cat > "$ROOT/sitemap.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc><priority>1.0</priority></url>
  <url><loc>${ORIGIN}/features</loc><priority>0.8</priority></url>
  <url><loc>${ORIGIN}/pricing</loc><priority>0.8</priority></url>
  <url><loc>${ORIGIN}/compare</loc><priority>0.7</priority></url>
  <url><loc>${ORIGIN}/privacy</loc><priority>0.3</priority></url>
  <url><loc>${ORIGIN}/terms</loc><priority>0.3</priority></url>
</urlset>
XML

# Point robots.txt at it. Idempotent: a container restarted twice must not accumulate two
# Sitemap lines, and the image's own robots.txt is read-only source we are appending to.
if [ -f "$ROOT/robots.txt" ]; then
  sed -i '/^Sitemap:/d' "$ROOT/robots.txt"
  printf '\nSitemap: %s/sitemap.xml\n' "$ORIGIN" >> "$ROOT/robots.txt"
fi

echo "[seo] wrote sitemap.xml and the robots.txt Sitemap line"
