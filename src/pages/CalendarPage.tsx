import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { format, isToday } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { useNotificationEventLink } from '@/hooks/use-notification-event-link';
import { useCalendarView, type CalendarViewMode } from '@/hooks/use-calendar-view';
import { useCalendarAccounts } from '@/hooks/use-calendar-accounts';
import { useEventActions } from '@/hooks/use-event-actions';
import { calendarApi, calendarQueryKeys, type CalendarCalendar } from '@/lib/calendar-api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { NarrowOnly, PageBody, PageHeader, PageShell } from '@/components/layout/PageShell';
import { CalendarPanel } from '@/components/calendar/CalendarPanel';
import { BinView } from '@/components/bin/BinView';
import { CalendarGrid, SelectedDay } from '@/components/calendar/CalendarGrid';
import { EventDialog, type EventDialogTarget } from '@/components/calendar/EventDialog';
import { AddCalendarAccountDialog, AddCalendarDialog, CalendarSettingsDialog } from '@/components/calendar/CalendarAccountDialogs';
import { atLeast, isReached, ownerName } from '@/components/calendar/calendar-access';
import { Chip, ChipGroup } from '@/components/ui/chips';

const MODES: { id: CalendarViewMode; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];

function ModeSwitch({ value, onChange, className }: { value: CalendarViewMode; onChange: (mode: CalendarViewMode) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Calendar view" className={cn('inline-flex rounded-md bg-muted p-0.5', className)}>
      {MODES.map(mode => (
        <button key={mode.id} type="button" role="radio" aria-checked={value === mode.id} onClick={() => onChange(mode.id)}
          className={cn('h-7 rounded-[5px] px-3 text-sm touch:h-9 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === mode.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {mode.label}
        </button>
      ))}
    </div>
  );
}

const CalendarPage = () => {
  const { user } = useAuth();
  const timezone = user?.timezone ?? null;
  const data = useCalendarAccounts();
  const view = useCalendarView(data.calendars);
  const actions = useEventActions();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<EventDialogTarget>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addingCalendarTo, setAddingCalendarTo] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<CalendarCalendar | null>(null);

  // The person's own calendars are shown as this browser last chose; a calendar
  // they reach follows their view of it, which is the same on every device.
  // Until the calendars are known, the browser's last choice stands.
  const calendarsKnown = !!data.calendarsQuery.data;
  const shownIds = useMemo(() => !calendarsKnown ? view.selectedCalendarIds
    : data.calendars.filter(calendar => isReached(calendar) ? calendar.is_visible : view.selectedCalendarIds.includes(calendar.id)).map(calendar => calendar.id),
  [calendarsKnown, data.calendars, view.selectedCalendarIds]);
  const filters = {
    includeTodos: false, includeDone: true, calendarIds: shownIds,
    rangeStart: view.range.start.toISOString(), rangeEnd: view.range.end.toISOString(),
  };
  // No calendar switched on shows nothing; a request without calendars would answer every event.
  const eventsQuery = useQuery({ queryKey: calendarQueryKeys.list(filters), queryFn: ({ signal }) => calendarApi.fetchEvents(filters, signal), enabled: !calendarsKnown || shownIds.length > 0 });
  const events = (calendarsKnown && shownIds.length === 0 ? undefined : eventsQuery.data) ?? [];

  useNotificationEventLink((event) => {
    view.selectDay(new Date(event.start_time));
    if (event.calendar_id) view.showCalendar(event.calendar_id, true);
    setDialog({ kind: 'edit', event });
  });

  // Today and the command palette link here to start a new event.
  useEffect(() => {
    if (params.get('action') !== 'new') return;
    setDialog({ kind: 'new' });
    const next = new URLSearchParams(params);
    next.delete('action');
    setParams(next, { replace: true });
  }, [params, setParams]);

  // ?view=bin shows the deleted events, tasks and calendars in place of the grid.
  const binOpen = params.get('view') === 'bin';
  const setBinOpen = (open: boolean, calendarId?: string) => {
    const next = new URLSearchParams(params);
    if (open) next.set('view', 'bin'); else next.delete('view');
    if (open && calendarId) next.set('calendar', calendarId); else next.delete('calendar');
    setParams(next, { replace: true });
  };
  // What was deleted from a calendar others share waits in that calendar's own bin, for everyone who may edit it.
  const sharedBins = data.calendars.filter(calendar => isReached(calendar) && atLeast(calendar, 'edit'));
  const binOf = binOpen ? sharedBins.find(calendar => calendar.id === params.get('calendar')) : undefined;

  const calendarsReady = !data.accountsQuery.isLoading && !data.calendarsQuery.isLoading;
  const newEvent = (date?: Date) => setDialog({ kind: 'new', date: date ?? view.selectedDate });
  const longTitle = view.viewMode === 'month' ? format(view.currentDate, 'MMMM yyyy')
    : view.viewMode === 'week' ? `${format(view.range.start, 'd MMM')} to ${format(view.range.end, 'd MMM yyyy')}`
    : format(view.currentDate, 'EEEE d MMMM');
  const shortTitle = view.viewMode === 'month' ? format(view.currentDate, 'MMM yyyy')
    : view.viewMode === 'week' ? `${format(view.range.start, 'd MMM')} to ${format(view.range.end, 'd MMM')}`
    : format(view.currentDate, 'EEE d MMM');
  const title = <><span className="md:hidden">{shortTitle}</span><span className="hidden md:inline">{longTitle}</span></>;
  const showingToday = view.viewMode === 'day' ? isToday(view.currentDate) : view.range.start <= new Date() && new Date() <= view.range.end;
  const shownCount = shownIds.length;
  const scope = data.calendars.length === 0 || shownCount === data.calendars.length ? 'All calendars'
    : shownCount === 0 ? 'No calendars' : `${shownCount} of ${data.calendars.length} calendars`;
  const periodNav = (
    <>
      <Button variant="ghost" size="icon" aria-label={`Previous ${view.viewMode}`} onClick={() => view.shiftPeriod(-1)}><ChevronLeft aria-hidden="true" /></Button>
      <Button variant="outline" size="sm" disabled={showingToday} onClick={view.goToday}>Today</Button>
      <Button variant="ghost" size="icon" aria-label={`Next ${view.viewMode}`} onClick={() => view.shiftPeriod(1)}><ChevronRight aria-hidden="true" /></Button>
    </>
  );

  const panel = (
    <CalendarPanel data={data} shownIds={shownIds} onShow={view.showCalendar} onNewEvent={() => newEvent()}
      onAddAccount={() => setAddingAccount(true)} onAddCalendar={setAddingCalendarTo} onCalendarSettings={setSettingsFor}
      binOpen={binOpen} onOpenBin={() => setBinOpen(true)} />
  );

  // The bin shows in place of the grid, under its own header. The panel and its
  // dialogs (a new event, a new account or calendar, a calendar's settings)
  // belong to both views, so they stay mounted here whichever is shown.
  const header = binOpen ? (
    <PageHeader title="Calendar" scope="Bin" back={
      <Button variant="ghost" size="icon" aria-label="Back to the calendar" onClick={() => setBinOpen(false)}><ChevronLeft aria-hidden="true" /></Button>
    }>
      {sharedBins.length > 0 && (
        <div className="px-4 pb-3 md:px-6">
          <ChipGroup label="Deleted from">
            <Chip icon={Trash2} selected={!binOf} onSelect={() => setBinOpen(true)}>My calendars</Chip>
            {sharedBins.map(calendar => (
              <Chip key={calendar.id} color={calendar.color} selected={binOf?.id === calendar.id} onSelect={() => setBinOpen(true, calendar.id)}>
                {calendar.name}{calendar.owner_kind === 'user' && ` · ${ownerName(calendar)}`}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      )}
    </PageHeader>
  ) : (
    <PageHeader title={title} scope={scope} actions={<>
      <div className="hidden items-center gap-1 md:flex">
        <ModeSwitch value={view.viewMode} onChange={view.setViewMode} className="mr-2" />
        {periodNav}
      </div>
      <NarrowOnly><Button size="icon" aria-label="New event" onClick={() => newEvent()}><Plus aria-hidden="true" /></Button></NarrowOnly>
    </>}>
      {/* Phones get the view switch and period buttons on their own row. */}
      <div className="flex items-center gap-1 px-4 pb-2 md:hidden">
        <ModeSwitch value={view.viewMode} onChange={view.setViewMode} className="mr-auto" />
        {periodNav}
      </div>
    </PageHeader>
  );

  return (
    <PageShell panel={panel} panelLabel="Calendars" panelId="calendar">
      {header}
      {binOpen ? <PageBody width="reading"><BinView key={binOf?.id ?? 'own'} module="calendar" calendar={binOf} /></PageBody> : (
        <PageBody width="full" className="md:py-5">
          {eventsQuery.error && <ErrorState className="mb-4" title="Could not load events" error={eventsQuery.error}
            onRetry={() => void eventsQuery.refetch()} retrying={eventsQuery.isFetching} />}
          {eventsQuery.isLoading ? <LoadingState label="Loading calendar…" /> : view.viewMode === 'day' ? (
            <div className="mx-auto max-w-3xl">
              <CalendarGrid view={view} events={events} timezone={timezone} onOpen={event => setDialog({ kind: 'edit', event })} onNew={newEvent} />
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <CalendarGrid view={view} events={events} timezone={timezone} onOpen={event => setDialog({ kind: 'edit', event })} onNew={newEvent} />
              <SelectedDay date={view.selectedDate} events={events} timezone={timezone} onOpen={event => setDialog({ kind: 'edit', event })} onNew={newEvent} />
            </div>
          )}
        </PageBody>
      )}
      {/* The dialog waits for calendars and accounts: whether an event is read-only
          or on a server (and so asks about repeating events) depends on them. */}
      <EventDialog target={calendarsReady ? dialog : null} onClose={() => setDialog(null)} calendars={data.calendars} accounts={data.accounts} actions={actions} timezone={timezone} events={events} />
      <AddCalendarAccountDialog open={addingAccount} onOpenChange={setAddingAccount} data={data} />
      <AddCalendarDialog accountId={addingCalendarTo} onClose={() => setAddingCalendarTo(null)} data={data} />
      <CalendarSettingsDialog calendar={settingsFor} onClose={() => setSettingsFor(null)} data={data} />
    </PageShell>
  );
};

export default CalendarPage;
