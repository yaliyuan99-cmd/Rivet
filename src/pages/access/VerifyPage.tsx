import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { Actions, ActionsBelow, Alert, AnchorButton, Button, ContextRail, DisabledAction, FieldInput, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime, formatDuration } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';

interface Verification {
  email: string;
  verified: boolean;
  requestedAt: string | null;
  expiresAt: string | null;
  resendAvailableAt: string;
  serverNow: string;
}

/** Counts down using the server's clock, so a wrong device clock cannot unlock the button early. */
function useCooldown(data: Verification) {
  const [offset] = useState(() => new Date(data.serverNow).getTime() - Date.now());
  const remaining = () => Math.max(0, new Date(data.resendAvailableAt).getTime() - (Date.now() + offset));
  const [left, setLeft] = useState(remaining);
  useEffect(() => {
    setLeft(remaining());
    const timer = window.setInterval(() => setLeft(remaining()), 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.resendAvailableAt]);
  return left;
}

function VerifyContent({ data }: { data: Verification }) {
  const { data: session } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const left = useCooldown(data);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const emailDelivered = session?.features.email ?? false;
  const cooldown = formatDuration(left);

  const resend = useApiMutation(() => api.post('/api/auth/resend'), {
    invalidate: ['/api/auth/verification'],
    onSuccess: () => toast.success('Fresh link sent', `The previous link no longer works. Check ${data.email}.`),
  });
  const changeEmail = useApiMutation(() => api.post('/api/auth/change-email', { email: newEmail }), {
    onSuccess: async () => {
      setChanging(false);
      setNewEmail('');
      await client.invalidateQueries();
      toast.success('Email updated', 'A fresh link is on its way to the new address.');
    },
  });

  return (
    <Page title="Check your inbox">
      <PageHeader eyebrow="01 Access" title="Check your inbox" subtitle="One last step before your first evaluation." status="Verification pending" />
      <Alert live>
        {emailDelivered
          ? `A one-time link was sent to ${data.email}. It expires in 30 minutes.`
          : `No email provider is configured, so the one-time link for ${data.email} is waiting in the dev outbox. It expires in 30 minutes.`}
      </Alert>
      {resend.formError ? <Alert tone="danger">{resend.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Delivery">Check inbox and spam.</RailItem>
            <RailItem term="Safety">Rivet never asks for a password by email.</RailItem>
            <RailItem term="Wrong address?">Change email and request a fresh link.</RailItem>
            <RailNote>No research data is visible to unverified visitors.</RailNote>
            {left > 0 ? <RailUnavailable action="Resend link" reason={`Available in ${cooldown}`} /> : null}
          </ContextRail>
        }
      >
        <Section title="Check your email to continue">
          <p>Open the verification link on this device. Your workspace, task creation and data library remain locked until verification is complete.</p>
        </Section>
        <Section title="Waiting for verification">
          <Pairs
            items={[
              { term: 'Email address', detail: data.email },
              { term: 'Link requested', detail: formatDateTime(data.requestedAt) },
              { term: 'Resend cooldown', detail: left > 0 ? `${cooldown} remaining` : 'Ready' },
            ]}
          />
        </Section>
      </Workspace>
      <Actions>
        {emailDelivered ? (
          <AnchorButton variant="primary" href={`mailto:${data.email}`}>
            Open email app
          </AnchorButton>
        ) : (
          <LinkButton variant="primary" to="/dev/outbox">
            Open dev outbox
          </LinkButton>
        )}
        <Button onClick={() => setChanging(true)}>Change email</Button>
      </Actions>
      <ActionsBelow>
        {left > 0 ? (
          <DisabledAction reason={`Available in ${cooldown}`}>Resend link</DisabledAction>
        ) : (
          <Button busy={resend.isPending} busyLabel="Sending a fresh link" onClick={() => resend.mutate()}>
            Resend link
          </Button>
        )}
      </ActionsBelow>
      <Modal open={changing} onClose={() => setChanging(false)} title="Change your email">
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            changeEmail.mutate();
          }}
          noValidate
        >
          <p style={{ marginBottom: 16 }}>Rivet will send a fresh link to the new address. The old link stops working.</p>
          <FieldInput label="Work email" type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" required error={changeEmail.fieldErrors.email} />
          {changeEmail.formError && !changeEmail.fieldErrors.email ? <p className="field-message" data-tone="danger">{changeEmail.formError}</p> : null}
          <div className="modal-actions">
            <Button type="submit" variant="primary" busy={changeEmail.isPending} busyLabel="Updating your email">
              Send fresh link
            </Button>
            <Button onClick={() => setChanging(false)}>Cancel</Button>
          </div>
        </form>
      </Modal>
      <p>
        <Link className="text-link" to="/signin">
          Use a different account
        </Link>
      </p>
    </Page>
  );
}

export default function VerifyPage() {
  const { data: session, isPending } = useSession();
  const query = useApiQuery<Verification>('/api/auth/verification', {
    enabled: Boolean(session?.user),
    // Verification usually happens in another tab; notice it without a reload.
    refetchInterval: 5000,
  });
  const client = useQueryClient();

  useEffect(() => {
    if (query.data?.verified && !session?.user?.emailVerified) void client.invalidateQueries({ queryKey: ['session'] });
  }, [client, query.data?.verified, session?.user?.emailVerified]);

  if (isPending) return <Page title="Check your inbox">{null}</Page>;
  if (!session?.user) return <Navigate to="/signin" replace />;
  if (session.user.emailVerified) return <Navigate to="/" replace />;
  return <QueryBoundary query={query}>{(data) => <VerifyContent data={data} />}</QueryBoundary>;
}
