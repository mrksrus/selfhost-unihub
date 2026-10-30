#!/usr/bin/env bash
# Shows that the app puts UniHub's contacts on the phone and keeps them in step,
# on a running emulator:
#
#   contacts-test.sh <unihub.apk> [<previous release's unihub.apk>]
#
# CONTACTS_TEST_PART=full runs only the part with the full model (for local runs).
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
# ends, and the app moves to another server; both sides must follow each time.
#
# Then the same with the full contact model (servers listing contacts-vcard,
# 0.26.0 on): the stub server upgrades under contacts synced with the 3+3
# fields (by the previous release's app, when given), and the phone's own
# data must reach it without duplicates; every kind and label goes both
# ways, photos come to the phone, merges in UniHub (twelve at once) leave the
# phone without "too many deletions", and an edit in UniHub during a sync is
# not overwritten. CI runs it on every emulator after window-test.sh
# (.github/workflows/docker-image.yml).
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

# The full contact model as the stub keeps it (api/src/contracts/contacts.ts):
# the server's fields plus the 3+3 projection it keeps answering.
cat > "$work/model.py" <<'PY'
import itertools, re
LISTS = ('emails', 'phones', 'addresses', 'urls', 'impp', 'related', 'nicknames')
FULL_KEYS = ('version', 'name', 'organization', 'birthday', 'anniversary', 'kept_properties', 'categories') + LISTS
_ids = itertools.count(1)

def project(c):
    name = c['name']
    c['first_name'] = name.get('given') or ('' if name.get('family') else name.get('display')) or ''
    c['last_name'] = name.get('family')
    c['company'] = c['organization'].get('name')
    for kind, slots in (('emails', ('email', 'email2', 'email3')), ('phones', ('phone', 'phone2', 'phone3'))):
        for i, slot in enumerate(slots):
            c[slot] = c[kind][i]['value'] if i < len(c[kind]) else None
    return c

def values(kind, items, old, prefix):
    known = {v['id'] for v in old}
    out = []
    for item in items or []:
        v = dict({'value': item} if isinstance(item, str) else item)
        if v.get('id') not in known:
            v['id'] = '%s-%d' % (prefix, next(_ids))
        if kind == 'addresses':
            city = ' '.join(p for p in (v.get('postal_code'), v.get('locality')) if p)
            v['value'] = '\n'.join(p for p in (v.get('po_box'), v.get('extended'), v.get('street'), city, v.get('region'), v.get('country')) if p)
        v.setdefault('label', '')
        v.setdefault('custom_label', None)
        v.setdefault('preferred', False)
        out.append(v)
    return out

def date(v):
    if not v or isinstance(v, dict):
        return v or None
    m = re.match(r'^(?:(\d{4})|-)-(\d{2})-(\d{2})$', v)
    return {'year': int(m.group(1)) if m.group(1) else None, 'month': int(m.group(2)), 'day': int(m.group(3))}

def write(c, body, prefix='v'):
    """A full write: the body replaces the content; the favourite stays unless given."""
    c['name'] = {k: (body.get('name') or {}).get(k) for k in ('display', 'given', 'family', 'middle', 'prefix', 'suffix')}
    c['organization'] = {k: (body.get('organization') or {}).get(k) for k in ('name', 'department')}
    c['job_title'] = body.get('job_title')
    c['notes'] = body.get('notes')
    c['birthday'] = date(body.get('birthday'))
    c['anniversary'] = date(body.get('anniversary'))
    if 'is_favorite' in body:
        c['is_favorite'] = body['is_favorite']
    c['categories'] = body.get('categories') or []
    for kind in LISTS:
        c[kind] = values(kind, body.get(kind), c.get(kind) or [], prefix)
    c['version'] = c.get('version', 0) + 1
    c.setdefault('photo', None)
    return project(c)

def upgrade(c):
    """A 3+3 contact as the server's upgrade (step 22) turns it into the full model."""
    if 'version' in c:
        return c
    body = {'name': {'given': c.get('first_name') or None, 'family': c.get('last_name')},
            'organization': {'name': c.get('company')}, 'job_title': c.get('job_title'), 'notes': c.get('notes'),
            'emails': [c[k] for k in ('email', 'email2', 'email3') if c.get(k)],
            'phones': [c[k] for k in ('phone', 'phone2', 'phone3') if c.get(k)]}
    c['version'] = 0
    return write(c, body, 'm')
PY

# The stub reads the signed-in user and the contacts from files, so each step
# below changes the server by writing them. With "1" in the file full, it is
# a server with the full model.
cat > "$work/stub.py" <<'PY'
import hashlib, json, os, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model

state = sys.argv[2]
def read(name):
    with open(os.path.join(state, name)) as f:
        return f.read().strip()
