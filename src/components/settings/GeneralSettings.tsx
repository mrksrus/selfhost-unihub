import { useQuery } from '@tanstack/react-query';
import { useUserSettings } from '@/hooks/use-settings';
import { useModules } from '@/hooks/use-modules';
import { REMINDER_OPTIONS, calendarApi, calendarQueryKeys, type CalendarCalendar } from '@/lib/calendar-api';
import { defaultEventCalendar, defaultTaskList, listRefusal } from '@/lib/tasks';
import type { UserSettingValues } from '@/lib/settings-api';
import { ErrorState } from '@/components/ui/page-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { ADMIN_REASON } from '@/components/settings/setting-policy';
import { ListChooser } from '@/components/todo/ListChooser';
import InstallSettings from '@/components/pwa/InstallSettings';

const START_PAGES: { value: UserSettingValues['default_start_page']; label: string; path: string }[] = [
  { value: 'mail', label: 'Mail', path: '/mail' },
  { value: 'calendar', label: 'Calendar', path: '/calendar' },
  { value: 'todo', label: 'ToDo', path: '/todo' },
  { value: 'contacts', label: 'Contacts', path: '/contacts' },
  { value: 'recordings', label: 'Recordings', path: '/recordings' },
  { value: 'music', label: 'Music', path: '/music' },
  { value: 'dashboard', label: 'Today', path: '/dashboard' },
];
const WEEK_STARTS: { value: UserSettingValues['week_start']; label: string }[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'saturday', label: 'Saturday' },
];
// The event dialog's choices plus "none"; null is stored for none.
const NO_REMINDER = 'none';
// '' is stored for UniHub's choice; the chooser needs a value of its own for it.
const UNIHUB_CHOICE = { value: 'auto', label: 'Let UniHub choose' };

// A list qualifies as the default task list when every task can go there,
// also one without a date, and it shows in ToDo (the server checks the same).
const taskListCandidates = (calendars: CalendarCalendar[]) => calendars.filter(calendar => calendar.takes_undated_tasks && calendar.auto_todo_enabled && !listRefusal(calendar, { undated: true }));

export default function GeneralSettings() {
  const { canAccess } = useModules();
  const { settings, values: preferences, change, unavailable, error, refetch, refetching } = useUserSettings();
  const lock = (key: keyof UserSettingValues) => settings[key].locked ? ADMIN_REASON : undefined;
  const disabled = (key: keyof UserSettingValues) => unavailable || settings[key].locked;
  const calendarOn = canAccess('/calendar');
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal), enabled: calendarOn }).data ?? [];
  const taskLists = taskListCandidates(calendars);
  const storedList = preferences.default_task_list_id;
  const storedCalendar = preferences.default_calendar_id;
  // A choice that no longer qualifies (deleted, read-only, paused) reads as UniHub's choice; the row says which list that is.
  const staleList = !!storedList && calendars.length > 0 && !taskLists.some(list => list.id === storedList);
  const staleCalendar = !!storedCalendar && calendars.length > 0 && !calendars.some(calendar => calendar.id === storedCalendar && !listRefusal(calendar, { undated: false }));
  const listInEffect = defaultTaskList(calendars);
  const calendarInEffect = defaultEventCalendar(calendars);

  return (
    <>
      <SettingsSection title="Behaviour" description="Saved with your account, so every device follows.">
        {error && (
          <div className="py-4">
            <ErrorState title="Could not load your preferences" error={error} onRetry={refetch} retrying={refetching} />
          </div>
        )}
        <SettingsRow label="Start page" description="The page UniHub opens on." htmlFor="start-page" lock={lock('default_start_page')}>
          <Select value={preferences.default_start_page} disabled={disabled('default_start_page')}
            onValueChange={value => change({ default_start_page: value as UserSettingValues['default_start_page'] })}>
            <SelectTrigger id="start-page" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {START_PAGES.filter(page => canAccess(page.path) || page.value === preferences.default_start_page).map(page => (
                <SelectItem key={page.value} value={page.value}>{page.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Email addresses" description="When you click an email address." htmlFor="email-links" lock={lock('email_link_behavior')}>
          <Select value={preferences.email_link_behavior} disabled={disabled('email_link_behavior')}
            onValueChange={value => change({ email_link_behavior: value as UserSettingValues['email_link_behavior'] })}>
            <SelectTrigger id="email-links" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">Write in UniHub</SelectItem>
              <SelectItem value="mailto">Open the device mail app</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      {calendarOn && (
        <SettingsSection title="Calendar and ToDo">
          <SettingsRow label="Week starts on" description="For the calendar and date pickers." htmlFor="week-start" lock={lock('week_start')}>
            <Select value={preferences.week_start} disabled={disabled('week_start')}
              onValueChange={value => change({ week_start: value as UserSettingValues['week_start'] })}>
              <SelectTrigger id="week-start" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {WEEK_STARTS.map(day => <SelectItem key={day.value} value={day.value}>{day.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="Reminder for new events" description="What a new event starts with. Each event can still be changed." htmlFor="default-reminder" lock={lock('default_event_reminder')}>
            <Select value={preferences.default_event_reminder === null ? NO_REMINDER : String(preferences.default_event_reminder)} disabled={disabled('default_event_reminder')}
              onValueChange={value => change({ default_event_reminder: value === NO_REMINDER ? null : Number(value) })}>
              <SelectTrigger id="default-reminder" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_REMINDER}>No reminder</SelectItem>
                {REMINDER_OPTIONS.map(option => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="New tasks go to" htmlFor="default-task-list" lock={lock('default_task_list_id')}
            description={<>
              The list a new task starts in, in ToDo and from an email; each task can still go elsewhere. Only your own UniHub lists shown in ToDo can take every task. Where mail is sent from is chosen under Settings, Mail.
              {staleList && <span className="block text-warning">The list chosen before is no longer available; new tasks go to {listInEffect?.name ?? 'UniHub’s choice'}.</span>}
            </>}>
            <ListChooser id="default-task-list" calendars={taskLists} value={staleList ? UNIHUB_CHOICE.value : storedList || UNIHUB_CHOICE.value} undated extra={UNIHUB_CHOICE}
              disabled={disabled('default_task_list_id')} className="w-full sm:w-64"
              onChange={value => change({ default_task_list_id: value === UNIHUB_CHOICE.value ? '' : value })} />
          </SettingsRow>
          <SettingsRow label="New events go to" htmlFor="default-calendar" lock={lock('default_calendar_id')}
            description={<>
              The calendar a new event starts in; any writable calendar, also on a calendar server.
              {staleCalendar && <span className="block text-warning">The calendar chosen before is no longer available; new events go to {calendarInEffect?.name ?? 'UniHub’s choice'}.</span>}
            </>}>
            <ListChooser id="default-calendar" calendars={calendars} value={staleCalendar ? UNIHUB_CHOICE.value : storedCalendar || UNIHUB_CHOICE.value} extra={UNIHUB_CHOICE}
              disabled={disabled('default_calendar_id')} className="w-full sm:w-64" placeholder="Choose a calendar"
              onChange={value => change({ default_calendar_id: value === UNIHUB_CHOICE.value ? '' : value })} />
          </SettingsRow>
        </SettingsSection>
      )}

      <InstallSettings />
    </>
  );
}
