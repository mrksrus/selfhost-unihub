import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { people, signInPassword, stack, type Person } from './env.ts';

export interface ApiResult<T = any> { status: number; data: T }
export type ApiCall = <T = any>(method: string, path: string, body?: unknown) => Promise<ApiResult<T>>;

interface StoredSession { cookie: string; csrfToken: string }
const sessionCache = `${stack.state}/e2e-api-sessions.json`;
const readCache = (): Record<string, StoredSession> => existsSync(sessionCache) ? JSON.parse(readFileSync(sessionCache, 'utf8')) : {};

function client(session: StoredSession, userAgent: string): ApiCall & { cookie: string } {
  const call = (async (method: string, path: string, data?: unknown) => {
    const res = await fetch(`${stack.url}${path}`, {
      method, headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'User-Agent': userAgent,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await res.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data: json };
  }) as ApiCall & { cookie: string };
  call.cookie = session.cookie;
  return call;
}

/**
 * A signed-in session for one of the synthetic people, from Node: for preparing
 * data a test needs but does not cover, and as a second device. Every sign-in
 * uses one of the account's 10 attempts per 10 minutes (successful ones too), so
 * a session is kept in the instance's state directory and reused while the
 * server still accepts it; `fresh` always signs in anew (a device to sign out).
 */
export async function signIn(person: Person | string, { userAgent = 'UniHub e2e helper', fresh = false } = {}) {
  const email = person in people ? people[person as Person].email : person;
  const key = `${email} ${userAgent}`;
  if (!fresh) {
    const cached = readCache()[key];
    if (cached) {
      const api = client(cached, userAgent);
      if ((await api('GET', '/api/auth/me')).status === 200) return api;
    }
  }
  const response = await fetch(`${stack.url}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent }, body: JSON.stringify({ email, password: signInPassword }),
  });
  const body = await response.json() as { csrfToken: string };
  if (!response.ok) throw new Error(`sign-in as ${email}: ${response.status} ${JSON.stringify(body)}`);
  const session = { cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrfToken: body.csrfToken };
  if (!fresh) writeFileSync(sessionCache, JSON.stringify({ ...readCache(), [key]: session }), { mode: 0o600 });
  return client(session, userAgent);
}

/** Fails with the response when a call did not succeed; returns its data. */
export function ok<T>(result: ApiResult<T>, what: string): T {
  if (result.status < 200 || result.status >= 300) throw new Error(`${what}: ${result.status} ${JSON.stringify(result.data).slice(0, 300)}`);
  return result.data;
}

type PageEval = { evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R> };

/** A JSON API call made by the page itself, with its session cookie and CSRF token. */
export async function pageApi<T = any>(browser: unknown, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  return (browser as PageEval).evaluate(async ({ method, path, body }: { method: string; path: string; body: unknown }) => {
    const me = await (await fetch('/api/auth/me', { credentials: 'include' })).json();
    const response = await fetch(path, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken ?? '' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, data };
  }, { method, path, body: body ?? null }) as Promise<ApiResult<T>>;
}

/** Saves the signed-in person's own settings (registry keys from api/src/services/settings-registry.ts). */
export async function setSettings(browser: unknown, values: Record<string, unknown>) {
  ok(await pageApi(browser, 'PUT', '/api/settings/values', { values }), 'save settings');
}

export interface MailAccount { id: string; email_address: string; display_name: string; sync_mode: string }

export async function mailAccount(browser: unknown, address: string): Promise<MailAccount> {
  const { accounts } = ok(await pageApi<{ accounts: MailAccount[] }>(browser, 'GET', '/api/mail/accounts'), 'list mail accounts');
  const account = accounts.find((a) => a.email_address === address);
  if (!account) throw new Error(`no mail account ${address}`);
  return account;
}

export interface ListedEmail { id: string; subject: string; is_read?: boolean; is_starred?: boolean; thread_key?: string; scheduled_send_status?: string | null }

/** Messages of a folder (inbox, sent, drafts, snoozed, …) whose subject is exactly this text. */
export async function emailsWithSubject(browser: unknown, folder: string, subject: string): Promise<ListedEmail[]> {
  const { emails } = ok(await pageApi<{ emails: ListedEmail[] }>(browser, 'GET',
    `/api/mail/emails?folder=${encodeURIComponent(folder)}&search=${encodeURIComponent(subject)}&limit=100`), `list ${folder}`);
  return emails.filter((e) => e.subject === subject);
}

export interface StoredDraft { id: string; subject: string; attachments: string[]; body_text?: string; body_html?: string }

/** The drafts with this subject, each with its stored attachments as "name:size". */
export async function storedDrafts(browser: unknown, subject: string): Promise<StoredDraft[]> {
  const rows = await emailsWithSubject(browser, 'drafts', subject);
  return Promise.all(rows.map(async (row) => {
    const detail = ok(await pageApi(browser, 'GET', `/api/mail/emails/${row.id}`), 'read draft');
    const email = detail.email ?? detail;
    return {
      id: row.id, subject: email.subject, body_text: email.body_text, body_html: email.body_html,
      attachments: (email.attachments ?? []).map((a: { filename: string; size_bytes: number }) => `${a.filename}:${a.size_bytes}`).sort(),
    };
  }));
}

/** A sign-in attempt with a wrong password; returns the HTTP status. */
export async function wrongSignIn(person: Person) {
  const response = await fetch(`${stack.url}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: people[person].email, password: 'not-the-synthetic-password' }),
  });
  await response.body?.cancel();
  return response.status;
}
