import { useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UseMutationOptions } from '@tanstack/react-query';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { AuthContext } from '@/contexts/auth-context';
import { hasCode } from '@/lib/api-error';

/**
 * useSessionMutation for a request whose variables carry a secret, such as
 * the administrator's password confirming an action. TanStack keeps the
 * variables of a settled mutation in its cache for the garbage-collection
 * time; here the mutation is reset as soon as it settles and collected at
 * once, so the secret is gone the moment the request is answered. Feedback
 * belongs in the callbacks: the result and the error are not kept either,
 * and, as for every session mutation, the callbacks run only while the
 * session the request started in is still the current one.
 *
 * The server proves the caller before such a change (caller-proof.ts) and
 * answers for everyone here: 403 PASSWORD_CHANGED (the password changed
 * meanwhile: sign in again) and 403 ADMIN_REQUIRED (no longer an
 * administrator: leave the admin screens). 401 SESSION_ENDED takes the
 * shared path of every 401 (the API client ends the session). Nothing was
 * changed in any of these cases.
 */
export function useSecretMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
) {
  // The session where one is mounted; a view rendered on its own (unit tests) may have none.
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const { toast } = useToast();
  const mutation = useSessionMutation<TData, TError, TVariables, TContext>({
    ...options,
    gcTime: 0,
    onError: (error, variables, onMutateResult, context) => {
      if (hasCode(error, 'PASSWORD_CHANGED')) {
        toast({ title: 'Your password was changed meanwhile. Sign in again.', description: 'Nothing was changed.', variant: 'destructive' });
        void auth?.signOut?.();
        return;
      }
      if (hasCode(error, 'ADMIN_REQUIRED')) {
        toast({ title: "You're no longer an administrator.", description: 'Nothing was changed.', variant: 'destructive' });
        void auth?.retrySession?.();
        navigate('/settings', { replace: true });
        return;
      }
      return options.onError?.(error, variables, onMutateResult, context);
    },
  });
  const { isSuccess, isError, reset } = mutation;
  useEffect(() => { if (isSuccess || isError) reset(); }, [isSuccess, isError, reset]);
  return mutation;
}
