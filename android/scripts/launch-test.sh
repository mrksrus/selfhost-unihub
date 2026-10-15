#!/usr/bin/env bash
# Starts the built app on a running emulator the way a person does, and fails
# when it crashes: a first start, "Open in app" (unihub://connect) with the
# app closed, and a start with a saved server whose page reported a theme.
# CI runs it on emulators (.github/workflows/docker-image.yml); locally, start
# an emulator first. The server is a stub page on this machine, which the
# emulator reaches at 10.0.2.2.
set -euo pipefail

apk="${1:?usage: launch-test.sh <unihub.apk>}"
package=io.github.mrksrus.unihub
port=8099
server="http://10.0.2.2:$port"

work="$(mktemp -d)"
stub_pid=
cleanup() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# The page reports a theme like UniHub's ThemeProvider does, then tells the
# stub whether the app's bridge was there.
mkdir "$work/site"
cat > "$work/site/index.html" <<'HTML'
<!doctype html>
<title>UniHub launch test</title>
<body style="background:#123456">
<script>
  if (window.UniHubAndroid) {
    UniHubAndroid.postMessage(JSON.stringify({ type: 'theme', dark: true, background: '#123456' }));
    fetch('/theme-posted');
  } else {
    fetch('/no-bridge');
  }
</script>
HTML
python3 -m http.server "$port" --bind 0.0.0.0 --directory "$work/site" 2>> "$work/stub.log" &
stub_pid=$!

fail() {
  echo "Launch test failed: $1" >&2
  adb logcat -d -b crash >&2 || true
  exit 1
}

# The app's own process is still there and nothing of it crashed.
expect_running() {
  sleep 3
  adb shell pidof "$package" >/dev/null || fail "$1: the app is not running"
  if adb logcat -d -b crash | grep -q "Process: $package"; then fail "$1: the app crashed"; fi
}

screen() {
  adb shell uiautomator dump /sdcard/launch-test.xml >/dev/null 2>&1 || true
  adb shell cat /sdcard/launch-test.xml 2>/dev/null || true
}

wait_for_text() {
  for _ in $(seq 1 20); do
    screen | grep -q "$1" && return 0
    sleep 1
  done
  fail "\"$1\" did not appear"
}

wait_for_request() {
  for _ in $(seq 1 30); do
    grep -qE "$1" "$work/stub.log" && return 0
    sleep 1
  done
  fail "the page did not request $1"
}

# The page ran its script. The bridge (WebMessageListener) needs a recent
# WebView, which the oldest emulator images may lack; from Android 12 on, the
# theme path is the one to test.
wait_for_page() {
  if (( sdk >= 31 )); then wait_for_request 'GET /theme-posted'; else wait_for_request 'GET /(theme-posted|no-bridge)'; fi
}

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
echo "Android API $sdk"
adb install -r "$apk" >/dev/null

echo 'First start: the connect screen'
adb logcat -c -b all
adb shell am start -W -n "$package/.MainActivity" >/dev/null
wait_for_text 'Connect to your UniHub'
expect_running 'first start'

echo 'Open in app with the app closed: asks before connecting'
adb shell am force-stop "$package"
adb logcat -c -b all
adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
wait_for_text 'Connect to 10.0.2.2?'
expect_running 'open in app'
bounds="$(screen | grep -o 'resource-id="android:id/button1"[^>]*bounds="[^"]*"' | grep -o 'bounds="[^"]*"' | head -n 1 || true)"
read -r x1 y1 x2 y2 <<<"$(sed 's/[^0-9]/ /g' <<<"$bounds")"
[[ -n "${y2:-}" ]] || fail 'no Connect button in the dialog'
adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
wait_for_page
expect_running 'connected'

echo 'Start with the saved server and theme'
adb shell am force-stop "$package"
: > "$work/stub.log"
adb logcat -c -b all
adb shell am start -W -n "$package/.MainActivity" >/dev/null
wait_for_page
expect_running 'start with a saved server'

echo 'The app starts and connects.'
