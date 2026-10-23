import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { invalidateMailMoveViews, mailQueryKeys, showRequestedSnoozeInMailCaches, type Email } from '@/lib/mail-api';
import { snoozeMail, unsnoozeMail } from '@/lib/mail-essentials-api';
import { formatWhen } from '@/lib/mail-times';

interface SnoozeOptions {
  /** A message that just left the current list (the reader closes if it shows it). */
  onSnoozedAway?: (emailId: string) => void;
}

/**
 * Snooze and unsnooze (0.24). The row leaves its list at once; a rejected
 * request puts it back and says so. Snoozing is UniHub's own state: the
 * message keeps its folder and nothing changes at the provider.
 */
export function useMailSnooze({ onSnoozedAway }: SnoozeOptions = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
      return showRequestedSnoozeInMailCaches(queryClient, new Set([email.id]), false);
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
    mutationFn: ({ email, until }: { email: Email; until: Date }) => snoozeMail(email.id, until),
    onMutate: ({ email }) => {
      track(email.id, true);
      void queryClient.cancelQueries({ queryKey: mailQueryKeys.all });
      const undo = showRequestedSnoozeInMailCaches(queryClient, new Set([email.id]), true);
      onSnoozedAway?.(email.id);
      return undo;
    },
    onSuccess: (result, { email }) => {
      toast({
        title: `Snoozed until ${formatWhen(result.snoozed_until ?? '')}`,
        description: 'It comes back to its folder then, with a notification.',
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
    snooze: (email: Email, until: Date) => snooze.mutate({ email, until }),
    unsnooze: (email: Email) => unsnooze.mutate({ email }),
    isPending,
  };
}

export type MailSnooze = ReturnType<typeof useMailSnooze>;
