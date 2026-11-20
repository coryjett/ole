#!/bin/sh
# Ole: build the locally signed Mac app and publish it to github.com/coryjett/ole,
# the feed installed copies check for updates (electron-builder.yml publish block).
# Bump "version" in app/package.json first; an installed copy only updates to a higher version.
# Needs the "Ole Local" code-signing identity in the login keychain: updates install only when the
# new build is signed by the same certificate as the installed one.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
gh release view "v$VERSION" --repo coryjett/ole >/dev/null 2>&1 && { echo "v$VERSION is already released; bump the version" >&2; exit 1; }
[ "${OLE_SKIP_BUILD:-0}" = 1 ] || YOGURT_SIGN_ID='Ole Local' YOGURT_NOTARIZE=0 sh scripts/release-mac.sh
gh release create "v$VERSION" --repo coryjett/ole --title "Ole $VERSION" $(case "$VERSION" in *-*) echo --prerelease;; esac) --notes "${OLE_NOTES:-Ole $VERSION}" \
  dist/latest-mac.yml dist/Ole-*.dmg dist/Ole-*.zip dist/*.blockmap
echo "published v$VERSION"
