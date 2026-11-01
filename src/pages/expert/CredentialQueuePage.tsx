import { Link } from 'react-router-dom';
import type { CredentialQueueItem, CredentialQueueResponse } from '../../../shared/types/expert.ts';
import { AdminTabs, Badge, ContextRail, EmptyState, Page, PageHeader, QueryBoundary, RailItem, RailNote, Row, Section, Workspace } from '../../components/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useDemo, useUser } from '../../lib/session.tsx';
import { APPLICATION_STATUS, EYEBROW } from './shared.tsx';
import './expert.css';

function QueueRow({ item }: { item: CredentialQueueItem }) {
  const status = APPLICATION_STATUS[item.status];
  const when = item.decidedAt ? `Decided ${formatDateTime(item.decidedAt)}` : `Submitted ${formatDateTime(item.submittedAt)}`;
  return (
    <Row
      label={
        <Link className="row-link" to={`/admin/credentials/${item.code}`}>
          {item.code} · {item.applicantName}
        </Link>
      }
      value={`${item.domainName} · ${when}`}
      extra={<Badge tone={status.tone}>{status.label}</Badge>}
    />
  );
}

function QueueContent({ data }: { data: CredentialQueueResponse }) {
  const user = useUser();
  const demo = useDemo();
  return (
    <Page title="Credential queue">
      <PageHeader eyebrow={EYEBROW} title="Domain credentials, verified by a person." subtitle="Inspect the evidence, then record a domain-specific decision." status={`Admin / ${data.awaiting.length} awaiting a decision`} />
      <AdminTabs />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Admin">{user.name}</RailItem>
            <RailItem term="Awaiting a decision">{data.awaiting.length}</RailItem>
            <RailItem term="Decided">{data.decided.length}</RailItem>
            <RailNote>{demo ? 'Credential documents and affiliations are synthetic. ' : ''}Every decision is retained in the credential audit log.</RailNote>
          </ContextRail>
        }
      >
        <div className="queue-rows">
          <Section title="Awaiting a decision" kind="table">
            {data.awaiting.length ? (
              data.awaiting.map((item) => <QueueRow key={item.code} item={item} />)
            ) : (
              <div style={{ paddingTop: 18 }}>
                <EmptyState>No applications are waiting for a decision.</EmptyState>
              </div>
            )}
          </Section>
        </div>
        <div className="queue-rows">
          <Section title="Decided" kind="table">
            {data.decided.length ? (
              data.decided.map((item) => <QueueRow key={item.code} item={item} />)
            ) : (
              <div style={{ paddingTop: 18 }}>
                <EmptyState>No decisions recorded yet.</EmptyState>
              </div>
            )}
          </Section>
        </div>
      </Workspace>
    </Page>
  );
}

export default function CredentialQueuePage() {
  const query = useApiQuery<CredentialQueueResponse>('/api/admin/credentials');
  return <QueryBoundary query={query}>{(data) => <QueueContent data={data} />}</QueryBoundary>;
}
