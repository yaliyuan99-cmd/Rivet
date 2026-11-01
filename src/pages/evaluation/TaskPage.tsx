import { Link, useNavigate, useParams } from 'react-router-dom';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, EmptyState, FieldSelect, FieldStatic, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailTamper, Row, Section, Workspace, useToast } from '../../components/index.ts';
import type { RunStartResponse, TaskDetailResponse } from '../../../shared/types/evaluation.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { ReviewActionButton, ReviewUnavailable, VerdictUnavailable } from './parts.tsx';
import './evaluation.css';

const SHARING_NOTE = 'Sharing a link does not grant access. AI clients need explicit scoped consent and cannot download private source files by default.';

function TaskContent({ data, path }: { data: TaskDetailResponse; path: string }) {
  const navigate = useNavigate();
  const toast = useToast();

  const run = useApiMutation(() => api.post<RunStartResponse>(`/api/tasks/${data.code}/runs`), {
    invalidate: [path],
    onSuccess: (result) => navigate(`/runs/${result.code}`),
  });
  const revise = useApiMutation(() => api.post(`/api/tasks/${data.code}/revise`), {
    invalidate: [path, '/api/tasks'],
    onSuccess: () => navigate(`/tasks/${data.code}/edit`),
  });
  const visibility = useApiMutation((value: string) => api.patch(`/api/tasks/${data.code}/visibility`, { visibility: value }), {
    invalidate: [path, '/api/tasks'],
    onSuccess: (_, value) => toast.success('Visibility saved', value === 'shared' ? 'Verified Rivet members can now read the frozen version.' : `Only ${data.workspaceName} members and authorized reviewers can read this task.`),
  });

  const version = data.latestVersion;
  const contract = version ?? data.draft;
  const shownVisibility = data.visibilityOptions.find((option) => option.value === data.visibility)?.label ?? data.visibility;

  const editorAction =
    data.verdicts.edit.allowed && data.draft ? (
      <LinkButton variant={version ? 'secondary' : 'primary'} to={`/tasks/${data.code}/edit`}>
        Continue editing{version ? ` v${data.draft.version}` : ''}
      </LinkButton>
    ) : null;

  const runAction = data.activeRunCode ? (
    <LinkButton variant="primary" to={`/runs/${data.activeRunCode}`}>
      Open {data.activeRunCode}
    </LinkButton>
  ) : data.verdicts.run.allowed ? (
    <Button variant="primary" busy={run.isPending} busyLabel="Starting the run" onClick={() => run.mutate()}>
      Run evaluation
    </Button>
  ) : (
    <DisabledAction reason={data.verdicts.run.reason}>Run evaluation</DisabledAction>
  );

  return (
    <Page title={data.label}>
      <PageHeader eyebrow="05 Workspace" title={data.visibility === 'private' ? 'Private by design.' : 'Shared for inspection.'} subtitle={`${data.label} · ${data.workspaceName} · Owner ${data.ownerName}`} status={data.statusLine} />
      {data.tamper && !data.tamper.verified ? <HashMismatch>The bytes of {data.tamper.code} differ from its seal. Do not use this artifact for scoring.</HashMismatch> : null}
      {run.formError ? <Alert tone="danger">{run.formError}</Alert> : null}
      {revise.formError ? <Alert tone="danger">{revise.formError}</Alert> : null}
      {visibility.formError ? <Alert tone="danger">{visibility.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Task owner">{data.ownerName}</RailItem>
            <RailItem term="Workspace">{data.workspaceName}</RailItem>
            <RailItem term="Task version">{data.label}</RailItem>
            <RailItem term="Sources">{data.sourcePack ?? 'None attached'}</RailItem>
            {data.tamper ? <RailTamper evidence={data.tamper} /> : <RailNote>No evidence sealed yet.</RailNote>}
            <VerdictUnavailable action="Run evaluation" verdict={data.activeRunCode ? { allowed: true } : data.verdicts.run} />
            {version && !editorAction ? <VerdictUnavailable action={`Revise as v${data.nextVersion}`} verdict={data.verdicts.revise} /> : null}
            <ReviewUnavailable action={data.reviewAction} />
          </ContextRail>
        }
      >
        <Section title={data.title || 'Untitled draft'}>
          <p>{data.statement}</p>
        </Section>
        <Section title="Access policy">
          <Pairs items={data.accessPolicy.map((row) => ({ key: row.term, term: row.term, detail: row.detail }))} />
        </Section>
        <Section title="Visibility" kind="form">
          {data.verdicts.visibility.allowed ? (
            <FieldSelect
              label="Task visibility"
              value={data.visibility}
              onChange={(value) => visibility.mutate(value)}
              options={data.visibilityOptions}
              disabled={visibility.isPending}
              hint={data.status === 'draft' ? `${SHARING_NOTE} A shared task becomes readable once it is frozen.` : SHARING_NOTE}
            />
          ) : (
            <FieldStatic label="Task visibility" hint={`${data.verdicts.visibility.reason} ${SHARING_NOTE}`}>
              {shownVisibility}
            </FieldStatic>
          )}
        </Section>
        {contract ? (
          <Section title={version ? `Prompt and rubric / v${version.version}` : `Prompt and rubric / v${data.draft?.version} draft`}>
            <p className="eval-quote">{contract.prompt || 'No prompt yet.'}</p>
            {contract.rubric.length > 0 ? <Pairs items={contract.rubric.map((criterion, index) => ({ key: `${index}-${criterion.name}`, term: `${criterion.name || 'Unnamed criterion'} / ${criterion.points}`, detail: criterion.guidance }))} /> : null}
            {version ? (
              <p>
                Frozen {formatDateTime(version.frozenAt)} · {version.models.map((model) => model.revision).join(' · ')}
                {version.scanCode && !(data.isOwner && data.draft) ? (
                  <>
                    {' · '}
                    <Link className="text-link" to={`/tasks/${data.code}/freeze`}>
                      Contamination check {version.scanCode}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </Section>
        ) : null}
        <Section title="Past runs" kind="form">
          {data.runs.length > 0 ? (
            <div className="eval-rows">
              {data.runs.map((item) => (
                <Row
                  key={item.code}
                  label={
                    <Link className="row-link" to={`/runs/${item.code}`}>
                      {item.code} / {item.taskLabel}
                    </Link>
                  }
                  value={item.summary}
                />
              ))}
            </div>
          ) : (
            <EmptyState>{version ? 'No runs yet. Every run reuses this frozen version.' : 'No runs yet. Freeze this draft to run it.'}</EmptyState>
          )}
        </Section>
      </Workspace>
      <Actions>
        {!version && editorAction ? editorAction : runAction}
        {version ? (
          data.verdicts.revise.allowed ? (
            <Button busy={revise.isPending} busyLabel="Creating a new draft" onClick={() => revise.mutate()}>
              Revise as v{data.nextVersion}
            </Button>
          ) : editorAction ? (
            editorAction
          ) : (
            <DisabledAction reason={data.verdicts.revise.reason}>Revise as v{data.nextVersion}</DisabledAction>
          )
        ) : null}
      </Actions>
      <ActionsBelow>
        {!version && editorAction ? runAction : null}
        <ReviewActionButton action={data.reviewAction} />
      </ActionsBelow>
    </Page>
  );
}

export default function TaskPage() {
  const { code = '' } = useParams();
  const path = `/api/tasks/${code}`;
  const query = useApiQuery<TaskDetailResponse>(path, { staleTime: 0 });
  return <QueryBoundary query={query}>{(data) => <TaskContent data={data} path={path} />}</QueryBoundary>;
}
