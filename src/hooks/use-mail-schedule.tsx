import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { invalidateMailQueries, type Email } from '@/lib/mail-api';
import { cancelMailSchedule, scheduleMailDraft } from '@/lib/mail-essentials-api';
import { sendDraft } from '@/lib/mail-compose-api';
import { formatWhen } from '@/lib/mail-times';

/**
 * The scheduled sends of Drafts rows (0.24): cancel or move a schedule, send
 * a draft now, reschedule one whose send failed. Each answer refreshes the
 * lists; the row shows what the server last reported.
 */
export function useMailSchedule() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The draft whose time is being picked (Edit time, Reschedule).
  const [picking, setPicking] = useState<Email | null>(null);
  const run = async (email: Email, work: () => Promise<void>, failure: string) => {
    setBusy(current => new Set(current).add(email.id));
    try {
      await work();
      void invalidateMailQueries(queryClient);
    } catch (error) {
      toast({ title: failure, description: error instanceof Error ? error.message : undefined, variant: 'destructive' });
    } finally {
      setBusy(current => { const next = new Set(current); next.delete(email.id); return next; });
    }
  };
  return {
    picking, setPicking,
    isBusy: (emailId: string) => busy.has(emailId),
    cancel: (email: Email) => run(email, async () => {
      await cancelMailSchedule(email.id);
      toast({ title: 'Scheduled send cancelled', description: 'The message stays in Drafts.' });
    }, 'Could not cancel the scheduled send'),
    reschedule: (email: Email, sendAt: Date) => run(email, async () => {
      const schedule = await scheduleMailDraft(email.id, sendAt);
      toast({ title: `Scheduled for ${formatWhen(schedule.send_at)}` });
    }, 'Could not schedule the message'),
    // A send by hand replaces the schedule; it carries its own send-once key.
    sendNow: (email: Email) => run(email, async () => {
      await sendDraft(email.id, `send-${crypto.randomUUID()}`);
      toast({ title: '✓ Email sent successfully' });
    }, 'Not sent'),
  };
}

export type MailSchedule = ReturnType<typeof useMailSchedule>;
