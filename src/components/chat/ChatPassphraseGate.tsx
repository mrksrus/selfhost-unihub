import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Loader2, LockKeyhole, TriangleAlert } from 'lucide-react';
import type { ChatDeviceName, ChatEngine, ChatReadiness } from '@/lib/chat/types';
import { WrongPassphraseError } from '@/lib/chat/key-backup';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChatPassphraseDialog, PassphraseFields } from '@/components/chat/ChatPassphrase';
import { AskForApproval } from '@/components/chat/ChatDeviceCode';
import { deviceNames } from '@/components/chat/chat-state';
import { settingsHref } from '@/components/settings/settings-sections';

interface Props {
  engine: ChatEngine;
  /** `choose-passphrase` at the first Chat open, `waiting` on a device that is not in Chat yet, `enter-passphrase` on one that is in Chat without the history. */
  readiness: Extract<ChatReadiness, { state: 'choose-passphrase' | 'enter-passphrase' | 'waiting' }>;
  /** "Not now" on a device in Chat: its chats open without the history. Choosing cannot wait, and a waiting device leaves from the page's header. */
  onLater?: () => void;
  /** The person's devices in Chat that a new key was refused for. */
  newKeyRefused: ChatDeviceName[] | null;
}

const WORDS = {
  'choose-passphrase': { title: 'Choose a chat passphrase', action: 'Set passphrase and open Chat', busy: 'Setting up…',
    text: 'Your messages are encrypted on your devices. Choosing a passphrase sets Chat up: colleagues can write to you from then on. The passphrase also lets a new phone or browser into your chats and brings your earlier messages to it.' },
  'enter-passphrase': { title: 'Enter your chat passphrase', action: 'Get my earlier messages', busy: 'Checking…',
    text: 'New messages already arrive on this device. Only your chat passphrase brings your earlier messages to it.' },
  waiting: { title: 'This device is not in Chat yet', action: 'Let this device in', busy: 'Checking…',
    text: 'Nothing of Chat reaches it until you let it in: no messages and no notifications.' },
} as const;

/**
 * In place of the chats: where the chat passphrase is chosen at the first
 * Chat open, where a device that is not in Chat yet is let in (the
 * passphrase, or an approval on another device), and where a device in Chat
 * gets the person's history. The passphrase goes to the engine and nowhere
 * else; once it is taken the page shows the chats, and the list says how far
 * the earlier messages are.
 */
export function ChatPassphraseGate({ engine, readiness, onLater, newKeyRefused }: Props) {
  const id = useId();
  const { toast } = useToast();
  const scope = useSessionScope();
  const choosing = readiness.state === 'choose-passphrase';
  const waiting = readiness.state === 'waiting';
  const words = WORDS[readiness.state];
  const Icon = waiting ? LockKeyhole : KeyRound;
  // The devices a new key waits for: the ones the server named, or the ones it will name.
  const inChat = newKeyRefused ?? (waiting ? readiness.approvers : []);
  // A device signed out a moment ago, in Settings, no longer stands in the way.
  useEffect(() => { if (waiting) void engine.sync().catch(() => undefined); }, [engine, waiting]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const passphrase = choosing ? chosen : typed;
    if (!passphrase || pending) return;
    setPending(true);
    setError(null);
    try {
      await (choosing ? engine.choosePassphrase(passphrase) : engine.enterPassphrase(passphrase));
    } catch (failure) {
      if (scope.ended) return;
      // The key was taken and the chats are open: only reading the earlier messages failed.
      if (engine.snapshot().holds_history_key) toast({ title: 'Your earlier messages could not all be fetched', description: 'UniHub fetches the rest when the connection is back.', variant: 'destructive' });
      else setError(failure instanceof WrongPassphraseError ? 'This is not your chat passphrase. Check for a typing mistake and try again.' : failure instanceof Error && failure.message ? failure.message : 'The passphrase was not taken.');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
    <form onSubmit={event => void submit(event)} className="mx-auto flex w-full max-w-md flex-col gap-6 py-6 md:py-10">
      <div className="space-y-2">
        <Icon aria-hidden="true" className="mb-4 h-8 w-8 text-accent" />
        <h2 className="text-xl font-semibold tracking-tight">{words.title}</h2>
        <p className="text-sm text-muted-foreground">{words.text}</p>
      </div>

      {choosing ? <PassphraseFields onChange={setChosen} disabled={pending} autoFocus /> : (
        <div className="space-y-2">
          <Label htmlFor={id}>Chat passphrase</Label>
          {/* No field takes the focus while there are two ways: on a phone the keyboard would cover the other one. */}
          <Input id={id} type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus={!waiting} readOnly={pending} value={typed}
            aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setTyped(event.target.value); setError(null); }} />
        </div>
      )}

      {choosing && (
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2.5 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>Without the passphrase and without another signed-in device, a lost device means lost history. Nobody else can restore it: not your organisation, not an administrator.</span>
          </p>
          <p className="text-muted-foreground">Do not use your sign-in password: the server sees that one every time you sign in. The passphrase never leaves your devices.</p>
        </div>
      )}

      <p id={`${id}-error`} role="alert" className="text-sm text-destructive empty:hidden">{error}</p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={pending || !(choosing ? chosen : typed)}>
          {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}
          {pending ? words.busy : words.action}
        </Button>
        {!choosing && onLater && <Button type="button" variant="outline" disabled={pending} onClick={onLater}>Not now</Button>}
      </div>

      {waiting && (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Or approve on another device</h3>
          <AskForApproval engine={engine} readiness={readiness} />
        </div>
      )}

      {!choosing && (
        <div className="space-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">Forgot it?</span> If another of your devices still shows your chats, set a new passphrase there under Settings › Chat. Nothing is lost that way.</p>
          {inChat.length ? <>
            <p>A new key cannot be started while a device of yours is in Chat: {deviceNames(inChat)}. If one of them is lost, sign it out first.</p>
            <Button asChild variant="outline" size="sm"><Link to={settingsHref('security')}>Settings › Security › Devices</Link></Button>
          </> : <>
            <p>If none does, you can start a new key. Earlier messages that no device of yours holds are then lost.</p>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setNewKey(true)}>Start a new key…</Button>
          </>}
        </div>
      )}
    </form>
    {/* Beside the form, not in it: the dialog has a form of its own. */}
    <ChatPassphraseDialog engine={engine} mode={newKey ? 'new-key' : null} onClose={() => setNewKey(false)} />
    </>
  );
}
