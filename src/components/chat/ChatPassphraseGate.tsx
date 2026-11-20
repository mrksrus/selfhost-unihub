import { useId, useState, type FormEvent } from 'react';
import { KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import type { ChatEngine } from '@/lib/chat/types';
import { WrongPassphraseError } from '@/lib/chat/key-backup';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChatPassphraseDialog, PassphraseFields } from '@/components/chat/ChatPassphrase';

interface Props {
  engine: ChatEngine;
  /** `choose-passphrase` at the first Chat open, `enter-passphrase` on a device that does not hold the history key yet. */
  state: 'choose-passphrase' | 'enter-passphrase';
  /** Entering can wait: the device already reads and writes new messages. Choosing cannot. */
  onLater?: () => void;
}

/**
 * Where the chat passphrase is chosen at the first Chat open, or entered on
 * a device that does not hold the person's history yet. The passphrase goes
 * to the engine and nowhere else; once it is taken the page shows the chats,
 * and the list says how far the earlier messages are.
 */
export function ChatPassphraseGate({ engine, state, onLater }: Props) {
  const id = useId();
  const { toast } = useToast();
  const scope = useSessionScope();
  const choosing = state === 'choose-passphrase';
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
        <KeyRound aria-hidden="true" className="mb-4 h-8 w-8 text-accent" />
        <h2 className="text-xl font-semibold tracking-tight">{choosing ? 'Choose a chat passphrase' : 'Enter your chat passphrase'}</h2>
        <p className="text-sm text-muted-foreground">
          {choosing
            ? 'Your messages are encrypted on your devices. The passphrase brings your earlier messages to a new phone or browser.'
            : 'New messages already arrive on this device. Your earlier messages come back with the passphrase you chose on another device.'}
        </p>
      </div>

      {choosing ? <PassphraseFields onChange={setChosen} disabled={pending} autoFocus /> : (
        <div className="space-y-2">
          <Label htmlFor={id}>Chat passphrase</Label>
          <Input id={id} type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus readOnly={pending} value={typed}
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
          {choosing ? (pending ? 'Setting up…' : 'Set passphrase and open Chat') : (pending ? 'Checking…' : 'Get my earlier messages')}
        </Button>
        {!choosing && onLater && <Button type="button" variant="outline" disabled={pending} onClick={onLater}>Not now</Button>}
      </div>

      {!choosing && (
        <div className="space-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">Forgot it?</span> If another of your devices still shows your chats, set a new passphrase there under Settings › Chat. Nothing is lost that way.</p>
          <p>If none does, you can start a new key. Earlier messages that no device of yours holds are then lost.</p>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setNewKey(true)}>Start a new key…</Button>
        </div>
      )}
    </form>
    {/* Beside the form, not in it: the dialog has a form of its own. */}
    <ChatPassphraseDialog engine={engine} mode={newKey ? 'new-key' : null} onClose={() => setNewKey(false)} />
    </>
  );
}
