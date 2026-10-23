import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { formatWhen, fromDateTimeLocal, toDateTimeLocal, type WhenChoice } from '@/lib/mail-times';

// The time choices of Snooze and Send later: a menu of the usual times with
// "Pick a date and time…", and the dialog that one opens. Both show the time
// each choice means, so "Tomorrow morning" is never a surprise.

// The server refuses a time less than a minute away; the picker says so first.
const MIN_LEAD_MS = 60 * 1000;

/** Menu entries for a list of times, each with the time it means, then "Pick a date and time…". */
export function WhenMenuItems({ choices, onPick, onPickCustom, pickLabel = 'Pick a date and time…' }: {
  choices: WhenChoice[]; onPick: (at: Date, choice: WhenChoice) => void; onPickCustom: () => void; pickLabel?: string;
}) {
  return <>
    {choices.map(choice => (
      <DropdownMenuItem key={choice.id} onSelect={() => onPick(choice.at, choice)} className="gap-6">
        <span>{choice.label}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatWhen(choice.at)}</span>
      </DropdownMenuItem>
    ))}
    {choices.length > 0 && <DropdownMenuSeparator />}
    <DropdownMenuItem onSelect={onPickCustom}>{pickLabel}</DropdownMenuItem>
  </>;
}

interface WhenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The usual times, listed as rows above the date field; none for a plain date and time dialog. */
  choices?: WhenChoice[];
  /** The time the field starts with (the current time of a schedule being moved). */
  initial?: Date | null;
  confirmLabel: string;
  onPick: (at: Date) => void;
}

/** A date and time in the future, from the usual choices or a date field. */
export function WhenDialog({ open, onOpenChange, title, description, choices = [], initial, confirmLabel, onPick }: WhenDialogProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setValue(toDateTimeLocal(initial ?? new Date(Date.now() + 60 * 60 * 1000)));
    setError(null);
  }, [open, initial]);
  const pick = (at: Date) => { onOpenChange(false); onPick(at); };
  const confirm = () => {
    const at = fromDateTimeLocal(value);
    if (!at) { setError('Choose a date and time.'); return; }
    if (at.getTime() < Date.now() + MIN_LEAD_MS) { setError('Choose a time at least a minute from now.'); return; }
    pick(at);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? 'Choose a time.'}</DialogDescription>
        </DialogHeader>
        {choices.length > 0 && (
          <ul className="-mx-2 divide-y divide-border rounded-md border border-border" aria-label="Usual times">
            {choices.map(choice => (
              <li key={choice.id}>
                <button type="button" onClick={() => pick(choice.at)}
                  className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm touch:py-3 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span>{choice.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatWhen(choice.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); confirm(); }}>
          <Label htmlFor="when-picker-time">{choices.length ? 'Or pick a date and time' : 'Date and time'}</Label>
          <Input id="when-picker-time" type="datetime-local" value={value} min={toDateTimeLocal(new Date())} step={60}
            aria-invalid={!!error} aria-describedby={error ? 'when-picker-error' : undefined}
            onChange={event => { setValue(event.target.value); setError(null); }} />
          {error && <p id="when-picker-error" role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit">{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
