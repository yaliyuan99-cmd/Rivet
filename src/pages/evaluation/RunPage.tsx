import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailStat, RailTamper, RailUnavailable, Row, Section, Workspace, useToast } from '../../components/index.ts';
import type { RunDetailResponse, RunStatus } from '../../../shared/types/evaluation.ts';
import { api } from '../../lib/api.ts';
import { formatClock, formatDuration } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { ReviewActionButton, ReviewUnavailable, VerdictUnavailable } from './parts.tsx';
import './evaluation.css';

const ACTIVE: RunStatus[] = ['queued', 'running', 'stopping'];
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const NO_EVIDENCE_YET = 'No evidence has been sealed yet.';

const scoreLine = (score: number | null, label: string | null) => (score === null ? 'Not scored' : `${score} / 100 ${label ?? ''}`.trim());

function Quarantine({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return <HashMismatch>The bytes of {codes.join(', ')} differ from the frozen manifest. Do not use {codes.length === 1 ? 'this artifact' : 'these artifacts'} for scoring.</HashMismatch>;
}

function Tamper({ data }: { data: RunDetailResponse }) {
  return data.tamper ? <RailTamper evidence={data.tamper} /> : null;
}

function RunLog({ data }: { data: RunDetailResponse }) {
  return (
    <Section title="Committed run log">
      {data.log.length > 0 ? (
        <ol className="eval-log">
          {data.log.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <time dateTime={line.at}>{formatClock(line.at)}</time>
              <span>{line.message}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p>Waiting for the first commit.</p>
      )}
    </Section>
  );
}

function ElapsedTime({ data, fetchedAt }: { data: RunDetailResponse; fetchedAt: number }) {
  const running = ACTIVE.includes(data.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // Between polls the clock keeps counting from what the server last reported.
  return <>{formatDuration(data.elapsedMs + (running && data.status !== 'queued' ? Math.max(0, now - fetchedAt) : 0))}</>;
}

function latestEvidence(data: RunDetailResponse) {
  const sealed = data.models.filter((model) => model.evidenceCode);
  return sealed[sealed.length - 1] ?? null;
}

function Running({ data, path, fetchedAt }: { data: RunDetailResponse; path: string; fetchedAt: number }) {
  const stop = useApiMutation(() => api.post(`/api/runs/${data.code}/stop`), { invalidate: [path] });
  const evidence = latestEvidence(data);
  const stopping = data.status === 'stopping';
  const modelWord = NUMBER_WORDS[data.models.length] ?? String(data.models.length);
  const status = data.status === 'queued' ? `Run queued / ${data.code}` : stopping ? `Stopping after checkpoint / ${data.code}` : `Run active / ${data.code}`;
  return (
    <Page title={`${data.code} in progress`}>
      <PageHeader eyebrow="02 Evaluation" title="Evaluation in progress" subtitle={`${data.task.label} · ${data.code} · ${modelWord} models, one frozen task.`} status={status} statusTone={stopping ? 'warning' : 'accent'} />
      <Quarantine codes={data.quarantined} />
      {stop.formError ? <Alert tone="danger">{stop.formError}</Alert> : null}
      <Alert tone={stopping ? 'warning' : 'accent'} live>
        {stopping ? 'Stopping after the current checkpoint. Completed evidence is preserved.' : `${data.percent}% complete. Evidence is captured at every checkpoint; you can leave this page.`}
      </Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailStat>
              {data.stagesDone} / {data.stagesTotal}
            </RailStat>
            <RailItem term="Progress">
              {data.stagesDone} of {data.stagesTotal} stages committed
            </RailItem>
            <RailItem term="Elapsed">
              <ElapsedTime data={data} fetchedAt={fetchedAt} />
            </RailItem>
            <RailItem term="Task">
              <Link className="quiet-link" to={`/tasks/${data.task.code}`}>
                {data.task.label} / Frozen
              </Link>
            </RailItem>
            <RailItem term="Checkpoint">{data.checkpointCode ?? 'None yet'}</RailItem>
            <RailItem term="Owner">{data.ownerName}</RailItem>
            <RailNote>Resume reuses this immutable contract. Completed outputs are never silently replaced.</RailNote>
            <Tamper data={data} />
            {evidence ? null : <RailUnavailable action="View live evidence" reason={NO_EVIDENCE_YET} />}
            <VerdictUnavailable action="Stop after checkpoint" verdict={stopping ? { allowed: true } : data.verdicts.stop} />
          </ContextRail>
        }
      >
        <Section title="Model execution">
          <Pairs items={data.models.map((model) => ({ key: model.id, term: model.displayName, detail: model.execution }))} />
        </Section>
        <RunLog data={data} />
      </Workspace>
      <Actions>
        {evidence ? (
          <LinkButton variant="primary" to={`/evidence/${evidence.evidenceCode}`}>
            View live evidence
          </LinkButton>
        ) : (
          <DisabledAction reason={NO_EVIDENCE_YET}>View live evidence</DisabledAction>
        )}
        {data.verdicts.stop.allowed ? (
          <Button busy={stop.isPending} busyLabel="Asking the run to stop" onClick={() => stop.mutate()}>
            Stop after checkpoint
          </Button>
        ) : (
          <DisabledAction reason={data.verdicts.stop.reason}>Stop after checkpoint</DisabledAction>
        )}
      </Actions>
    </Page>
  );
}

function Interrupted({ data, path }: { data: RunDetailResponse; path: string }) {
  const resume = useApiMutation(() => api.post(`/api/runs/${data.code}/resume`), { invalidate: [path] });
  const evidence = data.models.find((model) => model.evidenceCode);
  const nextAttempt = data.attempt + 1;
  const sources = data.task.sourcePack ? 'source pack and model revisions' : 'and model revisions';
  const from = data.checkpointCode ? `Continue from ${data.checkpointCode}` : 'Start from the first stage';
  return (
    <Page title={`${data.code} stopped safely`}>
      <PageHeader eyebrow="02 Evaluation" title="Resume from the last checkpoint" subtitle={`${data.task.label} · ${data.code} · Completed evidence is preserved.`} status={`Safe stop / ${data.code}`} statusTone="warning" />
      <Quarantine codes={data.quarantined} />
      {resume.formError ? <Alert tone="danger">{resume.formError}</Alert> : null}
      <Alert tone="warning" live>
        {data.interruptMessage}
      </Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailStat>
              {data.stagesDone} / {data.stagesTotal}
            </RailStat>
            <RailItem term="Last checkpoint">{data.checkpointCode ? `${data.checkpointCode} / ${formatClock(data.checkpointAt)} UTC` : 'None yet'}</RailItem>
            <RailItem term="Completed stages">
              {data.stagesDone} of {data.stagesTotal}
            </RailItem>
            <RailItem term="Retry attempt">
              {nextAttempt} / {data.verdicts.resume.allowed ? 'Ready' : 'Owner only'}
            </RailItem>
            <RailItem term="Run owner">{data.ownerName}</RailItem>
            <RailNote>Only the task owner can resume a run. Completed artifacts remain immutable.</RailNote>
            <Tamper data={data} />
            <VerdictUnavailable action={`Resume ${data.code}`} verdict={data.verdicts.resume} />
            {evidence ? null : <RailUnavailable action="View preserved evidence" reason={NO_EVIDENCE_YET} />}
          </ContextRail>
        }
      >
        <Section title="Preserved work">
          <Pairs items={data.models.map((model) => ({ key: model.id, term: model.displayName, detail: model.execution }))} />
        </Section>
        <Section title="Resume plan">
          <p>
            {from} with the same frozen {data.task.label}, {sources}. Only unfinished stages are retried. The new attempt is added to the audit log.
          </p>
        </Section>
      </Workspace>
      <Actions>
        {data.verdicts.resume.allowed ? (
          <Button variant="primary" busy={resume.isPending} busyLabel={`Resuming ${data.code}`} onClick={() => resume.mutate()}>
            Resume {data.code}
          </Button>
        ) : (
          <DisabledAction reason={data.verdicts.resume.reason}>Resume {data.code}</DisabledAction>
        )}
        {evidence ? (
          <LinkButton to={`/evidence/${evidence.evidenceCode}`}>View preserved evidence</LinkButton>
        ) : (
          <DisabledAction reason={NO_EVIDENCE_YET}>View preserved evidence</DisabledAction>
        )}
      </Actions>
    </Page>
  );
}

function Failed({ data }: { data: RunDetailResponse }) {
  const evidence = data.models.find((model) => model.evidenceCode);
  return (
    <Page title={`${data.code} could not finish`}>
      <PageHeader eyebrow="02 Evaluation" title="This run could not finish" subtitle={`${data.task.label} · ${data.code} · Completed evidence is preserved.`} status={`Run failed / ${data.code}`} statusTone="danger" />
      <Quarantine codes={data.quarantined} />
      <Alert tone="danger">{data.interruptMessage}</Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailStat tone="danger">
              {data.stagesDone} / {data.stagesTotal}
            </RailStat>
            <RailItem term="Last checkpoint">{data.checkpointCode ?? 'None'}</RailItem>
            <RailItem term="Task">
              <Link className="quiet-link" to={`/tasks/${data.task.code}`}>
                {data.task.label} / Frozen
              </Link>
            </RailItem>
            <RailItem term="Run owner">{data.ownerName}</RailItem>
            <RailNote>Retrying the same request will not change this. Start a new run from the task once the cause is fixed.</RailNote>
            <Tamper data={data} />
          </ContextRail>
        }
      >
        <Section title="Preserved work">
          <Pairs items={data.models.map((model) => ({ key: model.id, term: model.displayName, detail: model.execution }))} />
        </Section>
        <RunLog data={data} />
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to={`/tasks/${data.task.code}`}>
          Back to task
        </LinkButton>
        {evidence ? <LinkButton to={`/evidence/${evidence.evidenceCode}`}>View preserved evidence</LinkButton> : null}
      </Actions>
    </Page>
  );
}