lock = threading.Lock()
created = [0]
FIELDS = ('first_name', 'last_name', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'company', 'job_title', 'notes')
def full(): return read('full') == '1'

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
        elif url.path == '/api/version' and full():
            self.answer(200, json.dumps({'app': 'unihub', 'server': '0.26.0', 'protocol': 1, 'minApp': '0.21.0', 'features': ['contacts-vcard'], 'android': None}),
                        [('Content-Type', 'application/json')])
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
            if full() and 'merged' in query.get('include', [''])[0].split(','):
                listing['merged'] = json.loads(read('merged.json'))
            self.answer(200, json.dumps(listing), [('Content-Type', 'application/json')])
        elif full() and url.path.startswith('/api/contacts/') and url.path.endswith('/photo'):
            path = os.path.join(state, 'photos', url.path.split('/')[3])
            if not os.path.exists(path):
                return self.answer(404, json.dumps({'error': 'This contact has no photo', 'code': 'PHOTO_NOT_FOUND'}), [('Content-Type', 'application/json')])
            with open(path, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
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
        raw = self.rfile.read(length) if length else b''
        parts = url.path.split('/')
        photo = full() and len(parts) == 5 and parts[4] == 'photo'
        body = {} if photo else json.loads(raw or b'{}')
        with open(os.path.join(state, 'bodies'), 'a') as f:
            f.write(json.dumps({'method': method, 'path': url.path, 'body': body}) + '\n')
        with lock:
            path = os.path.join(state, 'contacts.json')
            contacts = json.loads(read('contacts.json'))
            if full():
                answer = self.write_full(method, url, parts, body, raw, contacts)
                if answer is None:
                    return
            elif method == 'POST' and url.path == '/api/contacts':
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

    # Like the contacts API with the full model: a 3+3 body is refused (the
    # app must not send one there), a PUT needs the current version, and the
    # contact named in the file conflict changes in UniHub during its write.
    def write_full(self, method, url, parts, body, raw, contacts):
        json_type = [('Content-Type', 'application/json')]
        if len(parts) == 5 and parts[4] == 'photo':
            found = [c for c in contacts if c['id'] == parts[3]]
            if not found:
                self.answer(404, json.dumps({'error': 'Contact not found'}), json_type)
                return None
            target = os.path.join(state, 'photos', parts[3])
            if method == 'PUT':
                with open(target, 'wb') as f:
                    f.write(raw)
                found[0]['photo'] = {'etag': hashlib.sha256(raw).hexdigest(), 'width': 512, 'height': 512}
            elif os.path.exists(target):
                os.remove(target)
                found[0]['photo'] = None
            found[0]['version'] += 1
            return {'contact': found[0]}
        if method in ('POST', 'PUT') and not any(k in body for k in model.FULL_KEYS):
            self.answer(400, json.dumps({'error': 'A 3+3 body sent to a server with the full model'}), json_type)
            return None
        if method == 'POST' and url.path == '/api/contacts':
            created[0] += 1
            contact = model.write({'id': 'n-%d' % created[0], 'is_favorite': False, 'photo': None}, body)
            contacts.append(contact)
            return {'contact': contact}
        if method == 'PUT' and len(parts) == 4:
            found = [c for c in contacts if c['id'] == parts[3]]
            if not found:
                self.answer(404, json.dumps({'error': 'Contact not found'}), json_type)
                return None
            contact = found[0]
            if read('conflict') == contact['id']:
                open(os.path.join(state, 'conflict'), 'w').close()
                contact['job_title'] = 'Changed in UniHub'
                contact['version'] += 1
                self.save(contacts)
            if body.get('version') != contact['version']:
                self.answer(409, json.dumps({'error': 'This contact was changed meanwhile', 'code': 'VERSION_CONFLICT', 'contact': contact}), json_type)
                return None
            model.write(contact, body)
            return {'contact': contact}
        if method == 'DELETE' and len(parts) == 4:
            contacts[:] = [c for c in contacts if c['id'] != parts[3]]
            return {'message': 'Contact deleted'}
        self.answer(404, json.dumps({'error': 'Not found'}))
        return None

    def save(self, contacts):
        path = os.path.join(state, 'contacts.json')
        with open(path + '.tmp', 'w') as f:
            json.dump(contacts, f)
        os.replace(path + '.tmp', path)

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
: > "$work/state/full"
: > "$work/state/conflict"
echo '[]' > "$work/state/merged.json"
mkdir "$work/state/photos"
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
  for _ in $(seq 1 60); do screen | grep -q "$1" && break; sleep 1; done
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

# Waits until no sync has finished for a while: a step whose two edits must
# meet in one sync must not have a sync asked for earlier run between them.
settle() {
  local before
  for _ in $(seq 1 20); do
    before="$(synced)"
    sleep 8
    [[ "$(synced)" == "$before" ]] && return 0
  done
}

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
owned_rows() { # UniHub's contacts of this user on the phone
  adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND sync4='$1' AND sourceid IS NOT NULL AND deleted=0\"" 2>/dev/null | grep -c '^Row' || true
}
phone_data_count() { # raw contact, mimetype
  adb shell content query --uri $contacts_uri/data --projection _id \
    --where "\"raw_contact_id=$1 AND mimetype='$2'\"" 2>/dev/null | grep -c '^Row' || true
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
if [[ "${CONTACTS_TEST_PART:-}" == full ]]; then
  updated="${previous:+1}"
else
if [[ -n "$previous" ]]; then
  echo 'Connect with the previous release, then accept the question'
  fresh_install "$previous"
  connect_and_accept
  : > "$work/state/writes"
  if adb install -r "$apk" >/dev/null 2>&1; then
    echo 'Updating keeps the contacts and sends nothing back'
    updated=1
    adb logcat -c -b all
    back_to_app
    leave_app
    converted() {
      adb shell content query --uri content://com.android.contacts/raw_contacts --projection sync1 \
        --where "\"account_type='$package' AND deleted=0 AND sync1='2'\"" 2>/dev/null | grep -c '^Row' || true
    }
    for _ in $(seq 1 40); do [[ "$(converted)" == 2 ]] && break; sleep 1; done
    [[ "$(converted)" == 2 ]] || fail "the update did not take over the previous app's contacts ($(converted) of 2)"
    [[ "$(unihub_rows)" == 2 && "$(unlinked_rows)" == 0 ]] || fail "after the update the phone has $(unihub_rows) UniHub contacts, $(unlinked_rows) unlinked"
    # This version's log line names what went to UniHub; the previous one's does not.
    adb logcat -d -s UniHubContacts | grep -q 'Synced.*to UniHub' || fail 'no sync by the updated app'
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

echo 'A contact deleted on the phone comes back when UniHub changed its note'
eve_id="$(python3 -c 'import json, sys; print([c["id"] for c in json.load(open(sys.argv[1])) if c["first_name"] == "Eve"][0])' "$work/state/contacts.json")"
settle
server_edit "by['$eve_id']['notes'] = 'a note written meanwhile'"
phone_delete "$(raw_for "$eve_id")"
sync_now
expect_name +15550104 'Eve Phone' 'deleted on the phone after its note changed in UniHub'
server_check "by['$eve_id']['notes'] == 'a note written meanwhile'" || fail 'the contact with the newer note was deleted in UniHub'
eve="$(raw_for "$eve_id")"
[[ -n "$eve" ]] || fail 'Eve was not brought back'
(( $(phone_data_count "$eve" vnd.android.cursor.item/phone_v2) == 1 )) || fail "bringing Eve back duplicated her number ($(phone_data_count "$eve" vnd.android.cursor.item/phone_v2))"

echo 'Signing out keeps what the phone has not sent yet, and what UniHub does not hold'
adb shell content insert --uri $contacts_uri/data --bind raw_contact_id:i:$eve \
  --bind mimetype:s:vnd.android.cursor.item/postal-address_v2 --bind data1:s:"'1 Example Street'"
server_edit "contacts.append(json.loads('$(contact c-zed '"Zed"' '"Copy"' '"+15550108"' null null null)'))"
sync_now
expect_name +15550108 'Zed Copy' 'a contact only UniHub changed'
sleep 5
set_mode write-error
fay="$(phone_add Fay Pending +15550106)"
back_to_app
expect_postponed 'UniHub refuses writes'
cp "$work/state/contacts.json" "$work/state/before-sign-out.json"
set_server '' '[]'
back_to_app
leave_app
expect_name +15550108 '' 'signed out'
expect_name +15550106 'Fay Pending' 'not sent yet when the session ended'
expect_name +15550104 'Eve Phone' 'with a postal address only the phone holds'
# Ada's phone contacts carry labels chosen on the phone ("Other", "Home").
expect_name +15550100 'Adelaide Phoned' 'with labels only the phone holds'
echo user-1 > "$work/state/user"
cp "$work/state/before-sign-out.json" "$work/state/contacts.json"
server_edit 'by["c-ada"]["last_name"] = "Again"'
back_to_app
leave_app
expect_server 'any(c["first_name"] == "Fay" for c in contacts)' 'the contact kept over the sign-out'
expect_name +15550100 'Adelaide Again' 'signed in again'
expect_name +15550108 'Zed Copy' 'back after signing in again'
grep -q '^POST' "$work/state/writes" || fail 'no contact was added in UniHub'
[[ "$(raws_for c-ada)" == 2 ]] || fail "Ada is on the phone $(raws_for c-ada) times after signing in again, expected her 2 phone contacts"
for _ in $(seq 1 20); do [[ "$(raws_for "$eve_id")" == 1 ]] && break; sleep 1; done
[[ "$(raws_for "$eve_id")" == 1 ]] || fail "Eve is on the phone $(raws_for "$eve_id") times after signing in again"
(( $(phone_data_count "$eve" vnd.android.cursor.item/postal-address_v2) == 1 )) || fail "Eve's postal address was lost"

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

echo "Another user signs in: only their contacts, even if their listing fails, and never the first user's"
set_mode write-error
phone_add Gus Pending +15550107 >/dev/null
back_to_app
expect_postponed 'the first user has a contact not yet sent'
set_server user-2 "$(contact c-dee '"Dee"' '"Other"' '"+15550103"' null null null)"
set_mode error
back_to_app
expect_postponed 'second user, listing fails'
expect_name +15550102 '' "the first user's copy after the second signed in"
# Ada's phone contacts carry labels only the phone holds: they stay, as the first user's.
expect_name +15550100 'Ada Later' "the first user's contact with the phone's own labels"
set_mode ''
back_to_app
leave_app
expect_name +15550103 'Dee Other' 'second user'
[[ "$(owned_rows user-2)" == 1 ]] || fail "expected one contact of the second user, found $(owned_rows user-2)"
sleep 5
server_check 'not any(c["first_name"] == "Gus" for c in contacts)' || fail "the first user's contact went to the second user"
expect_name +15550107 'Gus Pending' "the first user's contact not yet sent stays on the phone"

echo "The session ends: the phone keeps none of the user's copies"
set_server '' '[]'
back_to_app
leave_app
expect_name +15550103 '' 'signed out'
for _ in $(seq 1 20); do [[ "$(owned_rows user-2)" == 0 ]] && break; sleep 1; done
[[ "$(owned_rows user-2)" == 0 ]] || fail "UniHub's contacts stayed after the session ended"
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
fi

# ── The full contact model (servers listing contacts-vcard, 0.26.0 on) ──
set_full() { echo "$1" > "$work/state/full"; }
# Python statements changing `contacts` (full model); a changed contact gets
# its next version and its 3+3 projection, as the server writes it.
server_edit_full() {
  python3 -c 'import json, sys
sys.path.insert(0, sys.argv[3]); import model
contacts = json.load(open(sys.argv[1])); by = {c["id"]: c for c in contacts}
before = {c["id"]: json.dumps(c, sort_keys=True) for c in contacts}
exec(sys.argv[2])
for c in contacts:
    if before.get(c["id"]) != json.dumps(c, sort_keys=True):
        c["version"] = c.get("version", 0) + 1
        model.project(c)
json.dump(contacts, open(sys.argv[1], "w"))' "$work/state/contacts.json" "$1" "$work"
}
# The phone's data rows of a raw contact, as dicts in `rows`, checked by a Python expression.
phone_check() { # raw contact, expression
  adb shell content query --uri $contacts_uri/data \
    --projection mimetype:data1:data2:data3:data4:data5:data6:data7:data9:data14:is_primary \
    --where "\"raw_contact_id=$1\"" 2>/dev/null | tr -d '\r' | python3 -c 'import re, sys
text = sys.stdin.read()
rows = []
for chunk in re.split(r"(?m)^Row: \d+ ", text)[1:]:
    parts = re.split(r"(?:^|, )(mimetype|data\d+|is_primary)=", chunk.rstrip("\n"))
    row = dict(zip(parts[1::2], parts[2::2]))
    row["mime"] = row.get("mimetype", "").rsplit("/", 1)[-1]
    rows.append(row)
of = lambda mime: [r for r in rows if r["mime"] == mime]
sys.exit(0 if eval(sys.argv[1]) else 1)' "$2"
}
expect_phone() { # raw contact, expression, what it means
  for i in $(seq 1 45); do
    phone_check "$1" "$2" && return 0
    (( i % 10 == 0 )) && sync_now
    sleep 1
  done
  adb shell content query --uri $contacts_uri/data --projection mimetype:data1:data2:data3 --where "\"raw_contact_id=$1\"" >&2 || true
  fail "the phone does not have $3"
}
phone_insert() { # raw contact, mimetype (short), --bind arguments
  local raw="$1" mime="$2"; shift 2
  adb shell content insert --uri $contacts_uri/data --bind raw_contact_id:i:$raw --bind mimetype:s:vnd.android.cursor.item/$mime "$@"
}
data_id() { # raw contact, mimetype (short), data1
  adb shell content query --uri $contacts_uri/data --projection _id \
    --where "\"raw_contact_id=$1 AND mimetype='vnd.android.cursor.item/$2' AND data1='$3'\"" | first_id
}
full_rows() {
  adb shell content query --uri $contacts_uri/raw_contacts --projection _id \
    --where "\"account_type='$package' AND deleted=0 AND sync1='3'\"" 2>/dev/null | grep -c '^Row' || true
}
waiting_count() { adb logcat -d -s UniHubContacts | grep -c 'waiting for confirmation' || true; }
flat3() { # id first last phone1 phone2 phone3 email notes
  printf '{"id":"%s","user_id":"u","first_name":"%s","last_name":"%s","phone":"%s","phone2":"%s","phone3":"%s","email":"%s","email2":null,"email3":null,"company":"Example Labs","job_title":null,"notes":"%s","avatar_url":null,"is_favorite":0}' "$@"
}
# A small synthetic picture (a 128 px gradient).
photo_b64='/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCACAAIADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAQIFBv/EABUQAQEAAAAAAAAAAAAAAAAAAAEA/8QAGQEBAQEBAQEAAAAAAAAAAAAAAwIBBgQF/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIRAxEAPwDmgkJCoLqtfNlSFQSFQU6WVIVBIVBZpZUhUEhUFOklSFQSFQWaWVIVBIVBTpJUhUEhUFOllSFQSEhZpJWYFQSFQXo1zkqQqCQqCnSSpCoJCoLNLKkKgkJCnSSgKgkJCnSygJCoJCzSSgJCoJCnSygJCoJCzSyswKgkJC9GublASFQSFOklASFQSFmllASFQSFOklASFQSFmllASFQSFOllASFQSFOklASFQSFmllZgSFQSF6Nc3KAkKgkKdLKAkKgkLNJKAkKgkKdLKAkKgkKdJKAkJCoLNLKAkJCoKdJKkKgkKgs0srMCQqCQvRrm5QEhIVBTpZQEhIVBZpJUhUEhUFOllSFQSFQU6SVIVBIVBZpZUhUEhUFOllSFQSFQWaSVlhUEhUF6Nc3KkKgkKgp0sqQqCQqCzSSpCoJCoKdLKkKgkKgp0sqQqCQqCzSSpCoJCQp0soCoJCQs0krMCoJCoL0a5uVIVBIVBTpZUhUEhIU6WUBUEhIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBIVBIWaSVmBIVBIT65yUBIVBIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBISFQWaWV//Z'

echo 'The full model: a server upgrading under contacts the 3+3 sync linked'
set_full ''
: > "$work/state/conflict"
echo '[]' > "$work/state/merged.json"
set_server user-1 "$(flat3 c-ada Ada Example +15550100 +15550101 +15550102 ada@example.com 'private note 7f3a'),$(flat3 c-ben Ben Sample +15550110 +15550111 +15550112 ben@example.com '')"
connect_full() {
  adb shell am start -W -a android.intent.action.VIEW -d "'unihub://connect?server=$server'" >/dev/null
  tap_button 'Connect to 10.0.2.2?' android:id/button1
  tap_button 'Show UniHub contacts on this phone?' android:id/button1
  for _ in $(seq 1 20); do has_account && break; sleep 1; done
  has_account || fail 'no UniHub account after accepting'
  expect_name +15550100 'Ada Example' 'first sync, 3+3'
  expect_name +15550110 'Ben Sample' 'first sync, 3+3'
}
if [[ -n "$updated" ]]; then
  echo '  with the previous release'
  fresh_install "$previous"
else
  fresh_install "$apk"
fi
connect_full
ada="$(raw_for c-ada)"
[[ -n "$ada" ]] || fail 'no phone contact for Ada'
# What the 3+3 sync keeps as the phone's own: a fourth number with its label,
# an address, a birthday, a middle name, a web address, the phone's note.
phone_insert "$ada" phone_v2 --bind data1:s:"'+1 555 0113'" --bind data2:i:3
phone_insert "$ada" postal-address_v2 --bind data4:s:"'1 Example Street'" --bind data7:s:Springfield --bind data2:i:1
phone_insert "$ada" contact_event --bind data1:s:--12-10 --bind data2:i:3
# content splits a binding at every colon that has no backslash before it.
phone_insert "$ada" website --bind data1:s:"'https\://example.com/ada'" --bind data2:i:1
phone_insert "$ada" note --bind data1:s:"'a note of the phone 5c2e'"
adb shell content update --uri $contacts_uri/data --bind data5:s:M. --where "\"raw_contact_id=$ada AND mimetype='vnd.android.cursor.item/name'\""
sync_now
sleep 8
server_check 'by["c-ada"]["phone3"] == "+15550102" and len(contacts) == 2' || fail "the 3+3 sync changed UniHub: $(cat "$work/state/contacts.json")"
if [[ -n "$updated" ]]; then
  adb install -r "$apk" >/dev/null || fail 'the update did not install'
  adb logcat -c -b all
fi
# The server upgrades (step 22), and a 0.25-era merge in UniHub already gave
# Ada the phone's fourth number, written differently.
python3 -c 'import json, sys
sys.path.insert(0, sys.argv[2]); import model
contacts = [model.upgrade(c) for c in json.load(open(sys.argv[1]))]
for c in contacts:
    if c["id"] == "c-ada":
        c["phones"].append({"id": "m-0113", "value": "+1 (555) 0113", "label": "", "custom_label": None, "preferred": False})
json.dump(contacts, open(sys.argv[1], "w"))' "$work/state/contacts.json" "$work"
: > "$work/state/writes"
: > "$work/state/bodies"
set_full 1
back_to_app
leave_app
sync_now
expect_server 'by["c-ada"]["name"]["middle"] == "M." and by["c-ada"]["birthday"] == {"year": None, "month": 12, "day": 10}' "Ada's middle name and birthday from the phone"
expect_server '[a["street"] for a in by["c-ada"]["addresses"]] == ["1 Example Street"] and [u["label"] for u in by["c-ada"]["urls"]] == ["homepage"]' "Ada's address and web address from the phone"
server_check 'sorted(p["value"] for p in by["c-ada"]["phones"]) == ["+1 (555) 0113", "+15550100", "+15550101", "+15550102"]' \
  || fail "Ada's numbers are not the four she has, once each: $(cat "$work/state/contacts.json")"
server_check '[p["label"] for p in by["c-ada"]["phones"] if p["id"] == "m-0113"] == ["work"]' || fail "the phone's label of the fourth number did not reach UniHub"
server_check 'by["c-ada"]["notes"] == "private note 7f3a" and len(contacts) == 2' || fail "UniHub's note or contacts changed: $(cat "$work/state/contacts.json")"
grep -q '5c2e' "$work/state/bodies" && fail "the phone's own note was sent to UniHub"
grep -q '"first_name"' "$work/state/bodies" && fail 'a 3+3 body was sent to a server with the full model'
grep -q 'c-ben' "$work/state/writes" && fail "Ben was written although neither side changed him: $(cat "$work/state/writes")"
for _ in $(seq 1 20); do [[ "$(full_rows)" == 2 ]] && break; sleep 1; done
[[ "$(full_rows)" == 2 && "$(unihub_rows)" == 2 && "$(unlinked_rows)" == 0 ]] || fail "after the upgrade: $(full_rows) in the full format, $(unihub_rows) UniHub contacts, $(unlinked_rows) unlinked"
expect_phone "$ada" 'len(of("phone_v2")) == 4 and len(of("postal-address_v2")) == 1' 'four numbers and one address for Ada, none twice'
grep -q '^POST' "$work/state/writes" && fail "the upgrade added a contact in UniHub: $(cat "$work/state/writes")"

echo 'The full model: every kind UniHub keeps reaches the phone with its labels'
server_edit_full 'by["c-ada"].update({
  "organization": {"name": "Example Labs", "department": "Research"}, "job_title": "Engineer", "is_favorite": True,
  "anniversary": {"year": 1835, "month": 7, "day": 8},
  "phones": by["c-ada"]["phones"] + [{"id": "s-1", "value": "+15550114", "label": "custom", "custom_label": "Boat", "preferred": True}],
  "emails": [{"id": "s-2", "value": "ada@example.com", "label": "home", "custom_label": None, "preferred": False},
             {"id": "s-3", "value": "ada@example.org", "label": "work", "custom_label": None, "preferred": False},
             {"id": "s-4", "value": "ada@example.net", "label": "mobile", "custom_label": None, "preferred": False},
             {"id": "s-5", "value": "ada.club@example.com", "label": "custom", "custom_label": "Club", "preferred": False}],
  "impp": [{"id": "s-6", "value": "xmpp:ada@example.org", "label": "home", "custom_label": None, "preferred": False},
           {"id": "s-7", "value": "sip:ada@sip.example.com", "label": "work", "custom_label": None, "preferred": False}],
  "related": [{"id": "s-8", "value": "Ben Sample", "label": "spouse", "custom_label": None, "preferred": False},
              {"id": "s-9", "value": "Cy Sample", "label": "colleague", "custom_label": None, "preferred": False}],
  "nicknames": [{"id": "s-10", "value": "Addy", "label": "", "custom_label": None, "preferred": False}]})'
