import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { useAppLock } from '@/hooks/use-app-lock';
import { useToast } from '@/hooks/use-toast';
import { hasCode } from '@/lib/api-error';
import { lastActiveLabel } from '@/lib/account-api';
import { deviceLabel, devicesQueryKey, removeDevice } from '@/lib/devices-api';
import { useSessionScope } from '@/lib/session-scope';
import type { ChatApprovalRequest } from '@/lib/chat/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChatDeviceCode } from '@/components/chat/ChatDeviceCode';
import { useChatSnapshot } from '@/components/chat/chat-state';

const same = (one: ChatApprovalRequest, other: ChatApprovalRequest) => one.chat_device_id === other.chat_device_id && one.code === other.code;

/** "just now", "3 minutes ago", then the day. */
function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago` : lastActiveLabel(iso);
}

/**
 * Over any page of a device that is in Chat and holds the history: another
 * device of the person asks to be let in. The person compares the code with
 * the one that device shows and approves, or says it was not them and can
 * sign that device out. One request at a time; the one on screen stays the
 * one the person read, whatever arrives meanwhile. Not shown while Chat is
 * locked: it names a device and carries a decision.
 */
export function ChatApprovalDialog() {
  const engine = useChatEngine();
  const requests = useChatSnapshot(engine)?.approvals ?? [];
  const lock = useAppLock();
  const client = useQueryClient();
  const { toast } = useToast();
  const scope = useSessionScope();
  const [shown, setShown] = useState<{ request: ChatApprovalRequest; step: 'ask' | 'dropped' | 'ended'; error?: string } | null>(null);
  // Answered or closed: not again on this page.
  const [done, setDone] = useState<ChatApprovalRequest[]>([]);
  const [busy, setBusy] = useState<'approve' | 'not-me' | 'sign-out' | null>(null);

  const locked = lock.locked('chat');
  const next = requests.filter(request => !done.some(item => same(item, request))).at(-1);
  if (!shown && next && !locked) setShown({ request: next, step: 'ask' });
  // A request that ended unanswered goes without a word.
  else if (shown?.step === 'ask' && !shown.error && !busy && !requests.some(request => same(request, shown.request))) setShown(null);
  if (!engine || !shown || locked) return null;

  const { request, step, error } = shown;
  const close = () => { setDone(list => [...list, request]); setShown(null); };
  const act = async (action: NonNullable<typeof busy>, run: () => Promise<void>) => {
    setBusy(action);
    try {
      await run();
    } catch (failure) {
      if (scope.ended) return;
      const message = failure instanceof Error && failure.message ? failure.message : 'That did not work. Try again.';
      // Gone from the list, the request ended or was asked again; still there, the same answer can be tried again.
      setShown({ request, error: message, step: step === 'ask' && !engine.snapshot().approvals.some(item => same(item, request)) ? 'ended' : step });
    } finally {
      setBusy(null);
    }
  };
  const approve = () => act('approve', async () => {
    await engine.approve(request.chat_device_id, request.code);
    if (scope.ended) return;
    toast({ title: 'The device is in your chats now' });
    close();
  });
  const notMe = () => act('not-me', async () => {
    // Already ended: it is gone all the same, and the device may still be signed in.
    await engine.dropApproval(request.chat_device_id).catch(failure => { if (!hasCode(failure, 'CHAT_APPROVAL_NOT_FOUND')) throw failure; });
    if (!scope.ended) setShown({ request, step: 'dropped' });
  });
  const signOut = () => act('sign-out', async () => {
    await removeDevice(request.device.id);
    if (scope.ended) return;
    void client.invalidateQueries({ queryKey: devicesQueryKey });
    toast({ title: 'Device signed out' });
    close();
  });
  const spinner = <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />;

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      {/* The focus goes to the dialog, not to a button: Enter approves nothing that was not read. */}
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto outline-none" onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader>
          <DialogTitle>{step === 'dropped' ? 'The request was removed' : 'A device asks to join your chats'}</DialogTitle>
          <DialogDescription role={step === 'ended' ? 'alert' : undefined}>
            {step === 'dropped' ? 'That device is not in your chats. It is still signed in to your account.'
              : step === 'ended' ? error
              : 'Approve it only if you are signing in on that device now. It then gets your chats and your earlier messages.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <p className="break-words font-medium">{deviceLabel(request.device)}</p>
            <p className="text-muted-foreground">{request.signed_in_at ? `Signed in ${ago(request.signed_in_at)}.` : 'When it signed in is not known.'} Asked {ago(request.requested_at)}.</p>
          </div>
          {step === 'ask' && (
            <p className="flex items-start gap-2.5 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>The name comes from that device and can be made up. Go by the code.</span>
            </p>
          )}
          {step === 'dropped' && <p>Sign it out if you do not know it. If you did not sign in there yourself, someone else knows your password: change it under Settings › Security.</p>}
          {step !== 'ended' && <p role="alert" className="text-destructive empty:hidden">{error}</p>}
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          {step === 'ask' ? (
            <div className="shrink-0">
              <p className="text-sm text-muted-foreground">That device must show this code:</p>
              <ChatDeviceCode code={request.code} className="mt-1" />
            </div>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {step === 'ask' ? <>
              <Button variant="outline" disabled={!!busy} onClick={() => void notMe()}>{busy === 'not-me' && spinner}This was not me</Button>
              <Button disabled={!!busy} onClick={() => void approve()}>{busy === 'approve' && spinner}Approve</Button>
            </> : <>
              <Button variant="outline" disabled={!!busy} onClick={close}>{step === 'dropped' ? 'Keep it signed in' : 'OK'}</Button>
              {step === 'dropped' && <Button variant="destructive" disabled={!!busy} onClick={() => void signOut()}>{busy && spinner}Sign that device out</Button>}
            </>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
