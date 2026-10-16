#!/usr/bin/env bash
# Runs the apps of the Android support window on the running emulator, as
# planned by scripts/android-support-window.mts --out <dir>:
#
#   window-test.sh <dir> <candidate.apk> <candidate unihub-android.json>
#
# - "launch": the full launch test (launch-test.sh) with that release's app.
# - "crash": a known-broken app must still close on start exactly as recorded,
#   so the support table stays true; it is not counted as working.
# - Updating from the previous release's app to the candidate keeps the saved
#   server (when the old app can start here) and starts. Phones only accept
#   the update when both carry the release signature, so a candidate signed
#   with a throwaway key (pull requests from forks) reports this as not run.
# Every result is printed in a table; any unexpected result fails.
set -euo pipefail

dir="${1:?usage: window-test.sh <dir> <candidate.apk> <candidate unihub-android.json>}"
candidate="${2:?candidate apk}"
candidate_meta="${3:?candidate metadata}"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package=io.github.mrksrus.unihub
port=8098
server="http://10.0.2.2:$port"
sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
results=()
failed=0

work="$(mktemp -d)"
stub_pid=
cleanup() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

record() { results+=("$(printf '%-11s %-4s %-8s %s' "$1" "$sdk" "$2" "$3")"); [[ "$2" == ok || "$2" == not-run ]] || failed=1; }

crashed() { adb logcat -d -b crash | grep -q "Process: $package"; }

# A known-broken app: started from the launcher, it must close with a crash.
expect_crash() {
  adb uninstall "$package" >/dev/null 2>&1 || true
  adb install "$1" >/dev/null
  adb logcat -c -b all
  adb shell am start -n "$package/.MainActivity" >/dev/null
  for _ in $(seq 1 15); do
    crashed && return 0
    sleep 1
  done
  return 1
}

# fd 3: adb and the launch test read standard input.
while IFS=$'\t' read -r version api expectation apk <&3; do
  [[ "$api" == "$sdk" ]] || continue
  [[ "$apk" == - ]] && apk="$candidate"
  case "$expectation" in
    launch)
      adb uninstall "$package" >/dev/null 2>&1 || true
      if bash "$here/launch-test.sh" "$apk"; then record "$version" ok 'starts, connects, starts with the saved server'
      else record "$version" FAILED 'expected to start'; fi ;;
    crash)
      if expect_crash "$apk"; then record "$version" ok 'closes on start, as recorded (known broken)'
      else record "$version" FAILED 'recorded as closing on start, but did not: update android/support-window.json'; fi ;;
    unavailable) record "$version" not-run 'no app was published' ;;
    *) record "$version" FAILED "unknown expectation $expectation" ;;
  esac
done 3< "$dir/plan.tsv"
(( ${#results[@]} )) || { echo "No app in $dir/plan.tsv is planned for API $sdk: add this emulator to android/support-window.json." >&2; exit 1; }

# Update from the previous release's app.
previous="$(tr -d '[:space:]' < "$dir/upgrade-from")"
old_apk="$dir/$previous/unihub.apk"
old_expectation="$(awk -F '\t' -v v="$previous" -v a="$sdk" '$1 == v && $2 == a { print $3 }' "$dir/plan.tsv")"
if [[ -z "$previous" || ! -f "$old_apk" ]]; then
  record "$previous" FAILED 'previous release app missing for the update check'
elif ! grep -q '"signing":"release"' "$candidate_meta"; then
  record "$previous>new" not-run 'candidate is not release-signed, so a phone would refuse the update'
else
  mkdir "$work/site"
  printf '<!doctype html><title>UniHub update test</title><script>fetch("/page-loaded")</script>\n' > "$work/site/index.html"
  python3 -m http.server "$port" --bind 0.0.0.0 --directory "$work/site" 2>> "$work/stub.log" &
  stub_pid=$!
  adb uninstall "$package" >/dev/null 2>&1 || true
  adb install "$old_apk" >/dev/null
  saved=0
  if [[ "$old_expectation" == launch ]]; then
    # Connect the old app to a server, as its user did. A screen dump can come
    # back empty while the dialog draws, so a missed tap is tried again.
    for _ in 1 2 3; do
      adb shell am force-stop "$package"
      adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
      bounds=
      for _ in $(seq 1 20); do
        adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
        bounds="$(adb shell cat /sdcard/window.xml 2>/dev/null | grep -q 'Connect to 10.0.2.2?' \
          && adb shell cat /sdcard/window.xml 2>/dev/null | grep -o 'resource-id="android:id/button1"[^>]*bounds="[^"]*"' | grep -o 'bounds="[^"]*"' | head -n 1 || true)"
        [[ -n "$bounds" ]] && break
        sleep 1
      done
      read -r x1 y1 x2 y2 <<<"$(sed 's/[^0-9]/ /g' <<<"$bounds")"
      if [[ -n "${y2:-}" ]]; then adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2)); fi
      for _ in $(seq 1 30); do grep -q 'GET /page-loaded' "$work/stub.log" && { saved=1; break; }; sleep 1; done
      [[ "$saved" == 1 ]] && break
    done
    adb shell am force-stop "$package"
  fi
  : > "$work/stub.log"
  adb logcat -c -b all
  if ! adb install -r "$candidate" >/dev/null; then
    record "$previous>new" FAILED 'the phone refused the update'
  else
    adb shell am start -W -n "$package/.MainActivity" >/dev/null
    sleep 3
    if crashed || ! adb shell pidof "$package" >/dev/null; then record "$previous>new" FAILED 'the updated app does not start'
    elif [[ "$saved" == 1 ]]; then
      loaded=0
      for _ in $(seq 1 30); do grep -q 'GET /page-loaded' "$work/stub.log" && { loaded=1; break; }; sleep 1; done
      if [[ "$loaded" == 1 ]]; then record "$previous>new" ok 'update keeps the saved server and starts'
      else record "$previous>new" FAILED 'the updated app lost the saved server'; fi
    elif [[ "$old_expectation" == launch ]]; then record "$previous>new" FAILED 'the old app could not be connected for the update check'
    else record "$previous>new" ok 'installs over the broken app and starts (no server was saved)'; fi
  fi
fi

echo
echo "App         API  Result   Detail"
printf '%s\n' "${results[@]}"
exit "$failed"
