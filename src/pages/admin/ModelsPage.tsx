import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminModel, AdminModelsResponse, AdminPerson } from '../../../shared/types/admin.ts';
import { Actions, AdminTabs, Alert, Button, Checkbox, ContextRail, EmptyState, FieldInput, FieldStatic, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useUser } from '../../lib/session.tsx';
import { AdminLocked } from './AdminLocked.tsx';
import './admin.css';

const FIELD_NAMES: Record<string, string> = { displayName: 'Display name', cutoffDisclosure: 'Cutoff disclosure', enabled: 'Available for new evaluations' };

const listNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));
const showValue = (value: string | boolean) => (typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value);

function changeSummary(changes: AdminModel['history'][number]['changes']): string {
  return Object.entries(changes)
    .map(([field, change]) => `${FIELD_NAMES[field] ?? field}: ${showValue(change.from)} → ${showValue(change.to)}`)
    .join(' · ');
}

function History({ model }: { model: AdminModel }) {
  return (
    <Section title={`${model.shortName} change history`}>
      {model.history.length ? (
        <Pairs
          items={model.history.map((entry) => ({
            key: entry.id,
            term: `${formatDateTime(entry.createdAt)} / ${entry.editor ?? 'Unknown editor'}`,
            detail: (
              <>
                {changeSummary(entry.changes)}
                <br />
                {entry.rationale}
              </>
            ),
          }))}
        />
      ) : (
        <EmptyState>No metadata revisions yet. Each save adds one here, and none can be edited afterwards.</EmptyState>
      )}
    </Section>
  );
}

function Editor({ model, models, editor, selectHref }: { model: AdminModel; models: AdminModel[]; editor: AdminPerson; selectHref: (id: string) => string }) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(model.displayName);
  const [cutoff, setCutoff] = useState(model.cutoffDisclosure);
  const [enabled, setEnabled] = useState(model.enabled);
  const [rationale, setRationale] = useState('');

  const save = useApiMutation(() => api.patch<AdminModel>(`/api/admin/models/${encodeURIComponent(model.id)}`, { displayName, cutoffDisclosure: cutoff, enabled, rationale }), {
    invalidate: ['/api/admin/models'],
    onSuccess: (updated) => {
      setRationale('');
      toast.success('Metadata revision saved', `${updated.shortName} history has a new entry. The pinned revision did not change.`);
    },
  });

  const cancel = () => {
    setDisplayName(model.displayName);
    setCutoff(model.cutoffDisclosure);
    setEnabled(model.enabled);
    setRationale('');
    save.clearErrors();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  const illustrative = models.filter((item) => item.illustrative).map((item) => item.shortName);
  const fieldKeys = ['displayName', 'cutoffDisclosure', 'enabled', 'rationale'];
  const showFormError = save.formError && !fieldKeys.some((key) => save.fieldErrors[key]);

  return (
    <Page title="Model metadata">
      <PageHeader
        eyebrow="11 Administration"
        title="Model metadata, kept explicit."
        subtitle={illustrative.length === models.length ? 'Administration · Illustrative models used in this demo' : 'Administration · Model registry'}
        status={illustrative.length === models.length ? 'Admin / Illustrative model registry' : 'Admin / Model registry'}
      />
      <AdminTabs />
      {illustrative.length ? <Alert>{listNames(illustrative)} are fictional. Metadata is demo content, not provider claims.</Alert> : null}
      {showFormError ? <Alert tone="danger">{save.fieldErrors.form ?? save.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Editor">
                {editor.name} / {editor.role}
              </RailItem>
              <RailItem term="Frozen run metadata">Preserved</RailItem>
              <RailItem term="Change history">Append-only</RailItem>
              <RailItem term="Pinned revision edits">Not permitted</RailItem>
              <RailNote>Disabling a model prevents new selection. Historical outputs, pinned versions and citations remain visible.</RailNote>
            </ContextRail>
          }
        >
          <Section title="Pinned model revisions">
            <Pairs
              items={models.map((item, index) => ({
                key: item.id,
                term: (
                  <Link className="admin-model-link" to={selectHref(item.id)} aria-current={item.id === model.id ? 'true' : undefined}>
                    {item.displayName} / {item.enabled ? 'Enabled' : 'Disabled'}
                  </Link>
                ),
                detail: index === 0 ? `${item.revision} · ${item.contextK}k context / ${item.outputK}k output` : `${item.revision} · ${item.contextK}k / ${item.outputK}k`,
              }))}
            />
          </Section>
          <Section title={`Edit ${model.shortName} metadata`} kind="form">
            <FieldInput label="Display name" value={displayName} onChange={setDisplayName} required error={save.fieldErrors.displayName} />
            <FieldStatic label="Adapter">{model.adapterLabel}</FieldStatic>
            <FieldInput label="Cutoff disclosure" value={cutoff} onChange={setCutoff} required error={save.fieldErrors.cutoffDisclosure} />
            <FieldInput label="Change rationale" value={rationale} onChange={setRationale} required placeholder="Clarify provenance and cutoff disclosure. No change to the pinned revision." error={save.fieldErrors.rationale} />
            <Checkbox size="small" checked={enabled} onChange={setEnabled} error={save.fieldErrors.enabled}>
              Available for new evaluations.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={save.isPending} busyLabel="Saving the metadata revision">
            Save metadata revision
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </Actions>
      </form>
      <History model={model} />
    </Page>
  );
}

function ModelsContent({ data }: { data: AdminModelsResponse }) {
  const [params] = useSearchParams();
  const selected = data.items.find((item) => item.id === params.get('model')) ?? data.items[0];
  if (!selected) {
    return (
      <Page title="Model metadata">
        <PageHeader eyebrow="11 Administration" title="Model metadata, kept explicit." subtitle="Administration · Model registry" status="Admin / Model registry" />
        <AdminTabs />
        <EmptyState>No models are registered on this instance yet.</EmptyState>
      </Page>
    );
  }
  // key: choosing another model starts its form from what is stored.
  return <Editor key={selected.id} model={selected} models={data.items} editor={data.editor} selectHref={(id) => `/admin/models?model=${encodeURIComponent(id)}`} />;
}

function ModelsLoader() {
  const query = useApiQuery<AdminModelsResponse>('/api/admin/models');
  return <QueryBoundary query={query}>{(data) => <ModelsContent data={data} />}</QueryBoundary>;
}

export default function ModelsPage() {
  const user = useUser();
  return user.role === 'admin' ? <ModelsLoader /> : <AdminLocked />;
}
