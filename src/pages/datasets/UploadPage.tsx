import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { CreateDatasetResponse, DatasetReceipt, UploadContext, UploadDraft } from '../../../shared/types/datasets.ts';
import { Actions, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldFile, FieldInput, FieldSelect, FieldStatic, FieldTextarea, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Skeleton, Workspace, useToast } from '../../components/index.ts';
import { ApiError, api } from '../../lib/api.ts';
import { formatSize } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateDatasets } from './shared.ts';
import './datasets.css';

/** "resistance-evidence-demo.csv · 48 KB · 3 synthetic source records · UTF-8" */
function summaryLine(draft: UploadDraft): string {
  const size = formatSize(draft.size);
  if (draft.format === 'pdf') return `${draft.filename} · ${size} · Records not parsed · ${draft.receipt.encoding}`;
  const count = draft.recordsCount;
  return `${draft.filename} · ${size} · ${count.toLocaleString('en-US')} ${draft.receipt.synthetic ? 'synthetic ' : ''}source ${count === 1 ? 'record' : 'records'} · ${draft.receipt.encoding}`;
}

function ReceiptPairs({ receipt, visibility }: { receipt: DatasetReceipt; visibility: 'private' | 'shared' }) {
  const { requiredColumns: columns } = receipt;
  const workspaceLine = `${visibility === 'private' ? 'Private' : 'Shared'} workspace visibility`;
  const columnsLine =
    columns.applicable === false
      ? 'Not applicable to a PDF'
      : columns.missing.length
        ? `${columns.expected.join(', ')} · ${columns.passed}/${columns.total} passed · Missing ${columns.missing.join(', ')}`
        : `${columns.expected.join(', ')} · ${columns.passed}/${columns.total} passed`;
  const recordsLine = receipt.format === 'pdf' ? (receipt.recordsNote ?? 'Not parsed') : `${receipt.recordsParsed.toLocaleString('en-US')} / Duplicate source IDs: ${receipt.duplicateSourceIds}${receipt.missingSourceIds ? ` / Missing source IDs: ${receipt.missingSourceIds}` : ''}`;
  return (
    <Pairs
      items={[
        { term: 'Required columns', detail: columnsLine },
        { term: 'Records parsed', detail: recordsLine },
        { term: 'Sensitive data scan', detail: `${receipt.sensitiveData.note} · ${workspaceLine}` },
      ]}
    />
  );
}

