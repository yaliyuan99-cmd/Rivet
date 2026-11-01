import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Actions, ActionsBelow, Button, ContextRail, EmptyState, FieldInput, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import type { FilterOption, TaskBrowseResponse } from '../../../shared/types/evaluation.ts';
import { useApiQuery } from '../../lib/query.ts';
import { ReviewActionButton, ReviewUnavailable } from './parts.tsx';
import './evaluation.css';

const FILTER_KEYS = ['domain', 'status', 'scope'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const FILTER_LABELS: Record<FilterKey, string> = { domain: 'Domain', status: 'Status', scope: 'Workspace' };

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: FilterOption[]; onChange: (value: string) => void }) {
  return (
    <span className="eval-filter">
      <label className="sr-only" htmlFor={`filter-${label}`}>
        {label}
      </label>
      <select id={`filter-${label}`} className="field-control" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="field-chevron" size={14} strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

function allTasksLine({ readable, synthetic }: TaskBrowseResponse['counts']): string {
  if (readable > 0 && synthetic === readable) return `${readable} synthetic ${readable === 1 ? 'example' : 'examples'}`;
  const tasks = `${readable} ${readable === 1 ? 'task' : 'tasks'}`;
  return synthetic > 0 ? `${tasks} · ${synthetic} synthetic` : tasks;
}

export default function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const lastSent = useRef(search);

  // The address bar holds the search, so results can be linked and the back button works.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (lastSent.current === search) return;
      lastSent.current = search;
      const next = new URLSearchParams(params);
      if (search) next.set('q', search);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, params, setParams]);

  // A link or the back button changed the address: the box follows it.
  const urlSearch = params.get('q') ?? '';
  useEffect(() => {
    if (urlSearch === lastSent.current) return;
    lastSent.current = urlSearch;
    setSearch(urlSearch);
  }, [urlSearch]);

  const apiPath = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of ['q', ...FILTER_KEYS]) {
      const value = params.get(key);
      if (value) query.set(key, value);
    }
    const text = query.toString();
    return text ? `/api/tasks?${text}` : '/api/tasks';
  }, [params]);

  const query = useApiQuery<TaskBrowseResponse>(apiPath, { placeholderData: keepPreviousData });

  const setFilter = (key: FilterKey, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const filtering = Boolean(params.get('q') || FILTER_KEYS.some((key) => params.get(key)));
  const clearAll = () => {
    lastSent.current = '';
    setSearch('');
    setParams(new URLSearchParams());
  };

  return (
    <QueryBoundary query={query}>
      {(data) => (
        <Page title="Tasks">
          <PageHeader eyebrow="09 Discovery and profile" title="Real tasks. Open questions." subtitle="Browse evaluation tasks and inspect the evidence behind them." status={data.headline} />
          <Workspace
            rail={
              <ContextRail>
                <RailItem term="All tasks">{allTasksLine(data.counts)}</RailItem>
                <RailItem term="My tasks">
                  {data.counts.mine} / {data.viewerName}
                </RailItem>
                <RailItem term="Workspace">{data.workspaceName ?? 'No workspace'}</RailItem>
                <RailItem term="Evidence access">Permission checked</RailItem>
                <RailNote>Only task owners can run, resume or revise a task. Members can create tasks and inspect authorized evidence.</RailNote>
                {data.featured ? <ReviewUnavailable action={data.featured.reviewAction} /> : null}
              </ContextRail>
            }
          >
            <Section title="Search and refine" kind="form">
              <FieldInput label="Search tasks" type="search" value={search} onChange={setSearch} autoComplete="off" />
              <div className="field eval-filters" role="group" aria-labelledby="filters-label">
                <span id="filters-label" className="field-label">
                  Filters
                </span>
                <div className="eval-filter-row">
                  <FilterSelect label={FILTER_LABELS.domain} value={params.get('domain') ?? ''} options={data.filters.domains} onChange={(value) => setFilter('domain', value)} />
                  <span className="eval-filter-sep" aria-hidden="true">
                    ·
                  </span>
                  <FilterSelect label={FILTER_LABELS.status} value={params.get('status') ?? ''} options={data.filters.statuses} onChange={(value) => setFilter('status', value)} />
                  <span className="eval-filter-sep" aria-hidden="true">
                    ·
                  </span>
                  <FilterSelect label={FILTER_LABELS.scope} value={params.get('scope') ?? ''} options={data.filters.scopes} onChange={(value) => setFilter('scope', value)} />
                </div>
              </div>
            </Section>

            <Section title="Real questions, inspectable evidence">
              {data.items.length > 0 ? (
                <Pairs
                  items={data.items.map((item) => ({
                    key: item.code,
                    term: (
                      <Link className="quiet-link" to={`/tasks/${item.code}`}>
                        {item.label} / {item.title}
                      </Link>
                    ),
                    detail: item.meta,
                  }))}
                />
              ) : filtering ? (
                <EmptyState action={<Button onClick={clearAll}>Clear search and filters</Button>}>No tasks match this search and these filters.</EmptyState>
              ) : (
                <EmptyState>No tasks yet. Create one to define what good looks like before you measure.</EmptyState>
              )}
            </Section>

            {data.featured ? (
              <Section title={`Featured / ${data.featured.code}`}>
                <p>{data.featured.note}</p>
              </Section>
            ) : null}
          </Workspace>
          <Actions>
            {data.featured ? (
              <LinkButton variant="primary" to={`/tasks/${data.featured.code}`}>
                Open {data.featured.code}
              </LinkButton>
            ) : null}
            <LinkButton variant={data.featured ? 'secondary' : 'primary'} to="/tasks/new">
              Create task
            </LinkButton>
          </Actions>
          {data.featured ? (
            <ActionsBelow>
              <ReviewActionButton action={data.featured.reviewAction} />
            </ActionsBelow>
          ) : null}
        </Page>
      )}
    </QueryBoundary>
  );
}
