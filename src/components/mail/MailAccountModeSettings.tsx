import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MAIL_WINDOW_CHOICES, mailWindowKey, parseMailWindow, type MailWindowDays } from '@/lib/mail-api';
import { cn } from '@/lib/utils';
import { useEffect } from 'react';
import { usePolicies } from '@/hooks/use-policies';
import { PolicyNote } from '@/components/ui/policy-note';
import { policyLock } from '@/lib/policies-api';

type Mode = 'download' | 'sync';

interface Props {
  mode: Mode;
  syncWindow: MailWindowDays;
  trashWindow: MailWindowDays;
  deleteOnServer: boolean;
  /** An existing Sync account switching back must save Download before server deletion can be enabled. */
  saveDownloadFirst?: boolean;
  /** A new account: the administrator's preset mode (mail.mode.new_accounts) applies and locks the choice. */
  isNew?: boolean;
  onModeChange: (mode: Mode) => void;
  onSyncWindowChange: (days: MailWindowDays) => void;
  onTrashWindowChange: (days: MailWindowDays) => void;
  onDeleteChange: (enabled: boolean) => void;
}

const modes: { value: Mode; title: string; summary: string; details: string[] }[] = [
  {
    value: 'sync',
    title: 'Sync — works like a mail client',
    summary: 'The server decides what you see.',
    details: [
      'Reading, starring, moving and deleting here also happen on the server.',
      'Mail deleted or moved elsewhere is deleted or moved here too.',
      'Gmail messages appear once, and labels show as folders.',
    ],
  },
  {
    value: 'download',
    title: 'Download — keep an archive',
    summary: 'UniHub copies mail and never changes the server.',
    details: [
      'Everything stays in UniHub, even after it is deleted on the server.',
      'Reading, starring and filing here stay in UniHub.',
      'Optionally, UniHub can delete server copies after download.',
    ],
  },
];

function WindowSelect({ id, label, hint, value, allLabel, onChange }: {
  id: string; label: string; hint: string; value: MailWindowDays; allLabel: string; onChange: (days: MailWindowDays) => void;
}) {
  return <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Select value={mailWindowKey(value)} onValueChange={key => onChange(parseMailWindow(key))}>
      <SelectTrigger id={id} aria-describedby={`${id}-hint`}><SelectValue /></SelectTrigger>
      <SelectContent>
        {MAIL_WINDOW_CHOICES.map(choice => <SelectItem key={mailWindowKey(choice.value)} value={mailWindowKey(choice.value)}>
          {choice.value === null ? allLabel : choice.label}
        </SelectItem>)}
      </SelectContent>
    </Select>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
  </div>;
}

/**
 * The Sync/Download choice with plain explanations, Sync windows and
 * Download's server deletion. A mode a policy forbids is greyed out with the
 * reason; a preset for new accounts selects and locks the mode (F13). The
 * server refuses a forbidden choice anyway.
 */
export function MailAccountModeSettings(props: Props) {
  const { policies } = usePolicies();
  const preset = props.isNew ? policies['mail.mode.new_accounts'] : null;
  const presetMode: Mode | null = preset && preset.value !== 'user_choice' ? (preset.value === 'sync' ? 'sync' : 'download') : null;
  const modeLock = (mode: Mode) => presetMode ? (presetMode === mode ? undefined : preset?.reason ?? undefined)
    : policyLock(policies[mode === 'sync' ? 'mail.mode.sync' : 'mail.mode.download']);
  // For a new account, "required" (mail.provider_delete) or the "download and delete" preset turns server deletion on and locks it.
  const providerDelete = policies['mail.provider_delete'];
  const requiredDelete = !!props.isNew && (providerDelete.value === 'required' || preset?.value === 'download_delete');
  const deleteLock = requiredDelete
    ? (providerDelete.value === 'required' ? providerDelete.reason : preset?.reason) ?? 'Your administrator requires new accounts to delete downloaded mail at the provider.'
    : policyLock(providerDelete);
  const { onModeChange, onDeleteChange, mode, deleteOnServer } = props;
  useEffect(() => { if (presetMode && mode !== presetMode) onModeChange(presetMode); }, [presetMode, mode, onModeChange]);
  useEffect(() => { if (requiredDelete && mode === 'download' && !deleteOnServer) onDeleteChange(true); }, [requiredDelete, mode, deleteOnServer, onDeleteChange]);

  return <fieldset className="space-y-3">
    <legend className="mb-2 text-sm font-medium">How should UniHub handle this account?</legend>
    <div role="radiogroup" aria-label="Account mode" className="grid gap-2 sm:grid-cols-2">
      {modes.map(option => {
        const selected = props.mode === option.value;
        const lock = modeLock(option.value);
        return <label key={option.value}
          className={cn('flex gap-3 rounded-md border p-3 text-sm transition-colors motion-reduce:transition-none focus-within:ring-2 focus-within:ring-ring',
            lock ? 'cursor-not-allowed opacity-60' : 'cursor-pointer', selected ? 'border-accent bg-accent/10' : 'border-border', !lock && !selected && 'hover:bg-muted/50')}>
          <input type="radio" name="mail-account-mode" value={option.value} checked={selected} disabled={!!lock || (!!presetMode && !selected)}
            onChange={() => props.onModeChange(option.value)}
            aria-describedby={`mail-mode-${option.value}-details`}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent focus:outline-none" />
          <span className="min-w-0 space-y-1">
            <span className="block font-medium text-foreground">{option.title}</span>
            <span id={`mail-mode-${option.value}-details`} className="block space-y-1 text-xs text-muted-foreground">
              <span className="block text-foreground/80">{option.summary}</span>
              {option.details.map(line => <span key={line} className="block">{line}</span>)}
              {lock && <PolicyNote reason={lock} />}
            </span>
          </span>
        </label>;
      })}
    </div>
    {presetMode && preset?.reason && <PolicyNote reason={preset.reason} className="mt-0" />}
    <p className="text-xs text-muted-foreground">Server deletion options exist only in Download mode.</p>

    {props.mode === 'sync' ? <div className="grid gap-3 sm:grid-cols-2">
      <WindowSelect id="mail-sync-window" label="Keep mail from the last" value={props.syncWindow} allLabel="All mail"
        hint="Older mail stays on the server and is removed from UniHub." onChange={props.onSyncWindowChange} />
      <WindowSelect id="mail-trash-window" label="Trash & spam: keep the last" value={props.trashWindow} allLabel="All"
        hint="Older trash and spam leaves UniHub, not the server." onChange={props.onTrashWindowChange} />
    </div> : props.saveDownloadFirst ? <p className="text-sm text-muted-foreground">
      Save Download mode first. Server deletion stays off; you can turn it on afterward in these settings.
    </p> : <label className={cn('flex items-start gap-3 rounded-md border border-border p-3 text-sm', deleteLock && 'opacity-60')}>
      <Checkbox checked={props.deleteOnServer} disabled={!!deleteLock} onCheckedChange={checked => props.onDeleteChange(checked === true)} />
      <span><span className="font-medium">Delete emails on server after download</span>
        <span className="block text-muted-foreground">Off by default. When on, UniHub waits 10 minutes before deleting imported server copies. Switching modes turns this off.</span>
        <span className="mt-1 block text-muted-foreground">Keep a backup before deleting server copies; the local copy may become your only remaining email. Backups then always include this account's mail.</span>
        {deleteLock && <PolicyNote reason={deleteLock} />}
      </span>
    </label>}
  </fieldset>;
}
