#!/usr/bin/env bash
#
# Build this site for a PageBox site and push it there.
#
# The point of doing it this way round — asking the instance where the site lives before
# building — is that the base path never has to be written down. When a site later moves to
# its own hostname, /api/v1/whoami answers "/" and the next build comes out right with no
# change here.
#
#   PAGEBOX_ADMIN=https://pagebox.example.com \
#   PAGEBOX_TOKEN=pbx_… \
#   PAGEBOX_SLUG=docs \
#     ./scripts/deploy-to-pagebox.sh
#
set -euo pipefail

: "${PAGEBOX_ADMIN:?set PAGEBOX_ADMIN, e.g. https://pagebox.example.com}"
: "${PAGEBOX_TOKEN:?set PAGEBOX_TOKEN, the pbx_ deploy token for this site}"
: "${PAGEBOX_SLUG:?set PAGEBOX_SLUG, the site to deploy to}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "→ asking $PAGEBOX_ADMIN where /s/$PAGEBOX_SLUG/ lives"
whoami_json=$(curl -sfS "$PAGEBOX_ADMIN/api/v1/whoami" \
  -H "Authorization: Bearer $PAGEBOX_TOKEN")

base_path=$(printf '%s' "$whoami_json" | jq -r '.basePath')
site_url=$(printf '%s' "$whoami_json" | jq -r '.siteUrl')
token_slug=$(printf '%s' "$whoami_json" | jq -r '.slug')

if [ "$token_slug" != "$PAGEBOX_SLUG" ]; then
  echo "✗ this token is scoped to '$token_slug', not '$PAGEBOX_SLUG'" >&2
  exit 1
fi

echo "  base path: $base_path"

# next.config.mjs trims the trailing slash itself; passing it through unchanged keeps this
# script honest about what the API actually returned.
DOCS_BASE_PATH="$base_path" DOCS_SITE_URL="$site_url" pnpm build

# Zip the *contents* of out/, not out/ itself — an archive with a single top-level
# directory is the most common reason a deployed site has no index.html at its root.
rm -f "$root/site.zip"
( cd out && zip -qr "$root/site.zip" . )

echo "→ uploading $(du -h "$root/site.zip" | cut -f1)"
response=$(curl -sfS -X POST "$PAGEBOX_ADMIN/api/v1/sites/$PAGEBOX_SLUG/deployments" \
  -H "Authorization: Bearer $PAGEBOX_TOKEN" \
  -H "Content-Type: application/zip" \
  -H "X-Deployment-Notes: ${DEPLOY_NOTES:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}" \
  --data-binary "@$root/site.zip")

printf '%s\n' "$response" | jq .

broken=$(printf '%s' "$response" | jq -r '.brokenAssets // 0')
if [ "$broken" != "0" ]; then
  echo "✗ $broken references in index.html do not resolve:" >&2
  printf '%s' "$response" | jq -r '.brokenAssetSamples[]?' >&2
  exit 1
fi

echo "✓ live at $(printf '%s' "$response" | jq -r '.url')"
