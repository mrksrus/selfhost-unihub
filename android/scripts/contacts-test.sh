#!/usr/bin/env bash
# Shows that the app puts UniHub's contacts on the phone and keeps them in step,
# on a running emulator:
#
#   contacts-test.sh <unihub.apk> [<previous release's unihub.apk>]
#
# With the previous release's app, the test starts with that app and its
# contacts on the phone, then updates to <unihub.apk>.
#
# A stub server on this machine answers like UniHub (a session cookie,
# /api/auth/me and /api/contacts with synthetic contacts, which it also adds,
# changes and deletes like the real API). The app is connected, the contacts
# question is accepted, and the phone's own lookup (what the Phone app and
# WhatsApp use) must find the names. Then contacts change on the server and
# on the phone (as a contacts app would), another user signs in, the session
# ends, and the app moves to another server; both sides must follow each time. CI runs it on every
# emulator after window-test.sh (.github/workflows/docker-image.yml).
set -euo pipefail

apk="${1:?usage: contacts-test.sh <unihub.apk> [<previous unihub.apk>]}"
previous="${2:-}"
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
import json, os, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = sys.argv[2]
def read(name):
    with open(os.path.join(state, name)) as f:
        return f.read().strip()
lock = threading.Lock()
created = [0]
FIELDS = ('first_name', 'last_name', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'company', 'job_title', 'notes')

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
            # The marker a renewal changes; set once, so a page load that
            # answers after a renewal was written does not undo it.
            marker = [] if 'renewed' in sent else [('Set-Cookie', 'renewed=no; Path=/')]
            csrf = [] if 'csrf-token' in sent else [set_csrf]
            # The heartbeat hands the page a new session when the test changes
            # it, and moves the page to another address (/auth: signing in).
            script = 'setInterval(() => fetch("/heartbeat").then(r => r.text()).then(go => { if (go && go !== location.pathname) history.pushState({}, "", go) }), 1000)'
            self.answer(200, '<!doctype html><title>UniHub contacts test</title><p>UniHub<script>%s</script>' % script,
                        [('Content-Type', 'text/html')] + ([set_session] + csrf + marker if user else []))
        elif url.path == '/heartbeat':
            # A new CSRF token reaches the page once, as a rotation would.
            rotate = [set_csrf] if sent.get('csrf-token') != read('csrf') else []
            self.answer(200, read('goto'), [set_session] + rotate if user else [])
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

    # Writes like api/src/routes/contacts.ts: the CSRF cookie must match the
    # header, PUT replaces every field, a missing field becomes null.
    def write(self, method):
        url = urllib.parse.urlparse(self.path)
        sent = dict(c.split('=', 1) for c in (self.headers.get('Cookie') or '').split('; ') if '=' in c)
        session = 'auth-token=' + read('session')
        if read('user') == '' or session not in (self.headers.get('Cookie') or '').split('; '):
            return self.answer(401, json.dumps({'error': 'Unauthorized'}), [('Content-Type', 'application/json')])
        if not sent.get('csrf-token') or sent.get('csrf-token') != self.headers.get('X-CSRF-Token'):
            return self.answer(403, json.dumps({'error': 'CSRF token validation failed'}), [('Content-Type', 'application/json')])
        if read('mode') == 'write-error':
            return self.answer(500, json.dumps({'error': 'Failed'}), [('Content-Type', 'application/json')])
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        with lock:
            path = os.path.join(state, 'contacts.json')
            contacts = json.loads(read('contacts.json'))
            parts = url.path.split('/')
            if method == 'POST' and url.path == '/api/contacts':
                if not (body.get('first_name') or '').strip():
                    return self.answer(400, json.dumps({'error': 'First name is required'}), [('Content-Type', 'application/json')])
                created[0] += 1
                contact = {'id': 'n-%d' % created[0], 'user_id': 'u', 'avatar_url': None, 'is_favorite': 0}
                contact.update({k: body.get(k) or None for k in FIELDS})
                contacts.append(contact)
                answer = {'contact': contact}
            elif method == 'PUT' and len(parts) == 4:
                found = [c for c in contacts if c['id'] == parts[3]]
                for c in found:
                    c.update({k: body.get(k) or None for k in FIELDS})
                    c['first_name'] = (body.get('first_name') or '').strip()
                answer = {'contact': found[0]} if found else {}
            elif method == 'DELETE' and len(parts) == 4:
                contacts = [c for c in contacts if c['id'] != parts[3]]
                answer = {'message': 'Contact deleted'}
            else:
                return self.answer(404, json.dumps({'error': 'Not found'}))
            with open(path + '.tmp', 'w') as f:
                json.dump(contacts, f)
            os.replace(path + '.tmp', path)
        with open(os.path.join(state, 'writes'), 'a') as f:
            f.write('%s %s\n' % (method, url.path))
        self.answer(200, json.dumps(answer), [('Content-Type', 'application/json')])

    def do_POST(self): self.write('POST')
    def do_PUT(self): self.write('PUT')
    def do_DELETE(self): self.write('DELETE')

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
  adb logcat -d -s UniHubContacts UniHubSession >&2 || true
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

