import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import {
  browserTimeZone, calendarApi, calendarQueryKeys, invalidateCalendarQueries,
  type CalendarAccount, type CalendarCalendar, type CalendarProvider,
} from '@/lib/calendar-api';

export interface NewCalendarAccount {
  provider: CalendarProvider;
  account_email: string;
  display_name: string;
  username: string;
  password: string;
  url: string;
}

const EMPTY_ACCOUNTS: CalendarAccount[] = [];
const EMPTY_CALENDARS: CalendarCalendar[] = [];

/** Calendar accounts and calendars: what they are, and every change to them. */
export function useCalendarAccounts() {
  const client = useQueryClient();
  const { toast } = useToast();
  const refresh = () => { void invalidateCalendarQueries(client); };
  const failed = (title: string) => (error: Error) => toast({ title, description: error.message, variant: 'destructive' });

  const accountsQuery = useQuery({ queryKey: calendarQueryKeys.accounts, queryFn: ({ signal }) => calendarApi.fetchAccounts(signal) });
  const calendarsQuery = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal) });

  const createAccount = useMutation({
    mutationFn: (form: NewCalendarAccount) => calendarApi.createAccount({
      provider: form.provider,
      account_email: form.provider === 'ics' ? null : form.account_email.trim() || null,
      display_name: form.display_name.trim() || null,
      ...(form.provider === 'caldav' ? { username: form.username.trim() || form.account_email.trim(), password: form.password } : {}),
      ...(form.provider !== 'local' ? { url: form.url.trim() || null, time_zone: browserTimeZone() } : {}),
    }),
    onSuccess: (data) => {
      refresh();
      const count = data.calendars?.length;
      toast({
        title: data.account.provider === 'local' ? 'Calendar account created' : 'Calendar connected',
        description: data.account.provider === 'local' ? undefined
          : `${count !== undefined ? `${count} calendar${count === 1 ? '' : 's'}${data.server?.label ? ` on ${data.server.label}` : ''}. ` : ''}Events appear as the first sync finishes.`,
      });
    },
    onError: failed('Could not add the calendar account'),
  });

  const deleteAccount = useMutation({
    mutationFn: (id: string) => calendarApi.deleteAccount(id),
    onSuccess: () => { refresh(); toast({ title: 'Account removed' }); },
    onError: failed('Could not remove the account'),
  });

  const syncAccount = useMutation({
    mutationFn: (id: string) => calendarApi.syncAccount(id),
    onSettled: refresh,
    onError: failed('Calendar sync failed'),
  });

  const setAccountActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => calendarApi.updateAccount(id, { is_active: active }),
    onSuccess: (account) => {
      refresh();
      void client.invalidateQueries({ queryKey: ['mail-calendar'] });
      toast({ title: account.is_active ? 'Sync resumed' : 'Sync paused' });
    },
    onError: failed('Could not change sync'),
  });

  const createCalendar = useMutation({
    mutationFn: (form: { account_id: string; name: string; color: string; auto_todo_enabled: boolean }) =>
      calendarApi.createCalendar({ ...form, name: form.name.trim() }),
    onSuccess: () => { refresh(); toast({ title: 'Calendar created' }); },
    onError: failed('Could not create the calendar'),
  });

  const updateCalendar = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Pick<CalendarCalendar, 'is_visible' | 'auto_todo_enabled' | 'color'>> }) =>
      calendarApi.updateCalendar(id, data),
    onSuccess: refresh,
    onError: failed('Could not update the calendar'),
  });

  const deleteCalendar = useMutation({
    mutationFn: (id: string) => calendarApi.deleteCalendar(id),
    onSuccess: () => { refresh(); toast({ title: 'Calendar deleted' }); },
    onError: failed('Could not delete the calendar'),
  });

  return {
    accountsQuery, calendarsQuery,
    accounts: accountsQuery.data ?? EMPTY_ACCOUNTS,
    calendars: calendarsQuery.data ?? EMPTY_CALENDARS,
    createAccount, deleteAccount, syncAccount, setAccountActive, createCalendar, updateCalendar, deleteCalendar,
  };
}

export type CalendarAccounts = ReturnType<typeof useCalendarAccounts>;
