import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Recommendation, ReviewDetailResponse, ReviewEvidenceDto, ReviewInput } from '../../../shared/types/expert.ts';
import {
  Actions,
  ActionsBelow,
  Alert,
  Button,
  Checkbox,
  ContextRail,
  DisabledAction,
  FieldInput,
  FieldStatic,
  FieldTextarea,
  HashMismatch,
  LinkButton,
  Page,
  PageHeader,
  Pairs,
  QueryBoundary,
  RailItem,
  RailNote,
  RailTamper,
  RailUnavailable,
  Section,
  TabLinks,
  Workspace,
  useToast,
} from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { EYEBROW, keepEnterFromSubmitting, lockedNote, reportPath } from './shared.tsx';
import './expert.css';

/* ---------- Form state ---------- */

interface CriterionState {
  score: string;
  note: string;
}

interface FormState {
  assessment: string;
  rationale: string;
  finding: string;
  conflictAck: boolean;
  recommendations: Record<string, { annotation: string; criteria: CriterionState[] }>;
}

function initialForm(data: ReviewDetailResponse): FormState {
  return {
    assessment: data.assessment,
    rationale: data.rationale,
    finding: data.finding,
    conflictAck: data.conflictAck,
    recommendations: Object.fromEntries(
      data.evidence.map((item) => {
        const saved: Recommendation | undefined = data.recommendations[item.code];
        return [
          item.code,
          {
            annotation: saved?.annotation ?? '',
            criteria: data.task.rubric.map((_, index) => {
              const criterion = saved?.criteria[index];
              return { score: criterion?.score === null || criterion?.score === undefined ? '' : String(criterion.score), note: criterion?.note ?? '' };
            }),
          },
        ];
      }),
    ),
  };
}

function toInput(form: FormState): ReviewInput {
  return {
    assessment: form.assessment,
    rationale: form.rationale,
    finding: form.finding,
    conflictAck: form.conflictAck,
    recommendations: Object.fromEntries(
      Object.entries(form.recommendations).map(([code, value]) => [
        code,
        {
          annotation: value.annotation,
          criteria: value.criteria.map((criterion) => ({
            score: criterion.score.trim() === '' || Number.isNaN(Number(criterion.score)) ? null : Number(criterion.score),
            note: criterion.note,
          })),
        },
      ]),
    ),
  };
}

const sealedLine = (item: ReviewEvidenceDto) => `${item.totalScore} / 100 ${item.scoreLabel} · ${item.code}`;

/* ---------- Pieces shared by the states ---------- */

function SealedOutput({ item }: { item: ReviewEvidenceDto }) {
  return (
    <details className="disclosure">
      <summary>Read the sealed output / {item.code}</summary>
      <p className="prewrap">“{item.outputText}”</p>
      <p>
        <Link className="text-link" to={`/evidence/${item.code}`}>
          Inspect {item.code} →
        </Link>
      </p>
    </details>
  );
}

function FrozenTask({ data }: { data: ReviewDetailResponse }) {
  return (
    <details className="disclosure">
      <summary>Read the frozen task / {data.task.label}</summary>
      <p>{data.task.title}</p>
      <p className="prewrap">{data.task.prompt}</p>
    </details>
  );
}

function ModelTabs({ data, selected, labelFor }: { data: ReviewDetailResponse; selected: string; labelFor: (item: ReviewEvidenceDto) => string }) {
  return (
    <TabLinks
      label="Model"
      items={data.evidence.map((item) => ({ to: `?model=${item.code}`, label: labelFor(item), current: item.code === selected }))}
    />
  );
}

function ReviewRail({ data, selected, edit }: { data: ReviewDetailResponse; selected: ReviewEvidenceDto | undefined; edit: boolean }) {
  const note = lockedNote(data.lockedDomains);
  const showOwnerBlock = data.statusLine === 'You own this task';
  return (
    <ContextRail>
      <RailItem term="Assigned expert">{data.expertName ?? 'Not yet claimed'}</RailItem>
      <RailItem term={data.eligible ? 'Verified domain' : 'Domain'}>{data.task.domainName}</RailItem>
      <RailItem term="Task owner">{data.task.ownerName}</RailItem>
      <RailItem term="Final publication">Admin only</RailItem>
      {edit && data.draftSavedAt ? <RailItem term="Draft saved">{formatDateTime(data.draftSavedAt)}</RailItem> : null}
      {data.submittedAt ? <RailItem term="Submitted">{formatDateTime(data.submittedAt)}</RailItem> : null}
      {selected ? <RailTamper evidence={selected} /> : null}
      {note ? <RailNote>{note}</RailNote> : null}
      {showOwnerBlock ? <RailUnavailable action="Review this task" reason="You own this task" /> : null}
      {data.actions.publish.allowed ? null : <RailUnavailable action="Publish final adjudication" reason={data.actions.publish.reason as string} />}
    </ContextRail>
  );
}