synced() { adb logcat -d -s UniHubContacts UniHubSession 2>/dev/null | grep -c 'Synced' || true; }

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

postponed() { adb logcat -d -s UniHubContacts UniHubSession 2>/dev/null | grep -c 'Sync postponed' || true; }

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

# ── The phone's side, as a contacts app changes it (no sync adapter flag) ──
contacts_uri=content://com.android.contacts
sync_now() { adb shell requestsync -n 10.0.2.2 -t "$package" -a com.android.contacts -f "$@" >/dev/null; }
first_id() { tr -d '\r' | sed -n 's/.*_id=\([0-9]*\).*/\1/p' | head -n 1; }

phone_add() { # given family number: a new contact in the UniHub account; prints its ID
  adb shell content insert --uri $contacts_uri/raw_contacts --bind account_type:s:$package --bind account_name:s:10.0.2.2
  local id
  id="$(adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND sourceid IS NULL AND deleted=0\"" --sort "\"_id DESC\"" | first_id)"
  [[ -n "$id" ]] || fail 'the new phone contact was not saved'
  # Row by row, so a sync can come in between: the number first, so the
  # contact can be recognised at every step (a contacts app saves all at once).
  phone_add_number "$id" "$3"
  [[ -n "$1$2" ]] && adb shell content insert --uri $contacts_uri/data --bind raw_contact_id:i:$id \
    --bind mimetype:s:vnd.android.cursor.item/name --bind data2:s:"$1" --bind data3:s:"$2"
  echo "$id"
}
phone_add_number() { # raw contact, number
  adb shell content insert --uri $contacts_uri/data --bind raw_contact_id:i:$1 \
    --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind data1:s:"'$2'" --bind data2:i:7
}
phone_add_email() { # raw contact, address
  adb shell content insert --uri $contacts_uri/data --bind raw_contact_id:i:$1 \
    --bind mimetype:s:vnd.android.cursor.item/email_v2 --bind data1:s:"$2" --bind data2:i:1
}
raw_for() { # the UniHub contact on the phone with this UniHub ID
  adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND sourceid='$1' AND deleted=0\"" | first_id
}
raws_for() { # how many phone contacts stand for this UniHub ID
  adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND sourceid='$1' AND deleted=0\"" 2>/dev/null | grep -c '^Row' || true
}
unlinked_rows() {
  adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND sourceid IS NULL AND deleted=0\"" 2>/dev/null | grep -c '^Row' || true
}
phone_set_family() { # raw contact, family name
  local data
  data="$(adb shell content query --uri $contacts_uri/data --projection _id \
    --where "\"raw_contact_id=$1 AND mimetype='vnd.android.cursor.item/name'\"" | first_id)"
  adb shell content update --uri $contacts_uri/data --bind data3:s:"$2" --where "_id=$data"
}
phone_delete() { adb shell content delete --uri $contacts_uri/raw_contacts --where "_id=$1"; }

# ── The server's side ──
# A Python expression over the server's contacts (`contacts`, and `by` ID).
server_check() {
  python3 -c 'import json, sys
contacts = json.load(open(sys.argv[1])); by = {c["id"]: c for c in contacts}
sys.exit(0 if eval(sys.argv[2]) else 1)' "$work/state/contacts.json" "$1"
}
expect_server() { # expression, what it means
  for i in $(seq 1 45); do
    server_check "$1" && return 0
    (( i % 10 == 0 )) && sync_now
    sleep 1
  done
  fail "UniHub does not have $2: $(cat "$work/state/contacts.json")"
}
server_edit() { # Python statements changing `contacts`
  python3 -c 'import json, sys
contacts = json.load(open(sys.argv[1])); by = {c["id"]: c for c in contacts}
exec(sys.argv[2])
json.dump(contacts, open(sys.argv[1], "w"))' "$work/state/contacts.json" "$1"
}

sdk="$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
echo "Android API $sdk"