function UploadContent({ context, draft, onDraft }: { context: UploadContext; draft: UploadDraft | null; onDraft: (draft: UploadDraft | null) => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const { target } = context;

  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState(context.defaultDomainId);
  const [version, setVersion] = useState(target?.nextVersion ?? '1.0');
  const [provenance, setProvenance] = useState(target?.provenance ?? '');
  const [rightsAck, setRightsAck] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const fileWrap = useRef<HTMLDivElement>(null);

  const domain = context.domains.find((entry) => entry.id === domainId) ?? context.domains[0];
  const code = target?.code ?? domain?.nextCode ?? '';
  const label = `${code} v${version.trim() || '…'}`;
  const canUpload = target ? target.canUpload : context.canCreate;

  // Remounting the input lets the same corrected file be chosen again; keep focus where it was.
  useEffect(() => {
    if (fileKey) fileWrap.current?.querySelector('input')?.focus();
  }, [fileKey]);

  const upload = useApiMutation(
    (file: File) => {
      const form = new FormData();
      form.append('file', file);
      if (target) form.append('dataset', target.code);
      return api.upload<UploadDraft>('/api/datasets/uploads', form);
    },
    {
      onSuccess: (result) => {
        onDraft(result);
        setFileKey((key) => key + 1);
        void invalidateDatasets(client);
      },
      onError: () => setFileKey((key) => key + 1),
    },
  );

  const create = useApiMutation(
    () =>
      api.post<CreateDatasetResponse>('/api/datasets', {
        draftId: draft?.id,
        name: target ? undefined : name,
        version: version.trim(),
        provenance,
        domainId: target ? undefined : domainId,
        rightsAck,
        expectedCode: target ? undefined : code,
      }),
    {
      onSuccess: async (result) => {
        await invalidateDatasets(client);
        toast.success(`${result.code} v${result.version} created`, 'New bytes create a new version with a SHA-256 hash. Existing snapshots are never replaced.');
        navigate(`/datasets/${result.code}`);
      },
      onError: (error: ApiError) => {
        if (error.code === 'code_changed' || error.code === 'identical_bytes') void invalidateDatasets(client);
      },
    },
  );

  const choose = (file: File | null) => {
    setLocalError(null);
    upload.clearErrors();
    if (!file) return;
    if (file.size > context.maxBytes) {
      setLocalError(`${file.name} is ${formatSize(file.size)}. This file is larger than the 100 MB upload limit.`);
      setFileKey((key) => key + 1);
      return;
    }
    upload.mutate(file);
  };

  const cancel = async () => {
    if (draft) await api.delete(`/api/datasets/uploads/${draft.id}`).catch(() => undefined);
    await invalidateDatasets(client);
    navigate(target ? `/datasets/${target.code}` : '/datasets');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft?.passed && canUpload.allowed) create.mutate();
  };

  const failures = draft?.receipt.failures ?? [];
  const blockReason = !canUpload.allowed
    ? canUpload.reason
    : upload.isPending
      ? 'Validation is still running.'
      : !draft
        ? 'Upload a file that passes validation first.'
        : !draft.passed
          ? 'This file failed validation. Fix what is listed and choose it again.'
          : null;

  let status = target ? `New version / ${target.code}` : 'Ready to upload';
  let statusTone: 'accent' | 'warning' | 'danger' = 'accent';
  if (!canUpload.allowed) {
    status = 'Upload unavailable';
    statusTone = 'warning';
  } else if (upload.isPending) status = 'Uploading / Validating';
  else if (draft?.passed) status = 'Upload complete / Validation passed';
  else if (draft) {
    status = 'Validation failed';
    statusTone = 'danger';
  }

  return (
    <Page title={target ? `New version of ${target.code}` : 'Upload a dataset'}>
      <PageHeader
        eyebrow="06 Datasets"
        title="Bring your source material."
        subtitle={target ? `${target.code} · ${target.name} · Upload a new version.` : `${context.workspace?.name ?? 'No workspace'} · Upload a versioned, traceable dataset.`}
        status={status}
        statusTone={statusTone}
      />
      {upload.isPending ? (
        <Alert tone="neutral" live>
          <span className="ds-uploading">
            <span className="spinner" aria-hidden="true" />
            Uploading and validating your file. Large files can take a moment.
          </span>
        </Alert>
      ) : draft?.passed ? (
        <Alert live>{summaryLine(draft)}</Alert>
      ) : draft ? (
        <Alert tone="danger">
          {draft.filename} · {formatSize(draft.size)} failed validation, so nothing was created and this upload was not kept.
        </Alert>
      ) : null}
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      {upload.formError ? <Alert tone="danger">{upload.formError}</Alert> : null}
      {create.formError && !Object.keys(create.fieldErrors).length ? <Alert tone="danger">{create.formError}</Alert> : null}
      {canUpload.allowed ? null : (
        <Alert tone="warning">
          {canUpload.reason}
          {context.workspace || target ? null : (
            <>
              {' '}
              <Link className="text-link" to="/workspace/new">
                Create a workspace
              </Link>
            </>
          )}
        </Alert>
      )}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Formats">{context.formats.join(' / ')}</RailItem>
              <RailItem term="Upload limit">{formatSize(context.maxBytes).replace('.0 MB', ' MB')}</RailItem>
              <RailItem term="Owner">{context.ownerName}</RailItem>
              <RailItem term={target ? 'New version' : 'New dataset'}>{label}</RailItem>
              <RailNote>New bytes create a new version with a SHA-256 hash. Existing snapshots are never replaced.</RailNote>
              {blockReason ? <RailUnavailable action={`Create ${label}`} reason={blockReason} /> : null}
            </ContextRail>
          }
        >
          <Section title="Versioned dataset" kind="form">
            {target ? (
              <FieldStatic label="Dataset name">{target.name}</FieldStatic>
            ) : (
              <>
                <FieldInput label="Dataset name" value={name} onChange={setName} required maxLength={120} disabled={!canUpload.allowed} error={create.fieldErrors.name} />
                <FieldSelect label="Domain" value={domainId} onChange={setDomainId} options={context.domains.map((entry) => ({ value: entry.id, label: entry.name }))} disabled={!canUpload.allowed} error={create.fieldErrors.domainId} />
              </>
            )}
            <FieldInput label="Version" value={version} onChange={setVersion} required inputMode="decimal" disabled={!canUpload.allowed} error={create.fieldErrors.version} hint={target ? `Latest is v${target.latestVersion}.` : undefined} />
            <div ref={fileWrap}>
              <FieldFile key={fileKey} label="Source file" fileName={draft?.filename ?? null} onFile={choose} accept=".csv,.jsonl,.ndjson,.pdf" disabled={upload.isPending || !canUpload.allowed} error={upload.fieldErrors.file} />
            </div>
            <div className="ds-grow">
              <FieldTextarea label="Provenance statement" value={provenance} onChange={setProvenance} required rows={2} maxLength={2000} disabled={!canUpload.allowed} error={create.fieldErrors.provenance} />
            </div>
          </Section>
          {failures.length ? (
            <Section title="What failed">
              <ul className="ds-failures">
                {failures.map((failure, index) => (
                  <li key={index}>{failure.message}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title="Validation receipt">{draft ? <ReceiptPairs receipt={draft.receipt} visibility={draft.visibility} /> : <p>Choose a file to run validation. Required columns are source_id, observation and provenance.</p>}</Section>
          <Section title="Upload rights">
            <Checkbox checked={rightsAck} onChange={setRightsAck} disabled={!canUpload.allowed} error={create.fieldErrors.rightsAck}>
              I have permission to upload this file and its provenance is accurate.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          {blockReason ? (
            <DisabledAction reason={blockReason}>Create {label}</DisabledAction>
          ) : (
            <Button type="submit" variant="primary" busy={create.isPending} busyLabel={`Creating ${label}`}>
              Create {label}
            </Button>
          )}
          <Button onClick={() => void cancel()}>Cancel</Button>
        </Actions>
      </form>
    </Page>
  );
}

export default function UploadPage() {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const targetCode = params.get('dataset');
  const draftId = params.get('draft');
  const contextPath = `/api/datasets/upload-context${targetCode ? `?dataset=${encodeURIComponent(targetCode)}` : ''}`;
  const context = useApiQuery<UploadContext>(contextPath);
  const draftPath = `/api/datasets/uploads/${draftId}`;
  const draftQuery = useApiQuery<UploadDraft>(draftPath, { enabled: Boolean(draftId), retry: false });

  const setDraft = (draft: UploadDraft | null) => {
    const next = new URLSearchParams(params);
    if (draft) {
      client.setQueryData([`/api/datasets/uploads/${draft.id}`], draft);
      next.set('draft', draft.id);
    } else next.delete('draft');
    setParams(next, { replace: true });
  };

  // A reload of a replaced or used upload just returns to choosing a file.
  const expired = draftQuery.error instanceof ApiError && draftQuery.error.status === 404;
  useEffect(() => {
    if (expired) setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  if (draftId && draftQuery.isPending) return <Skeleton />;
  const draft = draftId && draftQuery.data && draftQuery.data.targetCode === targetCode ? draftQuery.data : null;
  return <QueryBoundary query={context}>{(data) => <UploadContent key={contextPath} context={data} draft={draft} onDraft={setDraft} />}</QueryBoundary>;
}
