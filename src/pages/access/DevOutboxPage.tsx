import { Alert, EmptyState, Page, PageHeader, QueryBoundary, Section } from '../../components/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';

interface OutboxMessage {
  id: string;
  to: string;
  subject: string;
  body: string;
  link: string | null;
  purpose: string;
  createdAt: string;
}

/** Stands in for an email provider on local instances. The API refuses this in production. */
export default function DevOutboxPage() {
  const query = useApiQuery<{ messages: OutboxMessage[] }>('/api/dev/outbox', { refetchInterval: 3000 });
  return (
    <QueryBoundary query={query}>
      {({ messages }) => (
        <Page title="Dev outbox">
          <PageHeader eyebrow="Local development" title="Dev outbox" subtitle="Messages Rivet would have emailed. Set RESEND_API_KEY to send real email." status={`${messages.length} messages`} />
          <Alert tone="warning">Only local instances serve this page. Anyone who can open it can use these links.</Alert>
          {messages.length === 0 ? <EmptyState>No messages yet. Sign up or request a password reset to create one.</EmptyState> : null}
          {messages.map((message) => (
            <Section key={message.id} title={message.subject}>
              <p>
                To {message.to} · {formatDateTime(message.createdAt)}
              </p>
              <p className="prewrap">{message.body}</p>
              {message.link ? (
                <p>
                  <a className="text-link" href={message.link}>
                    Open this link
                  </a>
                </p>
              ) : null}
            </Section>
          ))}
        </Page>
      )}
    </QueryBoundary>
  );
}
