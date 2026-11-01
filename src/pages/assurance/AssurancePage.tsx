import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { AssuranceCandidateItem, AssuranceIndex, AssuranceTraceItem, ImportTraceResponse } from '../../../shared/types/assurance.ts';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, EmptyState, FieldTextarea, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateAssurance } from './shared.ts';
import './assurance.css';

const stateLabel = (candidate: AssuranceCandidateItem) => {
  if (candidate.state === 'not_run') return 'Not run';
  const result = `${candidate.state === 'passed' ? 'Passed' : 'Blocked'} ${candidate.passedCount} / ${candidate.totalCount}`;
  return candidate.approved ? `${result} · Release approved` : result;
};

function traceRow(item: AssuranceTraceItem, showWorkspace: boolean): { key: string; term: ReactNode; detail: ReactNode } {
  return {
    key: item.code,
    term: (
      <>
        <Link className="text-link" to={`/assurance/traces/${item.code}`}>
          {item.code}
        </Link>{' '}
        / {item.agentLabel} / Harness {item.harnessVersion}
      </>
    ),
    detail: [showWorkspace ? item.workspaceName : null, item.candidate, item.taskLabel, item.decisionCode ? `${item.state} ${item.decisionCode}` : item.state, item.isSynthetic ? 'Synthetic' : null].filter(Boolean).join(' · '),
  };
}

function IndexContent({ data }: { data: AssuranceIndex }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [json, setJson] = useState('');

  const importTrace = useApiMutation(() => api.post<ImportTraceResponse>('/api/assurance/traces', { json }), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      toast.success(`${result.code} imported`, 'Rivet computed its SHA-256. The trace cannot be changed from here on.');
      navigate(`/assurance/traces/${result.code}`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (data.canImport.allowed) importTrace.mutate();
  };

  const activeRegressions = data.regressions.filter((regression) => regression.status === 'active').length;
  const status = data.workspace
    ? `${data.traces.length} ${data.traces.length === 1 ? 'trace' : 'traces'} / ${activeRegressions} active ${activeRegressions === 1 ? 'regression' : 'regressions'} / ${data.gates.length} ${data.gates.length === 1 ? 'gate' : 'gates'}`
    : 'No workspace';

  return (
    <Page title="Agent assurance">
      <PageHeader eyebrow="07 Agent assurance" title="Every release leaves a trail." subtitle={`${data.workspace?.name ?? 'No workspace'} · Traces, regressions, gates and candidates`} status={status} />
      {importTrace.formError && !importTrace.fieldErrors.json ? <Alert tone="danger">{importTrace.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Workspace">{data.workspace?.name ?? 'None yet'}</RailItem>
              <RailItem term="Suite">{data.gates[0]?.suite ?? data.suite}</RailItem>
              <RailItem term="Policy">No manual bypass</RailItem>
              <RailNote>Traces are immutable once imported. Only a verified domain reviewer who does not own a trace can adjudicate it. Only the workspace or task owner can run a gate or approve an eligible release.</RailNote>
              {data.canImport.allowed ? null : <RailUnavailable action="Import trace" reason={data.canImport.reason} />}
            </ContextRail>
          }
        >
          {data.reviewQueue.length ? (
            <Section title="Traces for expert review">
              <Pairs items={data.reviewQueue.map((item) => traceRow(item, true))} />
            </Section>
          ) : null}
          {data.workspace ? (
            <>
              <Section title="Release gates">
                {data.gates.length ? (
                  <Pairs
                    items={data.gates.flatMap((gate) => [
                      { key: gate.code, term: `${gate.code} / ${gate.target}`, detail: `${gate.suite} · ${gate.suiteSize} checks` },
                      ...gate.candidates.map((candidate) => ({
                        key: `${gate.code}-${candidate.candidate}`,
                        term: (
                          <>
                            <Link className="text-link" to={`/assurance/gates/${gate.code}/${candidate.candidate}`}>
                              {candidate.candidate}
                            </Link>{' '}
                            / Harness {candidate.harnessVersion}
                          </>
                        ),
                        detail: `${stateLabel(candidate)} · ${candidate.traceCode}`,
                      })),
                    ])}
                  />
                ) : (
                  <p>No release gates yet. Importing a Biology trace creates one.</p>
                )}
              </Section>
              <Section title="Regressions">
                {data.regressions.length ? (
                  <Pairs
                    items={data.regressions.map((regression) => ({
                      key: regression.code,
                      term: (
                        <>
                          <Link className="text-link" to={`/assurance/regressions/${regression.code}`}>
                            {regression.code}
                          </Link>{' '}
                          / {regression.name}
                        </>
                      ),
                      detail: `${regression.status === 'active' ? 'Active / Gating' : 'Draft'} · Rule version ${regression.currentVersion} · ${regression.policyLabel}${regression.sourceCode ? ` · ${regression.sourceCode}` : ''}`,
                    }))}
                  />
                ) : (
                  <p>No regressions yet. A confirmed finding can become one.</p>
                )}
              </Section>
              <Section title="Traces">{data.traces.length ? <Pairs items={data.traces.map((item) => traceRow(item, false))} /> : <p>No traces in {data.workspace.name} yet. Import one below.</p>}</Section>
              <Section title="Import a trace" kind="form">
                <div className="as-json">
                  <FieldTextarea
                    label="Trace JSON"
                    value={json}
                    onChange={setJson}
                    rows={10}
                    spellCheck={false}
                    disabled={!data.canImport.allowed}
                    error={importTrace.fieldErrors.json}
                    hint="Validated on import. Rivet computes a real SHA-256 and assigns an immutable TRACE code."
                  />
                </div>
              </Section>
            </>
          ) : (
            <Section title="Traces">
              <EmptyState
                action={
                  <Link className="text-link" to="/workspace/new">
                    Create a workspace
                  </Link>
                }
              >
                You are not in a workspace yet, so there is nothing to assure. Create a workspace to import a trace.
              </EmptyState>
            </Section>
          )}
        </Workspace>
        {data.canImport.allowed ? (
          <Actions>
            <Button type="submit" variant="primary" busy={importTrace.isPending} busyLabel="Importing trace">
              Import trace
            </Button>
            <Button onClick={() => setJson(data.importExample)}>Fill in an example</Button>
          </Actions>
        ) : (
          <ActionsBelow>
            <DisabledAction reason={data.canImport.reason}>Import trace</DisabledAction>
          </ActionsBelow>
        )}
      </form>
    </Page>
  );
}

export default function AssurancePage() {
  const query = useApiQuery<AssuranceIndex>('/api/assurance');
  return <QueryBoundary query={query}>{(data) => <IndexContent data={data} />}</QueryBoundary>;
}
