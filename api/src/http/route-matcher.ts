import type { ApiError } from '../types';

// Resolves a request to a key of the route table ('METHOD /path/:param').
//
// Matching is by whole path segment: an exact key wins, then the parameterized
// keys of the same method, trying the one with the most literal segments first
// (so a literal sibling such as /subtasks/reorder is never taken for a
// /subtasks/:subtaskId). Among equals, a literal beats a parameter at the
// first segment where they differ. A :param stands for exactly one non-empty
// segment and is percent-decoded; malformed encoding is a 400.
interface RouteMatch { key: string; params: Record<string, string> }
interface RoutePattern { key: string; segments: string[]; literals: number; shape: string }

function compileRouteMatcher(keys: Iterable<string>) {
  const exact = new Set<string>();
  const patterns = new Map<string, RoutePattern[]>();
  for (const key of keys) {
    const space = key.indexOf(' ');
    const method = key.slice(0, space);
    const path = key.slice(space + 1);
    if (!/^\/(?:[^/]*\/)*[^/]*$/.test(path) || !method) throw new Error(`Invalid route key: ${key}`);
    if (!path.includes('/:')) { exact.add(key); continue; }
    const segments = path.split('/').slice(1);
    if (segments.some(segment => !segment || (segment.startsWith(':') && segment.length === 1))) throw new Error(`Invalid route key: ${key}`);
    const literals = segments.filter(segment => !segment.startsWith(':')).length;
    const shape = segments.map(segment => (segment.startsWith(':') ? 'P' : 'L')).join('');
    if (!patterns.has(method)) patterns.set(method, []);
    patterns.get(method)!.push({ key, segments, literals, shape });
  }
  for (const list of patterns.values()) {
    list.sort((a, b) => b.literals - a.literals || (a.shape < b.shape ? -1 : a.shape > b.shape ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return function matchRoute(method: string, pathname: string): RouteMatch | null {
    const key = `${method} ${pathname}`;
    if (exact.has(key)) return { key, params: {} };
    const segments = pathname.split('/').slice(1);
    for (const pattern of patterns.get(method) || []) {
      if (pattern.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < segments.length && matched; index++) {
        const expected = pattern.segments[index];
        const actual = segments[index];
        if (expected.startsWith(':')) {
          if (!actual) matched = false;
          else params[expected.slice(1)] = actual;
        } else if (expected !== actual) matched = false;
      }
      if (!matched) continue;
      for (const name of Object.keys(params)) {
        try { params[name] = decodeURIComponent(params[name]); }
        catch { throw Object.assign(new Error('Invalid request address'), { status: 400 }) as ApiError; }
      }
      return { key: pattern.key, params };
    }
    return null;
  };
}

export { compileRouteMatcher };
export type { RouteMatch };
