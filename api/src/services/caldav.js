const crypto = require('crypto');
const { db } = require('../state');
const { encrypt } = require('../security/encryption');
const { assessMailHost } = require('./mail');
const {
  CALENDAR_PROVIDER_DEFAULT_CAPABILITIES,
  serializeCalendarAccount,
  serializeCalendarCalendar,
  toMysqlDatetime,
} = require('./calendar');

const CALDAV_SYNC_WINDOW_PAST_DAYS = 365;
const CALDAV_SYNC_WINDOW_FUTURE_DAYS = 730;

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function tagPattern(name) {
  return `(?:[a-zA-Z0-9_-]+:)?${name}`;
}

function getFirstTag(xml, name) {
  const match = String(xml || '').match(new RegExp(`<${tagPattern(name)}[^>]*>([\\s\\S]*?)</${tagPattern(name)}>`, 'i'));
  return match ? decodeXml(stripCdata(match[1]).trim()) : null;
}

function getNestedHref(xml, parentName) {
  const parent = String(xml || '').match(new RegExp(`<${tagPattern(parentName)}[^>]*>([\\s\\S]*?)</${tagPattern(parentName)}>`, 'i'));
  return parent ? getFirstTag(parent[1], 'href') : null;
}

function splitDavResponses(xml) {
  const responses = [];
  const re = new RegExp(`<${tagPattern('response')}[^>]*>([\\s\\S]*?)</${tagPattern('response')}>`, 'gi');
  let match;
  while ((match = re.exec(String(xml || '')))) responses.push(match[1]);
  return responses;
}

function resolveUrl(baseUrl, href) {
  return new URL(href, baseUrl).toString();
}

function normalizeCalDavDiscoveryUrl({ emailAddress, imapHost, explicitUrl }) {
  if (explicitUrl) return String(explicitUrl).trim();
  const emailDomain = String(emailAddress || '').split('@').pop();
  const host = String(imapHost || emailDomain || '').trim().replace(/^imap\./i, '');
  if (!host) return null;
  return `https://${host}/.well-known/caldav`;
}

function getUrlHostAndPort(urlString) {
  const url = new URL(urlString);
  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  };
}

