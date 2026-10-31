// 0.26.0: contacts on the phone with the full model, against the real server.
// The app syncs every field a phone contact has with a server that lists
// contacts-vcard (android/.../ContactsSync.kt, docs/ANDROID.md). Proven here
// through Android's own contacts provider (what the Phone app reads) and the
// API, with synthetic contacts of the seeded admin:
//
// - 26-09: an update from the 0.25.1 app (UNIHUB_E2E_PREVIOUS_APK, signed like
//   the installed debug app) keeps the synced contacts without duplicates and
//   sends what only the phone had; before it, the 0.25.1 app against this
//   server keeps its 3+3 behaviour (a fourth and fifth number survive its write).
// - 26-02: a contact with five numbers and four emails shows with its labels.
// - 26-10 (agent part): photos both ways.
// - 26-07: "Merge all" of twelve groups leaves one contact each, without
//   Android's "Too many deletions"; an undone merge brings the contact back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, adb, answerSlowDialogs, openApp, screenNodes, sleep } from '../support/android.mjs';

const instance = Number(process.env.UNIHUB_E2E_INSTANCE ?? '1');
const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + instance}`;
const repo = new URL('../../..', import.meta.url).pathname;
const candidateApk = process.env.UNIHUB_E2E_CANDIDATE_APK ?? `${repo}android/app/build/outputs/apk/debug/app-debug.apk`;
const previousApk = process.env.UNIHUB_E2E_PREVIOUS_APK;
const run = Date.now().toString(36).slice(-5);
const tag = `E2e${run}`;
const contactsUri = 'content://com.android.contacts';
// A small synthetic picture (a 128 px gradient).
const PHOTO = '/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCACAAIADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAQIFBv/EABUQAQEAAAAAAAAAAAAAAAAAAAEA/8QAGQEBAQEBAQEAAAAAAAAAAAAAAwIBBgQF/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIRAxEAPwDmgkJCoLqtfNlSFQSFQU6WVIVBIVBZpZUhUEhUFOklSFQSFQWaWVIVBIVBTpJUhUEhUFOllSFQSEhZpJWYFQSFQXo1zkqQqCQqCnSSpCoJCoLNLKkKgkJCnSSgKgkJCnSygJCoJCzSSgJCoJCnSygJCoJCzSyswKgkJC9GublASFQSFOklASFQSFmllASFQSFOklASFQSFmllASFQSFOllASFQSFOklASFQSFmllZgSFQSF6Nc3KAkKgkKdLKAkKgkLNJKAkKgkKdLKAkKgkKdJKAkJCoLNLKAkJCoKdJKkKgkKgs0srMCQqCQvRrm5QEhIVBTpZQEhIVBZpJUhUEhUFOllSFQSFQU6SVIVBIVBZpZUhUEhUFOllSFQSFQWaSVlhUEhUF6Nc3KkKgkKgp0sqQqCQqCzSSpCoJCoKdLKkKgkKgp0sqQqCQqCzSSpCoJCQp0soCoJCQs0krMCoJCoL0a5uVIVBIVBTpZUhUEhIU6WUBUEhIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBIVBIWaSVmBIVBIT65yUBIVBIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBIVBIWaSUBIVBIU6WUBISFQWaWV//Z';

// ── The server, as the seeded admin ──
let api;
async function signIn() {
  const response = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'local-dev-admin-password' }) });
  const body = await response.json();
  assert.ok(response.ok, `sign-in: ${response.status}`);
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  api = async (method, path, data, { raw, type } = {}) => {
    const send = () => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken,
      ...(data !== undefined ? { 'Content-Type': type ?? 'application/json' } : {}) },
    body: data === undefined ? undefined : raw ? data : JSON.stringify(data) });
    // A read after a long wait on the phone may reuse a connection nginx
    // closed meanwhile (keep-alive): it is asked again once. Writes are not.
    const res = await send().catch(error => {
      if (method !== 'GET' || error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
      return send();
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return json;
  };
}
const contact = async id => (await api('GET', `/api/contacts/${id}`)).contact;
const create = async body => (await api('POST', '/api/contacts', body)).contact;
async function ours() {
  const { contacts } = await api('GET', `/api/contacts?q=${tag}&limit=2000`);
  return contacts.filter(c => c.display_name.includes(tag) || (c.name?.family ?? '').includes(tag));
}
const v = (value, label = '', custom_label = null) => ({ value, label, custom_label, preferred: false });

// ── The phone: Android's contacts provider, read and changed as a contacts app does ──
function query(uri, projection, where) {
  const text = adb('shell', 'content', 'query', '--uri', uri, '--projection', projection.join(':'), '--where', `"${where}"`);
  const keys = projection.join('|');
  return text.split(/^Row: \d+ /m).slice(1).map(chunk => {
    const parts = chunk.replace(/\s+$/, '').split(new RegExp(`(?:^|, )(${keys})=`));
    const row = {};
    for (let i = 1; i < parts.length; i += 2) row[parts[i]] = parts[i + 1];
    return row;
  });
}
const rawsFor = id => query(`${contactsUri}/raw_contacts`, ['_id', 'sync1', 'starred'],
  `account_type='${PACKAGE}' AND sourceid='${id}' AND deleted=0`);
const dataOf = raw => query(`${contactsUri}/data`, ['_id', 'mimetype', 'data1', 'data2', 'data3', 'data4', 'data5', 'data14', 'is_primary'], `raw_contact_id=${raw}`)
  .map(row => ({ ...row, mime: row.mimetype.split('/').pop() }));
const of = (rows, mime) => rows.filter(row => row.mime === mime);
const hasAccount = () => /Account \{name=[^,]*, type=io\.github\.mrksrus\.unihub\}/.test(adb('shell', 'dumpsys', 'account'));
function insertData(raw, mime, binds) {
  adb('shell', 'content', 'insert', '--uri', `${contactsUri}/data`, '--bind', `raw_contact_id:i:${raw}`, '--bind', `mimetype:s:vnd.android.cursor.item/${mime}`,
    ...Object.entries(binds).flatMap(([column, value]) => ['--bind', typeof value === 'number' ? `${column}:i:${value}` : `${column}:s:'${value}'`]));
}
function requestSync() {
  adb('shell', 'requestsync', '-n', '127.0.0.1', '-t', PACKAGE, '-a', 'com.android.contacts', '-f');
}
/** Waits for a condition of both sides, asking for a sync now and then (Android may delay one). */
async function until(check, what, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  let last;
  for (let attempt = 0; Date.now() < end; attempt++) {
    try { if (await check()) return; } catch (error) { last = error; }
    if (attempt % 8 === 0) requestSync();
    await sleep(2500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/** Whether the phone's default network is metered (what the app's isActiveNetworkMetered sees). */
function defaultNetworkMetered() {
  const dump = adb('shell', 'dumpsys', 'connectivity');
  const id = /Active default network: (\d+)/.exec(dump)?.[1];
  const agent = id && dump.split('\n').find(line => line.includes(`NetworkAgentInfo{network{${id}}`));
  const capabilities = agent && /Capabilities: (\S+)/.exec(agent)?.[1].split('&');
  return !!capabilities && !capabilities.includes('NOT_METERED');
}

/**
 * Makes the phone's network metered and returns how, with its undo; null when
 * this emulator cannot. First the Wi-Fi marked metered (as Android's Wi-Fi
 * settings do), else Wi-Fi off so that mobile data is the active network.
 */
async function meteredNetwork() {
  const ways = [];
  const ssid = /connected to "([^"]+)"/.exec(adb('shell', 'cmd', 'wifi', 'status'))?.[1];
  if (ssid) {
    // The current setting (true, false or none) is put back afterwards.
    const was = new RegExp(`^${ssid};(\\w+)`, 'm').exec(adb('shell', 'cmd', 'netpolicy', 'list', 'wifi-networks'))?.[1] ?? 'none';
    // Android 15 exits with 255 even when the value is set; the network's own state below is what counts.
    const mark = value => { try { adb('shell', 'cmd', 'netpolicy', 'set', 'metered-network', ssid, value); } catch { /* checked below */ } };
    ways.push({ how: `Wi-Fi ${ssid} marked metered`, on: () => mark('true'), off: () => mark(was === 'none' ? 'undefined' : was) });
  }
  // A mobile network the phone is connected to (requests name CELLULAR too, without one).
  if (/NetworkAgentInfo\{.*Transports: CELLULAR/.test(adb('shell', 'dumpsys', 'connectivity'))) {
    ways.push({ how: 'Wi-Fi off, mobile data on', on: () => adb('shell', 'svc', 'wifi', 'disable'), off: () => adb('shell', 'svc', 'wifi', 'enable') });
  }
  for (const way of ways) {
    way.on();
    for (let i = 0; i < 15 && !defaultNetworkMetered(); i++) await sleep(2000);
    if (defaultNetworkMetered()) return way;
    way.off();
  }
  return null;
}

/** Contacts on the phone for the signed-in admin, as Android's Settings → Add account → UniHub turns them on. */
async function contactsOn() {
  adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.READ_CONTACTS');
  adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.WRITE_CONTACTS');
  if (hasAccount()) return;
  adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`, '-a', `${PACKAGE}.SHOW_CONTACTS`);
  for (let attempt = 0; attempt < 60 && !hasAccount(); attempt++) {
    await answerSlowDialogs();
    // Dialog buttons show in capitals on newer Android versions.
    const button = screenNodes().find(node => /^show contacts$/i.test(node.text));
    if (button) adb('shell', 'input', 'tap', `${button.x}`, `${button.y}`);
    await sleep(2000);
  }
  assert.ok(hasAccount(), 'contacts are on: the UniHub account exists');
}

