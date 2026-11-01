import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { RegressionDetail, RegressionPolicy } from '../../../shared/types/assurance.ts';
import { Actions, ActionsBelow, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldInput, FieldSelect, FieldStatic, FieldTextarea, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { invalidateAssurance } from './shared.ts';
import './assurance.css';

function RegressionContent({ data }: { data: RegressionDetail }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(data.name);
  const [passCondition, setPassCondition] = useState(data.passCondition);
  const [policy, setPolicy] = useState<RegressionPolicy>(data.policy);
  const [scopeAck, setScopeAck] = useState(data.scopeAck);
  const active = data.status === 'active';
  const body = { name, passCondition, policy, scopeAck };

  // Follows the saved row, so what the fields show is what the server holds.
  useEffect(() => {
    setName(data.name);
    setPassCondition(data.passCondition);
    setPolicy(data.policy);
    setScopeAck(data.scopeAck);
  }, [data.currentVersion, data.name, data.passCondition, data.policy, data.scopeAck]);

  const save = useApiMutation(() => api.put<{ version: number; changed: boolean }>(`/api/assurance/regressions/${data.code}`, body), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      if (result.changed) toast.success(`Saved as rule version ${result.version}`, 'Earlier rule versions, the finding and the failed trace are unchanged.');
      else toast.warning('Nothing to save', `This matches rule version ${result.version}.`);
    },
  });

  const activate = useApiMutation(() => api.post<{ code: string; status: string; version: number }>(`/api/assurance/regressions/${data.code}/activate`, body), {
    onSuccess: async (result) => {
      await invalidateAssurance(client);
      toast.success(`${result.code} is active`, `Rule version ${result.version} now gates every ${data.target} release candidate and cannot be bypassed.`);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!data.canEdit.allowed) return;
    if (active) save.mutate();
    else activate.mutate();
  };

  const errors = { ...save.fieldErrors, ...activate.fieldErrors };
  const formError = (!Object.keys(save.fieldErrors).length && save.formError) || (!Object.keys(activate.fieldErrors).length && activate.formError);
  const editable = data.canEdit.allowed;
  const blocked = data.canEdit.allowed ? null : data.canEdit.reason;

  return (
    <Page title={data.code}>
      <PageHeader eyebrow="07 Agent assurance" title="Turn a finding into a safeguard." subtitle={`${data.code} · ${data.name}`} status={active ? 'Active / Gating' : data.source ? 'Confirmed finding / Ready to activate' : 'Draft'} />
      {data.source ? (
        <Alert>
          {data.source.code} · {data.source.finding} · {data.source.severityShort}
        </Alert>
      ) : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Current state">{active ? 'Active / Gating' : 'Draft'}</RailItem>
              {active ? (
                <RailItem term="Activated">{formatDateTime(data.activatedAt)}</RailItem>
              ) : (
                <RailItem term="After activation">Active / Gating</RailItem>
              )}
              <RailItem term="Target">{data.target ?? 'No release gate'}</RailItem>
              <RailItem term="Release gate">{data.gateCode ?? 'None'}</RailItem>
              <RailItem term="Owner">{data.ownerName}</RailItem>
              <RailNote>Changes to a regression create a new rule version. The original finding, failed trace and frozen task remain unchanged.</RailNote>
              {blocked ? <RailUnavailable action="Activate regression" reason={blocked} /> : null}
            </ContextRail>
          }
        >
          <Section title={`Regression contract / ${data.code}`} kind="form">
            <FieldInput label="Regression name" value={name} onChange={setName} required maxLength={120} disabled={!editable} error={errors.name} />
            <FieldStatic label="Pinned evaluation">{data.pinnedEvaluation}</FieldStatic>
            <div className="as-grow">
              <FieldTextarea label="Pass condition" value={passCondition} onChange={setPassCondition} required rows={2} maxLength={2000} disabled={!editable} error={errors.passCondition} />
            </div>
            <FieldSelect label="Policy" value={policy} onChange={(value) => setPolicy(value as RegressionPolicy)} options={data.policyChoices} disabled={!editable} error={errors.policy} />
          </Section>
          <Section title="Activation scope">
            <Checkbox checked={scopeAck} onChange={setScopeAck} disabled={!editable || active} error={errors.scopeAck}>
              {data.scope} Activation records the rule, source task, expert finding and creator.
            </Checkbox>
          </Section>
          <Section title="Rule versions">
            <Pairs
              items={data.versions.map((version) => ({
                key: String(version.version),
                term: `v${version.version}${version.isCurrent ? ' / Current' : ''} / ${version.name}`,
                detail: `${version.policyLabel} · ${version.createdByName} · ${formatDateTime(version.createdAt)}`,
              }))}
            />
            {data.source ? (
              <p>
                Source finding by {data.source.reviewerName} on{' '}
                <Link className="text-link" to={`/assurance/traces/${data.source.traceCode}`}>
                  {data.source.traceCode}
                </Link>
                .
              </p>
            ) : null}
          </Section>
        </Workspace>
        <Actions>
          {blocked ? (
            <>
              <DisabledAction reason={blocked}>{active ? 'Save rule version' : 'Activate regression'}</DisabledAction>
              {active ? null : <DisabledAction reason={blocked}>Save draft</DisabledAction>}
            </>
          ) : active ? (
            <Button type="submit" variant="primary" busy={save.isPending} busyLabel="Saving a new rule version">
              Save rule version
            </Button>
          ) : (
            <>
              <Button type="submit" variant="primary" busy={activate.isPending} busyLabel="Activating regression">
                Activate regression
              </Button>
              <Button busy={save.isPending} busyLabel="Saving draft" onClick={() => save.mutate()}>
                Save draft
              </Button>
            </>
          )}
        </Actions>
        {active && !blocked ? (
          <ActionsBelow>
            <DisabledAction reason={`${data.code} is already active`}>Activate regression</DisabledAction>
          </ActionsBelow>
        ) : null}
      </form>
    </Page>
  );
}

export default function RegressionPage() {
  const { code = '' } = useParams();
  const query = useApiQuery<RegressionDetail>(`/api/assurance/regressions/${encodeURIComponent(code)}`);
  return <QueryBoundary query={query}>{(data) => <RegressionContent key={data.code} data={data} />}</QueryBoundary>;
}