back_to_app
leave_app
expect_phone "$ada" 'len(of("phone_v2")) == 5 and [r["data2"] for r in of("phone_v2") if r["data1"] == "+15550114"] == ["0"] and any(r["data3"] == "Boat" and r["is_primary"] == "1" for r in of("phone_v2"))' 'five numbers, the fifth with its own label'
expect_phone "$ada" 'sorted(r["data2"] for r in of("email_v2")) == ["0", "1", "2", "4"] and any(r["data3"] == "Club" for r in of("email_v2"))' 'four addresses with their labels (home, work, mobile, custom)'
expect_phone "$ada" '[r["data5"] for r in of("organization")] == ["Research"] and [r["data4"] for r in of("organization")] == ["Engineer"]' 'the department and job title'
expect_phone "$ada" 'any(r["data5"] == "7" and r["data1"] == "ada@example.org" for r in of("im")) and [r["data1"] for r in of("sip_address")] == ["ada@sip.example.com"]' 'the messaging and SIP addresses'
expect_phone "$ada" 'sorted((r["data2"], r["data3"]) for r in of("relation")) == [("0", "Colleague"), ("14", "NULL")] and [r["data1"] for r in of("nickname")] == ["Addy"]' 'the relations and the nickname'
expect_phone "$ada" 'sorted((r["data2"], r["data1"]) for r in of("contact_event")) == [("1", "1835-07-08"), ("3", "--12-10")]' 'the birthday and anniversary'
adb shell content query --uri $contacts_uri/raw_contacts --projection starred --where "_id=$ada" | grep -q 'starred=1' || fail 'the favourite is not starred on the phone'
adb shell content query --uri $contacts_uri/data --projection data1 --where "\"data1 LIKE '%7f3a%'\"" 2>/dev/null | grep -q '^Row' && fail 'a note reached the phone'