/** Installs an app over the current one (same signing key) and signs in. */
async function install(apk) {
  adb('install', '-r', '-d', apk);
  const { device } = await openApp();
  await device.close();
}

before(signIn);

after(async () => {
  // The run's contacts go; the phone follows without asking (deletions from UniHub).
  if (!api) return;
  const ids = (await ours()).map(c => c.id);
  if (ids.length) await api('POST', '/api/contacts/bulk-delete', { ids });
  requestSync();
});

test('[26-09] the update from the 0.25.1 app keeps the synced contacts, sends what only the phone had and adds nothing twice', { timeout: 1_500_000 }, async t => {
  if (!previousApk) { t.skip('UNIHUB_E2E_PREVIOUS_APK names no 0.25.1 app'); return; }
  const phones = ['+15550200', '+15550201', '+15550202', '+15550203', '+15550204'];
  const ada = await create({
    name: { given: 'Ada', family: tag }, organization: { name: 'Example Labs' }, notes: 'private note 7f3a',
    phones: phones.map((n, i) => v(n, ['mobile', 'home', 'work', 'pager', 'car'][i])),
    emails: [v(`ada.${run}@example.com`, 'work')],
  });
  await create({ name: { given: 'Ben', family: tag }, phones: [v('+15550210', 'mobile')] });

  // The 0.25.1 app, with contacts on: it sees the 3+3 projection.
  await install(previousApk);
  await contactsOn();
  let adaRaw;
  await until(() => { adaRaw = rawsFor(ada.id)[0]; return adaRaw?.sync1 === '2'; }, 'the 0.25.1 app synced Ada (format 2)');
  assert.equal(of(dataOf(adaRaw._id), 'phone_v2').length, 3, 'the 0.25.1 app holds three numbers');

  // Its write keeps the fourth and fifth number and every label (P-21).
  const name = of(dataOf(adaRaw._id), 'name')[0];
  adb('shell', 'content', 'update', '--uri', `${contactsUri}/data`, '--bind', `data3:s:${tag}x`, '--where', `"_id=${name._id}"`);
  await until(async () => (await contact(ada.id)).name.family === `${tag}x`, "the 0.25.1 app's edit in UniHub");
  const afterOldApp = await contact(ada.id);
  assert.deepEqual(afterOldApp.phones.map(p => [p.value, p.label]), phones.map((n, i) => [n, ['mobile', 'home', 'work', 'pager', 'car'][i]]));
  assert.equal(afterOldApp.notes, 'private note 7f3a');

  // What that app keeps as the phone's own: an address, a birthday, a number
  // UniHub does not have, and UniHub's fifth number written another way.
  insertData(adaRaw._id, 'postal-address_v2', { data4: '1 Example Street', data7: 'Springfield', data2: 1 });
  insertData(adaRaw._id, 'contact_event', { data1: '--12-10', data2: 3 });
  insertData(adaRaw._id, 'phone_v2', { data1: '+15550205', data2: 3 });
  insertData(adaRaw._id, 'phone_v2', { data1: '+1 555 0204', data2: 9 });
  await sleep(15_000);
  requestSync();
  await sleep(15_000);
  assert.equal((await contact(ada.id)).addresses.length, 0, 'the 0.25.1 app does not send the address');

  // The update.
  const before = (await ours()).length;
  await install(candidateApk);
  await contactsOn();
  await until(() => rawsFor(ada.id)[0]?.sync1 === '3', 'the first sync with every field (format 3)');
  await until(async () => (await contact(ada.id)).addresses.length === 1, "Ada's address in UniHub");
  const now = await contact(ada.id);
  assert.deepEqual(now.birthday, { year: null, month: 12, day: 10 });
  assert.equal(now.addresses[0].street, '1 Example Street');
  assert.deepEqual(now.phones.map(p => p.value).sort(), [...phones, '+15550205'].sort(), 'six numbers, none twice');
  assert.equal(now.phones.find(p => p.value === '+15550205').label, 'work');
  assert.equal(now.phones.find(p => p.value === '+15550204').label, 'car', "UniHub's label of a number both had stays");
  assert.equal(now.notes, 'private note 7f3a');
  assert.equal((await ours()).length, before, 'no contact added in UniHub');
  assert.equal(rawsFor(ada.id).length, 1, 'Ada is on the phone once');
  await until(() => of(dataOf(rawsFor(ada.id)[0]._id), 'phone_v2').length === 6, "the phone's six numbers");
});

