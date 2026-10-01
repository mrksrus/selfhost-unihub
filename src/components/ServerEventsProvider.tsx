import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ServerEventsContext } from '@/hooks/use-server-events';
import { startServerEvents } from '@/lib/server-events';

/**
 * Opens the live status stream for the current session. Mount it inside
 * SessionQueryProvider so the stream, like the query cache, ends with the
 * session and never outlives an account switch.
 */
export function ServerEventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const stop = startServerEvents({ client, onConnectedChange: setConnected });
    return () => {
      stop();
      setConnected(false);
    };
  }, [client, enabled]);

  return <ServerEventsContext.Provider value={enabled && connected}>{children}</ServerEventsContext.Provider>;
}
