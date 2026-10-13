import { usePreferences } from '@/hooks/use-preferences';
import { useModules } from '@/hooks/use-modules';
import { useMailAccounts } from '@/hooks/use-mail-queries';
import type { UserPreferences } from '@/lib/settings-api';
import { ErrorState } from '@/components/ui/page-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

const START_PAGES: { value: UserPreferences['default_start_page']; label: string; path: string }[] = [
  { value: 'mail', label: 'Mail', path: '/mail' },
  { value: 'calendar', label: 'Calendar', path: '/calendar' },
  { value: 'todo', label: 'ToDo', path: '/todo' },
  { value: 'contacts', label: 'Contacts', path: '/contacts' },
  { value: 'recordings', label: 'Recordings', path: '/recordings' },
  { value: 'music', label: 'Music', path: '/music' },
  { value: 'dashboard', label: 'Today', path: '/dashboard' },
];

export default function GeneralSettings() {
  const { canAccess } = useModules();
  const mailEnabled = canAccess('/mail');
  const senders = (useMailAccounts().data ?? []).filter(account => account.is_active && !account.disconnected_at);
  const { preferences, change, unavailable, error, refetch, refetching } = usePreferences();

  return (
    <>
      <SettingsSection title="Behaviour">
        {error && (
          <div className="py-4">
            <ErrorState title="Could not load your preferences" error={error} onRetry={refetch} retrying={refetching} />
          </div>
        )}
        <SettingsRow label="Start page" description="The page UniHub opens on." htmlFor="start-page">
          <Select value={preferences.default_start_page} disabled={unavailable}
            onValueChange={value => change({ default_start_page: value as UserPreferences['default_start_page'] })}>
            <SelectTrigger id="start-page" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {START_PAGES.filter(page => canAccess(page.path) || page.value === preferences.default_start_page).map(page => (
                <SelectItem key={page.value} value={page.value}>{page.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="Email addresses" description="When you click an email address." htmlFor="email-links">
          <Select value={preferences.email_link_behavior} disabled={unavailable}
            onValueChange={value => change({ email_link_behavior: value as UserPreferences['email_link_behavior'] })}>
            <SelectTrigger id="email-links" className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">Write in UniHub</SelectItem>
              <SelectItem value="mailto">Open the device mail app</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      {mailEnabled && senders.length > 0 && (
        <SettingsSection title="Mail">
          <SettingsRow label="Send from" description="For new messages written from All accounts. A reply comes from the account that received the message." htmlFor="send-from">
            <Select value={senders.some(account => account.id === preferences.default_mail_account_id) ? preferences.default_mail_account_id : 'first'} disabled={unavailable}
              onValueChange={value => change({ default_mail_account_id: value === 'first' ? '' : value })}>
              <SelectTrigger id="send-from" className="w-full sm:w-80"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first">First account ({senders[0].email_address})</SelectItem>
                {senders.map(account => <SelectItem key={account.id} value={account.id}>{account.email_address}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsSection>
      )}
    </>
  );
}
