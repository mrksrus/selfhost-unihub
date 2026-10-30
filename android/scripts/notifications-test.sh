#!/usr/bin/env bash
# Shows that the app receives notifications from its server over its own
# connection, on a running emulator:
#
#   notifications-test.sh <unihub.apk>
#
# A stub server on this machine answers like UniHub (a session cookie,
# /api/version, /api/auth/me and the Android notification routes). It
# encrypts each notification for the keys the phone registered (RFC 8291, its
# own implementation with Node's crypto, not the server's library). The page
# reports whether it can reach the app's bridge (WebView 74 of the Android 10
# image cannot). The app's own question after signing in is declined and
# notifications are turned on from the page, as Settings does; without the
# bridge the question is accepted instead. Then:
# a notification is shown and acknowledged, tapping it opens its page, one
# sent again is not shown twice, one sent with the app in the background
# arrives, an update of the app reconnects, signing out stops the connection
# and removes what was shown, signing in again resumes it, and turning it off
# (from the page, and with the ongoing notification's action) unregisters. CI runs it on every emulator
# (.github/workflows/docker-image.yml).
set -euo pipefail

apk="${1:?usage: notifications-test.sh <unihub.apk>}"
package=io.github.mrksrus.unihub
port=8098
server="http://10.0.2.2:$port"
control="http://127.0.0.1:$port/_control"

work="$(mktemp -d)"
stub_pid=
cleanup() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null || true
  adb shell cmd statusbar collapse >/dev/null 2>&1 || true
  [[ -n "${KEEP_APP:-}" ]] || adb uninstall "$package" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

cat > "$work/stub.mjs" <<'JS'
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2]);
const state = { user: 'user-1', session: 'session-1', csrf: 'csrf-1', enable: null, devices: new Map(), streams: new Set(),
  acks: [], unsubscribed: [], pages: [], replies: [], registrations: 0, connections: 0, bridge: null };

// RFC 8291 / RFC 8188 aes128gcm, one record.
function encrypt(device, text) {
  const ua = Buffer.from(device.p256dh, 'base64url');
  const auth = Buffer.from(device.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const as = ecdh.generateKeys();
  const shared = ecdh.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, as, body]).toString('base64url');
}

