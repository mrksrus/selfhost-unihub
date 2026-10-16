#!/usr/bin/env bash
# Shows that the app puts UniHub's contacts on the phone and keeps them in step,
# on a running emulator:
#
#   contacts-test.sh <unihub.apk>
#
# A stub server on this machine answers like UniHub (a session cookie,
# /api/auth/me and /api/contacts with synthetic contacts). The app is
# connected, the contacts question is accepted, and the phone's own lookup
# (what the Phone app and WhatsApp use) must find the names. Then contacts
# change on the server, another user signs in, the session ends, and the app
# moves to another server; the phone must follow each time. CI runs it on every
# emulator after window-test.sh (.github/workflows/docker-image.yml).
set -euo pipefail

apk="${1:?usage: contacts-test.sh <unihub.apk>}"
package=io.github.mrksrus.unihub
port=8097
server="http://10.0.2.2:$port"

work="$(mktemp -d)"
stub_pid=
cleanup() {
  [[ -n "$stub_pid" ]] && kill "$stub_pid" 2>/dev/null || true
  adb uninstall "$package" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# The stub reads the signed-in user and the contacts from files, so each step
# below changes the server by writing them.
cat > "$work/stub.py" <<'PY'
import json, os, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = sys.argv[2]
def read(name):
    with open(os.path.join(state, name)) as f:
        return f.read().strip()

class Stub(BaseHTTPRequestHandler):
    def answer(self, status, body, headers=()):
        data = body.encode()
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        user = read('user')
        session = 'auth-token=' + read('session')
        signed_in = user != '' and session in (self.headers.get('Cookie') or '').split('; ')
        set_session = ('Set-Cookie', session + '; HttpOnly; SameSite=Strict; Path=/')
        # Like servers up to 0.21.4, a page load (here also the heartbeat)
        # hands out the current CSRF cookie.
        set_csrf = ('Set-Cookie', 'csrf-token=%s; HttpOnly; SameSite=Strict; Path=/' % read('csrf'))
        sent = dict(c.split('=', 1) for c in (self.headers.get('Cookie') or '').split('; ') if '=' in c)
        if url.path in ('/', '/auth', '/heartbeat'):
            with open(os.path.join(state, 'page-cookies'), 'a') as f:
                f.write((self.headers.get('Cookie') or '') + '\n')
        if url.path in ('/', '/auth'):
            # The heartbeat hands the page a new session when the test changes
            # it, and moves the page to another address (/auth: signing in).
            script = 'setInterval(() => fetch("/heartbeat").then(r => r.text()).then(go => { if (go && go !== location.pathname) history.pushState({}, "", go) }), 1000)'
            self.answer(200, '<!doctype html><title>UniHub contacts test</title><p>UniHub<script>%s</script>' % script,
                        [('Content-Type', 'text/html')] + ([set_session, set_csrf, ('Set-Cookie', 'renewed=no; Path=/')] if user else []))
        elif url.path == '/heartbeat':
            self.answer(200, read('goto'), [set_session, set_csrf] if user else [])
        elif not url.path.startswith('/api/'):
            self.answer(404, 'not found')
        elif not signed_in:
            self.answer(401, json.dumps({'error': 'Unauthorized', 'status': 401}), [('Content-Type', 'application/json')])
        elif url.path == '/api/auth/me':
            # A renewed session: the same cookie again, and a marker to find
            # out whether the WebView got it.
            renew = read('renew')
            # The server sends the session and the request's CSRF cookie again.
            csrf = [('Set-Cookie', 'csrf-token=%s; HttpOnly; SameSite=Strict; Path=/' % sent['csrf-token'])] if 'csrf-token' in sent else []
            cookies = [set_session, ('Set-Cookie', 'renewed=%s; Path=/' % renew)] + csrf if renew else []
            self.answer(200, json.dumps({'user': {'id': user, 'email': 'tester@example.com'}}), [('Content-Type', 'application/json')] + cookies)
        elif url.path == '/api/contacts':
            contacts = json.loads(read('contacts.json'))
            limit, offset = int(query.get('limit', ['2000'])[0]), int(query.get('offset', ['0'])[0])
            page = contacts[offset:offset + limit]
            listing = {'contacts': page, 'has_more': offset + limit < len(contacts), 'offset': offset}
            mode = read('mode')
            if mode == 'error':
                self.answer(500, json.dumps({'error': 'Failed to get contacts'}), [('Content-Type', 'application/json')])
                return
            if mode == 'empty-more':
                listing = {'contacts': [], 'has_more': True, 'offset': offset}
            if mode == 'no-has-more':
                listing = {'contacts': page[:1], 'offset': offset}
            self.answer(200, json.dumps(listing), [('Content-Type', 'application/json')])
        else:
            self.answer(404, json.dumps({'error': 'Not found'}))

    def log_message(self, format, *args):
        sys.stderr.write('%s\n' % (format % args))

ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1])), Stub).serve_forever()
PY
mkdir "$work/state"
contact() { # id first last phone email company notes
  printf '{"id":"%s","user_id":"u","first_name":%s,"last_name":%s,"email":%s,"email2":null,"email3":null,"phone":%s,"phone2":null,"phone3":null,"company":%s,"job_title":null,"notes":%s,"avatar_url":null,"is_favorite":0}' \
    "$1" "$2" "$3" "$5" "$4" "$6" "$7"
}
echo test-session > "$work/state/session"
: > "$work/state/goto"
echo csrf-1 > "$work/state/csrf"
set_server() { echo "$1" > "$work/state/user"; printf '[%s]\n' "$2" > "$work/state/contacts.json"; : > "$work/state/mode"; : > "$work/state/renew"; }
# How /api/contacts misbehaves: error (HTTP 500), empty-more, no-has-more.
set_mode() { echo "$1" > "$work/state/mode"; }

