import { useCallback, useContext, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MutateOptions, UseMutationOptions, UseMutationResult } from '@tanstack/react-query';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { AuthContext } from '@/contexts/auth-context';
import { hasCode } from '@/lib/api-error';

/**
 * useSessionMutation for a request whose variables carry a secret, such as
 * the administrator's password confirming an action. TanStack keeps a
 * mutation's variables in its cache while it runs and, once settled, for the
 * garbage-collection time; here its variables are only a number, and the
 * real ones (the secret with them) stay in this component for the request's
 * own life: they are dropped when it settles, when the component unmounts
 * and so when the session ends (SessionQueryProvider is mounted per
 * session). The mutation is also reset as soon as it settles and collected
 * at once. Feedback belongs in the callbacks, which get the real variables:
 * the result and the error are not kept either, and, as for every session
 * mutation, the callbacks run only while the session the request started in
 * is still the current one.
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
  const secrets = useRef(new Map<number, TVariables>());
  const next = useRef(0);
  useEffect(() => { const held = secrets.current; return () => held.clear(); }, []);
  const of = (handle: number) => secrets.current.get(handle) as TVariables;
  const mutation = useSessionMutation<TData, TError, number, TContext>({
    ...options,
    gcTime: 0,
    mutationFn: (handle, context) => {
      if (!mutationFn) throw new Error('useSecretMutation needs a mutationFn');
      return mutationFn(of(handle), context);
    },
    onMutate: onMutate && ((handle, context) => onMutate(of(handle), context)),
    onSuccess: onSuccess && ((data, handle, onMutateResult, context) => onSuccess(data, of(handle), onMutateResult, context)),
    onSettled: (data, error, handle, onMutateResult, context) => {
      try { return onSettled?.(data, error, of(handle), onMutateResult, context); } finally { secrets.current.delete(handle); }
    },
    onError: (error, handle, onMutateResult, context) => {
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
  const { isSuccess, isError, reset, variables: settled, mutate: mutateHandle, mutateAsync: mutateHandleAsync } = mutation;
  // A request answered after its session ended runs no callbacks (useSessionMutation); its variables go here.
  useEffect(() => {
    if (!isSuccess && !isError) return;
    if (settled !== undefined) secrets.current.delete(settled);
    reset();
  }, [isSuccess, isError, settled, reset]);
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
