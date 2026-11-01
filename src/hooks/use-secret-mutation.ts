import { useEffect } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';

/**
 * useMutation for a request whose variables carry a secret, such as the
 * administrator's password confirming an action. TanStack keeps the variables
 * of a settled mutation in its cache for the garbage-collection time; here the
 * mutation is reset as soon as it settles and collected at once, so the secret
 * is gone the moment the request is answered. Feedback belongs in the
 * callbacks: the result and the error are not kept either.
 */
export function useSecretMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
) {
  const mutation = useMutation<TData, TError, TVariables, TContext>({ ...options, gcTime: 0 });
  const { isSuccess, isError, reset } = mutation;
  useEffect(() => { if (isSuccess || isError) reset(); }, [isSuccess, isError, reset]);
  return mutation;
}
