import { useCallback, useContext, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, type MutateOptions, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { useSessionScope } from '@/lib/session-scope';
import { useToast } from '@/hooks/use-toast';
import { AuthContext } from '@/contexts/auth-context';
import { hasCode } from '@/lib/api-error';

/**
 * useSessionMutation for a request whose variables carry a secret, such as
 * the administrator's password confirming an action. TanStack keeps a
 * mutation's variables in its cache while it runs and, once settled, for the
 * garbage-collection time; here its variables are only a number, and the
 * real ones (the secret with them) are kept beside the request for its own
 * life, as its body is: they are dropped once it settles and its callbacks
 * ran, also when the page was left meanwhile (the callbacks still get them,
 * so a success still refreshes what it changed) or the session ended (the
 * callbacks are skipped, the variables dropped all the same). The mutation
 * is also reset as soon as it settles and collected at once. Feedback
 * belongs in the callbacks: the result and the error are not kept either,
 * and, as for every session mutation (useSessionMutation), the callbacks run
 * only while the session the request started in is still the current one.
 *
 * The server proves the caller before such a change (caller-proof.ts) and
 * answers for everyone here: 403 PASSWORD_CHANGED (the password changed
 * meanwhile: sign in again) and 403 ADMIN_REQUIRED (no longer an
 * administrator: leave the admin screens). 401 SESSION_ENDED takes the
 * shared path of every 401 (the API client ends the session). Nothing was
 * changed in any of these cases, unless the action has several steps and
 * `partly` says what the earlier steps did (the group delete): then the
 * notice says that instead.
 */
export function useSecretMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  { partly, mutationFn, onMutate, onSuccess, onError, onSettled, ...options }: UseMutationOptions<TData, TError, TVariables, TContext> & { partly?: (variables: TVariables) => string | null },
): UseMutationResult<TData, TError, TVariables, TContext> {
  // The session where one is mounted; a view rendered on its own (unit tests) may have none.
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const { toast } = useToast();
  const scope = useSessionScope();
  // Not cleared when the page unmounts: a pending request's callbacks still need its entry.
  const secrets = useRef(new Map<number, TVariables>());
  const next = useRef(0);
  const of = (handle: number) => secrets.current.get(handle) as TVariables;
  const mutation = useMutation<TData, TError, number, TContext>({
    ...options,
    gcTime: 0,
    mutationFn: (handle, context) => {
      if (!mutationFn) throw new Error('useSecretMutation needs a mutationFn');
      return mutationFn(of(handle), context);
    },
    onMutate: onMutate && ((handle, context) => onMutate(of(handle), context)),
    onSuccess: onSuccess && ((data, handle, onMutateResult, context) => (scope.ended ? undefined : onSuccess(data, of(handle), onMutateResult, context))),
    // TanStack runs this after onSuccess or onError, whether or not the page is still there.
    onSettled: async (data, error, handle, onMutateResult, context) => {
      try { if (!scope.ended) await onSettled?.(data, error, of(handle), onMutateResult, context); } finally { secrets.current.delete(handle); }
    },
    onError: (error, handle, onMutateResult, context) => {
      if (scope.ended) return;
      const variables = of(handle);
      const outcome = partly?.(variables) ?? 'Nothing was changed.';
      if (hasCode(error, 'PASSWORD_CHANGED')) {
        toast({ title: 'Your password was changed meanwhile. Sign in again.', description: outcome, variant: 'destructive' });
        void auth?.signOut?.();
        return;
      }
      if (hasCode(error, 'ADMIN_REQUIRED')) {
        toast({ title: "You're no longer an administrator.", description: outcome, variant: 'destructive' });
        void auth?.retrySession?.();
        navigate('/settings', { replace: true });
        return;
      }
      return onError?.(error, variables, onMutateResult, context);
    },
  });
  const { isSuccess, isError, reset, mutate: mutateHandle, mutateAsync: mutateHandleAsync } = mutation;
  useEffect(() => { if (isSuccess || isError) reset(); }, [isSuccess, isError, reset]);
  // The variables of a call's own callbacks are the real ones, kept by the call.
  const hold = useCallback((variables: TVariables, callbacks?: MutateOptions<TData, TError, TVariables, TContext>) => {
    const handle = ++next.current;
    secrets.current.set(handle, variables);
    const own: MutateOptions<TData, TError, number, TContext> | undefined = callbacks && {
      onSuccess: callbacks.onSuccess && ((data, _handle, onMutateResult, context) => callbacks.onSuccess!(data, variables, onMutateResult, context)),
      onError: callbacks.onError && ((error, _handle, onMutateResult, context) => callbacks.onError!(error, variables, onMutateResult, context)),
      onSettled: callbacks.onSettled && ((data, error, _handle, onMutateResult, context) => callbacks.onSettled!(data, error, variables, onMutateResult, context)),
    };
    return [handle, own] as const;
  }, []);
  const mutate = useCallback((variables: TVariables, callbacks?: MutateOptions<TData, TError, TVariables, TContext>) => mutateHandle(...hold(variables, callbacks)), [hold, mutateHandle]);
  const mutateAsync = useCallback((variables: TVariables, callbacks?: MutateOptions<TData, TError, TVariables, TContext>) => mutateHandleAsync(...hold(variables, callbacks)), [hold, mutateHandleAsync]);
  // What TanStack holds is the handle; no caller reads the variables back.
  return { ...mutation, variables: undefined, mutate, mutateAsync } as unknown as UseMutationResult<TData, TError, TVariables, TContext>;
}
