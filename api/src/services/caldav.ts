// CalDAV (RFC 4791) and iCalendar subscription client: server discovery from a
// mail login, calendar listing, change detection and object read/write. All
// network access goes through caldav-transport, which enforces HTTPS, the
// outbound network policy and the credential scope.
import type { ApiError } from '../types';
import { promises as dns } from 'node:dns';
import { resolveMailConnectionTarget } from '../security/outbound-network';
import { parseCalDavUrl, resolveCalDavUrl, credentialScopeAllows, davRequest } from '../security/caldav-transport';

type CredentialScope = Parameters<typeof resolveCalDavUrl>[2];
interface Login { username?: string; password?: string; credentialScope?: CredentialScope; signal?: AbortSignal }
interface ProviderInput { emailAddress?: string | null; imapHost?: string | null }
interface Provider {
  id: string;
  label: string;
  domains: string[];
  hosts: string[];
  url?: string;
  scope?: CredentialScope;
  hint?: string;
  unsupported?: boolean;
}
interface CalendarObject { href: string; url: string; etag: string | null }
interface ReceivedObject { href: string; etag: string | null; ics: string }
interface Failure { url: string; error: ApiError }
type Resolvers = { resolveSrv?: typeof dns.resolveSrv; resolveTxt?: typeof dns.resolveTxt };

const PROBE_TIMEOUT_MS = 6000;
const MULTIGET_BATCH = 50;

function decodeXml(value: unknown) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripCdata(value: string) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagPattern(name: string) {
  return `(?:[a-zA-Z0-9_-]+:)?${name}`;
}

function getTagContent(xml: string, name: string) {
  const match = String(xml || '').match(new RegExp(`<${tagPattern(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagPattern(name)}>`, 'i'));
  return match ? match[1] : null;
}

