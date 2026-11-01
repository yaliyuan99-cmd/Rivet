import { keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { LeaderboardResponse } from '../../../shared/types/published.ts';
import { Actions, Alert, CiPlot, ContextRail, EmptyState, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Row, Section, Workspace } from '../../components/index.ts';
import { formatDate } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { DomainFilter } from './DomainFilter.tsx';
import './published.css';

const EYEBROW = '04 Published evidence';

function LeaderboardContent({ data, onDomain, stale }: { data: LeaderboardResponse; onDomain: (domainId: string) => void; stale: boolean }) {
  const { domain, sample, included } = data;
  const methodology = `/leaderboards/methodology?domain=${domain.id}`;
  const status = data.empty ? `${domain.name} / No frozen tasks yet` : `${domain.name} / Frozen tasks / ${formatDate(sample.snapshotAt)}`;

  return (
    <Page title={`${domain.name} leaderboard`}>
      <PageHeader
        eyebrow={EYEBROW}
        title={`${domain.name}, with uncertainty in view.`}
        subtitle={sample.synthetic || data.empty ? 'Illustrative model performance, grounded in inspectable evidence.' : 'Model performance, grounded in inspectable evidence.'}
        status={status}
      />
      <Alert tone={data.empty ? 'neutral' : 'accent'} live>
        {data.alert}
      </Alert>
      <Workspace
        rail={
          <ContextRail>
            <DomainFilter value={domain.id} options={data.domains} onChange={onDomain} />
            <RailItem term="Sample">{data.empty ? 'No tasks yet' : `${sample.tasks} paired ${sample.tasks === 1 ? 'task' : 'tasks'} / model`}</RailItem>
            <RailItem term="Metric">Mean 0–100 rubric score</RailItem>
            <RailItem term="Interval">95% bootstrap CI</RailItem>
            {sample.snapshotAt ? <RailItem term="Snapshot">{formatDate(sample.snapshotAt)}</RailItem> : null}
            {included ? <RailNote>{included.taskCode} contributes one task to this {sample.synthetic ? 'illustrative ' : ''}aggregate. Its individual report has n=1 and no confidence interval.</RailNote> : null}
            {included ? (
              <RailNote>
                Owner {included.ownerName}
                <br />
                Expert {included.expertName}
              </RailNote>
            ) : null}
          </ContextRail>
        }
      >
        <div className="published-rows" aria-busy={stale || undefined}>
          <Section title="Mean rubric score / 0–100" kind="table">
            {data.empty ? (
              <div style={{ paddingTop: 18 }}>
                <EmptyState
                  action={
                    <Link className="text-link" to="/reports">
                      Browse frozen reports →
                    </Link>
                  }
                >
                  No {domain.name} tasks have been frozen, reviewed and adjudicated yet. This table stays empty until one is, rather than showing a number without evidence behind it.
                </EmptyState>
              </div>
            ) : (
              data.rows.map((row) => (
                <Row
                  key={row.modelId}
                  label={row.displayName}
                  value={<span className="ci-summary">{row.summary.replace(/ (?=\[)| (?=n=\d)/g, '   ')}</span>}
                  tone="accent"
                  extra={
                    row.low !== null && row.high !== null ? (
                      <CiPlot estimate={row.mean} low={row.low} high={row.high} min={data.axis.min} max={data.axis.max} label={`${row.displayName}: mean ${row.mean}, 95% confidence interval ${row.low} to ${row.high}`} />
                    ) : (
                      <span className="no-interval">No interval</span>
                    )
                  }
                />
              ))
            )}
          </Section>
        </div>
        {data.empty ? null : (
          <>
            <Section title="Read the uncertainty">
              <p>{data.uncertainty}</p>
            </Section>
            <Section title="Inspect the evidence">
              <Pairs
                items={[
                  {
                    term: `${sample.tasks} ${sample.tasks === 1 ? 'task' : 'tasks'} / each model`,
                    detail: (
                      <Link className="quiet-link" to={`${methodology}#sample`}>
                        {data.receipts}
                      </Link>
                    ),
                  },
                  ...(included
                    ? [
                        {
                          term: `Included task / ${included.label}`,
                          detail: (
                            <Link className="quiet-link" to={included.reportHref}>
                              Open the {included.modelCount === 3 ? 'three' : included.modelCount} model {included.modelCount === 1 ? 'output' : 'outputs'} and expert review →
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  { term: 'Evidence boundary', detail: data.evidenceBoundary },
                ]}
              />
            </Section>
          </>
        )}
      </Workspace>
      <Actions>
        {included ? (
          <LinkButton variant="primary" to={included.evidenceHref}>
            Open {included.taskCode} evidence
          </LinkButton>
        ) : null}
        <LinkButton variant={included ? 'secondary' : 'primary'} to={methodology}>
          Read methodology
        </LinkButton>
      </Actions>
    </Page>
  );
}

export default function LeaderboardPage() {
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain');
  const path = domain ? `/api/leaderboards?domain=${encodeURIComponent(domain)}` : '/api/leaderboards';
  const query = useApiQuery<LeaderboardResponse>(path, { placeholderData: keepPreviousData });
  return (
    <QueryBoundary query={query}>
      {(data) => <LeaderboardContent data={data} stale={query.isPlaceholderData} onDomain={(next) => setParams({ domain: next })} />}
    </QueryBoundary>
  );
}