async function validateDavUrlPolicy(urlString) {
  const parsed = new URL(urlString);
  if (parsed.protocol !== 'https:') {
    return { error: 'CalDAV URL must use HTTPS', status: 400 };
  }
  const { host, port } = getUrlHostAndPort(urlString);
  const assessment = await assessMailHost(host, port);
  if (assessment.blocked) {
    return {
      error: 'CalDAV host resolves to a private/local address. Add it to TRUSTED_MAIL_HOSTS if this is intentional.',
      status: 400,
    };
  }
  return { accepted: true };
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function davRequest(urlString, { method = 'PROPFIND', username, password, body, depth = '0' }) {
  await validateDavUrlPolicy(urlString).then((result) => {
    if (result.error) {
      const error = new Error(result.error);
      error.status = result.status;
      throw error;
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(urlString, {
      method,
      redirect: 'follow',
      headers: {
        Authorization: basicAuth(username, password),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml,text/xml,*/*',
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok && response.status !== 207) {
      const error = new Error(`CalDAV request failed (${response.status})`);
      error.status = response.status;
      error.responseText = text.slice(0, 500);
      throw error;
    }
    return {
      status: response.status,
      url: response.url || urlString,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverCalDavCalendars({ discoveryUrl, username, password }) {
  const principalBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:current-user-principal />
    <cs:calendar-home-set />
  </d:prop>
</d:propfind>`;
  const first = await davRequest(discoveryUrl, { username, password, body: principalBody, depth: '0' });
  let currentUrl = first.url;
  let principalHref = getNestedHref(first.text, 'current-user-principal');
  let calendarHomeHref = getNestedHref(first.text, 'calendar-home-set');

  if (!calendarHomeHref && principalHref) {
    const principalUrl = resolveUrl(currentUrl, principalHref);
    const principal = await davRequest(principalUrl, { username, password, body: principalBody, depth: '0' });
    currentUrl = principal.url;
    calendarHomeHref = getNestedHref(principal.text, 'calendar-home-set');
  }

  const calendarHomeUrl = calendarHomeHref ? resolveUrl(currentUrl, calendarHomeHref) : currentUrl;
  const calendarListBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <d:getetag />
    <cs:getctag />
  </d:prop>
</d:propfind>`;
  const home = await davRequest(calendarHomeUrl, { username, password, body: calendarListBody, depth: '1' });
  const responses = splitDavResponses(home.text);
  const calendars = responses
    .map((response) => {
      const href = getFirstTag(response, 'href');
      const resourceType = response.match(new RegExp(`<${tagPattern('resourcetype')}[^>]*>([\\s\\S]*?)</${tagPattern('resourcetype')}>`, 'i'))?.[1] || '';
      if (!href || !new RegExp(`<${tagPattern('calendar')}[\\s/>]`, 'i').test(resourceType)) return null;
      return {
        href,
        url: resolveUrl(home.url, href),
        displayName: getFirstTag(response, 'displayname') || 'Calendar',
        ctag: getFirstTag(response, 'getctag') || null,
      };
    })
    .filter(Boolean);

  if (calendars.length === 0) {
    calendars.push({
      href: new URL(calendarHomeUrl).pathname,
      url: calendarHomeUrl,
      displayName: 'Calendar',
      ctag: null,
    });
  }

  return {
    baseUrl: calendarHomeUrl,
    principalHref,
    calendars,
  };
}

function unfoldIcs(value) {
  return String(value || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeIcsText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function getIcsProp(lines, name) {
  const upperName = name.toUpperCase();
  const line = lines.find((item) => {
    const key = item.split(':')[0].split(';')[0].toUpperCase();
    return key === upperName;
  });
  if (!line) return null;
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;
  return {
    rawKey: line.slice(0, colonIndex),
    value: line.slice(colonIndex + 1),
  };
}

function parseIcsDate(prop) {
  if (!prop?.value) return null;
  const value = prop.value.trim();
  const allDay = /(^|;)VALUE=DATE($|;)/i.test(prop.rawKey) || /^\d{8}$/.test(value);
  if (/^\d{8}$/.test(value)) {
    return {
      allDay: true,
      iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`,
    };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zulu] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000${zulu ? 'Z' : 'Z'}`;
  return { allDay, iso };
}

function parseSimpleVevents(calendarData) {
  const lines = unfoldIcs(calendarData);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = [];
    } else if (/^END:VEVENT$/i.test(line) && current) {
      if (!current.some(item => /^RRULE[:;]/i.test(item) || /^RECURRENCE-ID[:;]/i.test(item))) {
        const uid = getIcsProp(current, 'UID')?.value?.trim();
        const start = parseIcsDate(getIcsProp(current, 'DTSTART'));
        const end = parseIcsDate(getIcsProp(current, 'DTEND'));
        if (uid && start) {
          const startDate = new Date(start.iso);
          const endDate = end?.iso ? new Date(end.iso) : new Date(startDate.getTime() + 60 * 60 * 1000);
          events.push({
            uid,
            title: unescapeIcsText(getIcsProp(current, 'SUMMARY')?.value || 'Untitled Event'),
            description: unescapeIcsText(getIcsProp(current, 'DESCRIPTION')?.value || ''),
            location: unescapeIcsText(getIcsProp(current, 'LOCATION')?.value || ''),
            startIso: startDate.toISOString(),
            endIso: endDate.toISOString(),
            allDay: start.allDay,
          });
        }
      }
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return events;
}

async function fetchCalendarEvents({ calendarUrl, username, password }) {
  const now = Date.now();
  const start = new Date(now - CALDAV_SYNC_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const end = new Date(now + CALDAV_SYNC_WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${start}" end="${end}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const result = await davRequest(calendarUrl, { method: 'REPORT', username, password, body, depth: '1' });
  return splitDavResponses(result.text).flatMap((response) => {
    const href = getFirstTag(response, 'href');
    const etag = getFirstTag(response, 'getetag');
    const data = getFirstTag(response, 'calendar-data');
    if (!href || !data) return [];
    return parseSimpleVevents(data).map(event => ({
      ...event,
      href,
      etag,
    }));
  });
}

async function upsertCalDavEvents({ userId, accountId, calendarId, providerCalendarHref, events, connection = db }) {
  let imported = 0;
  for (const event of events) {
    const externalEventId = `${providerCalendarHref || calendarId}:${event.uid}`;
    const [refs] = await connection.execute(
      'SELECT event_id FROM calendar_event_external_refs WHERE account_id = ? AND external_event_id = ? LIMIT 1',
      [accountId, externalEventId]
    );
    const eventId = refs[0]?.event_id || crypto.randomUUID();
    if (refs.length > 0) {
      await connection.execute(
        `UPDATE calendar_events
         SET calendar_id = ?, title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?, location = ?, color = ?
         WHERE id = ? AND user_id = ?`,
        [
          calendarId,
          event.title,
          event.description || null,
          toMysqlDatetime(event.startIso),
          toMysqlDatetime(event.endIso),
          event.allDay ? 1 : 0,
          event.location || null,
          '#22c55e',
          eventId,
          userId,
        ]
      );
    } else {
      await connection.execute(
        `INSERT INTO calendar_events
          (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          userId,
          calendarId,
          event.title,
          event.description || null,
          toMysqlDatetime(event.startIso),
          toMysqlDatetime(event.endIso),
          event.allDay ? 1 : 0,
          event.location || null,
          '#22c55e',
        ]
      );
    }
    await connection.execute(
      `INSERT INTO calendar_event_external_refs
        (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, external_updated_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?, NULL, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), calendar_id = VALUES(calendar_id),
         external_etag = VALUES(external_etag), last_synced_at = UTC_TIMESTAMP()`,
      [crypto.randomUUID(), userId, eventId, calendarId, accountId, externalEventId, event.etag || null]
    );
    imported += 1;
  }
  return imported;
}

async function createCalDavAccountForMail({
  userId,
  emailAddress,
  displayName,
  username,
  password,
  imapHost,
  caldavUrl,
}) {
  const discoveryUrl = normalizeCalDavDiscoveryUrl({ emailAddress, imapHost, explicitUrl: caldavUrl });
  if (!discoveryUrl) throw new Error('Could not determine CalDAV discovery URL');
  const policy = await validateDavUrlPolicy(discoveryUrl);
  if (policy.error) {
    const error = new Error(policy.error);
    error.status = policy.status;
    throw error;
  }

  const discovery = await discoverCalDavCalendars({
    discoveryUrl,
    username: username || emailAddress,
    password,
  });

  const accountId = crypto.randomUUID();
  const encryptedPassword = encrypt(password);
  const capabilities = CALENDAR_PROVIDER_DEFAULT_CAPABILITIES.caldav;
  const connection = await db.getConnection();
  let importedEvents = 0;
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO calendar_accounts
        (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url, provider_config, capabilities, is_active, sync_status, sync_error, last_synced_at)
       VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'syncing', NULL, NULL)`,
      [
        accountId,
        userId,
        emailAddress || null,
        displayName || emailAddress || 'CalDAV',
        username || emailAddress,
        encryptedPassword,
        discoveryUrl,
        discovery.baseUrl,
        JSON.stringify({ principalHref: discovery.principalHref || null }),
        JSON.stringify(capabilities),
      ]
    );

    for (const [index, calendar] of discovery.calendars.entries()) {
      const calendarId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO calendar_calendars
          (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary, sync_token)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, TRUE, FALSE, ?, ?)`,
        [
          calendarId,
          userId,
          accountId,
          calendar.displayName || 'Calendar',
          calendar.href,
          index === 0 ? '#22c55e' : '#3b82f6',
          index === 0 ? 1 : 0,
          calendar.ctag || null,
        ]
      );
      const events = await fetchCalendarEvents({
        calendarUrl: calendar.url,
        username: username || emailAddress,
        password,
      }).catch((error) => {
        console.warn(`[CALDAV] Could not import events for ${calendar.url}:`, error.message);
        return [];
      });
      importedEvents += await upsertCalDavEvents({
        userId,
        accountId,
        calendarId,
        providerCalendarHref: calendar.href,
        events,
        connection,
      });
    }

    await connection.execute(
      `UPDATE calendar_accounts SET sync_status = 'ok', sync_error = NULL, last_synced_at = UTC_TIMESTAMP()
       WHERE id = ? AND user_id = ?`,
      [accountId, userId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const [accounts] = await db.execute('SELECT * FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
  const [calendars] = await db.execute('SELECT * FROM calendar_calendars WHERE account_id = ? AND user_id = ? ORDER BY created_at ASC', [accountId, userId]);
  return {
    account: accounts[0] ? serializeCalendarAccount(accounts[0]) : null,
    calendars: (calendars || []).map(serializeCalendarCalendar),
    importedEvents,
  };
}

module.exports = {
  normalizeCalDavDiscoveryUrl,
  validateDavUrlPolicy,
  discoverCalDavCalendars,
  parseSimpleVevents,
  createCalDavAccountForMail,
};
