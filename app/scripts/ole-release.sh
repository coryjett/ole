#!/bin/sh
# Ole: build the locally signed Mac app and publish it to github.com/coryjett/ole, the feed installed copies
# update from (electron-builder.yml publish block). Safe by construction (#26):
#   1. the version must be above every published release, or installed copies would never move to it;
#   2. the build's own update files are checked before anything is uploaded;
#   3. the release is created as a DRAFT, everything is uploaded, then downloaded again and verified
#      (checksums, the "Ole Local" certificate installed copies trust, feed coryjett/ole, version);
#   4. only a verified draft is published; a failed check deletes the draft, so nothing half-made is ever public;
#   5. the live feed is checked once more after publishing.
# Bump "version" in app/package.json first. Needs the "Ole Local" code-signing identity in the login keychain
# (see OLE.md, "The signing certificate"). Never delete the newest release: ship a higher version instead.
set -e
cd "$(dirname "$0")/.."
REPO=coryjett/ole
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
# a version like 0.1.0-alpha.1 is published as a GitHub pre-release
case "$VERSION" in *-*) PRE=--prerelease ;; *) PRE= ;; esac
IDENTITY=$(security find-identity -v -p codesigning | awk '/"Ole Local"$/ { print $2 }')
[ "${#IDENTITY}" = 40 ] || { echo 'The "Ole Local" signing identity is missing: installed copies only accept updates signed by it (OLE.md)' >&2; exit 1; }
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && { echo "$TAG already exists (as a release or a draft); bump the version" >&2; exit 1; }
node scripts/release-check.mjs newer "$VERSION" "$REPO"
[ "${OLE_SKIP_BUILD:-0}" = 1 ] || YOGURT_SIGN_ID='Ole Local' YOGURT_NOTARIZE=0 sh scripts/release-mac.sh
grep -q "^version: $VERSION\$" dist/latest-mac.yml || { echo "dist/latest-mac.yml is not for $VERSION; rebuild" >&2; exit 1; }
git fetch -q origin main
gh release create "$TAG" --repo "$REPO" --draft --target "$(git rev-parse origin/main)" --title "Ole $VERSION" $PRE --notes "${OLE_NOTES:-Ole $VERSION}" \
  dist/latest-mac.yml dist/Ole-*.dmg dist/Ole-*.zip dist/*.blockmap
if ! node scripts/release-check.mjs verify "$TAG" "$IDENTITY" "$REPO"; then
  gh release delete "$TAG" --repo "$REPO" --yes
  echo "$TAG was not published: the draft failed verification and was deleted" >&2
  exit 1
fi
gh release edit "$TAG" --repo "$REPO" --draft=false $PRE >/dev/null
node scripts/release-check.mjs feed "$REPO"
echo "published $TAG"
