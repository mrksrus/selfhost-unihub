import { useId, useState } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useSecretMutation } from '@/hooks/use-secret-mutation';
import { useToast } from '@/hooks/use-toast';
import { applyRetentionNow, RETENTION_WORD, retentionPreviewQueryKey, type RetentionPreview } from '@/lib/admin-api';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordConfirmDialog } from '@/components/admin/PasswordConfirmDialog';
import { formatDayTime } from '@/components/admin/person-words';

// "Delete chat messages after" is the one rule whose purpose is to delete.
// A shorter time is saved only after the administrator saw what it deletes
// and typed a word; the server then waits 24 hours, and until they are over
// the Policies page shows the change that is pending.

const DAY = 24 * 60 * 60 * 1000;
const count = (amount: number, one: string) => `${amount} ${one}${amount === 1 ? '' : 's'}`;

const CONSEQUENCES = [
  'Deleting starts 24 hours after you save. Until then you can undo it on this page, and nothing is deleted.',
  'A device that is switched off deletes its copies when it is next opened.',
  'An instance backup made before then still holds the encrypted messages for as long as it is kept.',
  'This deletes even where people may not delete for good.',
];

/** In the save dialog, before the password: what the shorter time deletes as the server counts it now, what follows, and the typed word. */
export function RetentionWarning({ days, preview, typed, onTyped }: { days: number; preview: UseQueryResult<RetentionPreview>; typed: string; onTyped: (value: string) => void }) {
  const id = useId();
  const found = preview.data;
  return (
    <div className="space-y-4" data-testid="retention-warning">
      <div className="rounded-md border border-destructive/50 px-3 py-2 text-sm">
        <p className="font-medium" aria-live="polite">
          {preview.isError ? 'Could not count what this deletes.' : !found ? 'Counting what this deletes…'
            : found.messages + found.files === 0 ? `Nothing is older than ${days} days yet. Messages are deleted as they reach that age.`
            : `${count(found.messages, 'message')} and ${count(found.files, 'file')} in ${count(found.conversations, 'chat')} are older than ${days} days and will be deleted.`}
        </p>
        {preview.isError && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void preview.refetch()} disabled={preview.isFetching}>Count again</Button>}
        <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
          {CONSEQUENCES.map(sentence => <li key={sentence}>{sentence}</li>)}
        </ul>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id}>Type <span className="font-mono text-xs">{RETENTION_WORD}</span> to confirm</Label>
        <Input id={id} value={typed} onChange={event => onTyped(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      </div>
    </div>
  );
}

/**
 * Under the rule while chats wait to start deleting. `saved` is a shorter
 * time saved in this visit: only then the page knows the earlier value and
 * offers Undo. The owner alone may end the wait.
 */
export function RetentionPending({ pending, saved, onUndo, onApplied }: { pending?: RetentionPreview; saved: { days: number; at: number } | null; onUndo: () => void; onApplied: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [applying, setApplying] = useState(false);
  const apply = useSecretMutation({
    mutationFn: (password: string) => applyRetentionNow(password),
    onSuccess: answer => {
      setApplying(false);
      // Deleting has begun: the save of this visit can no longer be undone without loss.
      onApplied();
      void client.invalidateQueries({ queryKey: retentionPreviewQueryKey() });
      const chats = answer?.conversations ?? 0;
      toast({ title: 'Deleting starts now', description: chats ? `Old messages in ${count(chats, 'chat')} are deleted within the hour.` : 'No chat was waiting.' });
    },
    onError: (error: Error) => toast({ title: 'Could not start deleting', description: error.message, variant: 'destructive' }),
  });
  const waiting = pending?.waiting_from ? pending.waiting : 0;
  if (!waiting && !saved) return null;
  return (
    <div role="status" data-testid="retention-pending" className="mt-2 space-y-2 rounded-md border border-warning/60 px-3 py-2 text-foreground">
      <p>
        {waiting ? `From ${formatDayTime(pending!.waiting_from!)}, old messages are deleted in ${count(waiting, 'chat')}.`
          : `From about ${formatDayTime(new Date(saved!.at + DAY).toISOString())}, messages older than ${saved!.days} days are deleted.`}
        {' '}
        <span className="text-muted-foreground">
          {saved ? 'Nothing is deleted before then.' : 'Nothing is deleted before then. A longer time set before then keeps what is younger than it; Never keeps everything.'}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {saved && <Button variant="outline" size="sm" onClick={onUndo}>Undo</Button>}
        {/* The owner alone holds this permission; the server refuses an administrator. */}
        {can(user, 'admins.manage') && <Button variant="outline" size="sm" onClick={() => setApplying(true)}>Apply now…</Button>}
      </div>
      <PasswordConfirmDialog open={applying} onClose={() => setApplying(false)} title="Start deleting now?" destructive
        description="The chats that wait start deleting within the hour instead of after their 24 hours. What is deleted cannot be brought back."
        actionLabel="Apply now" pending={apply.isPending} onConfirm={password => apply.mutate(password)} />
    </div>
  );
}
