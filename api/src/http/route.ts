import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import type { Permission } from '../security/permissions';
import { compileRouteMatcher } from './route-matcher';
import { isPermission } from '../security/permissions';

// A route is declared with its policy. request-handler.ts reads only the spec:
// who may call it, which module and restore section gate it, how large and of
// what kind its body may be, which CSRF rule applies and whether the handler
// writes the response itself. A handler of a 'user' or 'admin' route receives
// a signed-in user id; the boundary has already refused anyone else.
type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type RouteAuth = 'public' | 'user' | 'admin';
type RouteBodyKind = 'json' | 'backup-upload' | 'upload' | 'none';
type RouteCsrf = 'token' | 'background-header' | 'none';
type RouteResponseMode = 'json' | 'stream';

// The body a route with kind 'upload' receives: the raw request body, spooled
// by the boundary to a private file under the uploads root and bounded by the
// route's limit. The file exists while the handler runs and is removed when it
// returns or throws, also after the client disconnected; a handler that keeps
// the bytes moves or copies them first. An empty body never reaches a handler.
interface UploadBody {
  path: string;
  size: number;
  // The Content-Type header as sent ('' when absent) and its lower-case
  // type/subtype without parameters. Neither is trusted: sniff the content.
  contentType: string;
  mediaType: string;
}

// F13: the data-safety policies a destructive action is subject to, named by
// the route that removes or resets the data. 0.28 resolves them through the
// settings and policies owner (F1) and refuses a forbidden action at the
// boundary with POLICY_FORBIDS, before any side effect; until then the
// declaration is checked here and walked by the route policy test.
const DESTRUCTIVE_POLICIES = [
  // Removing a mail account: disconnecting it, or deleting the disconnected account.
  'accounts.mail.remove',
  // Deleting UniHub's copy of an account's mail; the provider keeps its mail.
  'accounts.mail.purge',
  // Deleting contacts for good. 0.28 resolves it: a delete becomes a bin move.
  'contacts.delete',
] as const;
type DestructivePolicy = typeof DESTRUCTIVE_POLICIES[number];
// A policy that applies to every request of the route, or only when each
// named query parameter has the given value (one route, several actions).
type DestructiveDeclaration = DestructivePolicy | { policy: DestructivePolicy; query: Readonly<Record<string, string>> };

interface RoutePolicy {
  // A module id gates the route behind that module's switch; null is a core route.
  module?: string | null;
  // The recovery section whose running restore makes this route read-only;
  // '*' refuses during any restore. Required on POST/PUT/DELETE outside
  // /api/backup and /api/auth; an explicit null states that the route writes
  // nothing a restore replaces.
  restoreSection?: string | null;
  // kind 'upload' hands the handler an UploadBody instead of parsed JSON.
  body?: { limit?: number; kind?: RouteBodyKind };
  // 'token' is the cookie/header pair; 'background-header' additionally accepts
  // the service worker's X-Background-Sync header; 'none' is for the routes
  // that issue the token. The bearer-without-cookie rule is global (auth.ts).
  csrf?: RouteCsrf;
  // 'stream': the handler may write and own the response (SSE); the boundary
  // serializes nothing once headers were sent.
  response?: RouteResponseMode;
  // F13: the policies of the data this route removes or resets (mutating routes only).
  destructive?: readonly DestructiveDeclaration[];
}
// Method signatures so a handler declared with a narrower request or body
// type (`body: Input`) is accepted; the body stays untrusted at dispatch.
interface PublicRouteSpec extends RoutePolicy {
  auth: 'public';
  handler(req: RouteRequest, userId: string | null, body: unknown, res: ServerResponse): Promise<RouteResponse | undefined>;
}
interface UserRouteSpec extends RoutePolicy {
  auth: 'user' | 'admin';
  // Required with 'admin': what the caller's role must grant (security/permissions.ts).
  permission?: Permission;
  handler(req: RouteRequest, userId: string, body: unknown, res: ServerResponse): Promise<RouteResponse | undefined>;
}
type RouteSpec = PublicRouteSpec | UserRouteSpec;
type RouteTable = Record<string, RouteSpec>;

const ROUTE_METHODS: readonly RouteMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];
const MUTATING_METHODS = new Set<string>(['POST', 'PUT', 'DELETE']);
// The small JSON documents most routes take, with room for the ordinary text
// their validators accept; a route carrying more declares body.limit.
const DEFAULT_BODY_LIMIT = 16384;
const AUTH_VALUES = new Set<string>(['public', 'user', 'admin']);
const BODY_KINDS = new Set<string>(['json', 'backup-upload', 'upload', 'none']);
const CSRF_VALUES = new Set<string>(['token', 'background-header', 'none']);
const RESPONSE_MODES = new Set<string>(['json', 'stream']);
const isDestructivePolicy = (value: unknown): value is DestructivePolicy => DESTRUCTIVE_POLICIES.includes(value as DestructivePolicy);

