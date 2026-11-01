import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Actions, ActionsBelow, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldInput, FieldSelect, FieldTextarea, LinkButton, Page, PageHeader, QueryBoundary, RailItem, RailNote, RailSelect, Section, Workspace, useToast } from '../../components/index.ts';
import type { CreateDatasetResponse, UploadDraft } from '../../../shared/types/datasets.ts';
import type { DraftDto, DraftInput, DraftSaveResponse, EditorDraftResponse, EditorNewResponse, EditorOptions, RunSettings, StarterDraft } from '../../../shared/types/evaluation.ts';
import { ApiError, api } from '../../lib/api.ts';
import { formatTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useUser } from '../../lib/session.tsx';
import { VerdictUnavailable } from './parts.tsx';
import './evaluation.css';

const AUTOSAVE_MS = 1000;

interface CriterionState {
  key: number;
  name: string;
  short: string;
  /** Text, so the box can be empty while someone types. */
  points: string;
  guidance: string;
}

interface FormState {
  title: string;
  domainId: string;
  prompt: string;
  rubric: CriterionState[];
  modelIds: string[];
  datasetVersionId: string | null;
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'error';

let nextKey = 1;
const toCriteria = (rubric: DraftInput['rubric']): CriterionState[] => rubric.map((item) => ({ key: nextKey++, name: item.name, short: item.short, points: String(item.points), guidance: item.guidance }));

const toInput = (form: FormState): DraftInput => ({
  title: form.title,
  domainId: form.domainId,
  prompt: form.prompt,
  rubric: form.rubric.map((item) => ({ name: item.name, short: item.short, points: item.points.trim() === '' ? 0 : Number(item.points), guidance: item.guidance })),
  modelIds: form.modelIds,
  datasetVersionId: form.datasetVersionId,
});

const without = (fields: Record<string, string>, ...keys: string[]) => Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)));