test('[26-02] a contact with five numbers and four emails shows with its labels, and every kind goes both ways', { timeout: 900_000 }, async () => {
  await openApp().then(({ device }) => device.close());
  await contactsOn();
  const cleo = await create({
    name: { given: 'Cleo', family: tag, middle: 'M.' }, organization: { name: 'Example Labs', department: 'Research' }, job_title: 'Engineer',
    birthday: '--03-14', anniversary: '2001-06-30', notes: 'never on the phone 9d1b',
    phones: [v('+15550300', 'mobile'), v('+15550301', 'home'), v('+15550302', 'work'), v('+15550303', 'custom', 'Boat'), v('+15550304', 'pager')],
    emails: [v(`cleo.${run}@example.com`, 'home'), v(`cleo.${run}@example.org`, 'work'), v(`cleo.${run}@example.net`, 'other'), v(`cleo.club.${run}@example.com`, 'custom', 'Club')],
    addresses: [{ street: '2 Example Road', locality: 'Springfield', postal_code: '12345', label: 'work' }],
    urls: [v('https://example.com/cleo', 'blog')],
    impp: [v(`xmpp:cleo.${run}@example.org`, 'home')],
    related: [v('Dee Example', 'colleague')],
    nicknames: [v('Cle')],
  });
  let raw;
  await until(() => { raw = rawsFor(cleo.id)[0]; return raw && of(dataOf(raw._id), 'phone_v2').length === 5; }, 'Cleo on the phone with five numbers');
  const rows = dataOf(raw._id);
  assert.deepEqual(of(rows, 'phone_v2').map(r => [r.data1, r.data2, r.data2 === '0' ? r.data3 : null]),
    [['+15550300', '2', null], ['+15550301', '1', null], ['+15550302', '3', null], ['+15550303', '0', 'Boat'], ['+15550304', '6', null]]);
  assert.deepEqual(of(rows, 'email_v2').map(r => [r.data2, r.data2 === '0' ? r.data3 : null]), [['1', null], ['2', null], ['3', null], ['0', 'Club']]);
  assert.equal(of(rows, 'postal-address_v2')[0].data4, '2 Example Road');
  assert.deepEqual(of(rows, 'website').map(r => r.data2), ['2']);
  assert.deepEqual(of(rows, 'im').map(r => [r.data1, r.data5]), [[`cleo.${run}@example.org`, '7']]);
  assert.deepEqual(of(rows, 'relation').map(r => [r.data2, r.data3]), [['0', 'Colleague']]);
  assert.deepEqual(of(rows, 'contact_event').map(r => [r.data2, r.data1]).sort(), [['1', '2001-06-30'], ['3', '--03-14']]);
  assert.deepEqual(of(rows, 'organization').map(r => [r.data1, r.data4, r.data5]), [['Example Labs', 'Engineer', 'Research']]);
  assert.ok(!rows.some(r => (r.data1 ?? '').includes('9d1b')), 'the note stays in UniHub');

  // Changed on the phone, as a contacts app does: in UniHub after the sync.
  const home = of(rows, 'phone_v2').find(r => r.data1 === '+15550301');
  adb('shell', 'content', 'update', '--uri', `${contactsUri}/data`, '--bind', 'data2:i:17', '--where', `"_id=${home._id}"`);
  adb('shell', 'content', 'delete', '--uri', `${contactsUri}/data`, '--where', `"_id=${of(rows, 'website')[0]._id}"`);
  insertData(raw._id, 'nickname', { data1: 'C.T.', data2: 5 });
  insertData(raw._id, 'relation', { data1: 'Eve Example', data2: 6 });
  await until(async () => {
    const now = await contact(cleo.id);
    return now.phones.find(p => p.value === '+15550301')?.label === 'work_mobile' && now.urls.length === 0
      && now.nicknames.some(n => n.value === 'C.T.' && n.label === 'initials') && now.related.some(r => r.value === 'Eve Example' && r.label === 'friend');
  }, "the phone's edits in UniHub");
  const now = await contact(cleo.id);
  assert.equal(now.notes, 'never on the phone 9d1b');
  assert.equal(now.phones.length, 5);
  assert.equal(now.phones.find(p => p.value === '+15550300').id, cleo.phones[0].id, 'unchanged values keep their identity');
});

