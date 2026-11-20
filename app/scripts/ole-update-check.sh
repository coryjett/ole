#!/bin/sh
# Ole: is the update feed healthy? Read-only: checks that the newest release on coryjett/ole has a complete,
# consistent latest-mac.yml, so every installed copy can update to it (#26). Add --full to download the release and
# verify checksums, signature and feed address too.
set -e
cd "$(dirname "$0")/.."
node scripts/release-check.mjs feed
if [ "$1" = --full ]; then
  # fail closed: without the signing identity the certificate check would have nothing to compare against
  IDENTITY=$(security find-identity -v -p codesigning | awk '/"Ole Local"$/ { print $2 }')
  [ "${#IDENTITY}" = 40 ] || { echo 'The "Ole Local" signing identity is missing (OLE.md); cannot verify the signature' >&2; exit 1; }
  TAG=$(node scripts/release-check.mjs newest)
  [ -n "$TAG" ] || { echo 'no published release to verify' >&2; exit 1; }
  node scripts/release-check.mjs verify "$TAG" "$IDENTITY"
fi