function getFirstTag(xml: string, name: string) {
  const content = getTagContent(xml, name);
  if (content == null) return null;
  return /<!\[CDATA\[/.test(content) ? stripCdata(content).trim() : decodeXml(content).trim();
}

function getNestedHref(xml: string, parentName: string) {
  const parent = getTagContent(xml, parentName);
  return parent ? getFirstTag(parent, 'href') : null;
}

function hasTag(xml: string, name: string) {
  return new RegExp(`<${tagPattern(name)}[\\s/>]`, 'i').test(String(xml || ''));
}

function splitDavResponses(xml: string) {
  const responses = [];
  const re = new RegExp(`<${tagPattern('response')}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagPattern('response')}>`, 'gi');
  let match;
  while ((match = re.exec(String(xml || '')))) responses.push(match[1]);
  return responses;
}

// Properties reported in a propstat with a non-2xx status are absent.
function successfulProps(response: string) {
  if (!hasTag(response, 'propstat')) return response;
  const re = new RegExp(`<${tagPattern('propstat')}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagPattern('propstat')}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = re.exec(response))) {
    const status = getFirstTag(match[1], 'status');
    if (!status || /\s2\d\d\s/.test(` ${status} `)) blocks.push(match[1]);
  }
  return blocks.join('\n');
}

function responseStatusOk(response: string) {
  const outside = response.replace(new RegExp(`<${tagPattern('propstat')}[\\s\\S]*?</${tagPattern('propstat')}>`, 'gi'), '');
  const status = getFirstTag(outside, 'status');
  return !status || /\s2\d\d\s/.test(` ${status} `);
}

function canonicalHref(href: string, base?: string) {
  const { pathname } = new URL(href, base);
  try { return decodeURIComponent(pathname); } catch { return pathname; }
}

function davError(message: string, { status = 400, code }: { status?: number; code?: string } = {}) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// Providers with a fixed CalDAV address. Google and Microsoft accept app
// passwords for mail but require OAuth for calendars; their accounts can use
// the private iCalendar address instead (read-only).
const CALENDAR_PROVIDERS: Provider[] = [
  { id: 'icloud', label: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'], hosts: ['imap.mail.me.com'],
    url: 'https://caldav.icloud.com/', scope: { origin: 'https://caldav.icloud.com', hostSuffixes: ['.icloud.com'] },
    hint: 'iCloud needs an app-specific password from appleid.apple.com.' },
  { id: 'fastmail', label: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'], hosts: ['imap.fastmail.com'],
    url: 'https://caldav.fastmail.com/', hint: 'Fastmail needs an app password with CalDAV access.' },
  { id: 'yahoo', label: 'Yahoo', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], hosts: ['imap.mail.yahoo.com'],
    url: 'https://caldav.calendar.yahoo.com/', hint: 'Yahoo needs an app password.' },
  { id: 'mailbox-org', label: 'mailbox.org', domains: ['mailbox.org'], hosts: ['imap.mailbox.org'], url: 'https://dav.mailbox.org/' },
  { id: 'posteo', label: 'Posteo', domains: ['posteo.de', 'posteo.net', 'posteo.org', 'posteo.eu'], hosts: ['posteo.de'], url: 'https://posteo.de:8443/' },
  { id: 'google', label: 'Google', unsupported: true, domains: ['gmail.com', 'googlemail.com'], hosts: ['imap.gmail.com'],
    hint: 'Google Calendar does not accept passwords over CalDAV. Add it as a subscription instead: Google Calendar → Settings → your calendar → "Secret address in iCal format".' },
  { id: 'microsoft', label: 'Microsoft', unsupported: true, domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    hosts: ['outlook.office365.com', 'imap-mail.outlook.com'],
    hint: 'Outlook calendars do not support CalDAV. Add one as a subscription instead: Outlook → Settings → Calendar → Shared calendars → "Publish a calendar" and copy the ICS link.' },
];

function hostOf(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function emailDomain(emailAddress: unknown) {
  const text = String(emailAddress || '').trim().toLowerCase();
  return text.includes('@') ? hostOf(text.split('@').pop()) : '';
}

function matchCalendarProvider({ emailAddress, imapHost }: ProviderInput) {
  const domain = emailDomain(emailAddress);
  const host = hostOf(imapHost);
  return CALENDAR_PROVIDERS.find(provider => provider.hosts.includes(host))
    || CALENDAR_PROVIDERS.find(provider => provider.domains.includes(domain))
    || null;
}

async function validateDavUrlPolicy(urlString: unknown) {
  try {
    const url = parseCalDavUrl(urlString);
    await resolveMailConnectionTarget(url.hostname);
    return { accepted: true };
  } catch (error) {
    return { error: (error as ApiError).message, status: 400 };
  }
}

// Where a stored account may send its password: a known provider's scope as
// stored at connect time, otherwise only the origin of its calendar home. A
// scope is never taken from stored data alone (it may come from a restored
// archive).
function accountCredentialScope({ provider_config: providerConfig, base_url: baseUrl, discovery_url: discoveryUrl }: { provider_config?: unknown; base_url?: string | null; discovery_url?: string | null }): CredentialScope {
  let config = providerConfig;
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = null; } }
  const stored = JSON.stringify((config as { credentialScope?: unknown } | null)?.credentialScope ?? null);
  const preset = CALENDAR_PROVIDERS.find(item => item.scope && JSON.stringify(item.scope) === stored);
  if (preset) return preset.scope!;
  // discovery_url is the server the login was confirmed against (after any
  // anonymous well-known redirects), so its origin bounds where the password goes.
  return new URL((discoveryUrl || baseUrl)!).origin;
}

function scopeOrigin(scope: CredentialScope) {
  return typeof scope === 'object' && scope ? scope.origin : scope;
}

function auth({ username, password, credentialScope, signal }: Login) {
  return { username, password, credentialOrigin: credentialScope, signal };
}

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const NAMESPACES = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';
const CALENDAR_PROPS = `<d:displayname /><d:resourcetype /><cs:getctag /><d:sync-token /><ic:calendar-color />
    <c:supported-calendar-component-set /><d:current-user-privilege-set />`;

function parseCalendarResponse(response: string, baseUrl: string, credentialScope: CredentialScope) {
  const href = getFirstTag(response, 'href');
  const props = successfulProps(response);
  const resourceType = getTagContent(props, 'resourcetype') || '';
  if (!href || !hasTag(resourceType, 'calendar') || hasTag(resourceType, 'subscribed')) return null;
  const components = getTagContent(props, 'supported-calendar-component-set');
  if (components && !/name\s*=\s*["']VEVENT["']/i.test(components)) return null;
  const privileges = getTagContent(props, 'current-user-privilege-set');
  const readOnly = privileges != null && !['write', 'write-content', 'all', 'bind'].some(name => hasTag(privileges, name));
  const color = (getFirstTag(props, 'calendar-color') || '').match(/^#[0-9a-f]{6}/i)?.[0] || null;
  const url = resolveCalDavUrl(href, baseUrl, credentialScope);
  return {
    href: canonicalHref(url),
    url,
    displayName: (getFirstTag(props, 'displayname') || '').slice(0, 255) || 'Calendar',
    ctag: getFirstTag(props, 'getctag') || getFirstTag(props, 'sync-token') || null,
    color,
    readOnly,
  };
}

// Find the calendars behind a CalDAV URL: the URL may be a calendar itself, a
// principal, a calendar home or a discovery endpoint. Credentials are only
// ever sent within credentialScope (by default the URL's own origin).
async function discoverCalDavCalendars({ discoveryUrl, username, password, credentialScope }: Login & { discoveryUrl: string }) {
  const scope = credentialScope || parseCalDavUrl(discoveryUrl).origin;
  const login = auth({ username, password, credentialScope: scope });
  const probeBody = `${XML_HEADER}
<d:propfind ${NAMESPACES}>
  <d:prop><d:current-user-principal /><c:calendar-home-set />${CALENDAR_PROPS}</d:prop>
</d:propfind>`;
  const first = await davRequest(discoveryUrl, { ...login, body: probeBody, depth: '0' });
  const firstResponse = splitDavResponses(first.text)[0] || first.text;
  const itself = parseCalendarResponse(firstResponse, first.url, scope);
  if (itself) return { baseUrl: first.url, principalHref: null, calendars: [itself] };

  let currentUrl = first.url;
  const principalHref = getNestedHref(successfulProps(firstResponse), 'current-user-principal');
  let calendarHomeHref = getNestedHref(successfulProps(firstResponse), 'calendar-home-set');
  if (!calendarHomeHref && principalHref) {
    const principalUrl = resolveCalDavUrl(principalHref, currentUrl, scope);
    const principal = await davRequest(principalUrl, { ...login, depth: '0', body: `${XML_HEADER}
<d:propfind ${NAMESPACES}><d:prop><c:calendar-home-set /></d:prop></d:propfind>` });
    currentUrl = principal.url;
    calendarHomeHref = getNestedHref(successfulProps(splitDavResponses(principal.text)[0] || principal.text), 'calendar-home-set');
  }
  if (!calendarHomeHref) {
    throw davError('This address answered, but did not report any CalDAV calendars.', { status: 422, code: 'CALDAV_NO_CALENDAR_HOME' });
  }
  const calendarHomeUrl = resolveCalDavUrl(calendarHomeHref, currentUrl, scope);
  const calendars = await listCalendars({ homeUrl: calendarHomeUrl, username, password, credentialScope: scope });
  return { baseUrl: calendarHomeUrl, principalHref: principalHref || null, calendars };
}

async function listCalendars({ homeUrl, username, password, credentialScope, signal }: Login & { homeUrl: string }) {
  const home = await davRequest(homeUrl, {
    ...auth({ username, password, credentialScope, signal }), depth: '1',
    body: `${XML_HEADER}\n<d:propfind ${NAMESPACES}><d:prop>${CALENDAR_PROPS}</d:prop></d:propfind>`,
  });
  return splitDavResponses(home.text)
    .map(response => parseCalendarResponse(response, home.url, credentialScope!))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

// Ask a URL anonymously whether a DAV server answers there. Cross-origin HTTPS
// redirects are followed (no credentials are sent); the final URL becomes the
// credential scope only for discovery that the user's own domain pointed to.
async function probeCalDavEndpoint(url: string) {
  const result = await davRequest(url, {
    anonymous: true, depth: '0', timeoutMs: PROBE_TIMEOUT_MS, acceptStatuses: [401],
    body: `${XML_HEADER}\n<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal /></d:prop></d:propfind>`,
  });
  const dav = String(result.headers?.dav || '');
  const isDav = result.status === 207 || /calendar-access/i.test(dav)
    || (result.status === 401 && /\b(1|2|3|calendar-access)\b/.test(dav))
    || (result.status === 401 && /basic|digest/i.test(String(result.headers?.['www-authenticate'] || '')));
  if (!isDav) throw davError('No CalDAV server answered.', { status: 404 });
  return result.url;
}

async function lookupSrvCandidates(domain: string, { resolveSrv = dns.resolveSrv.bind(dns), resolveTxt = dns.resolveTxt.bind(dns) }: Resolvers = {}) {
  if (!domain) return [];
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS).unref?.());
  const records = await Promise.race([resolveSrv(`_caldavs._tcp.${domain}`).catch(() => []), timeout]) || [];
  if (!records.length) return [];
  const txt = await Promise.race([resolveTxt(`_caldavs._tcp.${domain}`).catch(() => []), timeout]) || [];
  const pathRecord = txt.map(parts => parts.join('')).find(value => /^path=/i.test(value));
  const path = pathRecord ? pathRecord.replace(/^path=/i, '') : '/.well-known/caldav';
  return records
    .filter(record => record.name && record.name !== '.')
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .slice(0, 3)
    .map(record => {
      const host = hostOf(record.name);
      const port = Number(record.port) === 443 ? '' : `:${record.port}`;
      return `https://${host}${port}${path.startsWith('/') ? path : `/${path}`}`;
    });
}

function wellKnownCandidates({ emailAddress, imapHost }: ProviderInput) {
  const domain = emailDomain(emailAddress);
  const host = hostOf(imapHost);
  const stripped = host.replace(/^(imap|imaps|mail|mx)\./, '');
  return [...new Set([domain, stripped, host].filter(Boolean))].map(name => `https://${name}/.well-known/caldav`);
}

// Find the CalDAV server for a mail login without any setup:
//   explicit URL → known provider → DNS SRV (RFC 6764) → /.well-known/caldav
//   on the mail domain and the IMAP server.
// Returns what was found and where, so the UI can show it.
async function findCalDavServer({ emailAddress, imapHost, username, password, explicitUrl }: Login & ProviderInput & { explicitUrl?: string | null }, resolvers: Resolvers = {}) {
  const login = { username: (username || emailAddress) || undefined, password };
  if (!login.password) throw davError('A password is needed to connect the calendar.', { code: 'CALDAV_NO_PASSWORD' });
  const failures: Failure[] = [];
  const attempt = async (url: string, source: string, label?: string, credentialScope?: CredentialScope) => {
    try {
      const discovery = await discoverCalDavCalendars({ discoveryUrl: url, ...login, credentialScope });
      return { server: { url, source, label: label || new URL(url).host }, credentialScope: credentialScope || new URL(url).origin, discovery };
    } catch (error) {
      failures.push({ url, error: error as ApiError });
      return null;
    }
  };

  if (explicitUrl) {
    const url = parseCalDavUrl(/^webcal:/i.test(explicitUrl) ? explicitUrl.replace(/^webcal:/i, 'https:') : String(explicitUrl).trim()).toString();
    const found = await attempt(url, 'manual')
      || (new URL(url).pathname === '/' ? await attempt(new URL('/.well-known/caldav', url).toString(), 'manual') : null);
    if (found) return found;
    throw summarizeFailures(failures, null);
  }

  const provider = matchCalendarProvider({ emailAddress, imapHost });
  if (provider?.unsupported) {
    throw davError(provider.hint!, { status: 422, code: 'CALDAV_PROVIDER_UNSUPPORTED' });
  }
  if (provider) {
    const found = await attempt(provider.url!, 'provider', provider.label, provider.scope);
    if (found) return { ...found, hint: provider.hint || null };
  }

  const srv = await lookupSrvCandidates(emailDomain(emailAddress), resolvers).catch(() => []);
  const candidates = [...srv.map(url => ({ url, source: 'dns' })), ...wellKnownCandidates({ emailAddress, imapHost }).map(url => ({ url, source: 'well-known' }))]
    .filter((item, index, list) => list.findIndex(other => other.url === item.url) === index);
  const probes = await Promise.all(candidates.map(candidate => probeCalDavEndpoint(candidate.url)
    .then(finalUrl => ({ ...candidate, finalUrl }), error => { failures.push({ url: candidate.url, error }); return null; })));
  const tried = new Set();
  for (const probe of probes.filter((item): item is NonNullable<typeof item> => Boolean(item))) {
    const origin = new URL(probe.finalUrl).origin;
    if (tried.has(probe.finalUrl)) continue;
    tried.add(probe.finalUrl);
    const found = await attempt(probe.finalUrl, probe.source, new URL(probe.finalUrl).host, origin);
    if (found) return found;
  }
  throw summarizeFailures(failures, provider);
}

function summarizeFailures(failures: Failure[], provider: Provider | null) {
  if (failures.some(item => item.error?.status === 401 || item.error?.status === 403)) {
    return davError(`The calendar server was found but did not accept the login.${provider?.hint ? ` ${provider.hint}` : ''}`,
      { status: 422, code: 'CALDAV_AUTH_FAILED' });
  }
  const noHome = failures.find(item => item.error?.code === 'CALDAV_NO_CALENDAR_HOME');
  if (noHome) return noHome.error;
  const blocked = failures.find(item => item.error?.code === 'OUTBOUND_HOST_BLOCKED' && !/could not be resolved|timed out/.test(item.error.message));
  if (blocked) return davError(blocked.error.message, { status: 422, code: 'OUTBOUND_HOST_BLOCKED' });
  return davError('No calendar server was found for this account. Enter the CalDAV address from your provider to connect it manually.',
    { status: 422, code: 'CALDAV_NOT_FOUND' });
}

function davTime(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// All event objects that touch the window, with their ETags. Servers expand
// recurrences for time-range matching, so a series that started years ago
// but still recurs is included.
async function listCalendarObjects({ calendarUrl, username, password, credentialScope, signal, windowStartMs, windowEndMs }: Login & { calendarUrl: string; windowStartMs: number; windowEndMs: number }) {
  const login = auth({ username, password, credentialScope, signal });
  const parse = (text: string, base: string, skipSelf: boolean) => splitDavResponses(text).flatMap(response => {
    const href = getFirstTag(response, 'href');
    if (!href || !responseStatusOk(response)) return [];
    const props = successfulProps(response);
    if (hasTag(getTagContent(props, 'resourcetype') || '', 'collection')) return [];
    const url = resolveCalDavUrl(href, base, credentialScope!);
    if (skipSelf && canonicalHref(url) === canonicalHref(calendarUrl)) return [];
    const type = getFirstTag(props, 'getcontenttype');
    if (type && !/calendar/i.test(type)) return [];
    return [{ href: canonicalHref(url), url, etag: getFirstTag(props, 'getetag') || null }];
  });
  try {
    const result = await davRequest(calendarUrl, { ...login, method: 'REPORT', depth: '1', body: `${XML_HEADER}
<c:calendar-query ${NAMESPACES}>
  <d:prop><d:getetag /></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${davTime(windowStartMs)}" end="${davTime(windowEndMs)}" />
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>` });
    return parse(result.text, result.url, false);
  } catch (error) {
    if (![400, 403, 405, 415, 501].includes((error as ApiError).status!)) throw error;
    const result = await davRequest(calendarUrl, { ...login, depth: '1',
      body: `${XML_HEADER}\n<d:propfind ${NAMESPACES}><d:prop><d:getetag /><d:getcontenttype /><d:resourcetype /></d:prop></d:propfind>` });
    return parse(result.text, result.url, true);
  }
}

async function fetchCalendarObjects({ calendarUrl, objects, username, password, credentialScope, signal }: Login & { calendarUrl: string; objects: CalendarObject[] }) {
  const login = auth({ username, password, credentialScope, signal });
  const results = [];
  for (let index = 0; index < objects.length; index += MULTIGET_BATCH) {
    const batch = objects.slice(index, index + MULTIGET_BATCH);
    let received: ReceivedObject[] | null = null;
    try {
      const hrefs = batch.map(item => `<d:href>${new URL(item.url).pathname.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</d:href>`).join('');
      const result = await davRequest(calendarUrl, { ...login, method: 'REPORT', depth: '1', body: `${XML_HEADER}
<c:calendar-multiget ${NAMESPACES}><d:prop><d:getetag /><c:calendar-data /></d:prop>${hrefs}</c:calendar-multiget>` });
      received = splitDavResponses(result.text).flatMap(response => {
        const href = getFirstTag(response, 'href');
        const props = successfulProps(response);
        const ics = getFirstTag(props, 'calendar-data');
        if (!href || !ics || !responseStatusOk(response)) return [];
        return [{ href: canonicalHref(href, result.url), etag: getFirstTag(props, 'getetag') || null, ics }];
      });
    } catch (error) {
      if (![400, 403, 405, 415, 501].includes((error as ApiError).status!)) throw error;
    }
    if (!received) {
      received = [];
      for (const item of batch) {
        const result = await davRequest(item.url, { ...login, method: 'GET', accept: 'text/calendar', acceptStatuses: [404, 410] });
        if (result.status >= 300) continue;
        received.push({ href: item.href, etag: result.headers.etag || item.etag || null, ics: result.text });
      }
    }
    results.push(...received);
  }
  return results;
}

async function readObjectEtag(url: string, login: ReturnType<typeof auth>) {
  const result = await davRequest(url, { ...login, depth: '0',
    body: `${XML_HEADER}\n<d:propfind xmlns:d="DAV:"><d:prop><d:getetag /></d:prop></d:propfind>`, acceptStatuses: [404] });
  return result.status === 404 ? null : getFirstTag(result.text, 'getetag');
}

function conflictError() {
  return davError('The event was changed on the calendar server in the meantime. It has been refreshed; please review it and try again.',
    { status: 409, code: 'CALDAV_CONFLICT' });
}

// Create (etag null) or replace (etag known) one calendar object. A changed
// ETag means someone else edited it: nothing is overwritten.
async function putCalendarObject({ url, ics, etag, username, password, credentialScope, signal }: Login & { url: string; ics: string; etag?: string | null }) {
  const login = auth({ username, password, credentialScope, signal });
  const result = await davRequest(url, {
    ...login, method: 'PUT', body: ics, contentType: 'text/calendar; charset=utf-8', accept: '*/*',
    headers: etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }, acceptStatuses: [412],
  });
  if (result.status === 412) throw conflictError();
  return { etag: result.headers.etag || await readObjectEtag(url, login).catch(() => null) };
}

async function deleteCalendarObject({ url, etag, username, password, credentialScope, signal }: Login & { url: string; etag?: string | null }) {
  const result = await davRequest(url, {
    ...auth({ username, password, credentialScope, signal }), method: 'DELETE', accept: '*/*',
    headers: etag ? { 'If-Match': etag } : {}, acceptStatuses: [404, 410, 412],
  });
  if (result.status === 412) throw conflictError();
}

function normalizeIcsFeedUrl(value: unknown) {
  const text = String(value || '').trim().replace(/^webcals?:/i, 'https:');
  return parseCalDavUrl(text).toString();
}

// Read an iCalendar subscription. No credentials are involved; the address
// itself is the secret. The ETag (or Last-Modified) avoids re-downloading.
async function fetchIcsFeed({ url, etag }: { url: string; etag?: string | null }): Promise<{ notModified: true; etag?: string | null } | { notModified: false; text: string; etag: string | null }> {
  const result = await davRequest(normalizeIcsFeedUrl(url), {
    method: 'GET', anonymous: true, accept: 'text/calendar, */*;q=0.5',
    headers: etag ? { 'If-None-Match': etag } : {}, acceptStatuses: [304],
  });
  if (result.status === 304) return { notModified: true, etag };
  if (!/BEGIN:VCALENDAR/i.test(result.text.slice(0, 2000))) {
    throw davError('This address did not return an iCalendar file.', { status: 422, code: 'ICS_INVALID' });
  }
  return { notModified: false, text: result.text, etag: result.headers.etag || null };
}

export {
  CALENDAR_PROVIDERS,
  matchCalendarProvider,
  validateDavUrlPolicy,
  discoverCalDavCalendars,
  listCalendars,
  probeCalDavEndpoint,
  lookupSrvCandidates,
  wellKnownCandidates,
  findCalDavServer,
  listCalendarObjects,
  fetchCalendarObjects,
  putCalendarObject,
  deleteCalendarObject,
  normalizeIcsFeedUrl,
  fetchIcsFeed,
  canonicalHref,
  scopeOrigin,
  accountCredentialScope,
  credentialScopeAllows,
};