test('[26-10] a photo set in UniHub reaches the phone, and one set on the phone reaches UniHub', { timeout: 900_000 }, async () => {
  await contactsOn();
  const dee = await create({ name: { given: 'Dee', family: tag }, phones: [v('+15550400', 'mobile')] });
  const eve = await create({ name: { given: 'Eve', family: tag }, phones: [v('+15550410', 'mobile')] });
  await api('PUT', `/api/contacts/${dee.id}/photo`, Buffer.from(PHOTO, 'base64'), { raw: true, type: 'image/jpeg' });
  await until(() => { const raw = rawsFor(dee.id)[0]; return raw && of(dataOf(raw._id), 'photo').length === 1; }, "UniHub's photo on the phone");
  const deeVersion = (await contact(dee.id)).version;

  // As a contacts app sets one (debug builds only: adb cannot write a photo).
  let eveRaw;
  await until(() => { eveRaw = rawsFor(eve.id)[0]; return !!eveRaw; }, 'Eve on the phone');
  adb('shell', 'am', 'broadcast', '-n', `${PACKAGE}/.TestContactPhoto`, '--el', 'raw', eveRaw._id, '--es', 'jpeg', PHOTO);
  await until(async () => (await contact(eve.id)).photo !== null, "the phone's photo in UniHub");
  const eveVersion = (await contact(eve.id)).version;

  // Each side's picture as the other stores it is no change: nothing goes back.
  requestSync();
  await sleep(30_000);
  requestSync();
  await sleep(30_000);
  assert.equal((await contact(dee.id)).version, deeVersion, "UniHub's photo did not come back from the phone");
  assert.equal((await contact(eve.id)).version, eveVersion, "the phone's photo was sent once");
});

