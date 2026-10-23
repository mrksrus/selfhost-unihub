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

// Saves run one after another (the mutation scope), so the server stores the
// choices in the order they were made. Only the latest save of a setting may
// write its answer or roll back; a failure goes back to the value the server
// last confirmed, never to a choice that was only shown. Saves of different
// settings never touch each other's values.
const SAVE_SCOPE = { id: 'settings' };
interface SaveState { latest: Map<string, number>; pending: Map<string, number>; confirmed: Map<string, unknown> }
const saveStates = new WeakMap<QueryClient, SaveState>();
let saveCounter = 0;

function stateOf(client: QueryClient) {
  if (!saveStates.has(client)) saveStates.set(client, { latest: new Map(), pending: new Map(), confirmed: new Map() });
  return saveStates.get(client)!;
}
// Starts a save of these settings; `current` is what is shown now, which is
// what the server holds while no other save of a setting is pending.
function claim(client: QueryClient, keys: string[], current: (key: string) => unknown) {
  const state = stateOf(client);
  const save = ++saveCounter;
  for (const key of keys) {
    if (!state.pending.get(key)) state.confirmed.set(key, current(key));
    state.pending.set(key, (state.pending.get(key) || 0) + 1);
    state.latest.set(key, save);
  }
  return save;
}
function finish(client: QueryClient, keys: string[]) {
  const state = stateOf(client);
  for (const key of keys) {
    const left = (state.pending.get(key) || 1) - 1;
    if (left) state.pending.set(key, left);
    else { state.pending.delete(key); state.confirmed.delete(key); }
  }
}
const isLatest = (client: QueryClient, key: string, save: number) => stateOf(client).latest.get(key) === save;

interface Target<T extends object> {
  queryKey: QueryKey;
  // The scope's record id for mail accounts and calendars; '' for the user.
  id: string;
  read: (data: unknown) => ResolvedSettings<T> | undefined;
  write: (data: unknown, settings: ResolvedSettings<T>) => unknown;
}

// A change shows at once; the answer replaces only the changed settings, a
// failure puts back what the server holds and says so.
function useSettingsMutation<T extends object>(save: (id: string, patch: Partial<T>) => Promise<ResolvedSettings<T>>) {
  const client = useQueryClient();
  const { toast } = useToast();
  const scoped = (target: Target<T>, patch: Partial<T>) => Object.keys(patch).map((key): [string, string] => [key, `${JSON.stringify(target.queryKey)}:${target.id}:${key}`]);
  return useMutation({
    scope: SAVE_SCOPE,
    mutationFn: ({ target, patch }: { target: Target<T>; patch: Partial<T> }) => save(target.id, patch),
    onMutate: async ({ target, patch }) => {
      await client.cancelQueries({ queryKey: target.queryKey, exact: true });
      const current = target.read(client.getQueryData(target.queryKey));
      const keys = scoped(target, patch);
      const byScopedKey = new Map(keys.map(([key, scopedKey]) => [scopedKey, key]));
      const save = claim(client, keys.map(([, scopedKey]) => scopedKey), scopedKey => current?.[byScopedKey.get(scopedKey) as keyof T]);
      if (current) {
        const next = { ...current };
        for (const [key, value] of Object.entries(patch)) next[key as keyof T] = { ...current[key as keyof T], value, source: 'user' } as ResolvedSettings<T>[keyof T];
        client.setQueryData(target.queryKey, (data: unknown) => target.write(data, next));
      }
      return { save };
    },
    onError: (error, { target, patch }, context) => {
      const state = stateOf(client);
      const keys = scoped(target, patch).filter(([, scopedKey]) => context && isLatest(client, scopedKey, context.save));
      if (!keys.length) return;
      client.setQueryData(target.queryKey, (data: unknown) => {
        const current = target.read(data);
        if (!current) return data;
        const restored = keys.filter(([, scopedKey]) => state.confirmed.get(scopedKey) !== undefined)
          .map(([key, scopedKey]) => [key, state.confirmed.get(scopedKey)]);
        return target.write(data, { ...current, ...Object.fromEntries(restored) });
      });
      toast({ title: 'Could not save the setting', description: error.message, variant: 'destructive' });
    },
    onSuccess: (saved, { target, patch }, context) => {
      const state = stateOf(client);
      const keys = scoped(target, patch);
      for (const [key, scopedKey] of keys) if (saved[key as keyof T] !== undefined) state.confirmed.set(scopedKey, saved[key as keyof T]);
      const latest = keys.filter(([, scopedKey]) => isLatest(client, scopedKey, context.save)).map(([key]) => key);
      client.setQueryData(target.queryKey, (data: unknown) => {
        const current = target.read(data);
        return current ? target.write(data, { ...current, ...Object.fromEntries(latest.map(key => [key, saved[key as keyof T]])) }) : data;
      });
    },
    onSettled: (_saved, _error, { target, patch }) => finish(client, scoped(target, patch).map(([, scopedKey]) => scopedKey)),
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
