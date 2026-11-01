import type { QueryClient } from '@tanstack/react-query';

/** Every cached assurance read. */
export function invalidateAssurance(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/api/assurance') });
}