function Results({ data, path }: { data: RunDetailResponse; path: string }) {
  const toast = useToast();
  const requestReview = useApiMutation(() => api.post<{ code?: string }>('/api/reviews', { runCode: data.code }), {
    invalidate: [path],
    onSuccess: (result) => toast.success('Expert review requested', result?.code ? `${result.code} is waiting for a verified expert.` : 'It is waiting for a verified expert.'),
  });

  const top = [...data.models].filter((model) => model.evidenceCode).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const headerState = data.report ? `Report frozen / ${data.report.label}` : data.review ? data.review.label : 'Expert review pending';
  const shortNames = data.models.map((model) => model.shortName).join(' · ');

  return (
    <Page title={`${data.code} results`}>
      <PageHeader eyebrow="02 Evaluation" title="What does the evidence support?" subtitle={`${data.task.label} · ${data.task.title}`} status={`Run complete / ${headerState}`} />
      <Quarantine codes={data.quarantined} />
      {requestReview.formError ? <Alert tone="danger">Rivet could not request a review. {requestReview.formError}</Alert> : null}
      <Alert>{data.resultsNote}</Alert>
      <Workspace
        rail={
          <ContextRail>
            {data.models.map((model) => (
              <RailItem key={model.id} term={model.displayName}>
                {scoreLine(model.score, model.scoreLabel)}
              </RailItem>
            ))}
            <RailItem term="Evidence">
              {data.sealedCount} sealed output {data.sealedCount === 1 ? 'snapshot' : 'snapshots'}
            </RailItem>
            {data.review ? (
              <RailItem term="Expert review">
                <Link className="quiet-link" to={data.review.href}>
                  {data.review.code} / {data.review.label}
                </Link>
              </RailItem>
            ) : null}
            {data.report ? (
              <RailItem term="Report">
                <Link className="quiet-link" to={data.report.href}>
                  {data.report.label}
                </Link>
              </RailItem>
            ) : null}
            <Tamper data={data} />
            {data.settingsNotes.map((note) => (
              <RailNote key={note}>{note}</RailNote>
            ))}
            {data.review ? null : <VerdictUnavailable action="Request expert review" verdict={data.verdicts.requestReview} />}
            <ReviewUnavailable action={data.reviewAction} />
          </ContextRail>
        }
      >
        <Section title="Same task. Different evidence quality." kind="form">
          <div className="eval-rows">
            {data.models.map((model) => (
              <Row
                key={model.id}
                label={
                  model.evidenceCode ? (
                    <Link className="row-link" to={`/evidence/${model.evidenceCode}`}>
                      {model.displayName}
                    </Link>
                  ) : (
                    model.displayName
                  )
                }
                value={`${scoreLine(model.score, model.scoreLabel)} · ${model.evidenceCode ?? 'Not sealed'}${model.evidenceVerified === false ? ' · Hash mismatch' : ''}`}
              />
            ))}
          </div>
        </Section>
        <Section title={`Rubric comparison / ${shortNames}`}>
          <Pairs items={data.rubric.map((row) => ({ key: row.name, term: `${row.short} / ${row.points}`, detail: row.scores.map((score) => score ?? '—').join(' · ') }))} />
        </Section>
        {data.consequentialDifference ? (
          <Section title="The consequential difference">
            <p>{data.consequentialDifference}</p>
          </Section>
        ) : null}
      </Workspace>
      <Actions>
        {top?.evidenceCode ? (
          <LinkButton variant="primary" to={`/evidence/${top.evidenceCode}`}>
            Inspect {top.shortName} evidence
          </LinkButton>
        ) : null}
        {data.report ? <LinkButton to={data.report.href}>Open {data.report.label}</LinkButton> : null}
        {data.review ? (
          <LinkButton to={data.review.href}>Open {data.review.code}</LinkButton>
        ) : data.verdicts.requestReview.allowed ? (
          <Button busy={requestReview.isPending} busyLabel="Requesting an expert review" onClick={() => requestReview.mutate()}>
            Request expert review
          </Button>
        ) : (
          <DisabledAction reason={data.verdicts.requestReview.reason}>Request expert review</DisabledAction>
        )}
      </Actions>
      <ActionsBelow>
        <ReviewActionButton action={data.reviewAction} />
      </ActionsBelow>
    </Page>
  );
}

export default function RunPage() {
  const { code = '' } = useParams();
  const path = `/api/runs/${code}`;
  const query = useApiQuery<RunDetailResponse>(path, {
    staleTime: 0,
    // The worker commits on the server; follow it until the run settles.
    refetchInterval: (state) => (state.state.data && ACTIVE.includes(state.state.data.status) ? 1500 : false),
  });
  return (
    <QueryBoundary query={query}>
      {(data) =>
        ACTIVE.includes(data.status) ? (
          <Running data={data} path={path} fetchedAt={query.dataUpdatedAt} />
        ) : data.status === 'interrupted' ? (
          <Interrupted data={data} path={path} />
        ) : data.status === 'failed' ? (
          <Failed data={data} />
        ) : (
          <Results data={data} path={path} />
        )
      }
    </QueryBoundary>
  );
}
