import { useQuery } from '@tanstack/react-query';
import { useModules } from '@/hooks/use-modules';
import { useCalendarSettings, useMailAccountSettings, useUserSettings } from '@/hooks/use-settings';
import { useMailAccountFolders, useMailAccounts } from '@/hooks/use-mail-queries';
import type { MailAccount } from '@/lib/mail-api';
import { folderRef, refersTo, toggleFolder } from '@/lib/notification-folders';
import { calendarApi, calendarQueryKeys } from '@/lib/calendar-api';
import { DEFAULT_CALENDAR_SETTINGS, DEFAULT_MAIL_ACCOUNT_SETTINGS, defaultsResolved, settingValues, type MailAccountSettings, type MailAccountSettingValues, type NotificationFolderRef, type UserSettingValues } from '@/lib/settings-api';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ErrorState, LoadingState } from '@/components/ui/page-states';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { ADMIN_REASON, allowedByFloor, policyReason } from '@/components/settings/setting-policy';

// What is announced, per mail account and per calendar (F6). The server
// applies every choice here before a notification leaves it; the page only
// reflects them.

const MAIL_DETAIL: { value: MailAccountSettingValues['notify_detail']; label: string }[] = [
  { value: 'full', label: 'Sender and subject' },
  { value: 'sender', label: 'Sender only' },
  { value: 'none', label: 'Nothing, just “New email”' },
];
const MAIL_DETAIL_ORDER = MAIL_DETAIL.map(option => option.value);
const REMINDER_DETAIL: { value: UserSettingValues['reminder_notification_detail']; label: string }[] = [
  { value: 'full', label: 'Title and time' },
  { value: 'none', label: 'Nothing, just “Event reminder”' },
];
const REMINDER_DETAIL_ORDER = REMINDER_DETAIL.map(option => option.value);
const SERVER_NOTE = 'The server applies these choices before a notification leaves it.';
const ACCOUNT_NOTE = 'Saved with your account, so every device follows.';

export function NotificationChoices() {
  const { isEnabled } = useModules();
  return (
    <>
      {isEnabled('mail') && <MailNotificationChoices />}
      {isEnabled('calendar') && <CalendarNotificationChoices />}
    </>
  );
}

function MailNotificationChoices() {
  const accountsQuery = useMailAccounts();
  const accounts = (accountsQuery.data ?? []).filter(account => account.is_active && !account.disconnected_at);
  const { accounts: settings, change, unavailable, error, refetch, refetching } = useMailAccountSettings();
  return (
    <SettingsSection title="New mail" description={`For each mail account. ${ACCOUNT_NOTE} ${SERVER_NOTE}`}>
      {accountsQuery.isLoading && <SettingsBlock><LoadingState compact label="Loading accounts…" /></SettingsBlock>}
      {accountsQuery.error && <SettingsBlock><ErrorState title="Could not load the mail accounts" error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} retrying={accountsQuery.isFetching} /></SettingsBlock>}
      {error && <SettingsBlock><ErrorState title="Could not load the mail notification settings" error={error} onRetry={refetch} retrying={refetching} /></SettingsBlock>}
      {accountsQuery.isSuccess && accounts.length === 0 && <SettingsBlock><p className="text-sm text-muted-foreground">Add a mail account to choose what it announces.</p></SettingsBlock>}
      {accounts.map(account => (
        <AccountNotifications key={account.id} account={account} unavailable={unavailable}
          settings={settings[account.id] ?? defaultsResolved(DEFAULT_MAIL_ACCOUNT_SETTINGS)} change={patch => change(account.id, patch)} />
      ))}
    </SettingsSection>
  );
}

/** One account's rows under its address; a group, so the same labels can repeat per account. */
function AccountNotifications({ account, settings, unavailable, change }: {
  account: MailAccount; settings: MailAccountSettings; unavailable: boolean; change: (patch: Partial<MailAccountSettingValues>) => void;
}) {
  const values = settingValues(settings);
  const id = (key: string) => `notify-${key}-${account.id}`;
  const disabled = (key: keyof MailAccountSettingValues) => unavailable || settings[key].locked;
  const lock = (key: keyof MailAccountSettingValues) => settings[key].locked ? ADMIN_REASON : undefined;
  return (
    <div role="group" aria-labelledby={id('title')} className="pt-4">
      <h3 id={id('title')} className="text-sm font-semibold">{account.email_address}</h3>
      {account.display_name && <p className="mt-0.5 text-sm text-muted-foreground">{account.display_name}</p>}
      <div className="divide-y divide-border">
        <SettingsRow label="Notifications" description="New mail in this account." htmlFor={id('enabled')} lock={lock('notify_enabled')}>
          <Switch id={id('enabled')} checked={values.notify_enabled} disabled={disabled('notify_enabled')} onCheckedChange={checked => change({ notify_enabled: checked })} />
        </SettingsRow>
        {values.notify_enabled && (
          <>
            <SettingsRow label="Folders" description="Which folders announce new mail." htmlFor={id('mode')} lock={lock('notify_folder_mode')}>
              <Select value={values.notify_folder_mode} disabled={disabled('notify_folder_mode')} onValueChange={value => change({ notify_folder_mode: value as MailAccountSettingValues['notify_folder_mode'] })}>
                <SelectTrigger id={id('mode')} className="w-full sm:w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="except">All folders except</SelectItem>
                  <SelectItem value="only">Only these folders</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <FolderPicker account={account} mode={values.notify_folder_mode} refs={values.notify_folders} disabled={disabled('notify_folders')} lock={lock('notify_folders')}
              onChange={notify_folders => change({ notify_folders })} />
            <SettingsRow label="What it shows" description="The sender and subject, the sender, or only that mail arrived." htmlFor={id('detail')} lock={policyReason(settings.notify_detail)}>
              <Select value={values.notify_detail} disabled={disabled('notify_detail')} onValueChange={value => change({ notify_detail: value as MailAccountSettingValues['notify_detail'] })}>
                <SelectTrigger id={id('detail')} className="w-full sm:w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MAIL_DETAIL.map(option => (
                    <SelectItem key={option.value} value={option.value} disabled={!allowedByFloor(settings.notify_detail, MAIL_DETAIL_ORDER, option.value)}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </>
        )}
      </div>
    </div>
  );
}