fresh_install() { # apk
  adb uninstall "$package" >/dev/null 2>&1 || true
  # Android removes an earlier run's contacts shortly after its account.
  for _ in $(seq 1 30); do
    adb shell content query --uri content://com.android.contacts/raw_contacts --projection _id \
      --where "\"account_type='$package'\"" 2>/dev/null | grep -q '^Row' || break
    sleep 1
  done
  adb install "$1" >/dev/null
  # Android's own permission screen differs between versions; grant beforehand.
  adb shell pm grant "$package" android.permission.READ_CONTACTS
  adb shell pm grant "$package" android.permission.WRITE_CONTACTS
  adb logcat -c -b all
}

connect_and_accept() {
  adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
  tap_button 'Connect to 10.0.2.2?' android:id/button1
  tap_button 'Show UniHub contacts on this phone?' android:id/button1
  for _ in $(seq 1 20); do has_account && break; sleep 1; done
  has_account || fail 'no UniHub account after accepting'
  expect_name +15550100 'Ada Example' 'first sync'
  expect_name +15550101 'Ben Sample' 'first sync'
  [[ "$(unihub_rows)" == 2 ]] || fail "expected 2 UniHub contacts on the phone, found $(unihub_rows) (a contact with only a note has nothing to show)"
}

updated=
if [[ -n "$previous" ]]; then
  echo 'Connect with the previous release, then accept the question'
  fresh_install "$previous"
  connect_and_accept
  : > "$work/state/writes"
  if adb install -r "$apk" >/dev/null 2>&1; then
    echo 'Updating keeps the contacts and sends nothing back'
    updated=1
    back_to_app
    leave_app
    for _ in $(seq 1 40); do
      [[ "$(adb shell content query --uri content://com.android.contacts/raw_contacts --projection sync1 \
        --where "\"account_type='$package' AND deleted=0 AND sync1='2'\"" 2>/dev/null | grep -c '^Row' || true)" == 2 ]] && break
      sleep 1
    done
    [[ "$(unihub_rows)" == 2 && "$(unlinked_rows)" == 0 ]] || fail "after the update the phone has $(unihub_rows) UniHub contacts, $(unlinked_rows) unlinked"
    adb logcat -d -s UniHubContacts | grep -q 'Synced' || fail 'no sync after the update'
    [[ -s "$work/state/writes" ]] && fail "the update sent the read-only copies back to UniHub: $(cat "$work/state/writes")"
    expect_name +15550100 'Ada Example' 'after the update'
    back_to_app
  else
    # Phones only take an update with the same signature (pull requests from forks).
    echo 'Updating from the previous release: not run (the apps are signed differently)'
  fi
fi
if [[ -z "$updated" ]]; then
  echo 'Connect, then accept the question'
  fresh_install "$apk"
  connect_and_accept
fi
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

echo 'A contact added on the phone reaches UniHub'
set_server user-1 "$(contact c-ada '"Ada"' '"Changed"' '"+15550100"' '"ada@example.com"' null '"private note 7f3a"'),$(contact c-cy '"Cy"' '"Sample"' '"+15550102"' null null null)"
: > "$work/state/writes"
eve="$(phone_add Eve Phone +15550104)"
sync_now
expect_server 'any(c["first_name"] == "Eve" and c["last_name"] == "Phone" and c["phone"] == "+15550104" for c in contacts)' 'the contact added on the phone'
for _ in $(seq 1 20); do [[ "$(unlinked_rows)" == 0 ]] && break; sleep 1; done
[[ "$(unlinked_rows)" == 0 ]] || fail 'the added contact is not linked to its UniHub contact'
expect_name +15550104 'Eve Phone' 'added on the phone'
sleep 5
server_check 'len(contacts) == 3' || fail "the added contact reached UniHub more than once: $(cat "$work/state/contacts.json")"

echo 'An edit on the phone reaches UniHub and keeps the note'
ada="$(raw_for c-ada)"
[[ -n "$ada" ]] || fail 'no phone contact for Ada'
phone_set_family "$ada" Phoned
phone_add_number "$ada" '+1 555 0105'
sync_now
expect_server 'by["c-ada"]["last_name"] == "Phoned" and by["c-ada"]["phone2"] == "+1 555 0105" and by["c-ada"]["notes"] == "private note 7f3a"' "the phone's edit, with UniHub's note"
expect_name +15550100 'Ada Phoned' 'edited on the phone'

echo 'A deletion on the phone deletes in UniHub'
phone_delete "$(raw_for c-cy)"
sync_now
expect_server '"c-cy" not in by and len(contacts) == 2' 'Cy deleted'
expect_name +15550102 '' 'deleted on the phone'

echo 'A phone contact of someone already in UniHub joins them'
joined="$(phone_add Ada '' '+1 555-0100')"
phone_add_email "$joined" ada@example.org
sync_now
expect_server 'len(contacts) == 2 and by["c-ada"]["email2"] == "ada@example.org"' 'the address of the joined contact, and no duplicate'
for _ in $(seq 1 20); do [[ "$(raws_for c-ada)" == 2 ]] && break; sleep 1; done
[[ "$(raws_for c-ada)" == 2 ]] || fail "the joined phone contact is not linked to Ada ($(raws_for c-ada) linked)"

echo 'A change in UniHub reaches the phone and keeps what UniHub does not hold'
server_edit 'by["c-ada"]["first_name"] = "Adelaide"'
back_to_app
leave_app
expect_name +15550100 'Adelaide Phoned' 'renamed in UniHub after the phone added to it'
expect_name +15550105 'Adelaide Phoned' 'the number the phone added stays'

echo 'Many deletions on the phone wait for an answer'
many=""
for n in 10 11 12 13 14 15 16 17 18 19 20 21; do many+=",$(contact c-m$n '"Many"' "\"$n\"" "\"+155502$n\"" null null null)"; done
server_edit "contacts.extend(json.loads('[${many#,}]'))"
sync_now
expect_name +15550221 'Many 21' 'the many contacts arrived'
for n in 10 11 12 13 14 15 16 17 18 19 20 21; do phone_delete "$(raw_for c-m$n)"; done
before="$(adb logcat -d -s UniHubContacts | grep -c 'waiting for confirmation' || true)"
sync_now
for _ in $(seq 1 40); do (( $(adb logcat -d -s UniHubContacts | grep -c 'waiting for confirmation' || true) > before )) && break; sleep 1; done
(( $(adb logcat -d -s UniHubContacts | grep -c 'waiting for confirmation' || true) > before )) || fail 'deleting 12 contacts on the phone did not wait for an answer'
server_check 'len(contacts) == 14' || fail "contacts were deleted in UniHub without an answer: $(cat "$work/state/contacts.json")"
echo '  undo on the phone'
# What Android's "Too many deletions" notification does: one sync with the
# answer. Android may run a pending sync first, so ask until it ran.
for _ in $(seq 1 9); do
  sync_now --dd --ib --ex
  for _ in $(seq 1 10); do adb logcat -d -s UniHubContacts | grep -q 'Undoing 12 deletions' && break 2; sleep 1; done