echo 'The full model: every kind changed on the phone reaches UniHub'
: > "$work/state/writes"
adb shell content update --uri $contacts_uri/data --bind data2:i:17 --where "_id=$(data_id "$ada" phone_v2 +15550101)"
adb shell content delete --uri $contacts_uri/data --where "_id=$(data_id "$ada" website https://example.com/ada)"
phone_insert "$ada" relation --bind data1:s:"'Dee Sample'" --bind data2:i:6
phone_insert "$ada" im --bind data1:s:ada-signal --bind data2:i:3 --bind data5:i:-1 --bind data6:s:Signal
phone_insert "$ada" nickname --bind data1:s:A.L. --bind data2:i:5
adb shell content update --uri $contacts_uri/data --bind data1:s:1815-12-10 --where "\"raw_contact_id=$ada AND mimetype='vnd.android.cursor.item/contact_event' AND data2=3\""
sync_now
expect_server '[p["label"] for p in by["c-ada"]["phones"] if p["value"] == "+15550101"] == ["work_mobile"] and by["c-ada"]["urls"] == []' 'the relabelled number and the removed web address'
expect_server '("Dee Sample", "friend") in [(r["value"], r["label"]) for r in by["c-ada"]["related"]] and "Signal:ada-signal" in [i["value"] for i in by["c-ada"]["impp"]]' 'the relation and messaging address added on the phone'
expect_server '("A.L.", "initials") in [(n["value"], n["label"]) for n in by["c-ada"]["nicknames"]] and by["c-ada"]["birthday"] == {"year": 1815, "month": 12, "day": 10}' 'the nickname and the birthday with its year'
server_check 'by["c-ada"]["notes"] == "private note 7f3a" and by["c-ada"]["is_favorite"] is True' || fail "UniHub's note or favourite changed"