test('[26-10] a photo set on the phone for a contact UniHub merged away waits on a metered network, then reaches the survivor', { timeout: 1_200_000 }, async t => {
  await openApp().then(({ device }) => device.close());
  await contactsOn();
  // On an unmetered network the photo would be sent before the merge, and the
  // copy's way into the survivor (intoSurvivor) would not run at all.
  const metered = await meteredNetwork();
  if (!metered) {
    t.skip('needs a metered network on the emulator: neither marking its Wi-Fi metered nor mobile data worked');
    return;
  }
  console.log(`metered network: ${metered.how}`);
  const body = number => ({ name: { given: 'Fay', family: tag }, emails: [v(`fay.${run}@example.com`)], phones: [v(number)] });
  let keep, away;
  try {
    keep = await create(body('+15550600'));
    away = await create(body('+15550601'));
    await until(() => rawsFor(keep.id).length === 1 && rawsFor(away.id).length === 1, 'both copies on the phone');
    // A picture set on the copy and held on the phone before the merge, so no
    // sync the merge sets off can find the copy unchanged and remove it; on a
    // metered network it is not sent to the contact being merged away.
    const copy = rawsFor(away.id)[0]._id;
    adb('shell', 'am', 'broadcast', '-n', `${PACKAGE}/.TestContactPhoto`, '--el', 'raw', copy, '--es', 'jpeg', PHOTO);
    await until(() => of(dataOf(copy), 'photo').length === 1, 'the picture on the copy');
    const versions = { [keep.id]: (await contact(keep.id)).version, [away.id]: (await contact(away.id)).version };
    adb('logcat', '-c');
    await api('POST', '/api/contacts/merges', { contact_ids: [keep.id, away.id], survivor_id: keep.id, versions });
    await until(() => adb('shell', 'logcat -d -s UniHubContacts').includes('stays on the phone until its new photo is sent'), 'the copy waiting for its photo');
    assert.equal(rawsFor(away.id).length, 1, 'the copy stays while its photo cannot be sent');
    assert.equal((await contact(keep.id)).photo, null);
  } finally {
    metered.off();
  }
  for (let i = 0; i < 30 && defaultNetworkMetered(); i++) await sleep(2000);
  await until(async () => (await contact(keep.id)).photo !== null, "the merged-away copy's photo on the survivor");
  await until(() => rawsFor(away.id).length === 0, 'the merged-away copy gone from the phone');
  await until(() => { const raw = rawsFor(keep.id)[0]; return raw && of(dataOf(raw._id), 'photo').length === 1; }, "the survivor's copy with the photo");
});