const cookies = req => Object.fromEntries((req.headers.cookie || '').split('; ').filter(c => c.includes('=')).map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
const signedIn = req => state.user && cookies(req)['auth-token'] === state.session;
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
function sessionCookies() {
  return [`auth-token=${state.session}; HttpOnly; SameSite=Strict; Path=/`, `csrf-token=${state.csrf}; SameSite=Strict; Path=/`];
}
function endStreams(reason) {
  for (const stream of state.streams) { stream.res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`); stream.res.end(); }
  state.streams.clear();
}
setInterval(() => { for (const stream of state.streams) stream.res.write(': ping\n\n'); }, 5000).unref();

// The page: as Settings does, it asks the app (WebBridge) and reports the answer.
// Plain old JavaScript: the Android 10 image has WebView 74.
const page = `<!doctype html><title>UniHub notifications test</title><p>UniHub<script>
var bridge = window.UniHubAndroid;
if (bridge) bridge.addEventListener('message', function (event) { fetch('/_page/reply', { method: 'POST', body: event.data }); });
fetch('/_page/hello?bridge=' + !!bridge);
setInterval(function () {
  fetch('/_page/next').then(function (r) { return r.text(); }).then(function (action) {
    if (action && bridge) bridge.postMessage(JSON.stringify({ type: 'notifications', id: String(Math.random()).slice(2), action: action }));
  });
}, 1000);
</script>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const path = url.pathname;
  try {
    // ── The test's controls (from the host only) ──
    if (path === '/_control/state') return json(res, 200, { registrations: state.registrations, connections: state.connections, devices: [...state.devices.keys()], streams: state.streams.size,
      acks: state.acks, unsubscribed: state.unsubscribed, pages: state.pages, replies: state.replies, bridge: state.bridge });
    if (path === '/_control/ask') { state.enable = url.searchParams.get('action'); return json(res, 200, {}); }
    if (path === '/_control/send') {
      const id = url.searchParams.get('id') || crypto.randomUUID();
      const payload = { version: 1, userId: state.user, dedupeKey: url.searchParams.get('dedupe') || `mail:${id}`, kind: url.searchParams.get('kind') || 'mail',
        title: url.searchParams.get('title'), body: url.searchParams.get('body') || '', url: url.searchParams.get('url') || '/', notificationId: id };
      let written = 0;
      for (const stream of state.streams) {
        const device = state.devices.get(stream.device);
        if (!device) continue;
        stream.res.write(`event: notification\ndata: ${JSON.stringify({ id, body: encrypt(device, JSON.stringify(payload)) })}\n\n`);
        written++;
      }
      return json(res, 200, { id, written });
    }
    if (path === '/_control/signout') { state.user = ''; state.devices.clear(); endStreams('session_ended'); return json(res, 200, {}); }
    if (path === '/_control/signin') { state.user = 'user-1'; state.session = 'session-2'; return json(res, 200, {}); }
    // ── The page ──
    if (path === '/_page/hello') { state.bridge = url.searchParams.get('bridge') === 'true'; return json(res, 200, {}); }
    if (path === '/_page/next') {
      const action = state.enable; state.enable = null;
      // Signed out: the page's next answer clears the session cookie, as UniHub's sign-out does.
      res.writeHead(200, state.user ? {} : { 'Set-Cookie': ['auth-token=; Max-Age=0; Path=/', 'csrf-token=; Max-Age=0; Path=/'] });
      return res.end(action || '');
    }
    if (path === '/_page/reply') { state.replies.push(await body(req)); return json(res, 200, {}); }
    if (!path.startsWith('/api/')) {
      state.pages.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html', ...(state.user ? { 'Set-Cookie': sessionCookies() } : {}) });
      return res.end(page);
    }
    // ── The API ──
    if (path === '/api/version') return json(res, 200, { app: 'unihub', server: '0.22.1', protocol: 1, minApp: '0.21.0', features: ['android-notifications'], android: null });
    if (!signedIn(req)) return json(res, 401, { error: 'Unauthorized', status: 401 });
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== cookies(req)['csrf-token']) return json(res, 403, { error: 'CSRF token validation failed' });
    if (path === '/api/auth/me') return json(res, 200, { user: { id: state.user, email: 'tester@example.com' } });
    if (path === '/api/notifications/android/devices' && req.method === 'POST') {
      const input = await body(req);
      if (Buffer.from(input.keys?.p256dh || '', 'base64url').length !== 65 || Buffer.from(input.keys?.auth || '', 'base64url').length !== 16) return json(res, 400, { error: 'Invalid push subscription keys' });
      if (input.replaces) state.devices.delete(input.replaces);
      const device = crypto.randomUUID();
      state.devices.set(device, input.keys);
      state.registrations++;
      return json(res, 200, { device, endpoint: `unihub-android:${device}` });
    }
    if (path === '/api/notifications/android/stream') {
      const device = url.searchParams.get('device');
      if (!state.devices.has(device)) return json(res, 404, { error: 'This device is not registered for notifications', code: 'DEVICE_UNKNOWN' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write('retry: 10000\n\nevent: ready\ndata: {"v":1}\n\n');
      const stream = { res, device };
      state.streams.add(stream);
      state.connections++;
      res.on('close', () => state.streams.delete(stream));
      return;
    }
    if (path === '/api/notifications/android/ack' && req.method === 'POST') {
      const input = await body(req);
      if (!state.devices.has(input.device)) return json(res, 404, { error: 'This device is not registered for notifications', code: 'DEVICE_UNKNOWN' });
      state.acks.push(...input.ids);
      return json(res, 200, { acknowledged: input.ids.length });
    }
    if (path === '/api/notifications/unsubscribe' && req.method === 'POST') {
      const input = await body(req);
      state.unsubscribed.push(input.endpoint);
      state.devices.delete(String(input.endpoint).replace('unihub-android:', ''));
      endStreams('session_ended');
      return json(res, 200, { subscribed: false });
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
}).listen(port, '0.0.0.0');
JS
node "$work/stub.mjs" "$port" 2>> "$work/stub.log" &
stub_pid=$!

fail() {
  echo "Notifications test failed: $1" >&2
  echo "On screen (text, package, bounds):" >&2
  screen | grep -o '<node [^>]*>' | sed -n 's/.* text="\([^"]\+\)".* package="\([^"]*\)".* bounds="\([^"]*\)".*/  \1 | \2 | \3/p' >&2 || true
  curl -s "$control/state" >&2 || true
  echo >&2
  adb logcat -d -s UniHubNotifications UniHubSession >&2 || true
  adb logcat -d -b crash >&2 || true
  exit 1
}

# Reads all its input first: `grep -q` under pipefail can fail a pipeline
# that matched, by ending it early.
contains() { local text; text="$(cat)"; [[ "$text" == *"$1"* ]]; }

screen() {
  adb shell uiautomator dump /sdcard/notifications-test.xml >/dev/null 2>&1 || true
  adb shell cat /sdcard/notifications-test.xml 2>/dev/null || true
}

tap_button() { # resource id of a dialog button, waiting for the text first
  for _ in $(seq 1 30); do screen | contains "$1" && break; sleep 1; done
  local bounds x1 y1 x2 y2
  bounds="$(screen | grep -o "resource-id=\"$2\"[^>]*bounds=\"[^\"]*\"" | grep -o 'bounds="[^"]*"' | head -n 1 || true)"
  read -r x1 y1 x2 y2 <<<"$(sed 's/[^0-9]/ /g' <<<"$bounds")"
  [[ -n "${y2:-}" ]] || fail "no button next to \"$1\""
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

where() { # the centre of the first element showing this text (any case), or nothing
  local bounds x1 y1 x2 y2
  for _ in $(seq 1 20); do
    bounds="$(screen | grep -i -o "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | grep -o 'bounds="[^"]*"' | head -n 1 || true)"
    [[ -n "$bounds" ]] && break
    sleep 1
  done
  read -r x1 y1 x2 y2 <<<"$(sed 's/[^0-9]/ /g' <<<"$bounds")"
  [[ -n "${y2:-}" ]] || fail "nothing shows \"$1\" (on screen: $(screen | grep -o 'text="[^"]\+"' | tr '\n' ' '))"
  echo "$(((x1 + x2) / 2)) $(((y1 + y2) / 2))"
}

tap_text() { adb shell input tap $(where "$1"); }

# The centre of the action nearest below a notification's text, or nothing:
# the shade can hold Android's own actions of the same name (Android 16's
# notification cooldown offers "Turn off" on a new phone).
action_below() { # notification text, action text
  screen | grep -o '<node [^>]*>' \
    | sed -n 's/.* text="\([^"]*\)".* bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\2 \3 \4 \5 \1/p' \
    | awk -v note="$1" -v action="$2" '
      { text = $0; sub(/^[0-9]+ [0-9]+ [0-9]+ [0-9]+ /, "", text) }
      tolower(text) == tolower(note) && top == "" { top = $2 }
      tolower(text) == tolower(action) { x[++n] = int(($1 + $3) / 2); y[n] = int(($2 + $4) / 2) }
      END { if (top == "") exit; for (i = 1; i <= n; i++) if (y[i] > top && (best == "" || y[i] < y[best])) best = i; if (best != "") print x[best], y[best] }'
}

# A silent notification may show its actions only when expanded (Android 10,
# and Android 16 under another notification): pull it down, unless its action
# is already in view.
expand_notification() { # notification text, action text
  local x y
  [[ -n "$(action_below "$1" "$2")" ]] && return 0
  read -r x y <<<"$(where "$1")"
  adb shell input swipe "$x" "$y" "$x" $((y + 250)) 300
  sleep 1
}

tap_action_below() { # notification text, action text
  local point=
  for _ in $(seq 1 20); do
    point="$(action_below "$1" "$2")"
    [[ -n "$point" ]] && break
    sleep 1
  done
  [[ -n "$point" ]] || fail "no \"$2\" below \"$1\" (on screen: $(screen | grep -o 'text="[^"]\+"' | tr '\n' ' '))"
  adb shell input tap $point
}


# Awake and past any lock screen (Android 10 keeps a swipe one after a PIN is removed).
locked_screen() { adb shell dumpsys window 2>/dev/null | tr -d '\r' | contains 'isKeyguardShowing=true' || adb shell dumpsys window 2>/dev/null | tr -d '\r' | contains 'mDreamingLockscreen=true'; }
unlock() {
  for _ in $(seq 1 5); do
    adb shell input keyevent KEYCODE_WAKEUP
    adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
    adb shell input keyevent 82
    sleep 1
    locked_screen || return 0
  done
  fail 'the lock screen does not go away'
}

state() { curl -s "$control/state"; }
# An expression over the stub's state, e.g. 'acks.length'.
field() { state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(JSON.stringify(new Function(...Object.keys(v),'return ('+process.argv[1]+')')(...Object.values(v))))})" "$1"; }

wait_for() { # js-expression-on-state description [seconds]
  for _ in $(seq 1 "${3:-40}"); do
    [[ "$(field "$1")" == true ]] && return 0
    sleep 1
  done
  fail "$2"
}

send() { # id title body url
  curl -s "$control/send?id=$1&title=$(node -p 'encodeURIComponent(process.argv[1])' "$2")&body=$(node -p 'encodeURIComponent(process.argv[1])' "$3")&url=$(node -p 'encodeURIComponent(process.argv[1])' "$4")" \
    | contains '"written":1' || fail "no connection to send \"$2\" to"
}

# The notifications UniHub shows (not the connection's), by their text.
shown() { adb shell dumpsys notification --noredact 2>/dev/null | tr -d '\r' | grep -A40 "pkg=$package" | grep -c "android.title=String ($1)" || true; }
expect_shown() { for _ in $(seq 1 30); do (( $(shown "$1") > 0 )) && return 0; sleep 1; done; fail "\"$1\" is not shown ($2)"; }
expect_not_shown() { (( $(shown "$1") == 0 )) || fail "\"$1\" is shown ($2)"; }
# The connection itself, not its watchdog job (NotificationService$Watchdog).
service_running() { adb shell dumpsys activity services "$package" 2>/dev/null | contains '/.NotificationService}'; }

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
echo "Android API $sdk"
adb uninstall "$package" >/dev/null 2>&1 || true
adb install "$apk" >/dev/null
# Android's permission screen and its background question differ between
# versions; answer both beforehand. The app's own paths for them are the
# system dialogs.
if (( sdk >= 33 )); then adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS; fi
adb shell dumpsys deviceidle whitelist +"$package" >/dev/null
adb logcat -c -b all
adb shell cmd statusbar collapse >/dev/null 2>&1 || true
unlock

echo 'Connect and sign in; the app asks once'
adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
tap_button 'Connect to 10.0.2.2?' android:id/button1
wait_for 'bridge !== null' 'the page did not load'
bridge="$(field bridge)"
if [[ "$bridge" == true ]]; then
  echo 'Not now; then turn notifications on from the page'
  tap_button 'Get notifications on this phone?' android:id/button2
  sleep 2
  (( $(field 'registrations') == 0 )) || fail '"Not now" registered the phone'
  curl -s "$control/ask?action=enable" >/dev/null
  wait_for 'replies.some(r => r.ok && r.state.enabled && r.state.endpoint.startsWith("unihub-android:"))' 'the app did not answer "enable" with notifications on'
else
  echo 'This WebView has no message bridge: turn notifications on from the question'
  tap_button 'Get notifications on this phone?' android:id/button1
fi
wait_for 'registrations === 1 && streams === 1' 'the app did not register and connect'
service_running || fail 'the connection service is not running'
# Android 12+ may hold back a service's notification for ten seconds.
for _ in $(seq 1 20); do (( $(shown 'Connected to 10.0.2.2') > 0 )) && break; sleep 1; done
(( $(shown 'Connected to 10.0.2.2') > 0 )) || fail 'no ongoing connection notification'

echo 'A notification is shown and acknowledged'
first=11111111-1111-4111-8111-111111111111
send "$first" 'New Email' 'Alex Example: Quarterly numbers' "/mail?email=e-1"
expect_shown 'New Email' 'first notification'
wait_for "acks.includes('$first')" 'the first notification was not acknowledged'
(( $(adb shell dumpsys notification --noredact | tr -d '\r' | grep -c 'android.text=String (Alex Example: Quarterly numbers)' || true) > 0 )) || fail 'the notification text is missing'
# The lock screen version names no content (Android 10's dump does not list it).
dump="$(adb shell dumpsys notification --noredact | tr -d '\r')"
if [[ "$dump" == *'publicNotification='* && "$dump" != *'android.text=String (New notification)'* ]]; then fail 'no content-free lock screen version'; fi

echo 'Tapping it opens its page in the app'
adb shell input keyevent KEYCODE_HOME
sleep 1
adb shell cmd statusbar expand-notifications
tap_text 'New Email'
wait_for 'pages.includes("/mail?email=e-1")' 'tapping the notification did not open /mail?email=e-1'
expect_not_shown 'New Email' 'a tapped notification goes away'

echo 'One sent again is acknowledged but not shown twice'
before="$(field 'acks.length')"
send "$first" 'New Email' 'Alex Example: Quarterly numbers' "/mail?email=e-1"
wait_for "acks.length > $before" 'a repeated notification was not acknowledged'
sleep 1
expect_not_shown 'New Email' 'a repeated notification'

if (( sdk >= 30 )); then
echo 'A locked phone set to hide sensitive content shows that it arrived, not what it says'
# A PIN makes the lock screen secure. Android ignores an app's own lock screen
# setting for its channels, so the phone's setting decides.
send 55555555-5555-4555-8555-555555555555 'While locked' 'Board meeting moved' '/mail?email=e-2'
expect_shown 'While locked' 'before locking'
adb shell settings put secure lock_screen_allow_private_notifications 0
adb shell locksettings set-pin 1357 >/dev/null
adb shell input keyevent KEYCODE_SLEEP
sleep 2
adb shell input keyevent KEYCODE_WAKEUP
sleep 3
locked="$(screen)"
adb shell locksettings clear --old 1357 >/dev/null
adb shell settings put secure lock_screen_allow_private_notifications 1
unlock
[[ "$locked" == *'New notification'* ]] || fail "the lock screen does not show the content-free version (on screen: $(grep -o 'text="[^"]\+"' <<<"$locked" | tr '\n' ' '))"
[[ "$locked" == *'Board meeting moved'* || "$locked" == *'While locked'* ]] && fail 'the lock screen shows what the notification says'
else
  # The Android 10 image keeps its PIN screen after the PIN is removed.
  echo 'Lock screen: not run on Android 10 (the emulator image cannot unlock again)'
fi

echo 'With the app in the background, a notification still arrives'
adb shell input keyevent KEYCODE_HOME
sleep 2
send 22222222-2222-4222-8222-222222222222 'Reminder' 'Team call starts in 10 minutes' '/calendar?event=c-1'
expect_shown 'Reminder' 'app in the background'

echo 'After an update of the app, it connects again by itself'
before="$(field connections)"
adb install -r "$apk" >/dev/null
wait_for "connections > $before && streams === 1" 'no connection after the app was updated' 60
send 33333333-3333-4333-8333-333333333333 'After update' 'Still here' '/'
expect_shown 'After update' 'after the update'

echo 'Signing out stops the connection and removes what was shown'
curl -s "$control/signout" >/dev/null
for _ in $(seq 1 30); do service_running || break; sleep 1; done
service_running && fail 'the connection service still runs after signing out'
expect_not_shown 'Reminder' 'after signing out'
expect_not_shown 'After update' 'after signing out'

echo 'Signing in again resumes it with a new registration'
curl -s "$control/signin" >/dev/null
adb shell am start -W -n "$package/.MainActivity" >/dev/null
# The page hands the app its new session cookie.
adb shell am start -W -a android.intent.action.VIEW -d "'$server/'" -n "$package/.MainActivity" >/dev/null || true
wait_for 'registrations === 2 && streams === 1' 'notifications did not resume after signing in again' 60
send 44444444-4444-4444-8444-444444444444 'Signed in again' 'Welcome back' '/'
expect_shown 'Signed in again' 'after signing in again'

expect_stopped() {
  for _ in $(seq 1 20); do service_running || break; sleep 1; done
  service_running && fail "the connection service still runs after $1"
  return 0
}
turned_off=0
if [[ "$bridge" == true ]]; then
  echo 'Turning it off from the page unregisters and stops the connection'
  curl -s "$control/ask?action=disable" >/dev/null
  wait_for 'unsubscribed.length === 1' 'turning off did not unregister'
  wait_for 'replies.some(r => r.ok && r.state.enabled === false)' 'the app did not answer "disable"'
  expect_stopped 'turning off from the page'
  turned_off=1
  curl -s "$control/ask?action=enable" >/dev/null
  wait_for 'registrations === 3 && streams === 1' 'turning on again from the page did not connect'
fi

echo "The ongoing notification's Turn off does the same"
adb shell cmd statusbar expand-notifications
sleep 1
expand_notification 'Connected to 10.0.2.2' 'Turn off'
tap_action_below 'Connected to 10.0.2.2' 'Turn off'
wait_for "unsubscribed.length === $((turned_off + 1))" 'Turn off did not unregister'
expect_stopped 'Turn off'
adb shell cmd statusbar collapse

if adb logcat -d -b crash | contains "Process: $package"; then fail 'the app crashed'; fi
echo 'Notifications test passed'