echo 'The full model: a photo set in UniHub reaches the phone, and its removal too'
base64 -d <<<"$photo_b64" > "$work/state/photos/c-ada"
server_edit_full "by['c-ada']['photo'] = {'etag': '$(sha256sum "$work/state/photos/c-ada" | cut -d ' ' -f 1)', 'width': 128, 'height': 128}"
back_to_app
leave_app
expect_phone "$ada" 'len(of("photo")) == 1' "UniHub's photo"
: > "$work/state/writes"
sync_now
sleep 8
grep -q 'photo' "$work/state/writes" && fail "the photo went back to UniHub after Android stored it: $(cat "$work/state/writes")"
rm -f "$work/state/photos/c-ada"
server_edit_full "by['c-ada']['photo'] = None"
back_to_app
leave_app
expect_phone "$ada" 'len(of("photo")) == 0' 'no photo after UniHub removed it'

echo 'The full model: an edit in UniHub during the sync is not overwritten'
ben="$(raw_for c-ben)"
echo c-ben > "$work/state/conflict"
phone_set_family "$ben" Phoned
sync_now
expect_server 'by["c-ben"]["job_title"] == "Changed in UniHub"' 'the edit made in UniHub during the write'
expect_server 'by["c-ben"]["name"]["family"] == "Phoned" and by["c-ben"]["job_title"] == "Changed in UniHub"' "both the phone's and UniHub's edit after the next sync"
expect_name +15550110 'Ben Phoned' 'after the conflict'

