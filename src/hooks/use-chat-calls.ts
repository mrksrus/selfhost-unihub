import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import { acquireChatCalls, type CallView, type ChatCalls } from '@/lib/chat/call';
import { callSupport } from '@/lib/platform';

const none = () => () => undefined;

/**
 * The signed-in person's calls on this page and the call to show, shared by
 * every caller on the page; null while signed out, while Chat is off for the
 * person, and where this page does not run calls itself (callSupport()).
 */
export function useChatCalls(): { calls: ChatCalls; call: CallView | null } | null {
  const { user } = useAuth();
  const { isEnabled } = useModules();
  const id = user && isEnabled('chat') && callSupport() === 'page' ? user.id : null;
  const [held, setHeld] = useState<{ id: string; calls: ChatCalls } | null>(null);

  useEffect(() => {
    if (!id) return;
    const acquired = acquireChatCalls(id);
    setHeld({ id, calls: acquired.calls });
    return () => {
      acquired.release();
      setHeld(null);
    };
  }, [id]);

  // Never the previous person's calls, not even for the render before the effect.
  const calls = held && held.id === id ? held.calls : null;
  const call = useSyncExternalStore(calls?.subscribe ?? none, () => calls?.snapshot() ?? null);
  return calls ? { calls, call } : null;
}
