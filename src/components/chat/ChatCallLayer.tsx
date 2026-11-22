import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { useChatCalls } from '@/hooks/use-chat-calls';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { CallBody } from '@/components/chat/CallScreen';
import { callTime, callWords, useCallScreen } from '@/components/chat/call-state';
import { chatHref } from '@/components/chat/chat-state';

// Bottom centre, clear of the page headers and above the bottom bar and a chat's field.
const BAR = 'fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] left-1/2 z-[60] flex h-10 max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-accent px-4 text-sm font-medium tabular-nums text-accent-foreground shadow-md touch:h-11';
// The focus goes to the dialog, not to a button: a key pressed for the page underneath answers and ends nothing.
const focusDialog = (event: Event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); };

/**
 * The person's call over whichever page is open, and over the lock screen: a
 * dialog while someone calls (Escape does nothing in it: only Answer and
 * Decline end the ringing here), then the call's screen. Escape and "Hide" put
 * that screen aside while the call goes on, and a bar at the bottom brings it
 * back; neither ever hangs up. Another tab's call shows as a line with no
 * controls.
 */
export function ChatCallLayer() {
  const held = useChatCalls();
  const { call, name, connected } = useCallScreen(held);
  const navigate = useNavigate();
  // The call whose screen was put aside.
  const [aside, setAside] = useState<string | null>(null);
  if (!held || !call) return null;
  const { calls } = held;

  if (call.ended === 'other-tab') return <p role="status" className={BAR}><Phone aria-hidden="true" className="h-4 w-4 shrink-0" />On a call in another tab</p>;
  if (call.state === 'ringing') {
    return (
      <AlertDialog open>
        <AlertDialogContent className="max-w-sm outline-none" onOpenAutoFocus={focusDialog} onEscapeKeyDown={event => event.preventDefault()}>
          <CallBody calls={calls} call={call} name={name} connected={connected} dialog="alert" onAnswer={() => void calls.answer()} />
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const live = call.state !== 'ended';
  const key = call.id ?? 'starting';
  if (live && aside === key) {
    return (
      <button type="button" className={`${BAR} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`}
        aria-label={`Back to the call${name ? ` with ${name}` : ''}`} onClick={() => setAside(null)}>
        <Phone aria-hidden="true" className="h-4 w-4 shrink-0" />{call.state === 'active' ? callTime(call) : callWords(call, name, connected)}
      </button>
    );
  }
  const close = () => (live ? setAside(key) : calls.dismiss());
  const chat = call.conversation_id;
  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent hideClose className="max-w-sm outline-none" onOpenAutoFocus={focusDialog}>
        <CallBody calls={calls} call={call} name={name} connected={connected} dialog="dialog" onAnswer={() => void calls.answer()} onHide={() => setAside(key)}
          onOpenChat={chat ? () => { navigate(chatHref(chat)); close(); } : undefined} />
      </DialogContent>
    </Dialog>
  );
}
