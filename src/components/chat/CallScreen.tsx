import { Mic, MicOff, Phone, PhoneOff, Volume2 } from 'lucide-react';
import type { CallView, ChatCalls } from '@/lib/chat/call';
import { callAudioRoutes } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { callTime, callWords } from '@/components/chat/call-state';

interface Props {
  calls: ChatCalls;
  call: CallView;
  name: string | null;
  connected: boolean;
  /** The dialog the call is drawn in, for its title and description; none on the call's own page. */
  dialog?: 'alert' | 'dialog';
  /** Answers; the call's own page names the call it was opened for. */
  onAnswer: () => void;
  onOpenChat?: () => void;
  /** Puts the screen aside while the call goes on. */
  onHide?: () => void;
}

/** The call: who, what it is doing, and what can be done now. */
export function CallBody({ calls, call, name, connected, dialog, onAnswer, onOpenChat, onHide }: Props) {
  const Title = dialog === 'alert' ? AlertDialogTitle : dialog === 'dialog' ? DialogTitle : 'h1';
  const Description = dialog === 'alert' ? AlertDialogDescription : dialog === 'dialog' ? DialogDescription : 'p';
  const { state } = call;
  const ringing = state === 'ringing';
  const ended = state === 'ended';
  const words = callWords(call, name, connected);
  const { routes, choose } = callAudioRoutes();

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <span aria-hidden="true" className="relative flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground">
        {(ringing || state === 'calling') && <span className="absolute inset-0 rounded-full border-2 border-accent motion-safe:animate-ping" />}
        {name ? name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : <Phone className="h-6 w-6" />}
      </span>
      <div className="max-w-full space-y-1.5">
        <Title className="break-words text-xl font-semibold leading-tight tracking-tight">{ringing ? (name ? `${name} is calling` : 'Incoming call') : name ?? 'Voice call'}</Title>
        {/* The time is not in the announced line: it would be read out every second. */}
        <Description role="status" className={cn('text-sm text-muted-foreground', state === 'active' && 'sr-only', ended && 'text-foreground')}>
          {ringing && !name ? 'You can answer without unlocking UniHub.' : words}
        </Description>
        {(state === 'active' || state === 'reconnecting') && (
          <p role="timer" aria-label="Call time" className={cn('text-3xl font-semibold tabular-nums tracking-tight', state === 'reconnecting' && 'text-muted-foreground')}>{callTime(call)}</p>
        )}
        {call.muted && !ended && <p className="text-sm text-muted-foreground">Your microphone is off.</p>}
      </div>
      {call.silenced && <Button variant="secondary" onClick={() => calls.play()}><Volume2 aria-hidden="true" />Tap for sound</Button>}
      <div className="flex w-full flex-wrap justify-center gap-2">
        {ringing ? <>
          <Button variant="destructive" className="min-w-28" onClick={() => void calls.decline()}><PhoneOff aria-hidden="true" />Decline</Button>
          <Button className="min-w-28" onClick={onAnswer}><Phone aria-hidden="true" />Answer</Button>
        </> : ended ? (
          call.ended !== 'other-tab' && <Button variant="outline" className="min-w-28" onClick={() => calls.dismiss()}>Close</Button>
        ) : <>
          <Button variant={call.muted ? 'secondary' : 'outline'} aria-pressed={call.muted} onClick={() => calls.mute(!call.muted)}>
            {call.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}Mute
          </Button>
          {routes.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline"><Volume2 aria-hidden="true" />{routes.find(route => route.active)?.name ?? 'Sound'}</Button></DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup value={routes.find(route => route.active)?.id} onValueChange={choose}>
                  {routes.map(route => <DropdownMenuRadioItem key={route.id} value={route.id}>{route.name}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="destructive" onClick={() => void calls.hangUp()}><PhoneOff aria-hidden="true" />Hang up</Button>
        </>}
      </div>
      {!ringing && (onOpenChat || (onHide && !ended)) && (
        <div className="flex flex-wrap justify-center gap-1">
          {onOpenChat && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onOpenChat}>Open chat</Button>}
          {onHide && !ended && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onHide}>Hide</Button>}
        </div>
      )}
    </div>
  );
}
