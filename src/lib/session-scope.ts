// The lifetime of one signed-in session in this page. SessionQueryProvider is
// mounted per session (keyed by the user) and ends its scope when it unmounts:
// on an account switch, a sign-out or an expired session. A request started in
// a session may answer after it ended; its callbacks check the scope before
// they show a notice, write a cache, save a file or send the next request, so
// nothing of the previous account reaches the next one.
import { createContext, useContext } from 'react';

export interface SessionScope {
  ended: boolean;
}

// Outside a session provider (unit tests of a single view) nothing ends.
const OPEN_SCOPE: SessionScope = { ended: false };

export const SessionScopeContext = createContext<SessionScope>(OPEN_SCOPE);

/** The scope of the session this component renders in; read `ended` after every await. */
export function useSessionScope() {
  return useContext(SessionScopeContext);
}

/** A callback that does nothing once the session it was created in has ended. */
export function whileSession<A extends unknown[]>(scope: SessionScope, callback: (...args: A) => void) {
  return (...args: A) => { if (!scope.ended) callback(...args); };
}
