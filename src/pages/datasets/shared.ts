import type { QueryClient } from '@tanstack/react-query';
import type { DatasetFormat } from '../../../shared/types/datasets.ts';

/**
 * Every cached dataset read, whichever filter or version it was for. An upload in progress is left
 * alone: it belongs to the page holding it, and refetching one that was just used would only 404.
 */
export function invalidateDatasets(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      return typeof key === 'string' && key.startsWith('/api/datasets') && !key.startsWith('/api/datasets/uploads/');
    },
  });
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];

/** "Three observations", "Twelve observations", "48 observations". */
export function observationCount(count: number): string {
  return `${WORDS[count] ?? count.toLocaleString('en-US')} ${count === 1 ? 'observation' : 'observations'}`;
}

export const formatLabel = (format: DatasetFormat | 'unknown') => format.toUpperCase();

/** "3 records", or that a PDF's records were not read. */
export function recordsLabel(format: DatasetFormat | 'unknown', count: number): string {
  if (format === 'pdf') return 'PDF, records not parsed';
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'record' : 'records'}`;
}
