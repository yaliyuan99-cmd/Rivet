import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { GateCheckResult, GateDetail } from '../../../shared/types/assurance.ts';
import { Actions, ActionsBelow, Alert, AnchorButton, Button, ContextRail, DisabledAction, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailStat, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateAssurance } from './shared.ts';
import './assurance.css';

const statusWord = (state: string) => (state === 'failed' ? 'Failed' : 'Passed');

function AllChecks({ checks }: { checks: GateCheckResult[] }) {
  return (
    <details className="as-checks">
      <summary>All {checks.length} checks</summary>
      <ul>
        {checks.map((check) => (
          <li key={check.id}>
            <span className="as-check-state" data-tone={check.status === 'passed' ? undefined : check.blocking ? 'danger' : 'warning'}>
              {check.status === 'passed' ? 'Passed' : check.blocking ? 'Failed' : 'Failed, advisory'}
            </span>{' '}
            {check.label}
            <br />
            <span className="text-muted">{check.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function GateContent({ data }: { data: GateDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const { gate, candidate, state, run, trace } = data;
  const path = `/api/assurance/gates/${gate.code}/${candidate}`;

  const runGate = useApiMutation(() => api.post<{ state: 'blocked' | 'passed'; passedCount: number; totalCount: number }>(`${path}/run`), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      if (result.state === 'passed') toast.success(`${candidate} passed ${result.passedCount} / ${result.totalCount}`, 'Eligibility is not deployment.');
      else toast.warning(`${candidate} blocked at ${result.passedCount} / ${result.totalCount}`, 'This result is permanent. A later candidate will not erase it.');
    },
  });
  const approve = useApiMutation(() => api.post(`${path}/approve`), {
    onSuccess: async () => {
      await invalidateAssurance(client);
      toast.success('Release approved', 'A separate audited decision was recorded. Eligibility is not deployment.');
    },
  });

  const title = state === 'blocked' ? 'The release gate is blocked.' : state === 'passed' ? 'The release gate has passed.' : 'The release gate has not run.';
  const statusWordTop = state === 'blocked' ? 'Blocked' : state === 'passed' ? 'Passed' : 'Not run';
  const regressionLine = data.regressions.length ? data.regressions.map((regression) => `${regression.code} ${regression.status}`).join(', ') : 'None active';
  const previousLine = data.previous ? `${data.previous.candidate} / ${data.previous.state === 'blocked' ? 'Blocked' : 'Passed'}, retained` : null;

  return (
    <Page title={`${gate.code} ${candidate}`}>
      <PageHeader eyebrow="07 Agent assurance" title={title} subtitle={`${gate.code} · ${gate.workspaceName} · Release candidate ${candidate}`} status={`${statusWordTop} / ${gate.code} / ${candidate}`} statusTone={state === 'blocked' ? 'danger' : state === 'passed' ? 'accent' : 'warning'} />
      <Alert tone={state === 'blocked' ? 'danger' : state === 'passed' ? 'accent' : 'neutral'}>{data.alert}</Alert>
      {data.decision ? (
        <Alert live>
          Approved by {data.decision.decidedByName} on {formatDateTime(data.decision.createdAt)}. Eligibility is not deployment.
        </Alert>
      ) : null}
      {trace.verified ? null : <HashMismatch>The stored steps of {trace.code} no longer match their hash. Nothing can be approved on this evidence.</HashMismatch>}
      {runGate.formError ? <Alert tone="danger">{runGate.formError}</Alert> : null}
      {approve.formError ? <Alert tone="danger">{approve.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailStat>
              {run ? run.passedCount : '–'} / {run ? run.totalCount : gate.suiteSize}
            </RailStat>
            <RailItem term="Candidate">
              {candidate} / Harness {trace.harnessVersion}
            </RailItem>
            <RailItem term="Regression">{regressionLine}</RailItem>
            <RailItem term="Suite">{gate.suite}</RailItem>
            {state === 'passed' ? null : <RailItem term="Policy">No manual bypass</RailItem>}
            {state !== 'blocked' && previousLine ? <RailItem term="Previous candidate">{previousLine}</RailItem> : null}
            {state === 'blocked' ? (
              <RailNote>The task owner may revise the agent configuration, not the frozen task version. Passing a future run will not erase this failed gate.</RailNote>
            ) : state === 'passed' ? (
              <RailNote>{data.previous ? 'The same frozen regression suite was rerun.' : 'The frozen regression suite ran for this candidate.'} No policy was bypassed and no prior evidence was overwritten.</RailNote>
            ) : (
              <RailNote>Running the gate writes an immutable result. A failure stays on record, and passing a later run will not erase it.</RailNote>
            )}
            {!data.canApprove.allowed && state !== 'not_run' && !data.decision ? <RailUnavailable action={state === 'blocked' ? 'Approve release' : 'Approve eligible release'} reason={data.canApprove.reason} /> : null}
            {state === 'not_run' && !data.canRun.allowed ? <RailUnavailable action="Run gate" reason={data.canRun.reason} /> : null}
          </ContextRail>
        }
      >
        {run ? (
          <Section title={state === 'blocked' ? 'Required gate checks' : 'Release evidence'}>
            <Pairs items={run.groups.map((group) => ({ key: group.id, term: group.title, detail: `${statusWord(group.status)} · ${group.detail}` }))} />
            <AllChecks checks={run.checks} />
          </Section>
        ) : (
          <Section title="Release evidence">
            <p>
              {gate.suite} has not evaluated{' '}
              <Link className="text-link" to={`/assurance/traces/${trace.code}`}>
                {trace.code}
              </Link>{' '}
              yet. It runs {gate.suiteSize} named checks against the trace&rsquo;s steps, grouped into claim consistency, source attribution, private data boundary and evidence integrity.
            </p>
          </Section>
        )}
        {state === 'blocked' ? (
          <Section title="Required before retry">
            <p>{data.requiredBeforeRetry}</p>
          </Section>
        ) : data.whatChanged ? (
          <Section title={`What changed in ${candidate}`}>
            <p>{data.whatChanged}</p>
          </Section>
        ) : null}
      </Workspace>
      <Actions>
        {state === 'blocked' ? (
          <LinkButton variant="primary" to={`/assurance/traces/${trace.code}`}>
            Open failed trace
          </LinkButton>
        ) : state === 'passed' ? (
          data.canApprove.allowed ? (
            <Button variant="primary" busy={approve.isPending} busyLabel="Approving release" onClick={() => approve.mutate()}>
              Approve eligible release
            </Button>
          ) : null
        ) : data.canRun.allowed ? (
          <Button variant="primary" busy={runGate.isPending} busyLabel="Running the gate" onClick={() => runGate.mutate()}>
            Run gate
          </Button>
        ) : null}
        {data.reportPath ? <AnchorButton href={data.reportPath}>Download gate report</AnchorButton> : null}
        {state === 'not_run' ? <LinkButton to={`/assurance/traces/${trace.code}`}>Open trace</LinkButton> : null}
      </Actions>
      {state === 'blocked' ? (
        <ActionsBelow>
          <DisabledAction reason={data.canApprove.allowed ? '' : data.canApprove.reason}>Approve release</DisabledAction>
        </ActionsBelow>
      ) : state === 'passed' && !data.canApprove.allowed ? (
        <ActionsBelow>
          <DisabledAction reason={data.canApprove.reason}>Approve eligible release</DisabledAction>
        </ActionsBelow>
      ) : state === 'not_run' && !data.canRun.allowed ? (
        <ActionsBelow>
          <DisabledAction reason={data.canRun.reason}>Run gate</DisabledAction>
        </ActionsBelow>
      ) : null}
    </Page>
  );
}

export default function GatePage() {
  const { code = '', candidate = '' } = useParams();
  const query = useApiQuery<GateDetail>(`/api/assurance/gates/${encodeURIComponent(code)}/${encodeURIComponent(candidate)}`);
  return <QueryBoundary query={query}>{(data) => <GateContent data={data} />}</QueryBoundary>;
}
