import { Link, Navigate, useNavigate } from 'react-router-dom';
import type { ReviewQueueItem, ReviewsResponse } from '../../../shared/types/expert.ts';
import { Actions, Alert, Badge, Button, ContextRail, EmptyState, LinkButton, Page, PageHeader, QueryBoundary, RailItem, RailNote, Row, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { EYEBROW, REVIEW_STATUS, lockedNote, reportPath } from './shared.tsx';
import './expert.css';

const taskLine = (item: ReviewQueueItem) => `${item.taskLabel} · ${item.title}`;

function QueueContent({ data }: { data: ReviewsResponse }) {
  const toast = useToast();
  const navigate = useNavigate();
  const claim = useApiMutation((code: string) => api.post(`/api/reviews/${code}/claim`), {
    invalidate: ['/api/reviews'],
    onSuccess: (_, code) => {
      toast.success(`${code} claimed`, 'It is assigned to you. Your draft stays private until you submit.');
      navigate(`/review/${code}`);
    },
  });
  const domains = data.credentials.map((credential) => credential.domainName).join(', ');
  const count = data.requested.length;

  return (
    <Page title="Review queue">
      <PageHeader
        eyebrow={EYEBROW}
        title="Evidence waiting for an expert."
        subtitle="Requested reviews in your verified domains. Your own tasks never appear here."
        status={`${domains} verified / ${count} requested`}
      />
      {claim.formError ? <Alert tone="danger">{claim.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Verified domains">{domains}</RailItem>
            <RailItem term="Review scope">Verified domains only</RailItem>
            <RailItem term="Final decisions">Admin adjudication</RailItem>
            <RailNote>Expert access is domain-specific. A workspace role never grants review credentials.</RailNote>
            {lockedNote(data.lockedDomains) ? <RailNote>{lockedNote(data.lockedDomains)}</RailNote> : null}
            {data.openApplication ? (
              <RailItem term="Your application">
                <Link className="quiet-link" to={`/review/application?code=${data.openApplication.code}`}>
                  {data.openApplication.code} · {data.openApplication.domainName} →
                </Link>
              </RailItem>
            ) : null}
          </ContextRail>
        }
      >
        <div className="queue-rows">
          <Section title="Requested reviews" kind="table">
            {count === 0 ? (
              <div style={{ paddingTop: 18 }}>
                <EmptyState>No reviews are waiting in your verified domains.</EmptyState>
              </div>
            ) : (
              data.requested.map((item) => (
                <Row
                  key={item.code}
                  label={
                    <Link className="row-link" to={`/review/${item.code}`}>
                      {taskLine(item)}
                    </Link>
                  }
                  value={`${item.code} · ${item.domainName} · Owner ${item.ownerName} · Requested ${formatDateTime(item.createdAt)}`}
                  extra={
                    <Button variant="primary" busy={claim.isPending && claim.variables === item.code} busyLabel={`Claiming ${item.code}`} disabled={claim.isPending} onClick={() => claim.mutate(item.code)} aria-label={`Claim ${item.code}`}>
                      Claim
                    </Button>
                  }
                />
              ))
            )}
          </Section>
        </div>
        <div className="queue-rows">
          <Section title="Your drafts" kind="table">
            {data.drafts.length === 0 ? (
              <div style={{ paddingTop: 18 }}>
                <EmptyState>You have no reviews in progress.</EmptyState>
              </div>
            ) : (
              data.drafts.map((item) => (
                <Row
                  key={item.code}
                  label={
                    <Link className="row-link" to={`/review/${item.code}`}>
                      {taskLine(item)}
                    </Link>
                  }
                  value={item.status === 'returned' ? `${item.code} · Returned by an admin` : `${item.code} · ${item.draftSavedAt ? `Saved ${formatDateTime(item.draftSavedAt)}` : 'Not saved yet'}`}
                  extra={<Badge tone={REVIEW_STATUS[item.status].tone}>{REVIEW_STATUS[item.status].label}</Badge>}
                />
              ))
            )}
          </Section>
        </div>
        <div className="queue-rows">
          <Section title="Submitted reviews" kind="table">
            {data.submitted.length === 0 ? (
              <div style={{ paddingTop: 18 }}>
                <EmptyState>You have not submitted a review yet.</EmptyState>
              </div>
            ) : (
              data.submitted.map((item) => (
                <Row
                  key={item.code}
                  label={
                    <Link className="row-link" to={`/review/${item.code}`}>
                      {taskLine(item)}
                    </Link>
                  }
                  value={
                    item.report ? (
                      <>
                        {item.code} · Frozen as{' '}
                        <Link className="text-link" to={reportPath(item.report)}>
                          {item.report.code} v{item.report.version}
                        </Link>
                      </>
                    ) : (
                      `${item.code} · Submitted ${formatDateTime(item.submittedAt)}`
                    )
                  }
                  extra={<Badge tone={REVIEW_STATUS[item.status].tone}>{REVIEW_STATUS[item.status].label}</Badge>}
                />
              ))
            )}
          </Section>
        </div>
      </Workspace>
      <Actions>
        <LinkButton to="/review/apply">Apply for another domain</LinkButton>
      </Actions>
    </Page>
  );
}

export default function ReviewQueuePage() {
  const query = useApiQuery<ReviewsResponse>('/api/reviews', { refetchInterval: 20_000 });
  return (
    <QueryBoundary query={query}>
      {(data) => {
        if (data.state === 'apply') return <Navigate to="/review/apply" replace />;
        if (data.state === 'application') return <Navigate to="/review/application" replace />;
        return <QueueContent data={data} />;
      }}
    </QueryBoundary>
  );
}