function splitRouteKey(key: string) {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

function invalid(key: string, reason: string): never {
  throw new Error(`Invalid route ${key}: ${reason}`);
}

// Checks one file's table and freezes each spec. Keys keep the shape the
// matcher accepts; the matcher itself validates segments when the merged
// table is compiled.
function defineRoutes<T extends RouteTable>(table: T): T {
  for (const [key, spec] of Object.entries(table)) {
    const { method, path } = splitRouteKey(key);
    if (!ROUTE_METHODS.includes(method as RouteMethod) || !path.startsWith('/')) invalid(key, 'key must be "METHOD /path"');
    if (!spec || typeof spec !== 'object' || typeof spec.handler !== 'function') invalid(key, 'spec needs a handler');
    if (!AUTH_VALUES.has(spec.auth)) invalid(key, `unknown auth ${String(spec.auth)}`);
    const permission = (spec as { permission?: unknown }).permission;
    if (spec.auth === 'admin' && !isPermission(permission)) invalid(key, 'an admin route declares the permission it needs');
    if (spec.auth !== 'admin' && permission !== undefined) invalid(key, 'only an admin route declares a permission');
    if (spec.module !== undefined && spec.module !== null && typeof spec.module !== 'string') invalid(key, 'module must be an id or null');
    if (spec.restoreSection !== undefined && spec.restoreSection !== null && typeof spec.restoreSection !== 'string') invalid(key, 'restoreSection must be a section, "*" or null');
    if (spec.body !== undefined) {
      if (spec.body.limit !== undefined && (!Number.isInteger(spec.body.limit) || spec.body.limit <= 0)) invalid(key, 'body.limit must be a positive integer');
      if (spec.body.kind !== undefined && !BODY_KINDS.has(spec.body.kind)) invalid(key, `unknown body kind ${String(spec.body.kind)}`);
    }
    if (spec.csrf !== undefined && !CSRF_VALUES.has(spec.csrf)) invalid(key, `unknown csrf ${String(spec.csrf)}`);
    if (spec.response !== undefined && !RESPONSE_MODES.has(spec.response)) invalid(key, `unknown response ${String(spec.response)}`);
    if (spec.destructive !== undefined) {
      if (!MUTATING_METHODS.has(method)) invalid(key, 'only a mutating route is destructive');
      if (!Array.isArray(spec.destructive) || !spec.destructive.length) invalid(key, 'destructive lists at least one policy');
      for (const entry of spec.destructive) {
        const conditional = typeof entry === 'object' && entry !== null;
        if (!isDestructivePolicy(conditional ? entry.policy : entry)) invalid(key, `unknown destructive policy ${JSON.stringify(entry)}`);
        if (conditional && (!entry.query || !Object.keys(entry.query).length || !Object.values(entry.query).every(value => typeof value === 'string'))) {
          invalid(key, 'a conditional destructive policy names its query values');
        }
      }
    }
    Object.freeze(spec);
  }
  return table;
}

// The production table is the union of the feature files. A key declared
// twice is a mistake, not a precedence rule.
function mergeRouteTables(...tables: RouteTable[]): RouteTable {
  const merged: RouteTable = {};
  for (const table of tables) {
    for (const [key, spec] of Object.entries(table)) {
      if (key in merged) throw new Error(`Duplicate route ${key}`);
      merged[key] = spec;
    }
  }
  return merged;
}

interface RouteTableInvariants {
  // Ids whose /api/<id>/ prefix must declare that module.
  moduleIds: readonly string[];
  // Recovery sections with tables; each must be written by at least one route,
  // or a restore of it would lock nothing.
  sections?: readonly string[];
  // Keys under these prefixes may omit restoreSection: backup routes run the
  // restore, auth routes sign in and out.
  restoreExemptPrefixes?: readonly string[];
}

// Whole-table rules, checked at startup and by the policy test: an admin route
// declares auth 'admin', a module route declares its module, a mutating route
// states its restore section, every section has a write route, and every key
// resolves through the matcher.
function assertRouteTable(table: RouteTable, { moduleIds, sections = [], restoreExemptPrefixes = ['/api/backup/', '/api/auth/'] }: RouteTableInvariants) {
  const match = compileRouteMatcher(Object.keys(table));
  for (const section of sections) {
    if (!Object.values(table).some(spec => spec.restoreSection === section)) throw new Error(`Invalid route table: no route writes section ${section}`);
  }
  for (const [key, spec] of Object.entries(table)) {
    const { method, path } = splitRouteKey(key);
    if (path.startsWith('/api/admin/') && spec.auth !== 'admin') invalid(key, 'routes under /api/admin/ must declare auth "admin"');
    const moduleId = moduleIds.find(id => path === `/api/${id}` || path.startsWith(`/api/${id}/`));
    if (moduleId && spec.module !== moduleId) invalid(key, `routes under /api/${moduleId}/ must declare module "${moduleId}"`);
    if (MUTATING_METHODS.has(method) && spec.restoreSection === undefined && !restoreExemptPrefixes.some(prefix => path.startsWith(prefix))) {
      invalid(key, 'a mutating route must declare restoreSection (a section, "*" or null)');
    }
    const sample = path.replace(/:(\w+)/g, (_, name) => `sample-${name}`);
    const resolved = match(method, sample);
    if (!resolved || resolved.key !== key) invalid(key, `does not resolve from ${sample}`);
  }
}

/** The destructive policies one request of the route is subject to. */
function destructivePolicies(spec: Pick<RoutePolicy, 'destructive'>, query: URLSearchParams): DestructivePolicy[] {
  return (spec.destructive ?? []).flatMap(entry => typeof entry === 'string' ? [entry]
    : Object.entries(entry.query).every(([name, value]) => query.get(name) === value) ? [entry.policy] : []);
}

export { defineRoutes, mergeRouteTables, assertRouteTable, destructivePolicies, DEFAULT_BODY_LIMIT, MUTATING_METHODS, DESTRUCTIVE_POLICIES };
export type { UploadBody, RouteSpec, RouteTable, RoutePolicy, RouteAuth, RouteBodyKind, RouteCsrf, RouteResponseMode, PublicRouteSpec, UserRouteSpec, DestructivePolicy, DestructiveDeclaration };
