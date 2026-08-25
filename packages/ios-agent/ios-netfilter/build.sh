#!/bin/bash
# Build + Developer-ID-sign + notarize + staple the tapflow network-filter system extension.
# Requires a paid Apple Developer account and notarytool creds stored as 'tapflow-notary'.
# ad-hoc/self-signed do NOT load (measured code=4); un-notarized Developer ID is Gatekeeper-rejected.
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${NOTARY_PROFILE:-tapflow-notary}"

xcodegen generate >/dev/null
# Every build gets a unique, increasing CFBundleVersion — OSSystemExtension activation skips the
# replace (keeping the old bundle + running provider) when the version matches, returning result 0
# while nothing changed. See project.yml. xcodegen bakes the version in as a LITERAL, so a build
# setting can't override it — patch both Info.plists after generate.
BUILD_VERSION="$(date +%s)"
echo "CFBundleVersion=$BUILD_VERSION"
plutil -replace CFBundleVersion -string "$BUILD_VERSION" Extension/Info.plist
plutil -replace CFBundleVersion -string "$BUILD_VERSION" Host/Info.plist
# --timestamp: notarize needs a secure timestamp. INJECT_BASE_ENTITLEMENTS=NO: strip get-task-allow.
xcodebuild -project TapflowNetFilter.xcodeproj -scheme TapflowNetFilter -configuration Release \
  -derivedDataPath build \
  OTHER_CODE_SIGN_FLAGS="--timestamp" CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO build

APP="build/Build/Products/Release/TapflowNetFilter.app"
rm -f build/app.zip
ditto -c -k --keepParent "$APP" build/app.zip
echo "submitting for notarization…"
xcrun notarytool submit build/app.zip --keychain-profile "$PROFILE" --wait

# Staple the APP ONLY (stapling the embedded sysext breaks the app's seal). Work on a fresh unpack
# of the notarized zip so the on-disk build tree stays as signed.
rm -rf build/stapled && ditto -x -k build/app.zip build/stapled
xcrun stapler staple "build/stapled/TapflowNetFilter.app"
# Install it into the package and record it, in the same step that produced it.
#
# **The record and the artifact are written together on purpose.** `scripts/__tests__/` fails when the
# extension's sources move without the app moving with them, and a record written by a separate,
# remembered command would fail in a way correlated with the mistake it exists to catch: whoever
# forgets the rebuild forgets the record, both stay consistent, and the guard passes.
# `rm -rf` first: `ditto` **merges** into an existing destination and deletes nothing, so a rebuild
# that drops a file leaves it behind inside a sealed bundle — a stray `.systemextension` after a
# bundle-id change, an `embedded.provisionprofile` after the profile goes. `codesign --verify`
# then fails on the user's Mac, and the freshness guard cannot see it: it hashes the merged tree
# and records that, so the record is perfectly consistent with itself. Line 31 above already does
# this for the same reason.
rm -rf "../bin/TapflowNetFilter.app"
ditto "build/stapled/TapflowNetFilter.app" "../bin/TapflowNetFilter.app"
node ../../../scripts/record-netfilter-artifact.mjs

echo "done: shipped in packages/ios-agent/bin/TapflowNetFilter.app (notarized + stapled + recorded)"