set_server user-1 "$(contact c-ada '"Ada"' '"Example"' '"+15550100"' '"ada@example.com"' '"Example Labs"' '"private note 7f3a"'),$(contact c-ben '"Ben"' '"Sample"' '"+15550101"' null null null),$(contact c-notes null null null null null '"only a note"')"
python3 "$work/stub.py" "$port" "$work/state" 2>> "$work/stub.log" &
stub_pid=$!

fail() {
  echo "Contacts test failed: $1" >&2
  adb logcat -d -s UniHubContacts >&2 || true
  adb logcat -d -b crash >&2 || true
  exit 1
}

screen() {
  adb shell uiautomator dump /sdcard/contacts-test.xml >/dev/null 2>&1 || true
  adb shell cat /sdcard/contacts-test.xml 2>/dev/null || true
}

tap_button() { # resource id of a dialog button, waiting for the text first
  for _ in $(seq 1 30); do screen | grep -q "$1" && break; sleep 1; done
  local bounds x1 y1 x2 y2
  bounds="$(screen | grep -o "resource-id=\"$2\"[^>]*bounds=\"[^\"]*\"" | grep -o 'bounds="[^"]*"' | head -n 1 || true)"
  read -r x1 y1 x2 y2 <<<"$(sed 's/[^0-9]/ /g' <<<"$bounds")"
  [[ -n "${y2:-}" ]] || fail "no button next to \"$1\""
  adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

# What the Phone app shows for a number: the contact's name, or nothing.
name_for() {
  adb shell content query --uri "content://com.android.contacts/phone_lookup/$(sed 's/+/%2B/' <<<"$1")" --projection display_name 2>/dev/null \
    | tr -d '\r' | sed -n 's/.*display_name=\(.*\)$/\1/p' | sed 's/, [a-z_]*=.*$//' | head -n 1
}

expect_name() { # number name ("" for none)
  local found
  for _ in $(seq 1 40); do
    found="$(name_for "$1")"
    [[ "$found" == "$2" ]] && return 0
    sleep 1
  done
  fail "$1 shows \"$found\", expected \"$2\" ($3)"
}

unihub_rows() {
  adb shell content query --uri content://com.android.contacts/raw_contacts --projection _id \
    --where "\"account_type='$package' AND deleted=0\"" 2>/dev/null | grep -c '^Row' || true
}

has_account() { adb shell dumpsys account 2>/dev/null | grep -q "Account {name=[^,]*, type=$package}"; }

synced() { adb logcat -d -s UniHubContacts 2>/dev/null | grep -c 'Synced' || true; }