function PublishAction({ data }: { data: ReviewDetailResponse }) {
  return (
    <ActionsBelow>
      {data.actions.publish.allowed ? (
        <LinkButton to={`/admin/adjudications/${data.code}`}>Publish final adjudication</LinkButton>
      ) : (
        <DisabledAction reason={data.actions.publish.reason as string}>Publish final adjudication</DisabledAction>
      )}
    </ActionsBelow>
  );
}

function useSelectedEvidence(data: ReviewDetailResponse) {
  const [params] = useSearchParams();
  const wanted = params.get('model');
  return data.evidence.find((item) => item.code === wanted) ?? data.evidence[0];
}

/* ---------- Read-only: submitted, finalized, someone else's, or waiting to be claimed ---------- */

function ReadOnlyReview({ data }: { data: ReviewDetailResponse }) {
  const selected = useSelectedEvidence(data);
  const toast = useToast();
  const claim = useApiMutation(() => api.post<ReviewDetailResponse>(`/api/reviews/${data.code}/claim`), {
    invalidate: [`/api/reviews/${data.code}`, '/api/reviews'],
    onSuccess: () => toast.success(`${data.code} claimed`, 'It is assigned to you. Your draft stays private until you submit.'),
  });
  const recommendation = selected ? data.recommendations[selected.code] : undefined;
  const requested = data.status === 'requested';
  const showOwnerBlock = data.statusLine === 'You own this task';

  let alert: string | null = null;
  if (requested) alert = data.actions.claim.allowed ? 'This review is waiting for an expert. Claim it to start your independent assessment.' : `This review is waiting for a verified ${data.task.domainName} expert.`;
  else if (!data.contentVisible) alert = 'The expert’s work stays private until it is submitted.';
  else if (data.status === 'submitted') alert = `Submitted ${formatDateTime(data.submittedAt)}. This review is read-only while an admin decides.`;
  else if (data.status === 'finalized' && data.report) alert = `Finalized and frozen as ${data.report.code} v${data.report.version}. This review is read-only.`;

  return (
    <Page title="Independent expert review">
      <PageHeader
        eyebrow={EYEBROW}
        title="Independent expert review"
        subtitle={`${data.task.label} · ${data.expertName ? `Assigned to ${data.expertName}` : 'Not yet claimed'}`}
        status={data.statusLine}
        statusTone={data.eligible ? 'accent' : 'warning'}
      />
      {alert ? <Alert tone={requested || !data.contentVisible ? 'neutral' : 'accent'}>{alert}</Alert> : null}
      {!data.evidenceVerified ? <HashMismatch /> : null}
      {claim.formError ? <Alert tone="danger">{claim.formError}</Alert> : null}
      <Workspace rail={<ReviewRail data={data} selected={selected} edit={false} />}>
        {data.contentVisible ? (
          <>
            <Section title="Independent evidence assessment">
              <p className="prewrap">{data.assessment}</p>
            </Section>
            <Section title="Expert rubric recommendation">
              <ModelTabs data={data} selected={selected?.code ?? ''} labelFor={(item) => item.displayName} />
              {selected && recommendation ? (
                <>
                  <Pairs items={recommendation.criteria.map((criterion) => ({ term: criterion.name, detail: `${criterion.score ?? '—'} / ${criterion.points} · ${criterion.note}` }))} />
                  <Pairs items={[{ term: 'Reviewer annotation', detail: recommendation.annotation }]} />
                  <SealedOutput item={selected} />
                </>
              ) : null}
            </Section>
            <Section title="Review statement" kind="form">
              <FieldStatic label="Expert rationale">{data.rationale}</FieldStatic>
              <FieldStatic label="Finding">{data.finding}</FieldStatic>
              <Checkbox size="small" checked={data.conflictAck} onChange={() => undefined} disabled>
                No ownership, financial or authorship conflict for {data.task.code}.
              </Checkbox>
            </Section>
          </>
        ) : (
          <>
            <Section title="Frozen task">
              <Pairs items={[{ term: data.task.label, detail: data.task.title }]} />
              <p className="prewrap">{data.task.prompt}</p>
            </Section>
            <Section title="Model outputs">
              <ModelTabs data={data} selected={selected?.code ?? ''} labelFor={(item) => item.displayName} />
              {selected ? (
                <>
                  <Pairs items={[{ term: selected.displayName, detail: sealedLine(selected) }]} />
                  <SealedOutput item={selected} />
                </>
              ) : null}
            </Section>
          </>
        )}
      </Workspace>
      <Actions>
        {requested && !showOwnerBlock ? (
          data.actions.claim.allowed ? (
            <Button variant="primary" busy={claim.isPending} busyLabel={`Claiming ${data.code}`} onClick={() => claim.mutate()}>
              Claim review
            </Button>
          ) : (
            <DisabledAction reason={data.actions.claim.reason as string}>Claim review</DisabledAction>
          )
        ) : null}
        {data.report ? (
          <LinkButton variant="primary" to={reportPath(data.report)}>
            Open {data.report.code} v{data.report.version}
          </LinkButton>
        ) : null}
        <LinkButton to="/review">Back to review queue</LinkButton>
      </Actions>
      {showOwnerBlock ? (
        <ActionsBelow>
          <DisabledAction reason="You own this task">Review this task</DisabledAction>
        </ActionsBelow>
      ) : null}
      <PublishAction data={data} />
    </Page>
  );
}

