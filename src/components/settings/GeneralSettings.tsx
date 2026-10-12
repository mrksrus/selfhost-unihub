import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';
import { DEFAULT_PREFERENCES, preferencesQueryKey, preferencesQueryOptions, savePreferences, type UserPreferences } from '@/lib/settings-api';
import { useModules } from '@/hooks/use-modules';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/ui/page-states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

const THEMES = [{ value: 'dark', label: 'Dark', icon: Moon }, { value: 'light', label: 'Light', icon: Sun }, { value: 'system', label: 'System', icon: Monitor }] as const;

const START_PAGES: { value: UserPreferences['default_start_page']; label: string; path: string }[] = [
  { value: 'mail', label: 'Mail', path: '/mail' },
  { value: 'calendar', label: 'Calendar', path: '/calendar' },
  { value: 'todo', label: 'ToDo', path: '/todo' },
  { value: 'contacts', label: 'Contacts', path: '/contacts' },
  { value: 'recordings', label: 'Recordings', path: '/recordings' },
  { value: 'music', label: 'Music', path: '/music' },
  { value: 'dashboard', label: 'Today', path: '/dashboard' },
];

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md bg-muted p-0.5">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => setTheme(value)}
          className={cn('inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            theme === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <Icon aria-hidden="true" className="h-4 w-4" />{label}
        </button>
      ))}
    </div>
  );
}

export default function GeneralSettings() {
  const client = useQueryClient();
  const { toast } = useToast();
  const { canAccess } = useModules();
  const preferencesQuery = useQuery(preferencesQueryOptions);
  const preferences = preferencesQuery.data ?? DEFAULT_PREFERENCES;

  // A choice is saved as soon as it is made; a failure puts the old value back.
  const save = useMutation({
    mutationFn: savePreferences,
    onMutate: async next => {
      await client.cancelQueries({ queryKey: preferencesQueryKey });
      const previous = client.getQueryData<UserPreferences>(preferencesQueryKey);
      client.setQueryData(preferencesQueryKey, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) client.setQueryData(preferencesQueryKey, context.previous);
      toast({ title: 'Could not save the setting', description: error.message, variant: 'destructive' });
    },
    onSuccess: saved => client.setQueryData(preferencesQueryKey, saved),
  });
  const change = (patch: Partial<UserPreferences>) => save.mutate({ ...preferences, ...patch });
  const unavailable = !preferencesQuery.data;

  return (
    <>
      <SettingsSection title="Appearance">
        <SettingsRow label="Theme">
          <ThemeSwitch />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Behaviour">
        {preferencesQuery.error && (
          <div className="py-4">
            <ErrorState title="Could not load your preferences" error={preferencesQuery.error}
              onRetry={() => void preferencesQuery.refetch()} retrying={preferencesQuery.isFetching} />
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
    </>
  );
}
