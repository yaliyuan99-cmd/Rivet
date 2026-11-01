import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { AttentionItem, HomeData, Verdict } from '../../../shared/types/workspace.ts';
import { Actions, ActionsBelow, Alert, ContextRail, DisabledAction, EmptyState, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Row, Section, Workspace } from '../../components/index.ts';
import { firstName, formatDateTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useDemo, useUser } from '../../lib/session.tsx';
import { forgetInvitation, pendingInvitation } from '../workspace/pendingInvitation.ts';
import '../workspace/workspace.css';

const REVIEW_ACTION = 'Review Biology tasks';

function ReviewAction({ verdict }: { verdict: Verdict }) {
  return <ActionsBelow>{verdict.allowed ? <LinkButton to="/review">{REVIEW_ACTION}</LinkButton> : <DisabledAction reason={verdict.reason}>{REVIEW_ACTION}</DisabledAction>}</ActionsBelow>;
}

function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <Pairs
      items={items.map((item) => ({
        key: `${item.kind}:${item.code ?? item.title}`,
        term: item.title,
        detail: (
          <>
            {item.detail}
            {item.at ? ` · ${item.atLabel} ${formatDateTime(item.at)}` : ''}
            {item.href ? (
              <>
                {' · '}
                <Link className="text-link" to={item.href} aria-label={`${item.action}: ${item.title}`}>
                  {item.action} →
                </Link>
              </>
            ) : null}
          </>
        ),
      }))}
    />
  );
}

/** The first-run frame, adapted to what has been done so far. */
function FirstRun({ data }: { data: HomeData }) {
  const user = useUser();
  const demo = useDemo();
  const { workspace, starter, reviewBiology } = data;
  const visibilityNote = workspace?.defaultVisibility === 'shared' ? 'Shared tasks and datasets by default.' : 'Private tasks and datasets by default.';
  return (
    <Page title="Home">
      <PageHeader eyebrow="01 Access" title={`Welcome to Rivet, ${firstName(user.name)}.`} subtitle="Start with a real question. Build a body of evidence." status="Email verified / First run" />
      <Alert>{workspace ? `${workspace.name} is ready. Use the starter task to create your first evaluation.` : 'Your account is ready. Start a private workspace to create your first evaluation.'}</Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Starter task">{starter.title}</RailItem>
            {starter.domain ? <RailItem term="Domain">{starter.domain}</RailItem> : null}
            <RailItem term="Models">{starter.models || 'No models are enabled on this instance yet.'}</RailItem>
            <RailNote>
              {data.evaluations === 0 ? 'No evaluations yet. ' : ''}
              Use the authored demo task as a starting point, not as a scientific benchmark.
            </RailNote>
            {reviewBiology.allowed ? null : <RailUnavailable action={REVIEW_ACTION} reason={reviewBiology.reason} />}
          </ContextRail>
        }
      >
        {data.attention.length ? (
          <Section title="What needs attention">
            <AttentionList items={data.attention} />
          </Section>
        ) : null}
        <Section title="From a real question to inspectable evidence">
          <p>Define what good looks like before you measure. Compare the same task, source pack and rubric across {demo ? 'three illustrative models' : 'the models you select'}.</p>
        </Section>
        <Section title="Your first three steps">
          <Pairs
            items={[
              workspace
                ? { key: 'workspace', term: `01 / Create ${workspace.name}`, detail: `Done · ${visibilityNote}` }
                : { key: 'workspace', term: '01 / Create your workspace', detail: visibilityNote },
              { key: 'starter', term: '02 / Start with the starter task', detail: 'A Biology prompt and 100-point rubric.' },
              { key: 'run', term: '03 / Run and inspect', detail: 'Compare outputs, sources and expert findings.' },
            ]}
          />
        </Section>
      </Workspace>
      <Actions>
        {workspace ? (
          <LinkButton variant="primary" to="/tasks/new?starter=1">
            Use the starter task
          </LinkButton>
        ) : (
          <LinkButton variant="primary" to="/workspace/new">
            Create workspace
          </LinkButton>
        )}
        <LinkButton to="/tasks">{demo ? 'Browse demo tasks' : 'Browse tasks'}</LinkButton>
      </Actions>
      <ReviewAction verdict={reviewBiology} />
    </Page>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** No frame exists for this view. It is built from the same parts: see docs/assumptions/workspace.md. */
function Returning({ data }: { data: HomeData }) {
  const user = useUser();
  const { workspace, reviewBiology } = data;
  return (
    <Page title="Home">
      <PageHeader
        eyebrow="01 Access"
        title={`Welcome back, ${firstName(user.name)}.`}
        subtitle={`${workspace?.name ?? 'No workspace'} · ${plural(data.counts.tasks, 'task')} · ${plural(data.counts.reports, 'report')}`}
        status="Email verified / Returning"
      />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Workspace">{workspace?.name ?? 'None'}</RailItem>
            <RailItem term="Workspace role">{workspace?.role === 'owner' ? 'Owner' : 'Member'}</RailItem>
            <RailItem term="Domain credentials">{data.credentials.length ? data.credentials.map((credential) => credential.domainName).join(' · ') : 'None'}</RailItem>
            <RailNote>Only task owners can run, resume or revise a task. Members can create tasks and inspect authorized evidence.</RailNote>
            {reviewBiology.allowed ? null : <RailUnavailable action={REVIEW_ACTION} reason={reviewBiology.reason} />}
          </ContextRail>
        }
      >
        <Section title="What needs attention">{data.attention.length ? <AttentionList items={data.attention} /> : <EmptyState>Nothing needs your attention right now.</EmptyState>}</Section>
        <Section title="Recent tasks" kind="table">
          {data.recentTasks.length ? (
            data.recentTasks.map((task) => (
              <Row
                key={task.code}
                label={
                  <Link className="row-link" to={task.href}>
                    {task.code} · {task.title}
                  </Link>
                }
                value={`${task.state}${task.isSynthetic ? ' · Synthetic demo' : ''} · ${formatDateTime(task.updatedAt)}`}
              />
            ))
          ) : (
            <Row label={`No tasks in ${workspace?.name ?? 'this workspace'} yet.`} value={<Link className="text-link" to="/tasks/new?starter=1">Use the starter task →</Link>} />
          )}
        </Section>
        <Section title="Recent reports" kind="table">
          {data.recentReports.length ? (
            data.recentReports.map((report) => (
              <Row
                key={`${report.code}/${report.version}`}
                label={
                  <Link className="row-link" to={report.href}>
                    {report.code} v{report.version} · {report.headline}
                  </Link>
                }
                value={`${report.isSynthetic ? 'Synthetic demo · ' : ''}Frozen ${formatDateTime(report.frozenAt)}`}
              />
            ))
          ) : (
            <Row label="No reports yet." value="A report appears here once an evaluation is reviewed and frozen." />
          )}
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/tasks/new">
          Create task
        </LinkButton>
        <LinkButton to="/tasks">Browse tasks</LinkButton>
      </Actions>
      <ReviewAction verdict={reviewBiology} />
    </Page>
  );
}

export default function HomePage() {
  const query = useApiQuery<HomeData>('/api/home');
  // Signing in or verifying ends here, so an invitation someone was part-way through picks up again.
  const [invitation] = useState(pendingInvitation);
  useEffect(() => {
    if (invitation) forgetInvitation();
  }, [invitation]);
  if (invitation) return <Navigate to={invitation} replace />;
  return <QueryBoundary query={query}>{(data) => (data.firstRun ? <FirstRun data={data} /> : <Returning data={data} />)}</QueryBoundary>;
}
