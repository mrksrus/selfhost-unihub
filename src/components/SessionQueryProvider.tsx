import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerEventsProvider } from '@/components/ServerEventsProvider';

/**
 * Mount with the session identity as its key: private data never crosses sessions.
 * liveUpdates opens the live status stream; pass it only for an authenticated
 * online session, never for a cached offline profile.
 */
export function SessionQueryProvider({ children, liveUpdates = false }: { children: ReactNode; liveUpdates?: boolean }) {
  const [client] = useState(() => new QueryClient());

  useEffect(() => () => {
    // clear() destroys query observers and cancels pending query results, even for
    // older endpoints that do not consume an AbortSignal yet.
    client.clear();
  }, [client]);

  return (
    <QueryClientProvider client={client}>
      <ServerEventsProvider enabled={liveUpdates}>{children}</ServerEventsProvider>
    </QueryClientProvider>
  );
}
