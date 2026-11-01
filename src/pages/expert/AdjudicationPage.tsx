import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AdjudicationDecision, AdjudicationDetailResponse, AdjudicationResponse } from '../../../shared/types/expert.ts';
import { Actions, AdminTabs, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldSelect, FieldStatic, FieldTextarea, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { EYEBROW, reportPath } from './shared.tsx';
import './expert.css';

const DECISION_LABEL: Record<AdjudicationDecision, string> = { accept: 'Accept expert findings', return: 'Return to expert' };

const STATUS_WORDS: Record<AdjudicationDetailResponse['status'], string> = {
  requested: 'Waiting for an expert',
  draft: 'Expert review in progress',
  submitted: 'Expert review submitted',
  returned: 'Returned to expert',
  finalized: 'Finalized',
};

function AdjudicationRail({ data, unavailable }: { data: AdjudicationDetailResponse; unavailable?: string | null }) {
  const reportLabel = `${data.reportCode} v${data.reportVersion}`;
  return (
    <ContextRail>
      <RailItem term="Administrator">{data.adminName}</RailItem>
      <RailItem term="Expert">{data.expertName ?? 'Not yet claimed'}</RailItem>
      <RailItem term={data.report ? 'Report' : 'Report to create'}>
        {data.report ? (
          <Link className="quiet-link" to={reportPath(data.report)}>
            {reportLabel} →
          </Link>
        ) : (
          reportLabel
        )}
      </RailItem>
      <RailItem term="Audit decision">Append-only / {data.adjudicationCode}</RailItem>
      <RailNote>Finalization never overwrites earlier scores or rationale. The source evidence and independent findings remain inspectable.</RailNote>
      {unavailable ? <RailUnavailable action="Finalize & freeze report" reason={unavailable} /> : null}
    </ContextRail>
  );
}

function ExpertRecommendation({ data }: { data: AdjudicationDetailResponse }) {
  return (
    <Section title={`Expert recommendation / ${data.reviewCode}`}>
      <Pairs
        items={data.scores.map((score) => ({
          key: score.evidenceCode,
          term: score.displayName,
          detail: (
            <>
              {score.score === null ? 'Not recommended yet' : `${score.score} / 100 ${score.label}`} ·{' '}
              <Link className="text-link" to={`/evidence/${score.evidenceCode}`}>
                {score.evidenceCode}
              </Link>
              {score.score !== null && score.score !== score.sealedScore ? ` · Sealed ${score.sealedScore}` : ''}
            </>
          ),
        }))}
      />
    </Section>
  );
}

function ExpertFinding({ data }: { data: AdjudicationDetailResponse }) {
  if (!data.finding) return null;
  return (
    <Section title={`${data.expertName}’s finding`}>
      <p className="prewrap">“{data.finding}”</p>
      <p>
        <Link className="text-link" to={`/review/${data.reviewCode}`}>
          Read the full expert review →
        </Link>
      </p>
    </Section>
  );
}

function DecisionHistory({ data }: { data: AdjudicationDetailResponse }) {
  const earlier = data.decisions.filter((decision) => decision.decision === 'return');
  if (earlier.length === 0) return null;
  return (
    <Section title="Earlier decisions">
      <Pairs
        items={earlier.map((decision, index) => ({
          key: `${decision.code}-${index}`,
          term: `${decision.code} / Returned ${formatDateTime(decision.createdAt)} by ${decision.adminName}`,
          detail: decision.rationale,
        }))}
      />
    </Section>
  );
}

function headline(data: AdjudicationDetailResponse) {
  const words = STATUS_WORDS[data.status];
  return {
    subtitle: `${data.adjudicationCode} · ${data.task.label} · ${words}`,
    status: `Admin / ${data.adjudicationCode} / ${data.status === 'submitted' ? 'Review submitted' : words}`,
  };
}

function SummaryAlert({ data }: { data: AdjudicationDetailResponse }) {
  if (data.status === 'requested' || data.status === 'draft') {
    return <Alert tone="neutral">The expert has not submitted this review yet. Their draft stays private until they do.</Alert>;
  }
  if (data.status === 'returned') {
    const last = data.decisions.filter((decision) => decision.decision === 'return').at(-1);
    return (
      <Alert tone="warning" live>
        Returned to {data.expertName} {formatDateTime(last?.createdAt)}: “{last?.rationale}”
      </Alert>
    );
  }
  const conflict = data.conflictAck ? 'No conflicts declared' : 'No conflict attestation recorded';
  const hashes = data.evidenceVerified ? 'evidence hashes match' : 'evidence hashes do not match';
  return (
    <Alert tone={data.evidenceVerified && data.conflictAck ? 'accent' : 'danger'} live>
      Independent {data.task.domainName} review complete. {conflict}; {hashes}.
    </Alert>
  );
}

function ReadOnlyAdjudication({ data }: { data: AdjudicationDetailResponse }) {
  const { subtitle, status } = headline(data);
  const final = data.finalDecision;
  const lastReturn = data.status === 'returned' ? data.decisions.filter((decision) => decision.decision === 'return').at(-1) : null;
  return (
    <Page title="Make the final determination">
      <PageHeader eyebrow={EYEBROW} title="Make the final determination" subtitle={subtitle} status={status} statusTone={data.status === 'finalized' ? 'accent' : 'warning'} />
      <AdminTabs />
      <SummaryAlert data={data} />
      {!data.evidenceVerified ? <HashMismatch /> : null}
      <Workspace rail={<AdjudicationRail data={data} />}>
        <ExpertRecommendation data={data} />
        <ExpertFinding data={data} />
        {final ? (
          <Section title="Final admin determination" kind="form">
            <FieldStatic label="Decision">{DECISION_LABEL[final.decision]}</FieldStatic>
            <FieldStatic label="Rationale">{final.rationale}</FieldStatic>
            <Checkbox size="small" checked={final.checksAck} onChange={() => undefined} disabled>
              Evidence, reviewer eligibility and provenance checks are complete.
            </Checkbox>
            <p className="fine-print">
              {final.adminName} decided this {formatDateTime(final.createdAt)}. This decision is read-only.
            </p>
          </Section>
        ) : null}
        {lastReturn ? (
          <Section title="Final admin determination">
            <p>Back with {data.expertName}. A determination can be made once they resubmit.</p>
          </Section>
        ) : null}
        <DecisionHistory data={data} />
      </Workspace>
      <Actions>
        {data.report ? (
          <LinkButton variant="primary" to={reportPath(data.report)}>
            Open {data.report.code} v{data.report.version}
          </LinkButton>
        ) : null}
        <LinkButton to="/admin/adjudications">Back to adjudication queue</LinkButton>
      </Actions>
    </Page>
  );
}

function LiveAdjudication({ data }: { data: AdjudicationDetailResponse }) {
  const toast = useToast();
  const [decision, setDecision] = useState<AdjudicationDecision>('accept');
  const [rationale, setRationale] = useState('');
  const [checksAck, setChecksAck] = useState(false);
  const { subtitle, status } = headline(data);
  const finalizeRefused = data.actions.finalize.allowed ? null : (data.actions.finalize.reason as string);

  const decide = useApiMutation((chosen: AdjudicationDecision) => api.post<AdjudicationResponse>(`/api/admin/adjudications/${data.reviewCode}`, { decision: chosen, rationale, checksAck }), {
    invalidate: ['/api/admin/adjudications', `/api/admin/adjudications/${data.reviewCode}`],
    onSuccess: (done) => {
      if (done.report) {
        toast.success(`${done.report.code} v${done.report.version} frozen`, `${done.adjudicationCode} is recorded and the leaderboard has the new task.`);
        return;
      }
      if (done.mail?.sent) toast.success('Returned to expert', `${done.adjudicationCode} is recorded and ${data.expertName} has been emailed.`);
      else toast.warning('Returned to expert', `${done.adjudicationCode} is recorded, but the email failed: ${done.mail?.reason}`);
    },
  });

  const chooseReturn = () => {
    setDecision('return');
    decide.mutate('return');
  };

  return (
    <Page title="Make the final determination">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (decision === 'return' || !finalizeRefused) decide.mutate(decision);
        }}
        noValidate
        style={{ display: 'contents' }}
      >
        <PageHeader eyebrow={EYEBROW} title="Make the final determination" subtitle={subtitle} status={status} />
        <AdminTabs />
        <SummaryAlert data={data} />
        {!data.evidenceVerified ? <HashMismatch /> : null}
        {decide.formError ? <Alert tone="danger">{decide.formError}</Alert> : null}
        <Workspace rail={<AdjudicationRail data={data} unavailable={finalizeRefused} />}>
          <ExpertRecommendation data={data} />
          <ExpertFinding data={data} />
          <DecisionHistory data={data} />
          <Section title="Final admin determination" kind="form">
            <FieldSelect
              label="Decision"
              value={decision}
              onChange={(value) => setDecision(value as AdjudicationDecision)}
              error={decide.fieldErrors.decision}
              options={[
                { value: 'accept', label: DECISION_LABEL.accept },
                { value: 'return', label: DECISION_LABEL.return },
              ]}
            />
            <FieldTextarea
              label="Rationale"
              rows={3}
              value={rationale}
              onChange={setRationale}
              required
              error={decide.fieldErrors.rationale}
              hint={decision === 'return' ? `${data.expertName} is emailed this text.` : `Recorded with ${data.adjudicationCode}. Finalizing freezes ${data.reportCode} v${data.reportVersion}.`}
            />
            <Checkbox size="small" checked={checksAck} onChange={setChecksAck} error={decide.fieldErrors.checksAck}>
              Evidence, reviewer eligibility and provenance checks are complete.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          {decision === 'return' ? (
            <>
              <Button type="submit" variant="primary" busy={decide.isPending} busyLabel="Returning this review">
                Return to expert
              </Button>
              <DisabledAction reason="The decision is set to Return to expert">Finalize &amp; freeze report</DisabledAction>
            </>
          ) : (
            <>
              {finalizeRefused ? (
                <DisabledAction reason={finalizeRefused}>Finalize &amp; freeze report</DisabledAction>
              ) : (
                <Button type="submit" variant="primary" busy={decide.isPending} busyLabel="Finalizing and freezing the report">
                  Finalize &amp; freeze report
                </Button>
              )}
              <Button disabled={decide.isPending} onClick={chooseReturn}>
                Return to expert
              </Button>
            </>
          )}
        </Actions>
      </form>
    </Page>
  );
}

export default function AdjudicationPage() {
  const { code = '' } = useParams();
  const query = useApiQuery<AdjudicationDetailResponse>(`/api/admin/adjudications/${encodeURIComponent(code)}`);
  return (
    <QueryBoundary query={query}>
      {(data) => (data.status === 'submitted' && (data.actions.returnToExpert.allowed || data.actions.finalize.allowed) ? <LiveAdjudication key={`${data.reviewCode}-${data.decisions.length}`} data={data} /> : <ReadOnlyAdjudication data={data} />)}
    </QueryBoundary>
  );
}
