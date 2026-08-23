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
echo "done: build/stapled/TapflowNetFilter.app (notarized + stapled)"
