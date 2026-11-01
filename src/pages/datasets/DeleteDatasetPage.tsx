import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { DatasetDeletion } from '../../../shared/types/datasets.ts';
import { Actions, ActionsBelow, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldInput, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateDatasets } from './shared.ts';

function DeleteContent({ data }: { data: DatasetDeletion }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [confirmCode, setConfirmCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const { references, impact, canDelete, code, name } = data;

  const remove = useApiMutation(() => api.delete(`/api/datasets/${code}`, { confirmCode, acknowledged }), {
    onSuccess: async () => {
      await invalidateDatasets(client);
      toast.success(`${code} deleted`, 'The library entry is gone. Version rows and bytes are retained for audit.');
      navigate('/datasets');
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canDelete.allowed) remove.mutate();
  };

  const frozen = [...references.frozenTasks, ...references.traces];
  const label = `${code} v${data.version}`;
  return (
    <Page title={`Delete ${code}`}>
      <PageHeader eyebrow="06 Datasets" title="Delete this dataset?" subtitle={`${label} · ${name}`} status="Delete confirmation" statusTone="warning" />
      {references.frozenTasks.length || references.traces.length ? (
        <Alert tone="warning">Referenced by frozen {(references.frozenTasks.length ? references.frozenTasks : references.traces).join(', ')}. Audit snapshots will be retained.</Alert>
      ) : (
        <Alert tone="neutral">Not referenced by frozen evidence. Versions and bytes are still kept for audit.</Alert>
      )}
      {remove.formError && !Object.keys(remove.fieldErrors).length ? <Alert tone="danger">{remove.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Dataset">{label}</RailItem>
              <RailItem term="Owner">{data.ownerName}</RailItem>
              <RailItem term="Attached task">{references.frozenTasks.join(', ') || 'None'}</RailItem>
              <RailItem term="Report">{references.reports.join(', ') || 'None'}</RailItem>
              {references.draftTasks.length ? <RailItem term="Draft attachment">{references.draftTasks.join(', ')} keeps its reference but cannot freeze this dataset</RailItem> : null}
              {references.traces.length ? <RailItem term="Agent traces">{references.traces.join(', ')} unchanged</RailItem> : null}
              <RailNote>This action cannot be undone from the library. Use Keep dataset to cancel without making changes.</RailNote>
              {canDelete.allowed ? null : <RailUnavailable action="Delete dataset" reason={canDelete.reason} />}
            </ContextRail>
          }
        >
          <Section title="Deletion impact">
            <Pairs
              items={[
                { term: 'Library visibility', detail: impact.library },
                { term: 'New task attachments', detail: impact.attachments },
                { term: 'Frozen source snapshots', detail: impact.snapshots },
                { term: 'Existing reports', detail: impact.reports },
              ]}
            />
          </Section>
          <Section title={`Delete ${name}?`} kind="form">
            <FieldInput label={`Type ${code} to confirm`} value={confirmCode} onChange={setConfirmCode} required autoComplete="off" disabled={!canDelete.allowed} error={remove.fieldErrors.confirmCode} />
            <Checkbox size="small" checked={acknowledged} onChange={setAcknowledged} disabled={!canDelete.allowed} error={remove.fieldErrors.acknowledged}>
              I understand this removes the library entry permanently, but does not erase retained audit snapshots.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          {canDelete.allowed ? (
            <Button type="submit" variant="primary" busy={remove.isPending} busyLabel={`Deleting ${code}`}>
              Delete dataset
            </Button>
          ) : null}
          <LinkButton to={`/datasets/${code}`}>Keep dataset</LinkButton>
        </Actions>
        {canDelete.allowed ? null : (
          <ActionsBelow>
            <DisabledAction reason={canDelete.reason}>Delete dataset</DisabledAction>
          </ActionsBelow>
        )}
      </form>
    </Page>
  );
}

export default function DeleteDatasetPage() {
  const { code = '' } = useParams();
  const query = useApiQuery<DatasetDeletion>(`/api/datasets/${encodeURIComponent(code)}/deletion`);
  return <QueryBoundary query={query}>{(data) => <DeleteContent data={data} />}</QueryBoundary>;
}
