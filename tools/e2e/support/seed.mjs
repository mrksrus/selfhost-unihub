// Connects the synthetic users of an e2e stack to its providers, once
// (tools/e2e/stack.sh up runs it). The dev seed (scripts/local-db.sh dev) has
// already created admin@example.com and alex@example.com with sample data; this
// adds blair@example.com as the third person for sharing checks, and gives each
// of them a mail account on GreenMail and a CalDAV account on Radicale, both
// through the real API so the connection checks run as they would for a person.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../../api/package.json', import.meta.url)));
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const env = name => process.env[name] || (() => { throw new Error(`${name} is not set (run through tools/e2e/stack.sh)`); })();
const base = env('UNIHUB_E2E_URL');
const providerHost = env('UNIHUB_E2E_PROVIDER_HOST');
const providerPassword = env('UNIHUB_E2E_PROVIDER_PASSWORD');
const caldavUrl = env('UNIHUB_E2E_CALDAV_URL');
const password = 'local-dev-admin-password';
const people = [
  { email: 'admin@example.com', name: 'Avery Admin', mailbox: 'admin@mail.test' },
  { email: 'alex@example.com', name: 'Alex Example', mailbox: 'alex@mail.test' },
  { email: 'blair@example.com', name: 'Blair Third', mailbox: 'blair@mail.test' },
];

async function ensureThirdUser() {
  const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(env('MYSQL_PORT')), user: env('MYSQL_USER'),
    password: env('MYSQL_PASSWORD'), database: env('MYSQL_DATABASE') });
  try {
    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', ['blair@example.com']);
    if (rows.length) return;
    const id = crypto.randomUUID();
    await db.execute(`INSERT INTO users (id, email, password_hash, full_name, email_verified, role, timezone)
      VALUES (?, 'blair@example.com', ?, 'Blair Third', TRUE, 'user', 'Europe/Berlin')`, [id, await bcrypt.hash(password, 10)]);
    console.log('seed: created blair@example.com');
  } finally { await db.end(); }
}

async function session(email) {
  const response = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`sign-in as ${email}: ${response.status} ${JSON.stringify(body)}`);
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return async (method, path, data) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken,
      ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${path} as ${email}: ${res.status} ${text.slice(0, 300)}`);
    return json;
  };
}

// Radicale creates a principal on first sign-in but no collections: make one
// calendar and one task list per account, as a real CalDAV server would have.
async function ensureCollections(user) {
  const auth = `Basic ${Buffer.from(`${user}:${providerPassword}`).toString('base64')}`;
  for (const [slug, name, component] of [['calendar', 'Calendar', 'VEVENT'], ['tasks', 'Tasks', 'VTODO']]) {
    const url = `${caldavUrl}${user}/${slug}/`;
    const probe = await fetch(url, { method: 'PROPFIND', headers: { Authorization: auth, Depth: '0' } });
    if (probe.status !== 404) continue;
    const res = await fetch(url, { method: 'MKCALENDAR', headers: { Authorization: auth, 'Content-Type': 'application/xml' }, body:
      `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>` +
      `<D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="${component}"/>` +
      `</C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>` });
    if (!res.ok) throw new Error(`MKCALENDAR ${url}: ${res.status}`);
  }
}

const list = value => Array.isArray(value) ? value : value?.accounts ?? [];

await ensureThirdUser();
for (const person of people) {
  const api = await session(person.email);
  const mail = list(await api('GET', '/api/mail/accounts'));
  if (!mail.some(account => account.email_address === person.mailbox)) {
    await api('POST', '/api/mail/accounts', { email_address: person.mailbox, display_name: person.name, provider: 'custom',
      username: person.mailbox, encrypted_password: providerPassword, imap_host: providerHost, imap_port: 993,
      smtp_host: providerHost, smtp_port: 465, sync_mode: 'sync', sync_fetch_limit: 'all' });
    console.log(`seed: mail account ${person.mailbox} for ${person.email}`);
  }
  await ensureCollections(person.mailbox);
  const calendars = list(await api('GET', '/api/calendar/accounts'));
  if (!calendars.some(account => account.provider === 'caldav' && account.username === person.mailbox)) {
    await api('POST', '/api/calendar/accounts', { provider: 'caldav', username: person.mailbox, account_email: person.mailbox,
      password: providerPassword, url: `${caldavUrl}${person.mailbox}/`, display_name: `${person.name} (CalDAV)` });
    console.log(`seed: CalDAV account ${person.mailbox} for ${person.email}`);
  }
}
console.log('seed: done');
