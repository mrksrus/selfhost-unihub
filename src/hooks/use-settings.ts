import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  DEFAULT_USER_SETTINGS,
  calendarSettingsQueryKey,
  calendarSettingsQueryOptions,
  defaultsResolved,
  mailAccountSettingsQueryKey,
  mailAccountSettingsQueryOptions,
  saveCalendarSettings,
  saveMailAccountSettings,
  saveUserSettings,
  settingValues,
  userSettingsQueryKey,
  userSettingsQueryOptions,
  type CalendarSettings,
  type CalendarSettingValues,
  type MailAccountSettings,
  type MailAccountSettingValues,
  type ResolvedSettings,
  type UserSettings,
  type UserSettingValues,
} from '@/lib/settings-api';
import { useToast } from '@/hooks/use-toast';

// The latest save per query client and setting. Saves of one setting can
// finish out of order; only the latest may write its answer or roll back, or
// an earlier choice comes back. Saves of different settings never touch each
// other's values.
const latestSave = new WeakMap<QueryClient, Map<string, number>>();
let saveCounter = 0;

function claim(client: QueryClient, keys: string[]) {
  const save = ++saveCounter;
  if (!latestSave.has(client)) latestSave.set(client, new Map());
  for (const key of keys) latestSave.get(client)!.set(key, save);
  return save;
}
const isLatest = (client: QueryClient, key: string, save: number) => latestSave.get(client)?.get(key) === save;

interface Target<T extends object> {
  queryKey: QueryKey;
  // The scope's record id for mail accounts and calendars; '' for the user.
  id: string;
  read: (data: unknown) => ResolvedSettings<T> | undefined;
  write: (data: unknown, settings: ResolvedSettings<T>) => unknown;
}

// A change shows at once; the answer replaces only the changed settings, a
// failure puts them back and says so.
function useSettingsMutation<T extends object>(save: (id: string, patch: Partial<T>) => Promise<ResolvedSettings<T>>) {
  const client = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ target, patch }: { target: Target<T>; patch: Partial<T> }) => save(target.id, patch),
    onMutate: async ({ target, patch }) => {
      const keys = Object.keys(patch).map(key => `${target.id}:${key}`);
      const save = claim(client, keys);
      await client.cancelQueries({ queryKey: target.queryKey, exact: true });
      const current = target.read(client.getQueryData(target.queryKey));
      const previous = current && Object.fromEntries(Object.keys(patch).map(key => [key, current[key as keyof T]]));
      if (current) {
        const next = { ...current };
        for (const [key, value] of Object.entries(patch)) next[key as keyof T] = { ...current[key as keyof T], value, source: 'user' } as ResolvedSettings<T>[keyof T];
        client.setQueryData(target.queryKey, (data: unknown) => target.write(data, next));
      }
      return { save, previous };
    },
    onError: (error, { target, patch }, context) => {
      const keys = Object.keys(patch).filter(key => context && isLatest(client, `${target.id}:${key}`, context.save));
      if (!keys.length) return;
      if (context?.previous) {
        client.setQueryData(target.queryKey, (data: unknown) => {
          const current = target.read(data);
          return current ? target.write(data, { ...current, ...Object.fromEntries(keys.map(key => [key, context.previous![key]])) }) : data;
        });
      }
      toast({ title: 'Could not save the setting', description: error.message, variant: 'destructive' });
    },
    onSuccess: (saved, { target, patch }, context) => {
      const keys = Object.keys(patch).filter(key => isLatest(client, `${target.id}:${key}`, context.save));
      client.setQueryData(target.queryKey, (data: unknown) => {
        const current = target.read(data);
        return current ? target.write(data, { ...current, ...Object.fromEntries(keys.map(key => [key, saved[key as keyof T]])) }) : data;
      });
    },
  });
}

/**
 * The signed-in person's settings for a settings page or a feature. A choice
 * is saved as soon as it is made and shown at once.
 */
export function useUserSettings() {
  const query = useQuery(userSettingsQueryOptions);
  const mutation = useSettingsMutation<UserSettingValues>((_id, patch) => saveUserSettings(patch));
  const settings: UserSettings = query.data ?? defaultsResolved(DEFAULT_USER_SETTINGS);
  const target: Target<UserSettingValues> = { queryKey: userSettingsQueryKey, id: '', read: data => data as UserSettings | undefined, write: (_data, next) => next };
  return {
    settings,
    values: settingValues(settings),
    /** True until the saved settings are known; controls are disabled meanwhile. */
    unavailable: !query.data,
    error: query.error,
    refetch: () => void query.refetch(),
    refetching: query.isFetching,
    change: (patch: Partial<UserSettingValues>) => mutation.mutate({ target, patch }),
  };
}

function scopedTarget<T extends object>(queryKey: QueryKey, id: string): Target<T> {
  return {
    queryKey, id,
    read: data => (data as Record<string, ResolvedSettings<T>> | undefined)?.[id],
    write: (data, next) => ({ ...(data as Record<string, ResolvedSettings<T>>), [id]: next }),
  };
}

/** Settings of each of the person's mail accounts, by account id. */
export function useMailAccountSettings(enabled = true) {
  const query = useQuery({ ...mailAccountSettingsQueryOptions, enabled });
  const mutation = useSettingsMutation<MailAccountSettingValues>(saveMailAccountSettings);
  return {
    accounts: query.data ?? {} as Record<string, MailAccountSettings>,
    unavailable: !query.data,
    error: query.error,
    refetch: () => void query.refetch(),
    refetching: query.isFetching,
    change: (accountId: string, patch: Partial<MailAccountSettingValues>) => mutation.mutate({ target: scopedTarget(mailAccountSettingsQueryKey, accountId), patch }),
  };
}

/** Settings of each of the person's calendars, by calendar id. */
export function useCalendarSettings(enabled = true) {
  const query = useQuery({ ...calendarSettingsQueryOptions, enabled });
  const mutation = useSettingsMutation<CalendarSettingValues>(saveCalendarSettings);
  return {
    calendars: query.data ?? {} as Record<string, CalendarSettings>,
    unavailable: !query.data,
    error: query.error,
    refetch: () => void query.refetch(),
    refetching: query.isFetching,
    change: (calendarId: string, patch: Partial<CalendarSettingValues>) => mutation.mutate({ target: scopedTarget(calendarSettingsQueryKey, calendarId), patch }),
  };
}
