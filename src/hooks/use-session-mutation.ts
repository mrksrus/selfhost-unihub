import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { useSessionScope, type SessionScope } from '@/lib/session-scope';

/** A hook-level callback that does nothing once the session it started in has ended. */
function guard<A extends unknown[], R>(scope: SessionScope, callback: ((...args: A) => R) | undefined) {
  return callback && ((...args: A) => (scope.ended ? undefined : callback(...args)));
}

/**
 * useMutation for private data: a request that answers after an account switch
 * or a sign-out runs none of its hook-level callbacks (notices, cache writes,
 * follow-up requests). TanStack runs those even after the component is gone;
 * callbacks passed to mutate() already stop with it.
 */
export function useSessionMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
) {
  const scope = useSessionScope();
  return useMutation<TData, TError, TVariables, TContext>({
    ...options,
    onSuccess: guard(scope, options.onSuccess),
    onError: guard(scope, options.onError),
    onSettled: guard(scope, options.onSettled),
  });
}
