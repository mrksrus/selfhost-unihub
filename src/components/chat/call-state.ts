// What the call screens share: who can be called from where and why not, the
// words for a call's states and endings, and the sound, title and timers of
// the call on show.
import { useContext, useEffect, useReducer, useState } from 'react';
import { AuthContext } from '@/contexts/auth-context';
import { useAppLock } from '@/hooks/use-app-lock';
import { useChatCalls } from '@/hooks/use-chat-calls';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { usePolicy } from '@/hooks/use-policies';
import { useUserSettings } from '@/hooks/use-settings';
import type { CallView, ChatCalls } from '@/lib/chat/call';
import { playCallSound } from '@/lib/chat/call-sound';
import { androidApp, callSupport, placeCallInApp } from '@/lib/platform';
import { clock } from '@/components/chat/chat-state';

/** Who can be called: a colleague by their account, with what a chat knows of them. */
export interface CallPerson { user_id?: string | null; name: string; can_write?: boolean; reason?: string | null }

// People the server refused a call to under the administrator's rule, with its
// sentence: the page learns that rule only by asking, and keeps it until it is loaded again.
// Kept per signed-in person: the next account in this tab has rules of its own.
const forbidden = new Map<string, string>();
const refusal = (ownId: string | undefined, userId: string) => `${ownId}:${userId}`;

/**
 * Calling a colleague from here: `start`, and `reason` while a call cannot be
 * placed (the button stays, greyed, and says it). Null where no call is
 * offered: nobody to call, oneself, or Chat is off.
 */
export function useCallTo(person: CallPerson | undefined): { reason: string | undefined; start: () => void } | null {
  const ownId = useContext(AuthContext)?.user?.id;
  const engine = useChatEngine();
  const held = useChatCalls();
  const rule = usePolicy('chat.calls').lock;
  const lock = useAppLock();
  const userId = person?.user_id;
  if (!engine || !person || !userId || userId === ownId) return null;
  const call = held?.call;
  const support = callSupport();
  const reason = rule
    ?? (person.can_write === false ? person.reason ?? `${person.name} cannot be called now.` : undefined)
    ?? forbidden.get(refusal(ownId, userId))
    ?? (lock.locked('chat') ? 'Unlock Chat to call.'
      : support === 'app' ? undefined
      : support !== 'page' ? 'This browser cannot make calls.'
      : call?.ended === 'other-tab' ? 'You are on a call in another tab.'
      : call && call.state !== 'ended' ? 'You are on a call.' : undefined);
  // By the person, also from their chat: a refusal is then known to be about them.
  // The app's call screen starts it and shows a refusal; this page holds no call.
  if (support === 'app') return { reason, start: () => placeCallInApp(userId, person.name) };
  return { reason, start: () => { void held?.calls.start({ user_id: userId }, person.name).catch(() => undefined); } };
}

const CLOSES_AFTER_MS = 3000;
const ALLOW_MICROPHONE = androidApp() ? 'Allow it under Android settings › Apps › UniHub › Permissions.' : 'Allow it with the icon beside the address, or in your browser\'s settings for this site.';

/** Endings with nothing to read: the screen closes itself. */
const closesItself = (call: CallView) => call.ended === 'hung-up' || call.ended === 'answered-elsewhere' || (call.ended === 'cancelled' && !call.incoming);

/** How long the call has run, as 3:07. */
export const callTime = (call: CallView) => clock(call.answered_at ? Math.max(0, (Date.now() - Date.parse(call.answered_at)) / 1000) : 0);

/** What the call is doing, in a word; an ended call says how it ended. */
export function callWords(call: CallView, name: string | null, connected: boolean) {
  // Without the name (Chat is locked here) only calls that came in are shown.
  const who = name ?? 'The caller';
  if (call.state !== 'ended') return { calling: 'Calling…', ringing: 'Voice call', connecting: 'Connecting…', active: 'Connected', reconnecting: 'Reconnecting…' }[call.state];
  switch (call.ended) {
    case 'declined': return `${who} declined the call.`;
    case 'busy': return call.reason ?? `${who} is on another call.`;
    case 'no-answer': return `${who} did not answer.`;
    case 'cancelled': return call.incoming ? `${who} hung up before you answered.` : 'Call cancelled.';
    case 'failed': return call.reason ?? (connected ? 'The connection was lost and did not come back.' : 'Could not connect. Your administrator may need to set up the relay for calls.');
    case 'answered-elsewhere': return 'Answered on another device.';
    case 'other-tab': return 'You are on a call in another tab.';
    case 'microphone': return call.reason?.includes('no microphone') ? call.reason : `${call.reason ?? 'The microphone could not be used.'} ${ALLOW_MICROPHONE}`;
    case 'refused': return call.reason ?? 'The call could not be started.';
    default: return 'Call ended.';
  }
}

/**
 * What every place that shows the call shares: its sound, the tab's title and
 * a system notification while it rings, the endings that close themselves, and
 * the name to show: none while Chat is locked on this device.
 */
export function useCallScreen(held: { calls: ChatCalls; call: CallView | null } | null) {
  const call = held?.call ?? null;
  const calls = held?.calls;
  const lock = useAppLock();
  const ownId = useContext(AuthContext)?.user?.id;
  const quiet = useUserSettings().values.chat_notification_detail === 'none';
  const name = call && !lock.locked('chat') ? call.peer.name : null;
  const title = name ? `${name} is calling` : 'Incoming call';
  const ringing = call?.state === 'ringing';
  const sound = call?.sound;
  // Whether this call's sound ever flowed: a failure before that is one of connecting, not of a lost connection.
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [, tick] = useReducer((count: number) => count + 1, 0);
  const active = call?.state === 'active';

  useEffect(() => (sound ? playCallSound(sound) : undefined), [sound]);
  useEffect(() => {
    if (!ringing) return;
    const before = document.title;
    document.title = title;
    let notice: Notification | undefined;
    // For a page that is not in front, where the person allowed notifications. Browsers that take none from a page (Android's) refuse here.
    try {
      if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        notice = new Notification(quiet ? 'Incoming call' : title, { tag: 'unihub-call', requireInteraction: true });
        notice.onclick = () => { window.focus(); };
      }
    } catch { /* The dialog and the title remain. */ }
    return () => { document.title = before; notice?.close(); };
  }, [ringing, title, quiet]);
  useEffect(() => {
    if (!call) return;
    if (call.state === 'active') setConnectedId(call.id);
    if (call.forbidden && call.peer.user_id && call.reason) forbidden.set(refusal(ownId, call.peer.user_id), call.reason);
    if (!closesItself(call)) return;
    const timer = setTimeout(() => calls?.dismiss(), CLOSES_AFTER_MS);
    return () => clearTimeout(timer);
  }, [call, calls, ownId]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active]);

  return { call, name, title, connected: !!call?.id && connectedId === call.id };
}