echo 'The full model: "Merge all" of twelve groups leaves one contact each, without "too many deletions"'
many=""
for n in 10 11 12 13 14 15 16 17 18 19 20 21; do
  many+=",$(flat3 c-g${n}a Group "$n" +155503$n +155504$n +155505$n g$n@example.com ''),$(flat3 c-g${n}b Group "$n" +155506$n +155507$n +155508$n g$n@example.org '')"
done
server_edit_full "contacts.extend(model.upgrade(c) for c in json.loads('[${many#,}]'))"
sync_now
expect_name +15550621 'Group 21' 'the twenty-four contacts arrived'
for _ in $(seq 1 30); do [[ "$(raws_for c-g21b)" == 1 ]] && break; sleep 1; done
: > "$work/state/writes"
waiting_before="$(waiting_count)"
server_edit_full "
for n in range(10, 22):
    a, b = by['c-g%da' % n], by['c-g%db' % n]
    a['phones'] += b['phones']; a['emails'] += b['emails']
contacts[:] = [c for c in contacts if not (c['id'].startswith('c-g') and c['id'].endswith('b'))]
"
python3 -c 'import json, sys; json.dump([{"id": "c-g%db" % n, "into": "c-g%da" % n, "at": "2026-10-29T10:00:00.000Z"} for n in range(10, 22)], open(sys.argv[1], "w"))' "$work/state/merged.json"
sync_now
for n in 10 11 12 13 14 15 16 17 18 19 20 21; do
  for _ in $(seq 1 40); do [[ "$(raws_for c-g${n}b)" == 0 ]] && break; sleep 1; done
  [[ "$(raws_for c-g${n}b)" == 0 ]] || fail "the merged-away contact c-g${n}b is still on the phone"
