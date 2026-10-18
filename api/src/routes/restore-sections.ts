import routes = require('./index');
import { compileRouteMatcher } from '../http/route-matcher';

// The restore section a request would be checked against: the matched route's
// restoreSection. Request handling reads the spec directly; this is for code
// that holds a method and path (restore locks, access policy, tests).
const matchRoute = compileRouteMatcher(Object.keys(routes));

function getRestoreSectionForWrite(method: string, pathname: string): string | null {
  const match = matchRoute(method, pathname);
  return match ? routes[match.key].restoreSection ?? null : null;
}

export { getRestoreSectionForWrite };
