import { useId, useState } from 'react';
import type { ChatEngine } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useSessionScope } from '@/lib/session-scope';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { passphraseStrength } from '@/components/chat/chat-state';

const STRENGTH_TONE = ['', 'bg-destructive', 'bg-warning', 'bg-success'] as const;
// A password manager must not file the passphrase as the sign-in password.
const FIELD = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false } as const;

/**
 * A new chat passphrase, typed twice, with the strength hint under it.
 * `onChange` gets the passphrase once it is long enough and both fields
 * agree, and null until then.
 */
export function PassphraseFields({ onChange, disabled, autoFocus }: { onChange: (passphrase: string | null) => void; disabled?: boolean; autoFocus?: boolean }) {
  const id = useId();
  const [first, setFirst] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const strength = passphraseStrength(first);
  const differ = !!again && again !== first;
  const change = (nextFirst: string, nextAgain: string) => {
    setFirst(nextFirst);
    setAgain(nextAgain);
    onChange(passphraseStrength(nextFirst).level > 0 && nextFirst === nextAgain ? nextFirst : null);
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${id}-new`}>Chat passphrase</Label>
          <Button type="button" variant="ghost" size="sm" className="-my-2" aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</Button>
        </div>
        <Input id={`${id}-new`} type={shown ? 'text' : 'password'} {...FIELD} autoFocus={autoFocus} disabled={disabled} value={first}
          aria-describedby={`${id}-hint`} onChange={event => change(event.target.value, again)} />
        {/* Read with the field, not announced on every keystroke. */}
        <p id={`${id}-hint`} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="flex shrink-0 gap-1">
            {[1, 2, 3].map(step => <span key={step} className={cn('h-1 w-6 rounded-full', strength.level >= step ? STRENGTH_TONE[strength.level] : 'bg-border')} />)}
          </span>
          {strength.hint}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-again`}>Repeat the passphrase</Label>
        <Input id={`${id}-again`} type={shown ? 'text' : 'password'} {...FIELD} disabled={disabled} value={again} aria-invalid={differ}
          aria-describedby={differ ? `${id}-differ` : undefined} onChange={event => change(first, event.target.value)} />
        {differ && <p id={`${id}-differ`} className="text-xs text-destructive">The two do not match.</p>}
      </div>
    </div>
  );
}

const DIALOGS = {
  change: {
    title: 'Set a new chat passphrase',
    description: 'It replaces the passphrase on all your devices. This device holds your chat history, so your account password is enough: the old passphrase is not needed.',
    action: 'Set new passphrase',
    done: 'The chat passphrase was changed',
  },
  'new-key': {
    title: 'Start a new key?',
    description: 'For when the passphrase is forgotten and none of your devices shows your chats any more.',
    action: 'Start a new key',
    done: 'A new key was started',
  },
} as const;

/** What starting a new key costs, said before it starts. */
const NEW_KEY_LOSES = [
  'Earlier messages that none of your signed-in devices still holds cannot be read again, by you or by anyone else.',
  'Messages still on one of your devices stay there and are saved under the new key.',
  'The people you chat with keep their messages.',
];

/**
 * A new passphrase with the account password: for the key this device holds
 * (`change`), or for a new key when no device holds the old one and its
 * passphrase is forgotten (`new-key`).
 */
export function ChatPassphraseDialog({ engine, mode, onClose }: { engine: ChatEngine; mode: keyof typeof DIALOGS | null; onClose: () => void }) {
  const { toast } = useToast();
  const scope = useSessionScope();
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last mode stays while the dialog closes, so its words do not change on the way out.
  const [last, setLast] = useState<keyof typeof DIALOGS>('change');
  if (mode && mode !== last) setLast(mode);
  const kind = mode ?? last;
  const words = DIALOGS[kind];
  const close = () => { setPassphrase(null); setError(null); onClose(); };

  const confirm = async (password: string) => {
    if (!passphrase || !mode) return;
    setPending(true);
    setError(null);
    try {
      await (mode === 'change' ? engine.changePassphrase(password, passphrase) : engine.startNewKey(password, passphrase));
      if (scope.ended) return;
      toast({ title: words.done });
      close();
    } catch (failure) {
      if (!scope.ended) setError(failure instanceof Error && failure.message ? failure.message : 'The passphrase was not changed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <PasswordConfirmDialog open={mode !== null} onClose={close} title={words.title} description={words.description} actionLabel={words.action}
      destructive={kind === 'new-key'} pending={pending} confirmDisabled={!passphrase} onConfirm={password => void confirm(password)}>
      {kind === 'new-key' && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {NEW_KEY_LOSES.map(line => <li key={line}>{line}</li>)}
        </ul>
      )}
      {/* Mounted with the dialog, so a closed one keeps no typed passphrase. */}
      {mode && <PassphraseFields onChange={setPassphrase} disabled={pending} />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </PasswordConfirmDialog>
  );
}
