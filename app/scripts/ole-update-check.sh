#!/bin/sh
# Ole: is the update feed healthy? Read-only: checks that the newest release on coryjett/ole has a complete,
# consistent latest-mac.yml, so every installed copy can update to it (#26). Add --full to download the release and
# verify checksums, signature and feed address too.
set -e
cd "$(dirname "$0")/.."
node scripts/release-check.mjs feed
if [ "$1" = --full ]; then
  TAG=$(gh release list --repo coryjett/ole --limit 1 --exclude-drafts --json tagName -q '.[0].tagName')
  IDENTITY=$(security find-identity -v -p codesigning | awk '/"Ole Local"$/ { print $2 }')
  node scripts/release-check.mjs verify "$TAG" "$IDENTITY"
fi
