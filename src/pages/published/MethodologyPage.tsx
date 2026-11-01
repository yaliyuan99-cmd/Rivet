import { useEffect } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { MethodologyResponse } from '../../../shared/types/published.ts';
import { Actions, Alert, ContextRail, EmptyState, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import { formatDate } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { DomainFilter } from './DomainFilter.tsx';
import './published.css';

function MethodologyContent({ data, onDomain }: { data: MethodologyResponse; onDomain: (domainId: string) => void }) {
  const { domain, sample } = data;
  const location = useLocation();
  const resamples = data.resamples.toLocaleString('en-US');
  const status = data.empty ? `${domain.name} / No frozen tasks yet` : `${domain.name} / ${sample.tasks} ${sample.tasks === 1 ? 'task' : 'tasks'} / Seed ${data.seed}`;

  // The leaderboard links straight to the sample table.
  useEffect(() => {
    if (location.hash !== '#sample') return;
    const timer = window.setTimeout(() => document.getElementById('sample')?.scrollIntoView(), 50);
    return () => window.clearTimeout(timer);
  }, [location.hash]);

  return (
    <Page title="Leaderboard methodology">
      <PageHeader eyebrow="04 Published evidence" title="How the interval is computed." subtitle="Every number on the leaderboard can be recomputed from the sample below." status={status} />
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
            <RailNote>A single report has n=1 and no confidence interval. Only a sample of tasks can carry one.</RailNote>
          </ContextRail>
        }
      >
        <Section title="The statistic">
          <Pairs
            items={[
              { term: 'Metric', detail: 'The mean of each model’s 0–100 rubric scores across the tasks in this domain.' },
              { term: 'What is resampled', detail: 'Tasks. Each resample draws as many tasks as the sample holds, with replacement.' },
              { term: 'Pairing', detail: 'The same draw applies to every model, so a hard task stays hard for all of them.' },
              { term: 'Resamples', detail: `${resamples}, from the mulberry32 generator with seed ${data.seed}, over tasks in sorted label order. The same sample always gives the same interval.` },
              { term: 'Interval', detail: `A 95% percentile interval: the sorted resample means at positions ${data.percentiles.low} and ${data.percentiles.high}, counting from zero.` },
              { term: 'Missing runs', detail: 'A resample averages only the tasks a model has among those drawn. A model with fewer than two tasks gets no interval.' },
            ]}
          />
        </Section>
        <Section title="What it does not show">
          <Pairs
            items={[
              { term: 'Overlap', detail: 'The page says intervals overlap only when they do. That is a cautious reading of per-model intervals, not a pairwise significance test.' },
              { term: 'Capability', detail: 'These numbers describe these tasks. They do not establish general capability in a domain.' },
              { term: 'Stability', detail: 'A newly finalized task enters the sample and moves the numbers. Frozen reports do not change; this aggregate does.' },
              { term: 'Fixtures', detail: 'Authored fixtures are not sealed runs. They have no receipt to open, and the table below marks each one.' },
            ]}
          />
        </Section>
        <div id="sample" style={{ scrollMarginTop: 16 }}>
          <Section title={`Sample / ${domain.name}`}>
            {data.empty ? (
              <EmptyState
                action={
                  <Link className="text-link" to="/reports">
                    Browse frozen reports →
                  </Link>
                }
              >
                No {domain.name} tasks are in the sample yet.
              </EmptyState>
            ) : (
              <div className="table-wrap" role="region" aria-label={`Every task and score in the ${domain.name} sample`} tabIndex={0}>
                <table className="table sample-table">
                  <caption className="sr-only">Scores by task and model, with where each task came from</caption>
                  <thead>
                    <tr>
                      <th scope="col">Task</th>
                      <th scope="col">Version</th>
                      {data.models.map((model) => (
                        <th key={model.id} scope="col">
                          {model.shortName}
                        </th>
                      ))}
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((task) => (
                      <tr key={task.label}>
                        <td>{task.taskCode}</td>
                        <td>{task.version}</td>
                        {data.models.map((model) => (
                          <td key={model.id}>{task.scores[model.id] ?? '—'}</td>
                        ))}
                        <td>
                          {task.report ? (
                            <Link className="text-link" to={`/reports/${task.report.code}/v${task.report.version}`}>
                              Report {task.report.code}
                            </Link>
                          ) : (
                            'Fixture'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to={`/leaderboards?domain=${domain.id}`}>
          Back to leaderboard
        </LinkButton>
      </Actions>
    </Page>
  );
}

export default function MethodologyPage() {
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain');
  const path = domain ? `/api/leaderboards/methodology?domain=${encodeURIComponent(domain)}` : '/api/leaderboards/methodology';
  const query = useApiQuery<MethodologyResponse>(path, { placeholderData: keepPreviousData });
  return <QueryBoundary query={query}>{(data) => <MethodologyContent data={data} onDomain={(next) => setParams({ domain: next })} />}</QueryBoundary>;
}