kill_app() { # Android only kills a cached process, so wait for the last sync to end.
  for _ in $(seq 1 15); do
    adb shell am kill "$package"
    sleep 2
    adb shell pidof "$package" >/dev/null || return 0
  done
  fail 'the app is still running'
}

# The page's next load sends the cookie the server renewed during a sync.
# A fresh start loads the page (a restored activity would not).
expect_page_cookie() {
  : > "$work/state/page-cookies"
  adb shell am force-stop "$package"
  back_to_app
  for _ in $(seq 1 30); do grep -q "$1" "$work/state/page-cookies" && return 0; sleep 1; done
  fail "the WebView did not get the renewed session cookie ($2): $(tr '\n' ' ' < "$work/state/page-cookies")"
}

postponed() { adb logcat -d -s UniHubContacts 2>/dev/null | grep -c 'Sync postponed' || true; }

# A sync that must not change anything: wait for it to give up.
expect_postponed() {
  local before="$(postponed)"
  leave_app
  for _ in $(seq 1 40); do (( $(postponed) > before )) && return 0; sleep 1; done
  fail "no sync gave up ($1)"
}

# Leaving the app asks for a sync.
leave_app() {
  adb shell input keyevent KEYCODE_HOME
  sleep 1
}
back_to_app() { adb shell am start -W -n "$package/.MainActivity" >/dev/null; sleep 2; }

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
echo "Android API $sdk"
adb uninstall "$package" >/dev/null 2>&1 || true
adb install "$apk" >/dev/null
# Android's own permission screen differs between versions; grant beforehand.
adb shell pm grant "$package" android.permission.READ_CONTACTS
adb shell pm grant "$package" android.permission.WRITE_CONTACTS
adb logcat -c -b all

echo 'Connect, then accept the question'
adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
tap_button 'Connect to 10.0.2.2?' android:id/button1
tap_button 'Show UniHub contacts on this phone?' android:id/button1
for _ in $(seq 1 20); do has_account && break; sleep 1; done
has_account || fail 'no UniHub account after accepting'
expect_name +15550100 'Ada Example' 'first sync'
expect_name +15550101 'Ben Sample' 'first sync'
[[ "$(unihub_rows)" == 2 ]] || fail "expected 2 UniHub contacts on the phone, found $(unihub_rows) (a contact with only a note has nothing to show)"
if adb shell content query --uri content://com.android.contacts/data --projection data1 \
    --where "\"data1 LIKE '%7f3a%'\"" 2>/dev/null | grep -q '^Row'; then
  fail 'a note reached the phone'
fi

echo 'Changes on the server reach the phone'
set_server user-1 "$(contact c-ada '"Ada"' '"Changed"' '"+15550100"' '"ada@example.com"' null null),$(contact c-cy '"Cy"' '"Sample"' '"+15550102"' null null null)"
leave_app
expect_name +15550100 'Ada Changed' 'renamed'
expect_name +15550101 '' 'deleted on the server'
expect_name +15550102 'Cy Sample' 'added on the server'

echo 'A failed or incomplete listing keeps the copy'
for mode in error empty-more no-has-more; do
  set_mode "$mode"
  back_to_app
  expect_postponed "$mode"
  expect_name +15550100 'Ada Changed' "after $mode"
  expect_name +15550102 'Cy Sample' "after $mode"
done
set_mode ''

echo 'A sync from Android with the app closed (the periodic one) renews the session'
kill_app
set_server user-1 "$(contact c-ada '"Ada"' '"Later"' '"+15550100"' null null null),$(contact c-cy '"Cy"' '"Sample"' '"+15550102"' null null null)"
echo closed > "$work/state/renew"
adb shell requestsync -n 10.0.2.2 -t "$package" -a com.android.contacts -f >/dev/null
expect_name +15550100 'Ada Later' 'synced without the app open'
expect_page_cookie 'renewed=closed' 'sync with the app closed'

echo 'A renewal while the app is open reaches the WebView'
echo open > "$work/state/renew"
before="$(synced)"
leave_app
for _ in $(seq 1 40); do (( $(synced) > before )) && break; sleep 1; done
(( $(synced) > before )) || fail 'no sync after leaving the app'
kill_app
: > "$work/state/renew"
expect_page_cookie 'renewed=open' 'sync with the WebView alive'

