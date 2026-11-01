import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AdjudicationResponse, TraceAdjudication, TraceDetail } from '../../../shared/types/assurance.ts';
import { Actions, ActionsBelow, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldSelect, FieldTextarea, HashMismatch, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime, shortHash } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateAssurance } from './shared.ts';
import './assurance.css';

const OVERRIDE_REASON = 'Reviewer cannot bypass a gate';

function HistoryEntry({ entry, onRegression, busy }: { entry: TraceAdjudication; onRegression: (code: string) => void; busy: boolean }) {
  return (
    <>
      {entry.kind === 'finding' ? `${entry.severityLabel} · ` : ''}
      {entry.reviewerName} · {formatDateTime(entry.createdAt)}
      <br />
      {entry.rationale}
      {entry.regressionCode ? (
        <>
          <br />
          <Link className="text-link" to={`/assurance/regressions/${entry.regressionCode}`}>
            Open {entry.regressionCode}
          </Link>
        </>
      ) : entry.kind === 'finding' && entry.canCreateRegression.allowed ? (
        <div className="as-inline-action">
          <Button busy={busy} busyLabel="Creating a draft regression" onClick={() => onRegression(entry.code)}>
            Turn into a regression
          </Button>
        </div>
      ) : null}
    </>
  );
}

function TraceContent({ data }: { data: TraceDetail }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [finding, setFinding] = useState(data.findingChoices[0]?.value ?? '');
  const [severity, setSeverity] = useState(data.severityChoices[0]?.value ?? 'high');
  const [rationale, setRationale] = useState('');
  const [conflictAck, setConflictAck] = useState(false);
  const { canReview } = data;

  const adjudicate = useApiMutation((kind: 'finding' | 'clarification') => api.post<AdjudicationResponse>(`/api/assurance/traces/${data.code}/adjudications`, { kind, finding, severity, rationale, conflictAck }), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      setRationale('');
      setConflictAck(false);
      if (result.kind === 'finding') toast.success(`${result.code} confirmed`, 'Appended to this trace. Earlier adjudications are unchanged.');
      else if (result.emailed) toast.success('Clarification requested', `${data.ownerName} was emailed. ${result.code} is on this trace.`);
      else toast.warning('Clarification recorded, email not sent', result.emailError ?? `${data.ownerName} could not be emailed.`);
    },
  });

  const createRegression = useApiMutation((adjudicationCode: string) => api.post<{ code: string }>('/api/assurance/regressions', { adjudicationCode }), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      navigate(`/assurance/regressions/${result.code}`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canReview.allowed && data.verified) adjudicate.mutate('finding');
  };

  const blocked = !canReview.allowed ? canReview.reason : !data.verified ? 'This trace no longer matches its hash' : null;
  const pending = adjudicate.isPending;
  const history = [...data.adjudications].reverse();
  const decision = data.decisionCode ?? (data.flagged ? `Pending · ${data.nextDecisionCode} on confirmation` : 'None');

  return (
    <Page title={data.code}>
      <PageHeader
        eyebrow="07 Agent assurance"
        title="Follow every consequential step."
        subtitle={[data.code, data.taskLabel, data.agentLabel].filter(Boolean).join(' · ')}
        status={canReview.allowed ? `${data.domainName} verified / Trace adjudication` : 'Read only / Trace adjudication'}
        statusTone="warning"
      />
      {data.verified ? null : <HashMismatch>The stored steps of {data.code} differ from the hash recorded when it was imported. It cannot be adjudicated, and its gate cannot pass.</HashMismatch>}
      {adjudicate.formError && !Object.keys(adjudicate.fieldErrors).length ? <Alert tone="danger">{adjudicate.formError}</Alert> : null}
      {createRegression.formError ? <Alert tone="danger">{createRegression.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Reviewer">{data.reviewerName ?? 'Awaiting a reviewer'}</RailItem>
              <RailItem term="Owner">{data.ownerName}</RailItem>
              <RailItem term="Trace hash">{data.verified ? shortHash(data.sha256) : <span className="text-danger">Hash mismatch · {shortHash(data.sha256)}</span>}</RailItem>
              <RailItem term="Decision">{decision}</RailItem>
              {data.gate ? (
                <RailItem term="Release gate">
                  <Link className="text-link" to={`/assurance/gates/${data.gate.code}/${data.gate.candidate}`}>
                    {data.gate.code} / {data.gate.candidate}
                  </Link>{' '}
                  · {data.gate.state === 'not_run' ? 'Not run' : data.gate.state === 'passed' ? 'Passed' : 'Blocked'}
                </RailItem>
              ) : null}
              <RailNote>{data.separationNote}</RailNote>
              {blocked ? <RailUnavailable action="Confirm finding" reason={blocked} /> : null}
              <RailUnavailable action="Override release policy" reason={OVERRIDE_REASON} />
            </ContextRail>
          }
        >
          <Section title={`${data.code} / ${data.agentShort} / Harness ${data.harnessVersion}`}>
            <Pairs items={data.steps.map((step) => ({ key: String(step.n), term: step.heading, detail: step.detail }))} />
          </Section>
          {canReview.allowed && data.verified ? (
            <Section title="Expert adjudication" kind="form">
              <FieldSelect label="Finding" value={finding} onChange={setFinding} options={data.findingChoices} error={adjudicate.fieldErrors.finding} />
              <FieldSelect label="Severity" value={severity} onChange={setSeverity} options={data.severityChoices} error={adjudicate.fieldErrors.severity} />
              <div className="as-grow">
                <FieldTextarea label="Rationale" value={rationale} onChange={setRationale} required rows={2} maxLength={4000} error={adjudicate.fieldErrors.rationale} />
              </div>
              <Checkbox size="small" checked={conflictAck} onChange={setConflictAck} error={adjudicate.fieldErrors.conflictAck}>
                I have no ownership or financial conflict.
              </Checkbox>
            </Section>
          ) : null}
          <Section title="Adjudication history">
            {history.length ? (
              <Pairs
                items={history.map((entry) => ({
                  key: entry.id,
                  term: `${entry.code} / ${entry.kind === 'finding' ? entry.finding : 'Clarification requested'}`,
                  detail: <HistoryEntry entry={entry} onRegression={(code) => createRegression.mutate(code)} busy={createRegression.isPending} />,
                }))}
              />
            ) : (
              <p>No adjudications yet. They are append-only once made.</p>
            )}
          </Section>
        </Workspace>
        <Actions>
          {blocked ? (
            <>
              <DisabledAction reason={blocked}>Confirm finding</DisabledAction>
              <DisabledAction reason={blocked}>Request clarification</DisabledAction>
            </>
          ) : (
            <>
              <Button type="submit" variant="primary" busy={pending && adjudicate.variables === 'finding'} busyLabel="Confirming finding">
                Confirm finding
              </Button>
              <Button busy={pending && adjudicate.variables === 'clarification'} busyLabel="Requesting clarification" onClick={() => adjudicate.mutate('clarification')}>
                Request clarification
              </Button>
            </>
          )}
        </Actions>
        <ActionsBelow>
          <DisabledAction reason={OVERRIDE_REASON}>Override release policy</DisabledAction>
        </ActionsBelow>
      </form>
    </Page>
  );
}

export default function TracePage() {
  const { code = '' } = useParams();
  const query = useApiQuery<TraceDetail>(`/api/assurance/traces/${encodeURIComponent(code)}`);
  return <QueryBoundary query={query}>{(data) => <TraceContent key={data.code} data={data} />}</QueryBoundary>;
}
