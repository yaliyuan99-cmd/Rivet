import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Actions, Alert, Button, Checkbox, ContextRail, DisabledAction, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import type { FreezeResponse, FreezeResult, ScanFindings } from '../../../shared/types/evaluation.ts';
import { ApiError, api } from '../../lib/api.ts';
import { formatDateTime, shortHash } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import './evaluation.css';

const NOT_READY = 'Fix the listed fields in the editor first.';

const FIELD_NAMES: Record<string, string> = {
  title: 'Task title',
  prompt: 'Prompt',
  rubric: 'Rubric',
  modelIds: 'Models',
  datasetVersionId: 'Dataset',
  domainId: 'Domain',
};

function fieldName(key: string): string {
  const criterion = /^rubric\.(\d+)\.(\w+)$/.exec(key);
  if (criterion) return `Rubric criterion ${Number(criterion[1]) + 1}`;
  return FIELD_NAMES[key] ?? key;
}

function scanPairs(findings: ScanFindings) {
  const rows = [findings.exactPrompt, findings.nearDuplicate, findings.coverage, findings.sourceExposure, findings.trainingCoverage];
  return rows.filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => ({ key: row.label, term: row.label, detail: row.detail }));
}

function FreezeContent({ data, path }: { data: FreezeResponse; path: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const [findingsAck, setFindingsAck] = useState(false);
  const [retentionAck, setRetentionAck] = useState(false);
  const [ackErrors, setAckErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [staleNote, setStaleNote] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);

  const scan = useApiMutation(() => api.post<FreezeResponse>(`/api/tasks/${data.code}/scan`), {
    onSuccess: (fresh) => {
      setFindingsAck(false);
      setRetentionAck(false);
      client.setQueryData([path], fresh);
    },
  });

  // A preview must exist and match the draft before anything can be acknowledged, so it runs on arrival.
  const needsScan = data.status === 'draft' && data.validation.ok && (!data.scan || data.scan.stale);
  const scanKey = data.scan ? `${data.scan.code}:${data.scan.createdAt}` : 'none';
  useEffect(() => {
    if (!needsScan || attempted.current === scanKey) return;
    attempted.current = scanKey;
    scan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsScan, scanKey]);

  const freeze = useApiMutation(
    () =>
      api.post<FreezeResult>(`/api/tasks/${data.code}/freeze`, {
        scanCode: data.scan?.code,
        acknowledgeFindings: findingsAck,
        acknowledgeRetention: retentionAck,
      }),
    {
      invalidate: [`/api/tasks/${data.code}`, '/api/tasks', path],
      onSuccess: (result) => {
        toast.success(`${result.label} frozen`, `SHA-256 ${shortHash(result.sha256)}`);
        navigate(`/tasks/${data.code}`);
      },
      onError: (error: ApiError) => {
        setConfirming(false);
        if (error.code === 'scan_stale') {
          // The draft moved on in another tab. Show a new preview; the owner acknowledges that one instead.
          setStaleNote(`${error.message} A fresh scan is below; review it and acknowledge again.`);
          attempted.current = null;
          scan.mutate();
        } else if (error.fields.acknowledgeFindings || error.fields.acknowledgeRetention) {
          setAckErrors(error.fields);
        } else {
          // The draft or its models changed in the meantime: show the current reasons.
          void client.invalidateQueries({ queryKey: [path] });
        }
      },
    },
  );

  const openConfirm = () => {
    const missing: Record<string, string> = {};
    if (!findingsAck) missing.acknowledgeFindings = 'Acknowledge the scan findings to freeze this version.';
    if (!retentionAck) missing.acknowledgeRetention = 'Agree to retain the scan and its limitations to freeze this version.';
    setAckErrors(missing);
    if (Object.keys(missing).length === 0) setConfirming(true);
  };

  const frozen = data.status === 'frozen';
  const findings = data.scan?.findings;
  const invalidFields = Object.entries(data.validation.fields);
  const hasOverlap = data.scan && data.scan.risk !== 'none';

  const rail = (
    <ContextRail>
      <RailItem term="Prompt and rubric">{data.rail.promptAndRubric}</RailItem>
      <RailItem term="Source pack">{data.rail.sourcePack ?? 'None attached'}</RailItem>
      <RailItem term="Model revisions">{data.rail.modelRevisions}</RailItem>
      <RailItem term="Immutable version">{data.label}</RailItem>
      {data.frozen ? (
        <>
          <RailItem term="Frozen">
            {formatDateTime(data.frozen.frozenAt)} · {data.frozen.frozenBy}
          </RailItem>
          <RailItem term="SHA-256">
            <span className="rail-hash">{data.frozen.sha256}</span>
          </RailItem>
        </>
      ) : null}
      <RailNote>Freezing cannot be undone. The prompt, rubric, data and model selections cannot be overwritten; revisions create a new version.</RailNote>
      {!frozen && !data.validation.ok ? <RailUnavailable action={`Freeze ${data.label}`} reason={NOT_READY} /> : null}
    </ContextRail>
  );

  return (
    <Page title="Freeze the evidence contract">
      <PageHeader eyebrow="02 Evaluation" title="Freeze the evidence contract" subtitle={`${data.code} · ${data.title || 'Untitled draft'}`} status={frozen ? `Frozen / v${data.version}` : `Freeze preview / v${data.version}`} statusTone={frozen ? 'accent' : 'warning'} />

      {staleNote ? <Alert tone="warning" live>{staleNote}</Alert> : null}
      {findings ? <Alert tone={hasOverlap ? 'warning' : 'accent'}>{findings.summary}</Alert> : null}
      {data.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}
      {freeze.formError && !freeze.fieldErrors.acknowledgeFindings && !freeze.fieldErrors.acknowledgeRetention && freeze.error instanceof ApiError && freeze.error.code !== 'scan_stale' ? <Alert tone="danger">{freeze.formError}</Alert> : null}
      {scan.formError ? <Alert tone="danger">The contamination scan could not run. {scan.formError}</Alert> : null}

      <Workspace rail={rail}>
        {!data.validation.ok ? (
          <Section title="Not ready to freeze">
            <div>
              <p>Fix these in the editor. The scan runs once the draft is complete.</p>
              <ul className="eval-reasons">
                {invalidFields.map(([key, message]) => (
                  <li key={key}>
                    {fieldName(key)}: {message}
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        ) : null}

        {data.validation.ok && !findings ? (
          scan.isPending || needsScan ? (
            <Section title="Contamination check">
              <p role="status">Comparing this prompt with the documents you can access…</p>
            </Section>
          ) : (
            <Section title="Contamination check">
              <p>No scan has been recorded for this version.</p>
            </Section>
          )
        ) : null}

        {findings && data.scan ? (
          <>
            <Section title={`Contamination check / ${data.scan.code}`}>
              <Pairs items={scanPairs(findings)} />
              {findings.scope ? <p className="eval-scan-scope">{findings.scope}</p> : null}
            </Section>
            <Section title="Owner acknowledgement">
              {frozen ? (
                (data.frozen?.acknowledgements ?? []).map((text) => (
                  <Checkbox key={text} checked disabled onChange={() => undefined}>
                    {text}
                  </Checkbox>
                ))
              ) : (
                <>
                  <Checkbox
                    checked={findingsAck}
                    onChange={(next) => {
                      setFindingsAck(next);
                      setAckErrors(({ acknowledgeFindings: _, ...rest }) => rest);
                    }}
                    error={ackErrors.acknowledgeFindings}
                  >
                    {findings.acknowledgementText}
                  </Checkbox>
                  <Checkbox
                    checked={retentionAck}
                    onChange={(next) => {
                      setRetentionAck(next);
                      setAckErrors(({ acknowledgeRetention: _, ...rest }) => rest);
                    }}
                    error={ackErrors.acknowledgeRetention}
                  >
                    {findings.retentionText}
                  </Checkbox>
                </>
              )}
            </Section>
          </>
        ) : null}
      </Workspace>

      <Actions>
        {frozen ? (
          <LinkButton variant="primary" to={`/tasks/${data.code}`}>
            Back to task
          </LinkButton>
        ) : !data.validation.ok ? (
          <DisabledAction reason={NOT_READY}>Freeze {data.label}</DisabledAction>
        ) : !data.scan || data.scan.stale ? (
          scan.formError ? (
            <Button variant="primary" busy={scan.isPending} busyLabel="Running the contamination scan" onClick={() => scan.mutate()}>
              Run the scan again
            </Button>
          ) : (
            <DisabledAction reason="The contamination scan has not finished.">Freeze {data.label}</DisabledAction>
          )
        ) : (
          <Button variant="primary" onClick={openConfirm}>
            Freeze {data.label}
          </Button>
        )}
        {frozen ? null : <LinkButton to={`/tasks/${data.code}/edit`}>Return to editor</LinkButton>}
      </Actions>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Freeze version ${data.version}?`}
        actions={
          <>
            <Button variant="primary" busy={freeze.isPending} busyLabel={`Freezing version ${data.version}`} onClick={() => freeze.mutate()}>
              Freeze version
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        }
      >
        The prompt, rubric and model revisions become immutable.
      </Modal>
    </Page>
  );
}

export default function FreezePage() {
  const { code = '' } = useParams();
  const path = `/api/tasks/${code}/freeze`;
  const query = useApiQuery<FreezeResponse>(path, { staleTime: 0, gcTime: 0 });
  return <QueryBoundary query={query}>{(data) => <FreezeContent data={data} path={path} />}</QueryBoundary>;
}
