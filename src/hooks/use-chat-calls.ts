import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { useAppLock } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { useUserSettings } from '@/hooks/use-settings';
import { onAppEvent } from '@/lib/app-events';
import { chatApi } from '@/lib/chat-api';
import { acquireChatCalls, type CallView, type ChatCalls } from '@/lib/chat/call';
import { callSupport, handCallToApp } from '@/lib/platform';

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

/**
 * In an Android app that takes calls the main page runs none (useChatCalls is
 * null there): a call ringing for the person that this page hears of first
 * (the hint, or the only way while the app's notifications are off) rings
 * through the app, and its ring stops once the call stops ringing. Mounted once.
 */
export function useHandCallsToApp() {
  const { user } = useAuth();
  const { isEnabled } = useModules();
  const lock = useAppLock();
  const hidden = useRef(false);
  hidden.current = useUserSettings().values.chat_notification_detail === 'none' || lock.locked('chat');
  const id = user && isEnabled('chat') && callSupport() === 'app' ? user.id : null;

  useEffect(() => {
    if (!id) return;
    let ringing: string | null = null;
    let stopped = false;
    const check = async () => {
      const call = await chatApi.currentCall().catch(() => undefined);
      if (stopped || call === undefined) return;
      if (call?.state === 'ringing' && call.callee_user_id === id) {
        if (ringing !== call.id) handCallToApp(call.id, 'ring', hidden.current ? 'Incoming call' : call.caller_name);
        ringing = call.id;
      } else if (ringing) {
        handCallToApp(ringing, 'end', '');
        ringing = null;
      }
    };
    const later = () => void check();
    const onVisible = () => { if (document.visibilityState === 'visible') later(); };
    const stops = [onAppEvent('unihub:chat-call', later), onAppEvent('unihub:chat-changed', changed => { if (changed === null) later(); })];
    document.addEventListener('visibilitychange', onVisible);
    later();
    return () => { stopped = true; stops.forEach(stop => stop()); document.removeEventListener('visibilitychange', onVisible); };
  }, [id]);
}
