import { useMemo, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { MoreHorizontal, Plus, Settings2 } from 'lucide-react';
import { isRemoteCalendarAccount, type CalendarAccount, type CalendarCalendar } from '@/lib/calendar-api';
import type { CalendarAccounts } from '@/hooks/use-calendar-accounts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button-variants';
import { PanelHeader } from '@/components/layout/PageShell';

const providerLabels: Record<string, string> = { local: 'On this server', caldav: 'CalDAV', ics: 'Subscription' };

function accountSyncText(account: CalendarAccount) {
  const last = account.last_synced_at ? new Date(account.last_synced_at) : null;
  const ago = last && !Number.isNaN(last.getTime()) ? formatDistanceToNowStrict(last, { addSuffix: true }) : null;
  if (!account.is_active || account.sync_status === 'paused') return { text: account.sync_error || 'Sync paused', error: false };
  if (account.sync_status === 'syncing') return { text: 'Syncing…', error: false };
  if (account.sync_status === 'error') return { text: account.sync_error || 'Sync failed', error: true };
  return { text: ago ? `Synced ${ago}` : 'Waiting for the first sync', error: false };
}

type Confirm = { title: string; description: string; action: string; run: () => void };

interface Props {
  data: CalendarAccounts;
  shownIds: string[];
  onShow: (calendarId: string, shown: boolean) => void;
  onNewEvent: () => void;
  onAddAccount: () => void;
  onAddCalendar: (accountId: string) => void;
  onCalendarSettings: (calendar: CalendarCalendar) => void;
}

/** Calendar's context panel: accounts, their calendars and which ones are shown. */
export function CalendarPanel({ data, shownIds, onShow, onNewEvent, onAddAccount, onAddCalendar, onCalendarSettings }: Props) {
  const { accounts, calendars, accountsQuery, calendarsQuery } = data;
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const groups = useMemo(() => {
    const grouped = new Map<string, { account: CalendarAccount | null; calendars: CalendarCalendar[] }>();
    for (const account of accounts) grouped.set(account.id, { account, calendars: [] });
    for (const calendar of calendars) {
      const entry = grouped.get(calendar.account_id) || { account: null, calendars: [] };
      entry.calendars.push(calendar);
      grouped.set(calendar.account_id, entry);
    }
    return [...grouped.values()];
  }, [accounts, calendars]);

  const show = (calendar: CalendarCalendar, shown: boolean) => {
    onShow(calendar.id, shown);
    data.updateCalendar.mutate({ id: calendar.id, data: { is_visible: shown } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Calendar" action={<Button size="sm" onClick={onNewEvent}><Plus aria-hidden="true" />New event</Button>} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {accountsQuery.error || calendarsQuery.error ? (
          <div className="px-3"><ErrorState title="Could not load calendars" error={calendarsQuery.error ?? accountsQuery.error}
            onRetry={() => { void accountsQuery.refetch(); void calendarsQuery.refetch(); }}
            retrying={accountsQuery.isFetching || calendarsQuery.isFetching} /></div>
        ) : accountsQuery.isLoading || calendarsQuery.isLoading ? (
          <LoadingState compact label="Loading calendars…" />
        ) : groups.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted-foreground">No calendars yet. Add an account to start.</p>
        ) : groups.map(({ account, calendars: accountCalendars }) => {
          const remote = isRemoteCalendarAccount(account);
          const status = account && remote ? accountSyncText(account) : null;
          const name = account?.display_name || account?.account_email || 'Calendars';
          return (
            <section key={account?.id ?? accountCalendars[0]?.account_id} aria-label={name} className="px-2 py-2">
              <div className="flex items-start gap-1 px-2 pb-1">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xs font-medium text-muted-foreground" title={name}>{name}</h2>
                  <p className={cn('truncate text-xs', status?.error ? 'text-destructive' : 'text-muted-foreground/80')}>
                    {status ? status.text : providerLabels[account?.provider || ''] ?? ''}
                    {account?.mail_account_id ? ' · from a mail account' : ''}
                  </p>
                </div>
                {account && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Actions for ${name}`}><MoreHorizontal aria-hidden="true" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {remote && account.is_active && (
                        <DropdownMenuItem disabled={data.syncAccount.isPending} onClick={() => data.syncAccount.mutate(account.id)}>Sync now</DropdownMenuItem>
                      )}
                      {remote && (
                        <DropdownMenuItem onClick={() => data.setAccountActive.mutate({ id: account.id, active: !account.is_active })}>
                          {account.is_active ? 'Pause sync' : 'Resume sync'}
                        </DropdownMenuItem>
                      )}
                      {!remote && <DropdownMenuItem onClick={() => onAddCalendar(account.id)}>Add a calendar</DropdownMenuItem>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirm(remote ? {
                        title: `Remove ${name}?`,
                        description: 'Its calendars and events are removed from UniHub. Nothing is deleted on the calendar server.',
                        action: 'Remove account', run: () => data.deleteAccount.mutate(account.id),
                      } : {
                        title: `Delete ${name}?`,
                        description: 'All its calendars and their events are deleted. This cannot be undone.',
                        action: 'Delete account', run: () => data.deleteAccount.mutate(account.id),
                      })}>
                        {remote ? 'Remove account' : 'Delete account'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <ul className="space-y-0.5">
                {accountCalendars.map(calendar => {
                  const shown = shownIds.includes(calendar.id);
                  const readOnly = calendar.read_only || remote && account?.provider === 'ics';
                  return (
                    <li key={calendar.id} className="group flex items-center gap-1 rounded-md pr-1 hover:bg-muted/60">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-sm">
                        <input type="checkbox" checked={shown} onChange={event => show(calendar, event.target.checked)}
                          className="h-4 w-4 shrink-0 cursor-pointer rounded" style={{ accentColor: calendar.color }} />
                        <span className={cn('min-w-0 flex-1 truncate', !shown && 'text-muted-foreground')}>{calendar.name}</span>
                        {readOnly && <span className="shrink-0 text-xs text-muted-foreground">Read-only</span>}
                      </label>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                        aria-label={`Settings for ${calendar.name}`} onClick={() => onCalendarSettings(calendar)}>
                        <Settings2 aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        <div className="px-4 pt-2">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onAddAccount}><Plus aria-hidden="true" />Add calendar account</Button>
        </div>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => confirm?.run()}>{confirm?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
