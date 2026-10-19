#!/usr/bin/env bash
# Builds the Android app for the container image (Dockerfile, stage android-1). Writes <out>/unihub.apk and <out>/unihub-android.json, which the API
# reports in GET /api/version.
#
# Signing: Android only installs an update signed with the same key as the
# installed app. Official images use the key from the CI secrets (BuildKit
# secrets android_keystore = base64 of the keystore, android_keystore_password).
# Without them the APK is signed with a throwaway key, so a phone cannot update
# it from a later image: uninstall first. Self-hosters who build their own
# images can pass their own key the same way, with UNIHUB_ANDROID_SIGNER naming it
# (docs/ANDROID.md).
set -euo pipefail

out="${1:?usage: build-apk.sh <output directory>}"
cd "$(dirname "$0")/.."

# Same formula as app/build.gradle.kts: 0.21.0 is version code 21000. Gradle
# reads package.json as JSON; this reads the first "version" key whatever the
# formatting, and refuses anything Gradle would not turn into the same code, so
# the download's metadata cannot advertise an empty version or code 0.
version="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' ../package.json | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json has no plain major.minor.patch version (read: '$version')." >&2
  exit 1
fi
IFS=. read -r major minor patch <<<"$version"
code=$((10#$major * 1000000 + 10#$minor * 1000 + 10#$patch))

# The Dockerfile's build cache only notices a new key through UNIHUB_ANDROID_SIGNER.
key_name="${UNIHUB_ANDROID_SIGNER:-none}"
if [[ -s /run/secrets/android_keystore && "$key_name" == none ]]; then
  echo 'A signing key was given: also pass --build-arg UNIHUB_ANDROID_SIGNER=<a name for this key>, so a cached app signed with another key is not reused.' >&2
  exit 1
fi
if [[ -s /run/secrets/android_keystore && ! -s /run/secrets/android_keystore_password ]]; then
  echo 'A signing key was given without its password (secret android_keystore_password).' >&2
  exit 1
fi
if [[ ! -s /run/secrets/android_keystore && "$key_name" != none ]]; then
  echo "UNIHUB_ANDROID_SIGNER is $key_name, but no signing key was given (secret android_keystore)." >&2
  exit 1
fi

keystore="$(mktemp -d)/unihub.jks"
if [[ -s /run/secrets/android_keystore && -s /run/secrets/android_keystore_password ]]; then
  signing=release
  base64 -d /run/secrets/android_keystore > "$keystore"
  UNIHUB_KEYSTORE_PASSWORD="$(cat /run/secrets/android_keystore_password)"
else
  signing=local
  echo 'No Android signing key given: signing with a throwaway key. Phones must uninstall this app before installing one from another image.' >&2
  UNIHUB_KEYSTORE_PASSWORD=unihub-local-build
  keytool -genkeypair -noprompt -keystore "$keystore" -alias unihub -keyalg RSA -keysize 3072 -validity 10000 \
    -storepass "$UNIHUB_KEYSTORE_PASSWORD" -keypass "$UNIHUB_KEYSTORE_PASSWORD" -dname 'CN=UniHub local build' >/dev/null
fi
export UNIHUB_KEYSTORE="$keystore" UNIHUB_KEYSTORE_PASSWORD UNIHUB_KEY_ALIAS=unihub

./gradlew --no-daemon --console=plain testReleaseUnitTest assembleRelease
rm -f "$keystore"

mkdir -p "$out"
cp app/build/outputs/apk/release/app-release.apk "$out/unihub.apk"
size="$(stat -c %s "$out/unihub.apk")"
sha256="$(sha256sum "$out/unihub.apk" | cut -d ' ' -f 1)"
printf '{"versionName":"%s","versionCode":%d,"size":%d,"sha256":"%s","signing":"%s"}\n' \
  "$version" "$code" "$size" "$sha256" "$signing" > "$out/unihub-android.json"
cat "$out/unihub-android.json"
