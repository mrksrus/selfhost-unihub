import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import { compileRouteMatcher } from './route-matcher';

// A route is declared with its policy. request-handler.ts reads only the spec:
// who may call it, which module and restore section gate it, how large and of
// what kind its body may be, which CSRF rule applies and whether the handler
// writes the response itself. A handler of a 'user' or 'admin' route receives
// a signed-in user id; the boundary has already refused anyone else.
type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type RouteAuth = 'public' | 'user' | 'admin';
type RouteBodyKind = 'json' | 'backup-upload' | 'none';
type RouteCsrf = 'token' | 'background-header' | 'none';
type RouteResponseMode = 'json' | 'stream';

interface RoutePolicy {
  // A module id gates the route behind that module's switch; null is a core route.
  module?: string | null;
  // The recovery section whose running restore makes this route read-only;
  // '*' refuses during any restore. Required on POST/PUT/DELETE outside
  // /api/backup and /api/auth; an explicit null states that the route writes
  // nothing a restore replaces.
  restoreSection?: string | null;
  body?: { limit?: number; kind?: RouteBodyKind };
  // 'token' is the cookie/header pair; 'background-header' additionally accepts
  // the service worker's X-Background-Sync header; 'none' is for the routes
  // that issue the token. The bearer-without-cookie rule is global (auth.ts).
  csrf?: RouteCsrf;
  // 'stream': the handler may write and own the response (SSE); the boundary
  // serializes nothing once headers were sent.
  response?: RouteResponseMode;
}
// Method signatures so a handler declared with a narrower request or body
// type (`body: Input`) is accepted; the body stays untrusted at dispatch.
interface PublicRouteSpec extends RoutePolicy {
  auth: 'public';
  handler(req: RouteRequest, userId: string | null, body: unknown, res: ServerResponse): Promise<RouteResponse | undefined>;
}
interface UserRouteSpec extends RoutePolicy {
  auth: 'user' | 'admin';
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
const BODY_KINDS = new Set<string>(['json', 'backup-upload', 'none']);
const CSRF_VALUES = new Set<string>(['token', 'background-header', 'none']);
const RESPONSE_MODES = new Set<string>(['json', 'stream']);

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
    if (spec.module !== undefined && spec.module !== null && typeof spec.module !== 'string') invalid(key, 'module must be an id or null');
    if (spec.restoreSection !== undefined && spec.restoreSection !== null && typeof spec.restoreSection !== 'string') invalid(key, 'restoreSection must be a section, "*" or null');
    if (spec.body !== undefined) {
      if (spec.body.limit !== undefined && (!Number.isInteger(spec.body.limit) || spec.body.limit <= 0)) invalid(key, 'body.limit must be a positive integer');
      if (spec.body.kind !== undefined && !BODY_KINDS.has(spec.body.kind)) invalid(key, `unknown body kind ${String(spec.body.kind)}`);
    }
    if (spec.csrf !== undefined && !CSRF_VALUES.has(spec.csrf)) invalid(key, `unknown csrf ${String(spec.csrf)}`);
    if (spec.response !== undefined && !RESPONSE_MODES.has(spec.response)) invalid(key, `unknown response ${String(spec.response)}`);
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
  // Keys under these prefixes may omit restoreSection: backup routes run the
  // restore, auth routes sign in and out.
  restoreExemptPrefixes?: readonly string[];
}

// Whole-table rules, checked at startup and by the policy test: a module route
// declares its module, a mutating route states its restore section, and every
// key resolves through the matcher.
function assertRouteTable(table: RouteTable, { moduleIds, restoreExemptPrefixes = ['/api/backup/', '/api/auth/'] }: RouteTableInvariants) {
  const match = compileRouteMatcher(Object.keys(table));
  for (const [key, spec] of Object.entries(table)) {
    const { method, path } = splitRouteKey(key);
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

export { defineRoutes, mergeRouteTables, assertRouteTable, DEFAULT_BODY_LIMIT, MUTATING_METHODS };
export type { RouteSpec, RouteTable, RoutePolicy, RouteAuth, RouteBodyKind, RouteCsrf, RouteResponseMode, PublicRouteSpec, UserRouteSpec };
