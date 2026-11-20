import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { useModules } from '@/hooks/use-modules';
import type { ChatEngine } from '@/lib/chat/types';

/**
 * The signed-in person's chat engine, shared by every caller on the page; null
 * while signed out, while Chat is off for the person (their switch or a
 * policy) and until the engine's code has loaded. Nothing of Chat is fetched
 * for a person without it.
 */
export function useChatEngine(): ChatEngine | null {
  const { user } = useAuth();
  const { isEnabled } = useModules();
  const id = user && isEnabled('chat') ? user.id : null;
  const name = user ? user.full_name || user.email : '';
  const [held, setHeld] = useState<{ id: string; engine: ChatEngine } | null>(null);

  useEffect(() => {
    if (!id) return;
    let release: (() => void) | undefined;
    let cancelled = false;
    void import('@/lib/chat/engine').then(({ acquireChatEngine }) => {
      if (cancelled) return;
      const acquired = acquireChatEngine({ id, name });
      release = acquired.release;
      setHeld({ id, engine: acquired.engine });
    });
    return () => {
      cancelled = true;
      release?.();
      setHeld(null);
    };
  }, [id, name]);

  // Never the previous person's engine, not even for the render before the effect.
  return held && held.id === id ? held.engine : null;
}