/** The account's folders as checkboxes; a system folder is stored by its role, another by its id. */
function FolderPicker({ account, mode, refs, disabled, lock, onChange }: {
  account: MailAccount; mode: MailAccountSettingValues['notify_folder_mode']; refs: NotificationFolderRef[]; disabled: boolean; lock?: string;
  onChange: (refs: NotificationFolderRef[]) => void;
}) {
  const folders = useMailAccountFolders(account.id);
  const listed = (folders.data ?? []).filter(folder => folderRef(folder));
  const label = mode === 'only' ? 'Announced folders' : 'Quiet folders';
  if (folders.isLoading) return <SettingsBlock><LoadingState compact label="Loading folders…" /></SettingsBlock>;
  if (folders.error) return <SettingsBlock><ErrorState title="Could not load the folders" error={folders.error} onRetry={() => void folders.refetch()} retrying={folders.isFetching} /></SettingsBlock>;
  return (
    <SettingsRow label={label} description={mode === 'only' ? 'New mail in a ticked folder is announced.' : 'New mail in a ticked folder is not announced.'} lock={lock} stack>
      <div role="group" aria-label={label} className="grid w-full grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 touch:gap-y-4">
        {listed.map(folder => (
          <label key={folder.id} className="flex min-h-6 min-w-0 cursor-pointer items-center gap-2 text-sm touch:min-h-11">
            <Checkbox checked={refs.some(ref => refersTo(ref, folder))} disabled={disabled} onCheckedChange={checked => onChange(toggleFolder(refs, folder, checked === true))} />
            <span className="truncate" title={folder.display_name}>{folder.display_name}</span>
          </label>
        ))}
      </div>
    </SettingsRow>
  );
}

function CalendarNotificationChoices() {
  const { settings, values, change, unavailable } = useUserSettings();
  const calendars = useQuery({ queryKey: calendarQueryKeys.calendars, queryFn: ({ signal }) => calendarApi.fetchCalendars(signal) });
  const { calendars: calendarSettings, change: changeCalendar, unavailable: calendarsUnavailable, error, refetch, refetching } = useCalendarSettings();
  const detail = settings.reminder_notification_detail;
  return (
    <SettingsSection title="Reminders" description={`Event and task reminders, and new items in shared calendars. ${ACCOUNT_NOTE} ${SERVER_NOTE}`}>
      <SettingsRow label="What a reminder shows" description="The title and time, or only that a reminder is due." htmlFor="reminder-detail" lock={policyReason(detail)}>
        <Select value={values.reminder_notification_detail} disabled={unavailable || detail.locked}
          onValueChange={value => change({ reminder_notification_detail: value as UserSettingValues['reminder_notification_detail'] })}>
          <SelectTrigger id="reminder-detail" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {REMINDER_DETAIL.map(option => (
              <SelectItem key={option.value} value={option.value} disabled={!allowedByFloor(detail, REMINDER_DETAIL_ORDER, option.value)}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {error && <SettingsBlock><ErrorState title="Could not load the calendar notification settings" error={error} onRetry={refetch} retrying={refetching} /></SettingsBlock>}
      {calendars.isLoading && <SettingsBlock><LoadingState compact label="Loading calendars…" /></SettingsBlock>}
      {calendars.error && <SettingsBlock><ErrorState title="Could not load the calendars" error={calendars.error} onRetry={() => void calendars.refetch()} retrying={calendars.isFetching} /></SettingsBlock>}
      {(calendars.data ?? []).map(calendar => {
        const setting = (calendarSettings[calendar.id] ?? defaultsResolved(DEFAULT_CALENDAR_SETTINGS)).notify_enabled;
        return (
          <SettingsRow key={calendar.id} htmlFor={`notify-calendar-${calendar.id}`} lock={setting.locked ? ADMIN_REASON : undefined}
            label={<span className="flex items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}</span>}
            description={calendar.account_display_name || calendar.account_email || undefined}>
            <Switch id={`notify-calendar-${calendar.id}`} checked={setting.value} disabled={calendarsUnavailable || setting.locked}
              onCheckedChange={checked => changeCalendar(calendar.id, { notify_enabled: checked })} />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