test('[26-07] "Merge all" of twelve groups leaves one contact each on the phone, without "Too many deletions"; an undo brings one back', { timeout: 1_200_000 }, async () => {
  await contactsOn();
  const pairs = [];
  for (let n = 10; n < 22; n++) {
    const body = i => ({ name: { given: `Group${n}`, family: tag }, emails: [v(`group${n}.${run}@example.com`)], phones: [v(`+155505${n}${i}`)] });
    pairs.push([await create(body(0)), await create(body(1))]);
  }
  const ids = pairs.flat().map(c => c.id);
  await until(() => ids.every(id => rawsFor(id).length === 1), 'the twenty-four contacts on the phone');
  adb('logcat', '-c');

  const { groups } = await api('GET', '/api/contacts/duplicates?min=high');
  const mine = groups.filter(g => g.members.every(m => ids.includes(m.id)));
  assert.equal(mine.length, 12);
  assert.ok(mine.every(g => g.auto_merge), 'every group is one "Merge all" takes');
  const { results } = await api('POST', '/api/contacts/merges/auto', { group_ids: mine.map(g => g.id), min: 'high' });
  assert.deepEqual(results.map(r => r.status), Array(12).fill('merged'));
  const remaining = new Set((await ours()).map(c => c.id).filter(id => ids.includes(id)));
  assert.equal(remaining.size, 12);

  await until(() => ids.every(id => rawsFor(id).length === (remaining.has(id) ? 1 : 0)), 'one contact per group on the phone');
  const log = adb('shell', 'logcat -d -s UniHubContacts');
  assert.doesNotMatch(log, /waiting for confirmation/, 'no "Too many deletions"');
  assert.equal((await ours()).filter(c => ids.includes(c.id)).length, 12, 'the phone deleted nothing in UniHub');
  // Each survivor has both numbers on the phone.
  for (const id of remaining) assert.equal(of(dataOf(rawsFor(id)[0]._id), 'phone_v2').length, 2);

  // Undo one merge: the merged-away contact comes back to the phone.
  const { merges } = await api('GET', '/api/contacts/merges');
  const merge = merges.find(m => m.undone_at === null && remaining.has(m.survivor_id));
  const undone = await api('POST', `/api/contacts/merges/${merge.id}/undo`);
  await until(() => undone.restored_ids.every(id => rawsFor(id).length === 1), 'the restored contact on the phone');
  await until(() => of(dataOf(rawsFor(merge.survivor_id)[0]._id), 'phone_v2').length === 1, 'the survivor without the restored number');
});
