import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MAIL_WINDOW_CHOICES, mailWindowKey, parseMailWindow, type MailWindowDays } from '@/lib/mail-api';
import { cn } from '@/lib/utils';

type Mode = 'download' | 'sync';

interface Props {
  mode: Mode;
  syncWindow: MailWindowDays;
  trashWindow: MailWindowDays;
  deleteOnServer: boolean;
  /** An existing Sync account switching back must save Download before server deletion can be enabled. */
  saveDownloadFirst?: boolean;
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

/** The Sync/Download choice with plain explanations, Sync windows and Download's server deletion. */
export function MailAccountModeSettings(props: Props) {
  return <fieldset className="space-y-3">
    <legend className="mb-2 text-sm font-medium">How should UniHub handle this account?</legend>
    <div role="radiogroup" aria-label="Account mode" className="grid gap-2 sm:grid-cols-2">
      {modes.map(option => {
        const selected = props.mode === option.value;
        return <label key={option.value}
          className={cn('flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors motion-reduce:transition-none focus-within:ring-2 focus-within:ring-ring',
            selected ? 'border-accent bg-accent/10' : 'border-border hover:bg-muted/50')}>
          <input type="radio" name="mail-account-mode" value={option.value} checked={selected}
            onChange={() => props.onModeChange(option.value)}
            aria-describedby={`mail-mode-${option.value}-details`}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent focus:outline-none" />
          <span className="min-w-0 space-y-1">
            <span className="block font-medium text-foreground">{option.title}</span>
            <span id={`mail-mode-${option.value}-details`} className="block space-y-1 text-xs text-muted-foreground">
              <span className="block text-foreground/80">{option.summary}</span>
              {option.details.map(line => <span key={line} className="block">{line}</span>)}
            </span>
          </span>
        </label>;
      })}
    </div>
    <p className="text-xs text-muted-foreground">Server deletion options exist only in Download mode.</p>

    {props.mode === 'sync' ? <div className="grid gap-3 sm:grid-cols-2">
      <WindowSelect id="mail-sync-window" label="Keep mail from the last" value={props.syncWindow} allLabel="All mail"
        hint="Older mail stays on the server and is removed from UniHub." onChange={props.onSyncWindowChange} />
      <WindowSelect id="mail-trash-window" label="Trash & spam: keep the last" value={props.trashWindow} allLabel="All"
        hint="Older trash and spam leaves UniHub, not the server." onChange={props.onTrashWindowChange} />
    </div> : props.saveDownloadFirst ? <p className="text-sm text-muted-foreground">
      Save Download mode first. Server deletion stays off; you can turn it on afterward in these settings.
    </p> : <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
      <Checkbox checked={props.deleteOnServer} onCheckedChange={checked => props.onDeleteChange(checked === true)} />
      <span><span className="font-medium">Delete emails on server after download</span>
        <span className="block text-muted-foreground">Off by default. When on, UniHub waits 10 minutes before deleting imported server copies. Switching modes turns this off.</span>
        <span className="mt-1 block text-muted-foreground">UniHub backup, import and restore are ALPHA. Keep an independent backup before deleting server copies; the local copy may become your only remaining email.</span>
      </span>
    </label>}
  </fieldset>;
}
