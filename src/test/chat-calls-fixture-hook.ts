// Stands in for src/hooks/use-chat-calls.ts in the build the reference
// pictures are taken from (tools/ui-regression/support/vite-build.mts): the
// call a test asked for before the page loaded, or none, with actions that do
// nothing. No server, no microphone and no sound.
import type { CallView, ChatCalls } from '@/lib/chat/call';

const asked = (window as { uiRegressionCall?: Partial<CallView> }).uiRegressionCall;
const call: CallView | null = asked ? {
  id: 'call-1', conversation_id: 'chat-blair', peer: { user_id: 'user-blair', name: 'Blair Example' }, incoming: false, state: 'active', ended: null, reason: null,
  answered_at: null, muted: false, here: true, sound: null, silenced: false, forbidden: false, ...asked,
} : null;
const nothing = async () => undefined;
const calls: ChatCalls = { subscribe: () => () => undefined, snapshot: () => call, sync: nothing, start: nothing, answer: nothing, decline: nothing, hangUp: nothing, mute: () => undefined, play: () => undefined, dismiss: () => undefined };
const held = { calls, call };

export const useChatCalls = () => held;
export const useHandCallsToApp = () => undefined;
