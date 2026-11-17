import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useCalendarShareCandidates, useCalendarShareReach, useCalendarShares } from '@/hooks/use-calendar-shares';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import type { CalendarCalendar } from '@/lib/calendar-api';
import { calendarSharesApi, calendarSharesQueryKeys, type CalendarPermission } from '@/lib/calendar-shares-api';
import { can } from '@/lib/permissions';
import { ShareDialog, type ShareChange } from '@/components/organisation/ShareDialog';
import { LEVELS } from '@/components/calendar/calendar-access';

/** Who a calendar is shared with, each at one of the five levels. A level above a share's own is offered only where the server will take it. */
export function CalendarShareDialog({ calendar, open, onClose }: { calendar: Pick<CalendarCalendar, 'id' | 'name'>; open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const shares = useCalendarShares(calendar.id, open);
  const candidates = useCalendarShareCandidates(calendar.id, query, open);
  const mayRaise = useCalendarShareReach(calendar.id, shares.data ?? [], open);
  const change = useSessionMutation({
    mutationFn: ({ principal, permission }: ShareChange<CalendarPermission>) => calendarSharesApi.setShare(calendar.id, { principal, permission }),
    onSuccess: (next, { name, permission }) => {
      client.setQueryData(calendarSharesQueryKeys.shares(calendar.id), next);
      toast({ title: permission ? `${name} ${LEVELS[permission].toLowerCase()}` : `No longer shared with ${name}`, description: calendar.name });
    },
    onError: (error: Error) => toast({ title: 'Could not change the share', description: error.message, variant: 'destructive' }),
  });
  return (
    <ShareDialog open={open} onClose={onClose} title={<>Share {calendar.name}</>} description="They find it in their Calendar panel and its tasks in ToDo. A change applies as soon as you make it."
      noun="calendar" levels={LEVELS} levelClassName="w-44" shares={shares} query={query} onQuery={setQuery} candidates={candidates} mayRaise={mayRaise}
      notes={[
        '“Sees busy times” shows only when something is on, as “Busy”. “Can add subtasks” reads everything, adds subtasks to events and tasks and changes only their own.',
        !can(user, 'calendars.manage') && 'You can share with the groups you are in and the people in them. An administrator can share with anyone.',
      ]}
      pending={change.isPending} onChange={change.mutate} />
  );
}
