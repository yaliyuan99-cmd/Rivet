import { Link } from 'react-router-dom';
import type { AdjudicationQueueItem, AdjudicationQueueResponse } from '../../../shared/types/expert.ts';
import { AdminTabs, Badge, ContextRail, EmptyState, Page, PageHeader, QueryBoundary, RailItem, RailNote, Row, Section, Workspace } from '../../components/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useUser } from '../../lib/session.tsx';
import { EYEBROW, REVIEW_STATUS } from './shared.tsx';
import './expert.css';

function QueueRow({ item }: { item: AdjudicationQueueItem }) {
  const status = REVIEW_STATUS[item.status];
  const expert = item.expertName ?? 'No expert yet';
  const when = item.decidedAt ? `Decided ${formatDateTime(item.decidedAt)}` : item.submittedAt ? `Submitted ${formatDateTime(item.submittedAt)}` : 'Not submitted';
  return (
    <Row
      label={
        <Link className="row-link" to={`/admin/adjudications/${item.reviewCode}`}>
          {item.reviewCode} · {item.taskLabel} · {item.title}
        </Link>
      }
      value={`${item.domainName} · ${expert} · ${when}`}
      extra={<Badge tone={status.tone}>{status.label}</Badge>}
    />
  );
}

function Group({ title, items, empty }: { title: string; items: AdjudicationQueueItem[]; empty: string }) {
  return (
    <div className="queue-rows">
      <Section title={title} kind="table">
        {items.length ? (
          items.map((item) => <QueueRow key={item.reviewCode} item={item} />)
        ) : (
          <div style={{ paddingTop: 18 }}>
            <EmptyState>{empty}</EmptyState>
          </div>
        )}
      </Section>
    </div>
  );
}

function QueueContent({ data }: { data: AdjudicationQueueResponse }) {
  const user = useUser();
  return (
    <Page title="Adjudication queue">
      <PageHeader eyebrow={EYEBROW} title="Final determinations, on the record." subtitle="Submitted expert reviews waiting for an admin decision." status={`Admin / ${data.awaiting.length} awaiting a decision`} />
      <AdminTabs />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Administrator">{user.name}</RailItem>
            <RailItem term="Awaiting a decision">{data.awaiting.length}</RailItem>
            <RailItem term="Finalized">{data.finalized.length}</RailItem>
            <RailNote>Finalization never overwrites earlier scores or rationale. The source evidence and independent findings remain inspectable.</RailNote>
          </ContextRail>
        }
      >
        <Group title="Awaiting a decision" items={data.awaiting} empty="No submitted reviews are waiting for a decision." />
        <Group title="Returned to the expert" items={data.returned} empty="No reviews are back with their expert." />
        <Group title="With experts" items={data.inProgress} empty="No reviews are being written or waiting for an expert." />
        <Group title="Finalized" items={data.finalized} empty="No reviews have been finalized yet." />
      </Workspace>
    </Page>
  );
}

export default function AdjudicationQueuePage() {
  const query = useApiQuery<AdjudicationQueueResponse>('/api/admin/adjudications');
  return <QueryBoundary query={query}>{(data) => <QueueContent data={data} />}</QueryBoundary>;
}
