import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { invalidateMailMoveViews, mailQueryKeys, markRequestedSnoozeInMailCaches, showRequestedSnoozeInMailCaches, type Email } from '@/lib/mail-api';
import { snoozeMail, unsnoozeMail } from '@/lib/mail-essentials-api';
import { formatWhen } from '@/lib/mail-times';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';

interface SnoozeOptions {
  /** A message that just left the current list (the reader closes if it shows it). */
  onSnoozedAway?: (emailId: string) => void;
  /** A message's snooze time as requested (null: brought back), for the open reader. */
  onSnoozeChanged?: (emailId: string, until: string | null) => void;
}

/**
 * Snooze and unsnooze (0.24). The row leaves its list at once, or with
 * Settings > Mail "Keep in the folder" (snoozed_messages, 0.25) stays there
 * marked with its time; a rejected request puts it back and says so. Snoozing
 * is UniHub's own state: the message keeps its folder and nothing changes at
 * the provider.
 */
export function useMailSnooze({ onSnoozedAway, onSnoozeChanged }: SnoozeOptions = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const keep = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('snoozed_messages') }).data === 'keep';
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const track = (id: string, on: boolean) => setPending(current => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const unsnooze = useMutation({
    mutationFn: ({ email }: { email: Email; quiet?: boolean }) => unsnoozeMail(email.id),
    onMutate: ({ email }) => {
      track(email.id, true);
      void queryClient.cancelQueries({ queryKey: mailQueryKeys.all });
      const ids = new Set([email.id]);
      const undoLeave = showRequestedSnoozeInMailCaches(queryClient, ids, false);
      const undoMark = markRequestedSnoozeInMailCaches(queryClient, ids, null);
      onSnoozeChanged?.(email.id, null);
      return () => { undoMark(); undoLeave(); onSnoozeChanged?.(email.id, email.snoozed_until ?? null); };
    },
    onSuccess: (_result, { email, quiet }) => {
      if (!quiet) toast({ title: 'Brought back', description: `The message is back in ${email.folder === 'inbox' ? 'your inbox' : 'its folder'}.` });
    },
    onError: (error: Error, _variables, undo) => {
      undo?.();
      toast({ title: 'Could not bring the message back', description: error.message, variant: 'destructive' });
    },
    onSettled: (_result, _error, { email }) => { track(email.id, false); void invalidateMailMoveViews(queryClient); },
  });

  const snooze = useMutation({
    mutationFn: ({ email, until }: { email: Email; until: Date; keep: boolean }) => snoozeMail(email.id, until),
    onMutate: ({ email, until, keep: staying }) => {
      track(email.id, true);
      void queryClient.cancelQueries({ queryKey: mailQueryKeys.all });
      const ids = new Set([email.id]);
      // Kept in the folder, the row stays with its new time; otherwise it leaves.
      const undoMark = markRequestedSnoozeInMailCaches(queryClient, ids, until.toISOString());
      const undoLeave = staying ? () => {} : showRequestedSnoozeInMailCaches(queryClient, ids, true);
      if (staying) onSnoozeChanged?.(email.id, until.toISOString());
      else onSnoozedAway?.(email.id);
      return () => { undoLeave(); undoMark(); if (staying) onSnoozeChanged?.(email.id, email.snoozed_until ?? null); };
    },
    onSuccess: (result, { email, keep: staying }) => {
      toast({
        title: `Snoozed until ${formatWhen(result.snoozed_until ?? '')}`,
        description: staying ? 'It stays in its folder. You get a notification then.' : 'It comes back to its folder then, with a notification.',
        action: <ToastAction altText="Undo the snooze" onClick={() => unsnooze.mutate({ email, quiet: true })}>Undo</ToastAction>,
      });
    },
    onError: (error: Error, _variables, undo) => {
      undo?.();
      toast({ title: 'Could not snooze', description: error.message, variant: 'destructive' });
    },
    onSettled: (_result, _error, { email }) => { track(email.id, false); void invalidateMailMoveViews(queryClient); },
  });

  const isPending = useCallback((emailId: string) => pending.has(emailId), [pending]);
  return {
    snooze: (email: Email, until: Date) => snooze.mutate({ email, until, keep }),
    unsnooze: (email: Email) => unsnooze.mutate({ email }),
    isPending,
    /** Snoozed messages stay in their folders (Settings > Mail). */
    keep,
  };
}

export type MailSnooze = ReturnType<typeof useMailSnooze>;