/* ---------- Editable: claimed and not yet submitted, or returned ---------- */

function EditableReview({ data }: { data: ReviewDetailResponse }) {
  const toast = useToast();
  const selected = useSelectedEvidence(data);
  const [form, setForm] = useState<FormState>(() => initialForm(data));

  const save = useApiMutation(() => api.put<ReviewDetailResponse>(`/api/reviews/${data.code}`, toInput(form)), {
    invalidate: [`/api/reviews/${data.code}`, '/api/reviews'],
    onSuccess: (saved) => toast.success('Review draft saved', `Saved ${formatDateTime(saved.draftSavedAt)}. It stays private until you submit.`),
  });
  const submit = useApiMutation(() => api.post<ReviewDetailResponse>(`/api/reviews/${data.code}/submit`, toInput(form)), {
    invalidate: [`/api/reviews/${data.code}`, '/api/reviews'],
    onSuccess: () => toast.success('Expert review submitted', 'An admin will make the final determination. This review is now read-only.'),
  });
  const errors = { ...save.fieldErrors, ...submit.fieldErrors };
  const formError = submit.formError ?? save.formError;

  const recommendation = selected ? form.recommendations[selected.code] : undefined;
  const setCriterion = (code: string, index: number, change: Partial<CriterionState>) =>
    setForm((current) => {
      const entry = current.recommendations[code] as FormState['recommendations'][string];
      return {
        ...current,
        recommendations: {
          ...current.recommendations,
          [code]: { ...entry, criteria: entry.criteria.map((criterion, i) => (i === index ? { ...criterion, ...change } : criterion)) },
        },
      };
    });

  const total = useMemo(() => {
    if (!recommendation) return null;
    const scores = recommendation.criteria.map((criterion) => (criterion.score.trim() === '' ? Number.NaN : Number(criterion.score)));
    return scores.some(Number.isNaN) ? null : scores.reduce((sum, value) => sum + value, 0);
  }, [recommendation]);

  const problemsFor = (code: string) => Object.keys(errors).filter((key) => key.startsWith(`recommendations.${code}.`)).length;

  return (
    <Page title="Independent expert review">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit.mutate();
        }}
        onKeyDown={keepEnterFromSubmitting}
        noValidate
        style={{ display: 'contents' }}
      >
        <PageHeader
          eyebrow={EYEBROW}
          title="Independent expert review"
          subtitle={`${data.task.label} · Assigned to ${data.expertName}`}
          status={data.statusLine}
        />
        {data.returnedNote ? (
          <Alert tone="warning" live>
            An admin returned this review: “{data.returnedNote}”. Your earlier submission is kept. Change what you need and submit again.
          </Alert>
        ) : null}
        {!data.evidenceVerified ? <HashMismatch /> : null}
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <Workspace rail={<ReviewRail data={data} selected={selected} edit />}>
          <Section title="Independent evidence assessment" kind="form">
            <FieldTextarea label="Your assessment" rows={4} value={form.assessment} onChange={(assessment) => setForm((current) => ({ ...current, assessment }))} required error={errors.assessment} />
            <FrozenTask data={data} />
          </Section>
          <Section title="Expert rubric recommendation" kind="form">
            <ModelTabs
              data={data}
              selected={selected?.code ?? ''}
              labelFor={(item) => {
                const problems = problemsFor(item.code);
                return problems ? `${item.displayName} · ${problems} to fix` : item.displayName;
              }}
            />
            {selected && recommendation ? (
              <>
                <p className="criterion-model">
                  <span>{selected.displayName}</span>
                  <span className="text-muted mono">{total === null ? 'Recommended total pending' : `Recommended ${total} / 100`}</span>
                  <span className="text-muted mono">Sealed {sealedLine(selected)}</span>
                </p>
                <SealedOutput item={selected} />
                {data.task.rubric.map((criterion, index) => {
                  const sealed = selected.scores[index];
                  const value = recommendation.criteria[index] as CriterionState;
                  return (
                    <div className="criterion" key={`${selected.code}-${criterion.name}`}>
                      <FieldInput
                        label={`${criterion.name} / ${criterion.points}`}
                        type="number"
                        min={0}
                        max={criterion.points}
                        step={1}
                        inputMode="numeric"
                        value={value.score}
                        onChange={(score) => setCriterion(selected.code, index, { score })}
                        required
                        error={errors[`recommendations.${selected.code}.criteria.${index}.score`]}
                        hint={sealed ? `Sealed ${selected.scoreLabel} score ${sealed.score} / ${sealed.points}` : undefined}
                      />
                      <FieldInput
                        label="Note"
                        value={value.note}
                        onChange={(note) => setCriterion(selected.code, index, { note })}
                        required
                        error={errors[`recommendations.${selected.code}.criteria.${index}.note`]}
                        hint={criterion.guidance}
                      />
                    </div>
                  );
                })}
                <FieldTextarea
                  label={`Reviewer annotation / ${selected.shortName}`}
                  rows={2}
                  value={recommendation.annotation}
                  onChange={(annotation) =>
                    setForm((current) => ({
                      ...current,
                      recommendations: { ...current.recommendations, [selected.code]: { ...(current.recommendations[selected.code] as FormState['recommendations'][string]), annotation } },
                    }))
                  }
                  required
                  error={errors[`recommendations.${selected.code}.annotation`]}
                  hint={`Shown with ${selected.code} once this review is submitted.`}
                />
              </>
            ) : null}
          </Section>
          <Section title="Review statement" kind="form">
            <FieldTextarea label="Expert rationale" rows={3} value={form.rationale} onChange={(rationale) => setForm((current) => ({ ...current, rationale }))} required error={errors.rationale} />
            <FieldTextarea
              label="Finding"
              rows={3}
              value={form.finding}
              onChange={(finding) => setForm((current) => ({ ...current, finding }))}
              required
              error={errors.finding}
              hint="Quoted at adjudication and in the report. Its first sentence becomes the report’s headline."
            />
            <Checkbox size="small" checked={form.conflictAck} onChange={(conflictAck) => setForm((current) => ({ ...current, conflictAck }))} error={errors.conflictAck}>
              No ownership, financial or authorship conflict for {data.task.code}.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={submit.isPending} busyLabel="Submitting your review">
            Submit expert review
          </Button>
          <Button busy={save.isPending} busyLabel="Saving your draft" onClick={() => save.mutate()}>
            Save review draft
          </Button>
        </Actions>
        <PublishAction data={data} />
      </form>
    </Page>
  );
}

export default function ExpertReviewPage() {
  const { code = '' } = useParams();
  const query = useApiQuery<ReviewDetailResponse>(`/api/reviews/${encodeURIComponent(code)}`);
  return (
    <QueryBoundary query={query}>
      {(data) => (data.actions.edit.allowed ? <EditableReview key={data.code} data={data} /> : <ReadOnlyReview data={data} />)}
    </QueryBoundary>
  );
}
