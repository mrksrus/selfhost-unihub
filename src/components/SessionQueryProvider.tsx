import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerEventsProvider } from '@/components/ServerEventsProvider';
import { clearToasts } from '@/hooks/use-toast';
import { SessionScopeContext, type SessionScope } from '@/lib/session-scope';

/**
 * Mount with the session identity as its key: private data never crosses sessions.
 * liveUpdates opens the live status stream; pass it only for an authenticated
 * online session, never for a cached offline profile. privateSession (a signed-in
 * user) makes the end of the session also remove the notices shown in it, which
 * can name that account's data; the sign-in page's own notices stay.
 */
export function SessionQueryProvider({ children, liveUpdates = false, privateSession = false }: { children: ReactNode; liveUpdates?: boolean; privateSession?: boolean }) {
  const [client] = useState(() => new QueryClient());
  const [scope] = useState<SessionScope>(() => ({ ended: false }));
  // Fixed for the provider's life: it is keyed by the user, so signing in or out mounts a new one.
  const [endsPrivate] = useState(privateSession);

  useEffect(() => () => {
    // Late answers of this session check the scope (src/lib/session-scope.ts).
    scope.ended = true;
    if (endsPrivate) clearToasts();
    // clear() destroys query observers and cancels pending query results, even for
    // older endpoints that do not consume an AbortSignal yet.
    client.clear();
  }, [client, scope, endsPrivate]);

  return (
    <SessionScopeContext.Provider value={scope}>
      <QueryClientProvider client={client}>
        <ServerEventsProvider enabled={liveUpdates}>{children}</ServerEventsProvider>
      </QueryClientProvider>
    </SessionScopeContext.Provider>
  );
}