function EditorForm({ initial, options, draft, settings }: { initial: FormState; options: EditorOptions; draft: DraftDto | null; settings: RunSettings }) {
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState(initial);
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [savedAt, setSavedAt] = useState<string | null>(draft?.savedAt ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'review' | null>(null);
  const [revealErrors, setRevealErrors] = useState(0);

  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const latest = useRef(form);
  const code = useRef(draft?.code ?? null);
  const edits = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Saves in order: a slow request can never overwrite a newer one. */
  const saveNow = useCallback((): Promise<DraftSaveResponse> => {
    window.clearTimeout(timer.current);
    const run = queue.current.then(async () => {
      const editsAtStart = edits.current;
      setSaveState('saving');
      try {
        const body = toInput(latest.current);
        const res = code.current ? await api.put<DraftSaveResponse>(`/api/tasks/${code.current}/draft`, body) : await api.post<DraftSaveResponse>('/api/tasks', body);
        if (res.code !== code.current) {
          code.current = res.code;
          // The first save allocates the code. Update the address without remounting, so focus and typing are not disturbed.
          window.history.replaceState(window.history.state, '', `/tasks/${res.code}/edit`);
        }
        setSavedAt(res.savedAt);
        setSaveState(edits.current === editsAtStart ? 'clean' : 'dirty');
        setFormError(null);
        return res;
      } catch (error) {
        setSaveState('error');
        throw error;
      }
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const canAutosave = (next: FormState) => Boolean(code.current || (next.title.trim() && next.domainId));

  const change = (next: FormState) => {
    latest.current = next;
    edits.current += 1;
    setForm(next);
    setSaveState('dirty');
    window.clearTimeout(timer.current);
    if (!canAutosave(next)) return;
    timer.current = window.setTimeout(() => {
      saveNow().catch((error: unknown) => {
        if (error instanceof ApiError) {
          setErrors((current) => ({ ...current, ...error.fields }));
          setFormError(`Your latest changes are not saved. ${error.message}`);
        } else setFormError('Your latest changes are not saved. Check your connection and try again.');
      });
    }, AUTOSAVE_MS);
  };

  const patch = (changes: Partial<FormState>, ...clear: string[]) => {
    if (clear.length) setErrors((current) => without(current, ...clear));
    change({ ...latest.current, ...changes });
  };

  // Leaving with unsaved edits: warn on a tab close, and save on an in-app navigation.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saveStateRef.current !== 'clean') event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.clearTimeout(timer.current);
      if (saveStateRef.current === 'dirty' && canAutosave(latest.current)) void saveNow().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a refused review, take keyboard users to the first thing to fix.
  useEffect(() => {
    if (revealErrors === 0) return;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [revealErrors]);

  const applyError = (error: unknown) => {
    if (error instanceof ApiError) {
      setErrors(error.fields);
      setFormError(error.message);
      setRevealErrors((count) => count + 1);
    } else setFormError('Something went wrong. Please try again.');
  };

  const saveDraft = async () => {
    setBusy('save');
    setErrors({});
    try {
      const res = await saveNow();
      toast.success('Draft saved', `${res.code} · ${formatTime(res.savedAt)}`);
    } catch (error) {
      applyError(error);
    } finally {
      setBusy(null);
    }
  };

  const reviewAndFreeze = async () => {
    setBusy('review');
    setErrors({});
    try {
      const res = await saveNow();
      if (res.validation.ok) {
        navigate(`/tasks/${res.code}/freeze`);
        return;
      }
      setErrors(res.validation.fields);
      setFormError('This draft is not ready to freeze. Check the highlighted fields.');
      setRevealErrors((count) => count + 1);
    } catch (error) {
      applyError(error);
    } finally {
      setBusy(null);
    }
  };

  /* ----- Rubric ----- */

  const total = form.rubric.reduce((sum, item) => sum + (Number(item.points) || 0), 0);
  const [editingCriteria, setEditingCriteria] = useState<ReadonlySet<number>>(new Set());
  const setCriterionEditing = (key: number, editing: boolean) =>
    setEditingCriteria((current) => {
      const next = new Set(current);
      if (editing) next.add(key);
      else next.delete(key);
      return next;
    });
  const updateCriterion = (key: number, changes: Partial<CriterionState>, index: number, field: string) => {
    patch({ rubric: latest.current.rubric.map((item) => (item.key === key ? { ...item, ...changes } : item)) }, `rubric.${index}.${field}`, ...(field === 'points' ? ['rubric'] : []));
  };

  /* ----- Models ----- */

  const toggleModel = (id: string, checked: boolean) => {
    const ids = latest.current.modelIds;
    patch({ modelIds: checked ? [...ids, id] : ids.filter((item) => item !== id) }, 'modelIds');
  };
  const atLimit = form.modelIds.length >= 4;
  const selected = options.models.filter((model) => form.modelIds.includes(model.id));
  const settingsNote = selected.find((model) => model.settingsNote)?.settingsNote ?? null;

  /* ----- Dataset ----- */

  // The authored starter pack goes through the same upload validation as any other file.
  const queryClient = useQueryClient();
  const addPack = useApiMutation(async () => {
    const bytes = await (await fetch(options.starterPackUrl)).blob();
    const form = new FormData();
    form.set('file', new File([bytes], 'resistance-evidence-demo.csv', { type: 'text/csv' }));
    const draft = await api.upload<UploadDraft>('/api/datasets/uploads', form);
    const created = await api.post<CreateDatasetResponse>('/api/datasets', {
      draftId: draft.id,
      name: 'Resistance evidence pack',
      version: '1.0',
      provenance: 'Authored fixtures for the starter task. Not experimental measurements. No personal data or licensed publication text.',
      domainId: latest.current.domainId,
      rightsAck: true,
    });
    const fresh = await api.get<EditorNewResponse>('/api/tasks/editor-options');
    await queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith('/api/tasks/') });
    const attached = fresh.options.datasets.find((item) => item.label.startsWith(created.code));
    if (attached) patch({ datasetVersionId: attached.versionId }, 'datasetVersionId');
  });

  const dataset = options.datasets.find((item) => item.versionId === form.datasetVersionId) ?? null;
  const datasetOptions = [
    { value: '', label: 'No source pack' },
    ...(form.datasetVersionId && !dataset ? [{ value: form.datasetVersionId, label: 'Attached dataset is no longer available' }] : []),
    ...options.datasets.map((item) => ({ value: item.versionId, label: `${item.label} · ${item.name}` })),
  ];
  const citesStarterRecords = /\bE01\b/.test(form.prompt) && !dataset?.recordIds.includes('E01');
  const datasetHint =
    citesStarterRecords ? (
      <>
        This prompt cites E01–E03.{' '}
        <button type="button" className="inline-action" aria-busy={addPack.isPending || undefined} onClick={() => !addPack.isPending && addPack.mutate()}>
          {addPack.isPending ? 'Adding the authored source pack…' : 'Add the authored source pack'}
        </button>{' '}
        to this workspace and attach it, or{' '}
        <Link className="text-link" to="/datasets/upload">
          upload your own
        </Link>
        .{addPack.formError ? <span className="text-danger"> {addPack.formError}</span> : null}
      </>
    ) : options.datasets.length === 0 ? (
      <>
        This workspace has no datasets yet.{' '}
        <Link className="text-link" to="/datasets/upload">
          Upload one
        </Link>{' '}
        to attach it.
      </>
    ) : undefined;

  /* ----- Status line ----- */

  const visibilityWord = (draft?.visibility ?? options.workspace?.defaultVisibility ?? 'private') === 'shared' ? 'Shared' : 'Private';
  const saveWord = saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : saveState === 'dirty' ? 'Unsaved changes' : savedAt ? `Saved ${formatTime(savedAt)}` : 'Not saved yet';
  const draftWord = draft?.latestVersion ? `Draft v${draft.draftVersion}` : 'Draft';
  const laterVersion = draft?.afterFreezeVersion ?? '1.1';

  return (
    <Page title="Build an evaluation">
      <PageHeader eyebrow="02 Evaluation" title="Build an evaluation" subtitle={form.title.trim() || 'Untitled draft'} status={`${draftWord} / ${visibilityWord} / ${saveWord}`} statusTone={saveState === 'error' ? 'danger' : 'accent'} />
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="03 / Select 2–4 models">
              {form.modelIds.length} selected
              {errors.modelIds ? <span className="check-error" style={{ display: 'block' }}>{errors.modelIds}</span> : null}
            </RailItem>
            {options.models.length === 0 ? <RailNote>No models are registered on this instance yet.</RailNote> : null}
            {options.models.map((model) => {
              const checked = form.modelIds.includes(model.id);
              return (
                <div key={model.id} className="eval-model">
                  <Checkbox size="small" checked={checked} disabled={!checked && (!model.available || atLimit)} onChange={(next) => toggleModel(model.id, next)}>
                    <span className="eval-model-name">{model.displayName}</span>
                  </Checkbox>
                  <p className="eval-model-detail">{model.revision}</p>
                  {model.reason ? <p className="eval-model-detail">{model.reason}</p> : !checked && atLimit ? <p className="eval-model-detail">Four models are selected. Clear one to choose this.</p> : null}
                </div>
              );
            })}
            <RailItem term="Run settings">
              Temperature {settings.temperature} · Seed {settings.seed} · {settings.maxOutputK}k output
            </RailItem>
            {settingsNote ? <RailNote>{settingsNote}</RailNote> : null}
            <RailNote>Freeze pins the prompt, rubric, sources and revisions. Later changes create v{laterVersion}.</RailNote>
            <RailNote>
              Owner {options.ownerName} · {options.workspace?.name ?? 'No workspace'}
            </RailNote>
            <RailSelect label="Dataset" value={form.datasetVersionId ?? ''} onChange={(value) => patch({ datasetVersionId: value || null }, 'datasetVersionId')} options={datasetOptions} />
            {errors.datasetVersionId ? <p className="check-error">{errors.datasetVersionId}</p> : null}
            {datasetHint ? <RailNote>{datasetHint}</RailNote> : null}
            <VerdictUnavailable action="Expert review" verdict={options.review} />
          </ContextRail>
        }
      >
        <Section title="01 / Task definition" kind="form">
          <FieldInput label="Task title" value={form.title} onChange={(value) => patch({ title: value }, 'title')} error={errors.title} hint={savedAt || (form.title.trim() && form.domainId) ? undefined : 'Autosave starts once this draft has a title and a domain.'} maxLength={200} required />
          <FieldSelect
            label="Domain"
            value={form.domainId}
            onChange={(value) => patch({ domainId: value }, 'domainId')}
            options={[...(form.domainId ? [] : [{ value: '', label: 'Choose a domain', disabled: true }]), ...options.domains.map((domain) => ({ value: domain.id, label: domain.label }))]}
            disabled={draft?.domainLocked}
            error={errors.domainId}
            hint={draft?.domainLocked ? 'The domain is fixed once a version is frozen.' : code.current ? 'Changing the domain gives this draft a new code.' : undefined}
            required
          />
          <FieldTextarea label="Prompt" value={form.prompt} onChange={(value) => patch({ prompt: value }, 'prompt')} rows={3} error={errors.prompt} required />
        </Section>

        <Section title="02 / Rubric · Total 0–100">
          {form.rubric.map((criterion, index) => {
            const label = criterion.name.trim() || `criterion ${index + 1}`;
            const finished = Boolean(criterion.name.trim() && criterion.guidance.trim() && criterion.points !== '');
            const hasError = Object.keys(errors).some((key) => key.startsWith(`rubric.${index}.`));
            const remove = () => patch({ rubric: latest.current.rubric.filter((item) => item.key !== criterion.key) }, 'rubric');
            if (finished && !hasError && !editingCriteria.has(criterion.key)) {
              return (
                <div key={criterion.key} className="eval-criterion" data-editing="false" role="group" aria-label={`Criterion ${index + 1}`}>
                  <p>
                    {criterion.name} / {criterion.points}
                  </p>
                  <p>{criterion.guidance}</p>
                  <p className="eval-criterion-actions">
                    <button type="button" className="inline-action" onClick={() => setCriterionEditing(criterion.key, true)}>
                      Edit {label}
                    </button>{' '}
                    ·{' '}
                    <button type="button" className="inline-action" onClick={remove}>
                      Remove {label}
                    </button>
                  </p>
                </div>
              );
            }
            return (
              <div key={criterion.key} className="eval-criterion" data-editing="true" role="group" aria-label={`Criterion ${index + 1}`}>
                <div className="eval-criterion-head">
                  <FieldInput label="Criterion" autoFocus={editingCriteria.has(criterion.key)} value={criterion.name} onChange={(value) => updateCriterion(criterion.key, { name: value, short: value }, index, 'name')} error={errors[`rubric.${index}.name`]} maxLength={120} />
                  <FieldInput label="Points" type="number" inputMode="numeric" min={0} max={100} step={1} value={criterion.points} onChange={(value) => updateCriterion(criterion.key, { points: value }, index, 'points')} error={errors[`rubric.${index}.points`]} />
                </div>
                <FieldTextarea label="Guidance" value={criterion.guidance} onChange={(value) => updateCriterion(criterion.key, { guidance: value }, index, 'guidance')} rows={1} error={errors[`rubric.${index}.guidance`]} maxLength={500} />
                <p className="eval-criterion-actions">
                  {finished && !hasError ? (
                    <>
                      <button type="button" className="inline-action" onClick={() => setCriterionEditing(criterion.key, false)}>
                        Done with {label}
                      </button>{' '}
                      ·{' '}
                    </>
                  ) : null}
                  <button type="button" className="inline-action" onClick={remove}>
                    Remove {label}
                  </button>
                </p>
              </div>
            );
          })}
          <p className="eval-total" data-tone={total === 100 ? undefined : 'danger'} aria-live="polite">
            Total {total} / 100{total === 100 ? '' : total < 100 ? ` · ${100 - total} left to assign` : ` · ${total - 100} over`}
          </p>
          {errors.rubric ? (
            <p className="field-message" data-tone="danger">
              {errors.rubric}
            </p>
          ) : null}
          <div className="eval-add">
            <Button onClick={() => patch({ rubric: [...latest.current.rubric, { key: nextKey++, name: '', short: '', points: '', guidance: '' }] }, 'rubric')}>Add criterion</Button>
          </div>
        </Section>
      </Workspace>
      <Actions>
        <Button variant="primary" busy={busy === 'review'} busyLabel="Saving and checking this draft" onClick={() => void reviewAndFreeze()}>
          Review &amp; freeze
        </Button>
        <Button busy={busy === 'save'} busyLabel="Saving this draft" onClick={() => void saveDraft()}>
          Save draft
        </Button>
      </Actions>
      <ActionsBelow>{options.review.allowed ? <LinkButton to="/review">Expert review</LinkButton> : <DisabledAction reason={options.review.reason}>Expert review</DisabledAction>}</ActionsBelow>
    </Page>
  );
}

function NewDraft() {
  const user = useUser();
  const toast = useToast();
  const [params] = useSearchParams();
  const starter = params.get('starter') === '1';
  const query = useApiQuery<EditorNewResponse>(`/api/tasks/editor-options${starter ? '?starter=1' : ''}`, { staleTime: 0, gcTime: 0, enabled: Boolean(user.workspace) });

  useEffect(() => {
    if (!user.workspace) toast.warning('Create a workspace first', 'Tasks and datasets live in a workspace.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user.workspace) return <Navigate to="/workspace/new" replace />;

  return (
    <QueryBoundary query={query}>
      {(data) => {
        const prefill: StarterDraft | null = data.starter;
        const initial: FormState = {
          title: prefill?.title ?? '',
          domainId: prefill?.domainId ?? '',
          prompt: prefill?.prompt ?? '',
          rubric: toCriteria(prefill?.rubric ?? []),
          modelIds: prefill?.modelIds ?? [],
          datasetVersionId: prefill?.datasetVersionId ?? null,
        };
        return <EditorForm initial={initial} options={data.options} draft={null} settings={data.options.defaultSettings} />;
      }}
    </QueryBoundary>
  );
}

function ExistingDraft({ code }: { code: string }) {
  const navigate = useNavigate();
  const path = `/api/tasks/${code}/draft`;
  const query = useApiQuery<EditorDraftResponse>(path, { staleTime: 0, gcTime: 0 });
  const revise = useApiMutation(() => api.post(`/api/tasks/${code}/revise`), { invalidate: [path] });

  return (
    <QueryBoundary query={query}>
      {(data) => {
        const { draft, options } = data;
        if (draft.status !== 'draft') {
          const label = `${draft.code} v${draft.latestVersion}`;
          return (
            <Page title="Build an evaluation">
              <PageHeader eyebrow="02 Evaluation" title="Build an evaluation" subtitle={draft.title} status={`Frozen / ${label}`} />
              <Alert>
                {label} is frozen. Frozen versions are never edited. Revise it as v{draft.draftVersion} to make changes.
              </Alert>
              {revise.formError ? <Alert tone="danger">{revise.formError}</Alert> : null}
              <Actions>
                <Button variant="primary" busy={revise.isPending} busyLabel="Creating a new draft" onClick={() => revise.mutate()}>
                  Revise as v{draft.draftVersion}
                </Button>
                <Button onClick={() => navigate(`/tasks/${draft.code}`)}>Back to task</Button>
              </Actions>
            </Page>
          );
        }
        const initial: FormState = {
          title: draft.title,
          domainId: draft.domainId,
          prompt: draft.prompt,
          rubric: toCriteria(draft.rubric),
          modelIds: draft.modelIds,
          datasetVersionId: draft.datasetVersionId,
        };
        return <EditorForm key={draft.draftVersion} initial={initial} options={options} draft={draft} settings={draft.settings} />;
      }}
    </QueryBoundary>
  );
}

export default function EditorPage() {
  const { code } = useParams();
  const location = useLocation();
  // Keyed so that "Create task" always opens a blank form, even from an unsaved one.
  return code ? <ExistingDraft key={code} code={code} /> : <NewDraft key={location.key} />;
}
