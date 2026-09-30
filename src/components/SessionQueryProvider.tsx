import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Mount with the session identity as its key: private data never crosses sessions. */
export function SessionQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());

  useEffect(() => () => {
    // clear() destroys query observers and cancels pending query results, even for
    // older endpoints that do not consume an AbortSignal yet.
    client.clear();
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
