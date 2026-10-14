import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { format, isToday } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
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
import { CalendarGrid, SelectedDay } from '@/components/calendar/CalendarGrid';
import { EventDialog, type EventDialogTarget } from '@/components/calendar/EventDialog';
import { AddCalendarAccountDialog, AddCalendarDialog, CalendarSettingsDialog } from '@/components/calendar/CalendarAccountDialogs';

const MODES: { id: CalendarViewMode; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }];

function ModeSwitch({ value, onChange, className }: { value: CalendarViewMode; onChange: (mode: CalendarViewMode) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Calendar view" className={cn('inline-flex rounded-md bg-muted p-0.5', className)}>
      {MODES.map(mode => (
        <button key={mode.id} type="button" role="radio" aria-checked={value === mode.id} onClick={() => onChange(mode.id)}
          className={cn('h-7 rounded-[5px] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

  const filters = {
    includeTodos: false, includeDone: true, calendarIds: view.selectedCalendarIds,
    rangeStart: view.range.start.toISOString(), rangeEnd: view.range.end.toISOString(),
  };
  const eventsQuery = useQuery({ queryKey: calendarQueryKeys.list(filters), queryFn: ({ signal }) => calendarApi.fetchEvents(filters, signal) });
  const events = eventsQuery.data ?? [];

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
  const shownCount = data.calendars.filter(calendar => view.selectedCalendarIds.includes(calendar.id)).length;
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
    <CalendarPanel data={data} shownIds={view.selectedCalendarIds} onShow={view.showCalendar} onNewEvent={() => newEvent()}
      onAddAccount={() => setAddingAccount(true)} onAddCalendar={setAddingCalendarTo} onCalendarSettings={setSettingsFor} />
  );

  return (
    <PageShell panel={panel} panelLabel="Calendars" panelId="calendar">
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
      {/* The dialog waits for calendars and accounts: whether an event is read-only
          or on a server (and so asks about repeating events) depends on them. */}
      <EventDialog target={calendarsReady ? dialog : null} onClose={() => setDialog(null)} calendars={data.calendars} accounts={data.accounts} actions={actions} timezone={timezone} />
      <AddCalendarAccountDialog open={addingAccount} onOpenChange={setAddingAccount} data={data} />
      <AddCalendarDialog accountId={addingCalendarTo} onClose={() => setAddingCalendarTo(null)} data={data} />
      <CalendarSettingsDialog calendar={settingsFor} onClose={() => setSettingsFor(null)} data={data} />
    </PageShell>
  );
};

export default CalendarPage;
