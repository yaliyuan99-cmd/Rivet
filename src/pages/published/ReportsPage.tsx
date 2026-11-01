import { useEffect, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { ReportsResponse } from '../../../shared/types/published.ts';
import { Alert, Badge, Button, ContextRail, EmptyState, FieldInput, FieldSelect, Page, PageHeader, QueryBoundary, RailItem, RailNote, Row, Section, Workspace } from '../../components/index.ts';
import { formatDate } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import './published.css';

function ReportsContent({ data, domain, search, onDomain, onSearch, stale }: { data: ReportsResponse; domain: string; search: string; onDomain: (value: string) => void; onSearch: (value: string) => void; stale: boolean }) {
  const filtered = Boolean(domain || search.trim());
  return (
    <Page title="Reports">
      <PageHeader eyebrow="04 Published evidence" title="Reports you can cite." subtitle="Every report here is frozen, admin adjudicated and versioned." status={`${data.total} frozen ${data.total === 1 ? 'report' : 'reports'}`} />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Showing">
              {data.items.length} of {data.total}
            </RailItem>
            <RailItem term="Each report">n = 1 task. No population confidence interval.</RailItem>
            <RailItem term="Access">Any verified account can read a finalized report.</RailItem>
            <RailNote>Private sources and model outputs stay permission-checked, even when the report that cites them is readable.</RailNote>
          </ContextRail>
        }
      >
        <Section title="Filter" kind="form">
          <div className="report-filters">
            <FieldInput label="Search" type="search" value={search} onChange={onSearch} placeholder="Code, title, owner or expert" />
            <FieldSelect label="Domain" value={domain} onChange={onDomain} options={[{ value: '', label: 'All domains' }, ...data.domains.map((item) => ({ value: item.id, label: item.name }))]} />
          </div>
        </Section>
        <div className="published-rows" aria-busy={stale || undefined}>
          <Section title="Frozen reports" kind="table">
            {data.items.length === 0 ? (
              <div style={{ paddingTop: 18 }}>
                {filtered && data.total > 0 ? (
                  <EmptyState
                    action={
                      <Button
                        onClick={() => {
                          onSearch('');
                          onDomain('');
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  >
                    No reports match these filters.
                  </EmptyState>
                ) : (
                  <EmptyState
                    action={
                      <Link className="text-link" to="/tasks">
                        Browse tasks →
                      </Link>
                    }
                  >
                    No reports yet. A report appears here once a task has been frozen, run, reviewed by an expert and finalized by an admin.
                  </EmptyState>
                )}
              </div>
            ) : (
              data.items.map((item) => (
                <Row
                  key={`${item.code}-${item.version}`}
                  label={
                    <>
                      <Link className="row-link" to={item.href}>
                        {item.code} v{item.version}
                      </Link>
                      <p className="report-row-meta">{item.title}</p>
                    </>
                  }
                  value={
                    <>
                      {item.scoreLine}
                      <br />
                      {item.domainName} · Frozen {formatDate(item.frozenAt)} · Owner {item.ownerName} · Expert {item.expertName}
                    </>
                  }
                  extra={
                    <span className="report-row-badge">
                      <Badge tone={item.isSynthetic ? 'neutral' : 'accent'}>{item.isSynthetic ? 'Synthetic demo' : 'Frozen'}</Badge>
                    </span>
                  }
                />
              ))
            )}
          </Section>
        </div>
      </Workspace>
    </Page>
  );
}

export default function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain') ?? '';
  const applied = params.get('q') ?? '';
  const [search, setSearch] = useState(applied);

  // Search as you type, a moment after the last keystroke, with the URL as the record of the filter.
  useEffect(() => {
    if (search.trim() === applied) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams();
      if (domain) next.set('domain', domain);
      if (search.trim()) next.set('q', search.trim());
      setParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, applied, domain, setParams]);

  const apiParams = new URLSearchParams();
  if (domain) apiParams.set('domain', domain);
  if (applied) apiParams.set('q', applied);
  const suffix = apiParams.toString();
  const query = useApiQuery<ReportsResponse>(`/api/reports${suffix ? `?${suffix}` : ''}`, { placeholderData: keepPreviousData });

  const setDomain = (value: string) => {
    const next = new URLSearchParams();
    if (value) next.set('domain', value);
    if (search.trim()) next.set('q', search.trim());
    setParams(next, { replace: true });
  };

  return (
    <QueryBoundary query={query}>
      {(data) => <ReportsContent data={data} domain={domain} search={search} onDomain={setDomain} onSearch={setSearch} stale={query.isPlaceholderData} />}
    </QueryBoundary>
  );
}