done
expect_name +15550221 'Many 21' 'restored after undoing the deletions'
server_check 'len(contacts) == 14' || fail 'undoing the deletions changed UniHub'
for n in 10 11 12 13 14 15 16 17 18 19 20 21; do phone_delete "$(raw_for c-m$n)"; done
echo '  delete them after all'
for _ in $(seq 1 9); do
  sync_now --od --ib --ex
  for _ in $(seq 1 10); do server_check 'len(contacts) == 2' && break 2; sleep 1; done
done
expect_server 'len(contacts) == 2' 'the confirmed deletions'
expect_name +15550221 '' 'confirmed deletion'

echo 'Signing out keeps what the phone has not sent yet'
set_mode write-error
fay="$(phone_add Fay Pending +15550106)"
back_to_app
expect_postponed 'UniHub refuses writes'
set_server '' '[]'
back_to_app
leave_app
expect_name +15550100 '' 'signed out'
expect_name +15550106 'Fay Pending' 'not sent yet when the session ended'
set_server user-1 "$(contact c-ada '"Ada"' '"Again"' '"+15550100"' null null null)"
back_to_app
leave_app
expect_server 'any(c["first_name"] == "Fay" for c in contacts)' 'the contact kept over the sign-out'
expect_name +15550100 'Ada Again' 'signed in again'
grep -q '^POST' "$work/state/writes" || fail 'no contact was added in UniHub'

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
given="$(adb logcat -d -s UniHubContacts UniHubSession | grep -c 'renewal given' || true)"
# The sign-in answers with a new session cookie, then the page leaves /auth.
echo test-session-2 > "$work/state/session"
echo / > "$work/state/goto"
back_to_app
sleep 4
leave_app # the app keeps its cookies when it is left
sleep 3
(( $(adb logcat -d -s UniHubContacts UniHubSession | grep -c 'renewal given' || true) == given )) || fail 'a renewal was written while the page was signing in'
expect_page_cookie 'auth-token=test-session-2' 'the newer session'
adb logcat -d -s UniHubContacts UniHubSession | grep -q 'renewal dropped' || fail 'the kept renewal was not dropped for the newer session'
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
