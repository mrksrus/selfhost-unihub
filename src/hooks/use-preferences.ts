import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, preferencesQueryKey, preferencesQueryOptions, savePreferences, type UserPreferences } from '@/lib/settings-api';
import { useToast } from '@/hooks/use-toast';

/**
 * The user's preferences for a settings page. A choice is saved as soon as it
 * is made and shown at once; a failure puts the old value back and says so.
 */
export function usePreferences() {
  const client = useQueryClient();
  const { toast } = useToast();
  const query = useQuery(preferencesQueryOptions);
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
