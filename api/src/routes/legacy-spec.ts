import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import type { RouteSpec, RouteTable } from '../http/route';
import { DEFAULT_BODY_LIMIT, MUTATING_METHODS, defineRoutes } from '../http/route';
import { getModuleForPath } from '../services/module-catalog';
import { getRestoreSectionForWrite } from '../services/backup-catalog';
import { BACKUP_UPLOAD_MAX_SIZE, MAIL_COMPOSE_REQUEST_MAX_SIZE } from '../config';

// Route files not yet declared with specs export plain handlers; their policy
// comes from the tables below, which are the lookups request-handler.ts used
// before specs existed. route-spec.test.cts pins the derivation to them. A file
// converted to defineRoutes() removes its entries here.
// The widest function type: these files declare their own request, user id and
// body types, which the boundary used to cast away as a whole.
type LegacyHandler = (...args: never[]) => unknown;
type LegacyRouteTable = Record<string, LegacyHandler>;

const PUBLIC_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /api/version',
  'GET /api/auth/signup-mode',
  'POST /api/auth/signup',
  'POST /api/auth/signin',
  'POST /api/auth/2fa/login',
  'GET /api/backup/export',
]);

// Request body limits in bytes for the routes that carry files, archives,
// imports, bulk selections, or text columns sized well beyond the default.
const BODY_LIMIT_BY_PATH_PREFIX: readonly [string, number][] = [
  ['/api/notifications/', 16384],
];
const BODY_LIMIT_BY_ROUTE: Readonly<Record<string, number>> = {
  'GET /api/modules': 16384,
  'PUT /api/modules': 16384,
  // Credentials: a passphrase may be up to 1024 characters, so the JSON needs
  // more than a bare id but nowhere near the default.
  'POST /api/auth/signin': 4096,
  'POST /api/auth/signup': 4096,
  'PUT /api/auth/password': 4096,
  'PUT /api/admin/users/:id/password': 4096,
  // Contact notes are a TEXT column
  'POST /api/contacts': 65536,
  'PUT /api/contacts/:id': 65536,
  'POST /api/contacts/import': 500000, // vCard import can be large
  // A contact selection: up to 5000 IDs of ~39 bytes each
  'POST /api/contacts/bulk-delete': 250000,
  'POST /api/contacts/bulk-update': 250000,
  'POST /api/recordings/uploads/:id/chunk': 1200 * 1024, // Recording chunks are base64 encoded JSON.
  // Chord sheets (metadata.chords, 10000 characters), a TEXT description and tags
  'PUT /api/recordings/:id': 262144,
  'POST /api/recordings/uploads/start': 50000,
  'POST /api/backup/import': BACKUP_UPLOAD_MAX_SIZE,
  'POST /api/mail/send': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  'POST /api/mail/drafts': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  'PUT /api/mail/drafts/:id': MAIL_COMPOSE_REQUEST_MAX_SIZE,
  // Calendar account metadata payloads
  'POST /api/calendar/accounts': 50000,
  'PUT /api/calendar/accounts/:id': 50000,
  'PUT /api/mail/accounts/:id/calendar': 50000,
  // Synced events can carry long descriptions
  'POST /api/calendar/events': 100000,
  'PUT /api/calendar/events/:id': 100000,
  // Mail account credentials and custom host metadata
  'POST /api/mail/accounts': 50000,
  'PUT /api/mail/accounts/:id': 50000,
  // Bulk operations and sync need more space (100 emails * ~36 chars UUID + JSON overhead)
  'POST /api/mail/emails/bulk-update': 50000,
  'POST /api/mail/emails/bulk-delete': 50000,
  'POST /api/mail/emails/bulk-move': 50000,
  'POST /api/mail/sync': 50000,
};
function bodyLimitFor(routeKey: string, pathname: string) {
  for (const [prefix, limit] of BODY_LIMIT_BY_PATH_PREFIX) if (pathname.startsWith(prefix)) return limit;
  return BODY_LIMIT_BY_ROUTE[routeKey] ?? DEFAULT_BODY_LIMIT;
}

// Routes that write and own their response (returned { __handled: true }).
const STREAMING_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'GET /api/events',
  'GET /api/notifications/android/stream',
]);

// Restore sections by write path. /api/modules writes module preferences, a
// settings-section row, under a path the prefix table does not cover.
function restoreSectionFor(method: string, pathname: string) {
  if (!MUTATING_METHODS.has(method)) return undefined;
  if (pathname === '/api/modules') return 'settings';
  return getRestoreSectionForWrite(pathname);
}

function legacyRouteSpec(key: string, handler: LegacyHandler): RouteSpec {
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const pathname = key.slice(space + 1);
  const policy = {
    module: getModuleForPath(pathname),
    restoreSection: restoreSectionFor(method, pathname),
    body: { limit: bodyLimitFor(key, pathname), kind: (key === 'POST /api/backup/import' ? 'backup-upload' : 'json') as 'backup-upload' | 'json' },
    ...(STREAMING_ROUTE_KEYS.has(key) ? { response: 'stream' as const } : {}),
  };
  // A legacy handler accepts a nullable user id, so it serves either auth level.
  const run = handler as unknown as (req: RouteRequest, userId: string | null, body: unknown, res: ServerResponse) => Promise<RouteResponse | undefined>;
  return PUBLIC_ROUTE_KEYS.has(key) ? { auth: 'public', ...policy, handler: run } : { auth: 'user', ...policy, handler: run };
}

function legacyRoutes(table: LegacyRouteTable): RouteTable {
  return defineRoutes(Object.fromEntries(Object.entries(table).map(([key, handler]) => [key, legacyRouteSpec(key, handler)])));
}

export { legacyRoutes, legacyRouteSpec, PUBLIC_ROUTE_KEYS, BODY_LIMIT_BY_ROUTE, BODY_LIMIT_BY_PATH_PREFIX, STREAMING_ROUTE_KEYS, bodyLimitFor };
export type { LegacyHandler, LegacyRouteTable };