echo 'A renewal waits while the page signs in, and never replaces the new session'
echo /auth > "$work/state/goto"
back_to_app
sleep 4
echo stale > "$work/state/renew"
before="$(synced)"
leave_app
for _ in $(seq 1 40); do (( $(synced) > before )) && break; sleep 1; done
(( $(synced) > before )) || fail 'no sync after leaving the app'
: > "$work/state/renew"
given="$(adb logcat -d -s UniHubContacts | grep -c 'renewal given' || true)"
# The sign-in answers with a new session cookie, then the page leaves /auth.
echo test-session-2 > "$work/state/session"
echo / > "$work/state/goto"
back_to_app
sleep 4
leave_app # the app keeps its cookies when it is left
sleep 3
(( $(adb logcat -d -s UniHubContacts | grep -c 'renewal given' || true) == given )) || fail 'a renewal was written while the page was signing in'
expect_page_cookie 'auth-token=test-session-2' 'the newer session'
adb logcat -d -s UniHubContacts | grep -q 'renewal dropped' || fail 'the kept renewal was not dropped for the newer session'
grep -q 'renewed=stale' "$work/state/page-cookies" && fail 'the kept renewal replaced the newer session'
expect_name +15550100 'Ada Later' 'sync with the newer session'

echo 'A held renewal keeps a CSRF cookie the page got since'
echo /auth > "$work/state/goto"
back_to_app
sleep 4
echo held > "$work/state/renew"
before="$(synced)"
leave_app
for _ in $(seq 1 40); do (( $(synced) > before )) && break; sleep 1; done
(( $(synced) > before )) || fail 'no sync after leaving the app'
: > "$work/state/renew"
# The page loads again and gets a new CSRF cookie, then leaves /auth.
echo csrf-2 > "$work/state/csrf"
echo / > "$work/state/goto"
back_to_app
sleep 4
leave_app
sleep 2
: > "$work/state/page-cookies"
adb shell am force-stop "$package"
back_to_app
for _ in $(seq 1 30); do grep 'renewed=held' "$work/state/page-cookies" | grep -q 'csrf-token=csrf-2' && break; sleep 1; done
grep 'renewed=held' "$work/state/page-cookies" | grep -q 'csrf-token=csrf-2' \
  || fail "the renewal was not applied with the page's newer CSRF cookie: $(tail -n 3 "$work/state/page-cookies" | tr '\n' ' ')"
grep -q 'csrf-token=csrf-1' "$work/state/page-cookies" && fail 'the renewal brought back an older CSRF cookie'
echo / > "$work/state/goto"

echo 'Another user signs in: only their contacts, even if their listing fails'
set_server user-2 "$(contact c-dee '"Dee"' '"Other"' '"+15550103"' null null null)"
set_mode error
back_to_app
expect_postponed 'second user, listing fails'
expect_name +15550100 '' 'first user after the second signed in'
[[ "$(unihub_rows)" == 0 ]] || fail "the first user's contacts stayed while the second user's listing failed"
set_mode ''
back_to_app
leave_app
expect_name +15550103 'Dee Other' 'second user'
[[ "$(unihub_rows)" == 1 ]] || fail "expected only the second user's contact, found $(unihub_rows)"

echo 'The session ends: the phone keeps none'
set_server '' '[]'
back_to_app
leave_app
expect_name +15550103 '' 'signed out'
for _ in $(seq 1 20); do [[ "$(unihub_rows)" == 0 ]] && break; sleep 1; done
[[ "$(unihub_rows)" == 0 ]] || fail 'contacts stayed after the session ended'
has_account || fail 'the account should stay, so contacts come back after signing in'

echo 'Signing in again brings them back'
set_server user-2 "$(contact c-dee '"Dee"' '"Other"' '"+15550103"' null null null)"
back_to_app
leave_app
expect_name +15550103 'Dee Other' 'signed in again'

echo 'Another server: the account and its contacts go'
back_to_app
adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=http://localhost:$port'" >/dev/null
tap_button 'Connect to localhost?' android:id/button1
for _ in $(seq 1 20); do has_account || break; sleep 1; done
has_account && fail 'the account stayed after moving to another server'
expect_name +15550103 '' 'moved to another server'

if adb logcat -d -b crash | grep -q "Process: $package"; then fail 'the app crashed'; fi
echo 'Contacts reach the phone and follow UniHub.'