done
expect_name +15550621 'Group 21' "the merged-away contact's number, now on the survivor"
[[ "$(raws_for c-g21a)" == 1 ]] || fail 'the survivor is not on the phone once'
(( $(waiting_count) == waiting_before )) || fail 'merging in UniHub asked about too many deletions'
grep -q '^DELETE' "$work/state/writes" && fail "merges reaching the phone deleted in UniHub: $(cat "$work/state/writes")"

echo 'The full model: a merged-away contact changed on the phone gives its change to the survivor'
server_edit_full "contacts.extend(model.upgrade(c) for c in json.loads('[$(flat3 c-x1 Xena Sample +15550120 +15550121 +15550122 x1@example.com ''),$(flat3 c-x2 Xena Sample +15550123 +15550124 +15550125 x2@example.com '')]'))"
sync_now
expect_name +15550123 'Xena Sample' 'the contact about to be merged'
x2="$(raw_for c-x2)"
phone_add_number "$x2" +15550126
server_edit_full "by['c-x1']['phones'] += by['c-x2']['phones']; contacts[:] = [c for c in contacts if c['id'] != 'c-x2']"
python3 -c 'import json, sys; m = json.load(open(sys.argv[1])); m.append({"id": "c-x2", "into": "c-x1", "at": "2026-10-29T11:00:00.000Z"}); json.dump(m, open(sys.argv[1], "w"))' "$work/state/merged.json"
sync_now
expect_server '"+15550126" in [p["value"] for p in by["c-x1"]["phones"]] and "c-x2" not in by' "the number added on the phone, on the survivor"
for _ in $(seq 1 30); do [[ "$(raws_for c-x2)" == 0 ]] && break; sleep 1; done
[[ "$(raws_for c-x2)" == 0 ]] || fail 'the merged-away contact stayed on the phone'
expect_name +15550126 'Xena Sample' "the survivor with the phone's number"

echo 'The full model: an undone merge brings the contact back'
server_edit_full "
by['c-g10a']['phones'] = by['c-g10a']['phones'][:3]; by['c-g10a']['emails'] = by['c-g10a']['emails'][:1]
contacts.append(model.upgrade(json.loads('$(flat3 c-g10b Group 10 +15550610 +15550710 +15550810 g10@example.org '')')))
"
python3 -c 'import json, sys; json.dump([m for m in json.load(open(sys.argv[1])) if m["id"] != "c-g10b"], open(sys.argv[1], "w"))' "$work/state/merged.json"
sync_now
for _ in $(seq 1 40); do [[ "$(raws_for c-g10b)" == 1 ]] && break; sleep 1; done
[[ "$(raws_for c-g10b)" == 1 ]] || fail 'the contact brought back by an undo is not on the phone'
expect_phone "$(raw_for c-g10a)" 'len(of("phone_v2")) == 3' 'the survivor without the restored numbers'

if adb logcat -d -b crash | grep -q "Process: $package"; then fail 'the app crashed'; fi
echo 'Contacts reach the phone and follow UniHub.'

