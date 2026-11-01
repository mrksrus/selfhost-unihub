import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import type { RoutePolicy, RouteSpec, RouteTable } from '../http/route';
import { DEFAULT_BODY_LIMIT, MUTATING_METHODS, defineRoutes } from '../http/route';
import { getModuleForPath } from '../services/module-catalog';
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
  'GET /api/backup/export',
]);

// Request body limits in bytes for the routes that carry files, archives,
// imports, bulk selections, or text columns sized well beyond the default.
const BODY_LIMIT_BY_ROUTE: Readonly<Record<string, number>> = {
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
function bodyLimitFor(routeKey: string) {
  return BODY_LIMIT_BY_ROUTE[routeKey] ?? DEFAULT_BODY_LIMIT;
}

// Restore sections of the route files still on the derived policy, by path
// prefix: a write under a module's prefix is read-only while that module's
// section is being restored. Backup routes run the restore themselves.
const RESTORE_SECTION_BY_PATH_PREFIX: readonly [string, string][] = [
  ['/api/calendar', 'calendar'],
  ['/api/mail', 'mail'],
  ['/api/recordings', 'recordings'],
];
function restoreSectionFor(method: string, pathname: string) {
  if (!MUTATING_METHODS.has(method)) return undefined;
  if (pathname.startsWith('/api/backup/')) return null;
  return RESTORE_SECTION_BY_PATH_PREFIX.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + '/'))?.[1] ?? null;
}

// Routes the service worker calls with X-Background-Sync: 1 instead of a CSRF
// token: a non-blocking mail sync while the app window is closed, and
// finishing a recording upload saved on the device.
const BACKGROUND_HEADER_CSRF_KEYS: ReadonlySet<string> = new Set([
  'POST /api/mail/sync/background',
  'POST /api/recordings/uploads/start',
  'POST /api/recordings/uploads/:id/chunk',
  'POST /api/recordings/uploads/:id/complete',
  'DELETE /api/recordings/uploads/:id',
]);

// F13: the data-safety policies of these routes (http/route.ts).
// - DELETE /api/mail/accounts/:id disconnects an account, or with purge=true
//   deletes the disconnected account with UniHub's copy of its mail
//   (disconnect=true does both in one step).
// - Deleting a calendar account removes UniHub's copy only; the provider keeps
//   its calendars.
// - Deleting an event, a task, a local calendar with its events or a recording
//   removes it for good, which bin.delete forbids, until these deletes move
//   items to the bin (0.28 stream B), which drops the key here.
// - The backup routes: creating, restoring and deleting backups.
// Turning a mail account's linked calendar on or off depends on the body and
// is checked in its service, as are the mail modes and provider deletion.
const POLICIES_BY_ROUTE: Readonly<Record<string, Pick<RoutePolicy, 'destructive' | 'requires'>>> = {
  'POST /api/mail/accounts': { requires: ['accounts.add'] },
  'DELETE /api/mail/accounts/:id': { destructive: ['accounts.remove', { policy: 'accounts.reset', query: { purge: 'true' } }] },
  'POST /api/mail/accounts/:id/backup-export': { requires: ['backup.create'] },
  'POST /api/calendar/accounts': { requires: ['accounts.add'] },
  'DELETE /api/calendar/accounts/:id': { destructive: ['accounts.remove'] },
  'DELETE /api/calendar/calendars/:id': { destructive: ['bin.delete'] },
  'DELETE /api/calendar/events/:id': { destructive: ['bin.delete'] },
  'DELETE /api/recordings/:id': { destructive: ['bin.delete'] },
  'POST /api/backup/jobs': { requires: ['backup.create'] },
  'POST /api/backup/import': { requires: ['backup.restore'] },
  'POST /api/backup/jobs/:id/restore': { requires: ['backup.restore'] },
  'POST /api/backup/restore-jobs/:id/start': { requires: ['backup.restore'] },
  'DELETE /api/backup/jobs/:id': { destructive: ['backup.delete'] },
  'DELETE /api/backup/restore-jobs/:id': { destructive: ['backup.delete'] },
};

function legacyRouteSpec(key: string, handler: LegacyHandler): RouteSpec {
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const pathname = key.slice(space + 1);
  const policy = {
    module: getModuleForPath(pathname),
    restoreSection: restoreSectionFor(method, pathname),
    body: { limit: bodyLimitFor(key), kind: (key === 'POST /api/backup/import' ? 'backup-upload' : 'json') as 'backup-upload' | 'json' },
    ...(BACKGROUND_HEADER_CSRF_KEYS.has(key) ? { csrf: 'background-header' as const } : {}),
    ...POLICIES_BY_ROUTE[key],
  };
  // A legacy handler accepts a nullable user id, so it serves either auth level.
  const run = handler as unknown as (req: RouteRequest, userId: string | null, body: unknown, res: ServerResponse) => Promise<RouteResponse | undefined>;
  return PUBLIC_ROUTE_KEYS.has(key) ? { auth: 'public', ...policy, handler: run } : { auth: 'user', ...policy, handler: run };
}

function legacyRoutes(table: LegacyRouteTable): RouteTable {
  return defineRoutes(Object.fromEntries(Object.entries(table).map(([key, handler]) => [key, legacyRouteSpec(key, handler)])));
}

export { legacyRoutes, legacyRouteSpec, PUBLIC_ROUTE_KEYS, BODY_LIMIT_BY_ROUTE, RESTORE_SECTION_BY_PATH_PREFIX, BACKGROUND_HEADER_CSRF_KEYS, POLICIES_BY_ROUTE, bodyLimitFor };
export type { LegacyHandler, LegacyRouteTable };
