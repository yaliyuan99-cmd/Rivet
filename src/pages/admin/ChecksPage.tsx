import type { ChecksResponse } from '../../../shared/types/admin.ts';
import { Actions, AdminTabs, Alert, AnchorButton, Button, ContextRail, EmptyState, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime, formatTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useDemo, useUser } from '../../lib/session.tsx';
import { AdminLocked } from './AdminLocked.tsx';
import './admin.css';

const PATH = '/api/admin/checks';

function ChecksContent({ data }: { data: ChecksResponse }) {
  const toast = useToast();
  const demo = useDemo();
  const { latest } = data;
  const run = useApiMutation(() => api.post<ChecksResponse>(`${PATH}/run`), {
    invalidate: [PATH, '/api/admin/summary'],
    onSuccess: (result) => {
      if (result.latest?.tone === 'danger') toast.error('System checks finished', result.latest.message);
      else if (result.latest?.tone === 'warning') toast.warning('System checks finished', result.latest.message);
      else toast.success('System checks finished', result.latest?.message);
    },
  });
  const operator = latest?.operator ?? data.operator;
  return (
    <Page title="System checks">
      <PageHeader
        eyebrow="11 Administration"
        title="Trust is an operational practice."
        subtitle={latest ? `Administration · System checks · ${formatDateTime(latest.finishedAt)}` : 'Administration · System checks'}
        status={latest ? `Admin / System checks / ${formatTime(latest.finishedAt)}` : 'Admin / System checks / Not run yet'}
        statusTone={latest?.tone ?? 'accent'}
      />
      <AdminTabs />
      {latest ? (
        <Alert tone={latest.tone} live>
          {latest.message}
        </Alert>
      ) : (
        <Alert tone="neutral">No system checks have run on this instance yet.</Alert>
      )}
      {run.formError ? <Alert tone="danger">{run.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Integrity failures">Block runs</RailItem>
            <RailItem term="Permission failures">Deny access</RailItem>
            <RailItem term="Timeout warnings">Safe checkpoint and retry</RailItem>
            <RailItem term="Operator">
              {operator.name} / {operator.role}
            </RailItem>
            <RailNote>
              {demo
                ? 'Check receipts are computed for real over the synthetic fixtures on this instance. They do not describe a live production service.'
                : 'Check receipts are computed for real over the data on this instance.'}
            </RailNote>
          </ContextRail>
        }
      >
        <Section title="System check receipts">
          {latest ? (
            <Pairs
              items={latest.receipts.map((receipt) => ({
                key: receipt.code,
                term: `${receipt.code} / ${receipt.label}`,
                detail: (
                  <>
                    <span className={receipt.status === 'failed' ? 'text-danger' : undefined}>{receipt.detail}</span>
                    {receipt.failures.length ? (
                      <ul className="admin-failures">
                        {receipt.failures.slice(0, 8).map((failure) => (
                          <li key={failure.subject}>
                            {failure.subject}: {failure.reason}
                          </li>
                        ))}
                        {receipt.failures.length > 8 ? <li>And {receipt.failures.length - 8} more in the check log.</li> : null}
                      </ul>
                    ) : null}
                  </>
                ),
              }))}
            />
          ) : (
            <EmptyState>Run the system checks to produce the first receipts.</EmptyState>
          )}
        </Section>
        <Section title="Operational events">
          {data.events.length ? (
            <Pairs
              items={data.events.map((event) => ({
                key: event.id,
                term: `${event.subject} / ${formatTime(event.at)}`,
                detail: event.message,
              }))}
            />
          ) : (
            <EmptyState>No operational events yet.</EmptyState>
          )}
        </Section>
      </Workspace>
      <Actions>
        <Button variant="primary" busy={run.isPending} busyLabel="Running the system checks" onClick={() => run.mutate()}>
          Run system checks
        </Button>
        <AnchorButton href={`${PATH}/export`} download>
          Export check log
        </AnchorButton>
      </Actions>
    </Page>
  );
}

function ChecksLoader() {
  const query = useApiQuery<ChecksResponse>(PATH);
  return <QueryBoundary query={query}>{(data) => <ChecksContent data={data} />}</QueryBoundary>;
}

export default function ChecksPage() {
  const user = useUser();
  return user.role === 'admin' ? <ChecksLoader /> : <AdminLocked />;
}
