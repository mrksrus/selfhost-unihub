import { useMemo, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { MoreHorizontal, Plus, Settings2, Trash2 } from 'lucide-react';
import { isRemoteCalendarAccount, type CalendarAccount, type CalendarCalendar } from '@/lib/calendar-api';
import type { CalendarAccounts } from '@/hooks/use-calendar-accounts';
import { useSetCalendarView } from '@/hooks/use-calendar-shares';
import { useAuth } from '@/contexts/useAuth';
import { isReached, ownerName } from '@/components/calendar/calendar-access';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button-variants';
import { PanelGroup, PanelHeader, PanelItem } from '@/components/layout/PageShell';
import { usePolicy } from '@/hooks/use-policies';
import { PolicyMenuItem, PolicyNote } from '@/components/ui/policy-note';

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

// Calendars of other people, of groups and of the organisation, under the person's own.
const REACHED = [['user', 'Shared with me'], ['group', 'Groups'], ['organisation', 'Organisation']] as const;

/** One calendar: shown or not, its name, whose it is and what stands out about it, and its settings. */
function CalendarRow({ calendar, shown, detail, mark, onShow, onSettings }: {
  calendar: CalendarCalendar; shown: boolean; detail?: string | null; mark?: string | null; onShow: (shown: boolean) => void; onSettings: () => void;
}) {
  return (
    // On touch screens a row is as tall as its gear's tap area, so neighbouring rows' areas never overlap.
    <li className="group flex items-center gap-1 rounded-md pr-1 touch:min-h-11 hover:bg-muted/60">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-sm">
        <input type="checkbox" checked={shown} onChange={event => onShow(event.target.checked)}
          className="h-4 w-4 shrink-0 cursor-pointer rounded" style={{ accentColor: calendar.color }} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', !shown && 'text-muted-foreground')}>{calendar.name}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
        {mark && <span className="shrink-0 text-xs text-muted-foreground">{mark}</span>}
      </label>
      <Button variant="ghost" size="icon-xs" className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={`Settings for ${calendar.name}`} onClick={onSettings}>
        <Settings2 aria-hidden="true" />
      </Button>
    </li>
  );
}

interface Props {
  data: CalendarAccounts;
  shownIds: string[];
  onShow: (calendarId: string, shown: boolean) => void;
  onNewEvent: () => void;
  onAddAccount: () => void;
  onAddCalendar: (accountId: string) => void;
  onCalendarSettings: (calendar: CalendarCalendar) => void;
  /** The bin of deleted events, tasks and calendars (0.28). */
  binOpen: boolean;
  onOpenBin: () => void;
}

/** Calendar's context panel: accounts, their calendars and which ones are shown. */
export function CalendarPanel({ data, shownIds, onShow, onNewEvent, onAddAccount, onAddCalendar, onCalendarSettings, binOpen, onOpenBin }: Props) {
  const { accounts, calendars, accountsQuery, calendarsQuery } = data;
  const { user } = useAuth();
  const setView = useSetCalendarView();
  const reached = useMemo(() => calendars.filter(isReached), [calendars]);
  // The server refuses what a policy forbids; the entries only show the reason (F13).
  const removePolicy = usePolicy('accounts.remove');
  const addPolicy = usePolicy('accounts.add');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const groups = useMemo(() => {
    const grouped = new Map<string, { account: CalendarAccount | null; calendars: CalendarCalendar[] }>();
    for (const account of accounts) grouped.set(account.id, { account, calendars: [] });
    for (const calendar of calendars) {
      if (isReached(calendar)) continue;
      const entry = grouped.get(calendar.account_id) || { account: null, calendars: [] };
      entry.calendars.push(calendar);
      grouped.set(calendar.account_id, entry);
    }
    return [...grouped.values()];
  }, [accounts, calendars]);

  // A reached calendar is on or off in the person's own view of it, on every device.
  const show = (calendar: CalendarCalendar, shown: boolean) => {
    if (isReached(calendar)) { setView.mutate({ id: calendar.id, is_visible: shown }); return; }
    onShow(calendar.id, shown);
    data.updateCalendar.mutate({ id: calendar.id, data: { is_visible: shown } });
  };
  const row = (calendar: CalendarCalendar, readOnly: boolean) => {
    const offer = calendar.offer && (calendar.offer.to.id === user?.id ? 'Offered to you' : `Offered to ${calendar.offer.to.full_name || calendar.offer.to.email}`);
    return (
      <CalendarRow key={calendar.id} calendar={calendar} shown={shownIds.includes(calendar.id)} onShow={shown => show(calendar, shown)} onSettings={() => onCalendarSettings(calendar)}
        detail={[calendar.owner_kind === 'organisation' ? null : ownerName(calendar), offer].filter(Boolean).join(' · ')}
        mark={calendar.archived ? 'Archived' : calendar.permission === 'freebusy' ? 'Busy only' : readOnly || calendar.permission === 'read' ? 'Read-only' : null} />
    );
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
        ) : groups.length === 0 && reached.length === 0 ? (
          <p className="px-4 py-2 text-sm text-muted-foreground">No calendars yet. Add an account to start.</p>
        ) : groups.map(({ account, calendars: accountCalendars }) => {
          const remote = isRemoteCalendarAccount(account);
          const status = account && remote ? accountSyncText(account) : null;
          const name = account?.display_name || account?.account_email || 'Calendars';
          return (
            <section key={account?.id ?? accountCalendars[0]?.account_id} aria-label={name} className="px-2 py-2">
              <div className="flex items-start gap-1 px-2 pb-1 touch:pb-2.5">
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
                      <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={`Actions for ${name}`}><MoreHorizontal aria-hidden="true" /></Button>
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
                      <PolicyMenuItem lock={remote ? removePolicy.lock : undefined} className="text-destructive focus:text-destructive" onClick={() => setConfirm(remote ? {
                        title: `Remove ${name}?`,
                        description: 'Its calendars and events are removed from UniHub. Nothing is deleted on the calendar server.',
                        action: 'Remove account', run: () => data.deleteAccount.mutate(account.id),
                      } : {
                        title: `Delete ${name}?`,
                        description: 'All its calendars and their events are deleted. This cannot be undone.',
                        action: 'Delete account', run: () => data.deleteAccount.mutate(account.id),
                      })}>
                        {remote ? 'Remove account' : 'Delete account'}
                      </PolicyMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <ul className="space-y-0.5">
                {accountCalendars.map(calendar => row(calendar, calendar.read_only || remote && account?.provider === 'ics'))}
              </ul>
            </section>
          );
        })}
        {!calendarsQuery.isLoading && !calendarsQuery.error && REACHED.map(([kind, title]) => {
          const list = reached.filter(calendar => calendar.owner_kind === kind);
          return list.length > 0 && (
            <section key={kind} aria-label={title} className="px-2 py-2">
              <h2 className="truncate px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h2>
              <ul className="space-y-0.5">{list.map(calendar => row(calendar, false))}</ul>
            </section>
          );
        })}
        <div className="px-4 pt-2">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onAddAccount} disabled={!!addPolicy.lock}><Plus aria-hidden="true" />Add calendar account</Button>
          {addPolicy.lock && <PolicyNote reason={addPolicy.lock} />}
        </div>
        <PanelGroup className="mt-2 border-t border-border pt-3">
          <PanelItem icon={Trash2} active={binOpen} onSelect={onOpenBin}>Bin</PanelItem>
        </PanelGroup>
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
