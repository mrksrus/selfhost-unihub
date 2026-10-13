import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, preferencesQueryKey, preferencesQueryOptions, savePreferences, type UserPreferences } from '@/lib/settings-api';
import { useToast } from '@/hooks/use-toast';

// The latest save per query client. Saves can finish out of order; only the
// latest may write its answer or roll back, or an earlier choice comes back.
const latestSave = new WeakMap<QueryClient, number>();

/**
 * The user's preferences for a settings page. A choice is saved as soon as it
 * is made and shown at once; a failure puts the old value back and says so.
 */
export function usePreferences() {
  const client = useQueryClient();
  const { toast } = useToast();
  const query = useQuery(preferencesQueryOptions);
  const isLatest = (save: number | undefined) => save === latestSave.get(client);
  const save = useMutation({
    mutationFn: savePreferences,
    onMutate: async next => {
      const save = (latestSave.get(client) ?? 0) + 1;
      latestSave.set(client, save);
      await client.cancelQueries({ queryKey: preferencesQueryKey });
      const previous = client.getQueryData<UserPreferences>(preferencesQueryKey);
      if (isLatest(save)) client.setQueryData(preferencesQueryKey, next);
      return { previous, save };
    },
    onError: (error, _next, context) => {
      // A newer save carries this change too and decides the outcome.
      if (!isLatest(context?.save)) return;
      if (context?.previous) client.setQueryData(preferencesQueryKey, context.previous);
      toast({ title: 'Could not save the setting', description: error.message, variant: 'destructive' });
    },
    onSuccess: (saved, _next, context) => {
      if (isLatest(context?.save)) client.setQueryData(preferencesQueryKey, saved);
    },
  });
  const preferences = query.data ?? DEFAULT_PREFERENCES;
  return {
    preferences,
    /** True until the saved preferences are known; controls are disabled meanwhile. */
    unavailable: !query.data,
    error: query.error,
    refetch: () => void query.refetch(),
    refetching: query.isFetching,
    change: (patch: Partial<UserPreferences>) => save.mutate({ ...preferences, ...patch }),
  };
}
