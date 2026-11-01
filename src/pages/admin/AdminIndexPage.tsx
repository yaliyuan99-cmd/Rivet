import { Link } from 'react-router-dom';
import type { AdminSummary } from '../../../shared/types/admin.ts';
import { Actions, AdminTabs, Alert, ContextRail, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useUser } from '../../lib/session.tsx';
import { AdminLocked } from './AdminLocked.tsx';

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

function SummaryContent({ data }: { data: AdminSummary }) {
  const check = data.latestCheck;
  return (
    <Page title="Administration">
      <PageHeader eyebrow="11 Administration" title="Administration" subtitle="Administration · Queues, model metadata and system checks" status={`Admin / ${data.operator.name} / Audited`} statusTone={check?.tone ?? 'accent'} />
      <AdminTabs />
      {check ? <Alert tone={check.tone}>{check.message}</Alert> : <Alert tone="neutral">No system checks have run on this instance yet.</Alert>}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Operator">
              {data.operator.name} / {data.operator.role}
            </RailItem>
            <RailItem term="Every action">Audited</RailItem>
            <RailNote>Queue counts are read from the database on each visit. A workspace role never grants any of this.</RailNote>
          </ContextRail>
        }
      >
        <Section title="What needs a decision">
          <Pairs
            items={[
              {
                term: (
                  <Link className="quiet-link" to="/admin/credentials">
                    Credential queue →
                  </Link>
                ),
                detail: `${count(data.pendingCredentials, 'application', 'applications')} waiting for a decision`,
              },
              {
                term: (
                  <Link className="quiet-link" to="/admin/adjudications">
                    Adjudication queue →
                  </Link>
                ),
                detail: `${count(data.pendingAdjudications, 'submitted review', 'submitted reviews')} waiting for a decision`,
              },
            ]}
          />
        </Section>
        <Section title="Keep the record honest">
          <Pairs
            items={[
              {
                term: (
                  <Link className="quiet-link" to="/admin/models">
                    Model metadata →
                  </Link>
                ),
                detail: `${data.models.enabled} of ${count(data.models.total, 'model', 'models')} available for new evaluations`,
              },
              {
                term: (
                  <Link className="quiet-link" to="/admin/checks">
                    System checks →
                  </Link>
                ),
                detail: check ? `Last run ${formatDateTime(check.finishedAt)} · ${check.passed} passed, ${count(check.warnings, 'warning', 'warnings')}, ${check.failed} failed` : 'Not run yet',
              },
            ]}
          />
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/admin/checks">
          Open system checks
        </LinkButton>
        <LinkButton to="/admin/models">Open model metadata</LinkButton>
      </Actions>
    </Page>
  );
}

function AdminIndexContent() {
  const query = useApiQuery<AdminSummary>('/api/admin/summary');
  return <QueryBoundary query={query}>{(data) => <SummaryContent data={data} />}</QueryBoundary>;
}

export default function AdminIndexPage() {
  const user = useUser();
  return user.role === 'admin' ? <AdminIndexContent /> : <AdminLocked />;
}
