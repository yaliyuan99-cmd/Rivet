import { keepPreviousData } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { DatasetFilter, DatasetListItem, DatasetListResponse } from '../../../shared/types/datasets.ts';
import { Actions, ContextRail, DisabledAction, EmptyState, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace } from '../../components/index.ts';
import { formatDateTime, formatTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { recordsLabel } from './shared.ts';
import './datasets.css';

const FILTERS: { value: DatasetFilter; label: string; word: string; rail: string }[] = [
  { value: 'private', label: 'Private datasets', word: 'private ', rail: 'Private' },
  { value: 'shared', label: 'Shared datasets', word: 'shared ', rail: 'Shared' },
  { value: 'all', label: 'All datasets', word: '', rail: 'Private and shared' },
];

const asFilter = (value: string | null): DatasetFilter => (value === 'shared' || value === 'all' ? value : 'private');

function authorsOf(items: DatasetListItem[]): string {
  const names = [...new Set(items.map((item) => item.ownerName))];
  if (!names.length) return 'None yet';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ');
}

function provenanceOf(items: DatasetListItem[]): string {
  if (!items.length) return 'No datasets yet';
  if (items.every((item) => item.isSynthetic)) return 'Synthetic fixtures only';
  return items.some((item) => item.isSynthetic) ? 'Synthetic and uploaded data' : 'As stated on each dataset';
}

function SourceRow({ item }: { item: DatasetListItem }) {
  return (
    <>
      v{item.version} · {recordsLabel(item.format, item.recordsCount)} · {item.attachment}
      {item.inActiveWorkspace ? null : ` · Shared by ${item.workspaceName}`} ·{' '}
      <Link className="text-link" to={`/datasets/${item.code}`} aria-label={`Details for ${item.code}`}>
        Details
      </Link>{' '}
      /{' '}
      <a className="text-link" href={item.downloadPath} aria-label={`Download ${item.code} v${item.version}`}>
        Download
      </a>
    </>
  );
}

function Library({ data, filter, onFilter }: { data: DatasetListResponse; filter: DatasetFilter; onFilter: (value: DatasetFilter) => void }) {
  const option = FILTERS.find((entry) => entry.value === filter) as (typeof FILTERS)[number];
  const count = data.items.length;
  const status = `Dataset library / ${count} ${option.word}${count === 1 ? 'dataset' : 'datasets'}`;

  return (
    <Page title="Datasets">
      <PageHeader eyebrow="06 Datasets" title="Data with a paper trail." subtitle={`${data.workspace?.name ?? 'No workspace'} · Dataset library`} status={status} />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Workspace">{data.workspace?.name ?? 'None yet'}</RailItem>
            <RailItem term="Visibility">{option.rail}</RailItem>
            <RailItem term="Author">{authorsOf(data.items)}</RailItem>
            <RailItem term="Provenance">{provenanceOf(data.items)}</RailItem>
            <RailNote>Members can create and download datasets. Deletion requires dataset ownership or workspace-owner permission. Frozen source snapshots are retained for audit.</RailNote>
            {data.canCreate.allowed ? null : <RailUnavailable action="Upload dataset" reason={data.canCreate.reason} />}
          </ContextRail>
        }
      >
        <Section title="Versioned sources">
          {count ? (
            <Pairs items={data.items.map((item) => ({ key: item.code, term: `${item.name} / ${item.code}`, detail: <SourceRow item={item} /> }))} />
          ) : !data.workspace && filter === 'private' ? (
            <EmptyState
              action={
                <Link className="text-link" to="/workspace/new">
                  Create a workspace
                </Link>
              }
            >
              You are not in a workspace yet, so there is no private library to show. Create a workspace to upload your first dataset.
            </EmptyState>
          ) : (
            <p>{filter === 'shared' ? 'No shared datasets yet.' : `No ${option.word}datasets in ${data.workspace?.name ?? 'this library'} yet. Upload a file to start the paper trail.`}</p>
          )}
        </Section>
        <Section title="Recent library activity">
          {data.activity.length ? (
            <Pairs
              items={data.activity.map((row) => ({
                key: row.id,
                term: (
                  <>
                    <time dateTime={row.createdAt} title={formatDateTime(row.createdAt)}>
                      {formatTime(row.createdAt)}
                    </time>{' '}
                    / {row.kind}
                  </>
                ),
                detail: row.message,
              }))}
            />
          ) : (
            <p>No library activity yet.</p>
          )}
        </Section>
      </Workspace>
      <Actions>
        {data.canCreate.allowed ? (
          <LinkButton variant="primary" to="/datasets/upload">
            Upload dataset
          </LinkButton>
        ) : (
          <DisabledAction reason={data.canCreate.reason}>Upload dataset</DisabledAction>
        )}
        <span className="ds-filter">
          <select aria-label="Show datasets by visibility" value={filter} onChange={(event) => onFilter(asFilter(event.target.value))}>
            {FILTERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
        </span>
      </Actions>
    </Page>
  );
}

export default function DatasetsPage() {
  const [params, setParams] = useSearchParams();
  const filter = asFilter(params.get('visibility'));
  const query = useApiQuery<DatasetListResponse>(`/api/datasets?visibility=${filter}`, { placeholderData: keepPreviousData });
  return (
    <QueryBoundary query={query}>
      {(data) => <Library data={data} filter={filter} onFilter={(value) => setParams(value === 'private' ? {} : { visibility: value }, { replace: true })} />}
    </QueryBoundary>
  );
}
