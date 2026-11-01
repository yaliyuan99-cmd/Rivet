import { useState } from 'react';
import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
    },
  },
});

/** GET a JSON API path. The path is the cache key unless a key is given. */
export function useApiQuery<T>(path: string, options: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'> & { key?: QueryKey } = {}) {
  const { key, ...rest } = options;
  return useQuery<T, Error>({ queryKey: key ?? [path], queryFn: () => api.get<T>(path), ...rest });
}

interface MutationOptions<TOutput, TInput> {
  /** Query keys or API paths to refetch afterwards. The session is refetched with ['session']. */
  invalidate?: (string | QueryKey)[];
  onSuccess?: (data: TOutput, input: TInput) => void;
  onError?: (error: ApiError) => void;
}

/**
 * Wraps a write. `fieldErrors` and `formError` carry the server's validation result so a page
 * shows the exact reason; nothing reports success until the server has answered.
 */
export function useApiMutation<TInput = void, TOutput = unknown>(fn: (input: TInput) => Promise<TOutput>, options: MutationOptions<TOutput, TInput> = {}) {
  const client = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation<TOutput, Error, TInput>({
    mutationFn: fn,
    onMutate: () => {
      setFieldErrors({});
      setFormError(null);
    },
    onSuccess: async (data, input) => {
      await Promise.all(
        (options.invalidate ?? []).map((key) => client.invalidateQueries({ queryKey: typeof key === 'string' ? [key] : key })),
      );
      options.onSuccess?.(data, input);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFieldErrors(error.fields);
        if (Object.keys(error.fields).length === 0) setFormError(error.message);
        else setFormError(error.message);
        options.onError?.(error);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    },
  });
  return { ...mutation, fieldErrors, formError, clearErrors: () => { setFieldErrors({}); setFormError(null); } };
}
