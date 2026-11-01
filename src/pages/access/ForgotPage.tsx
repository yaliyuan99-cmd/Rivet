import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Actions, Alert, Button, ContextRail, FieldInput, LinkButton, Page, PageHeader, RailNote, Section, Workspace } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';

export default function ForgotPage() {
  const { data: session } = useSession();
  const [email, setEmail] = useState('');
  const forgot = useApiMutation(() => api.post('/api/auth/forgot', { email }));

  return (
    <Page title="Reset your password">
      <PageHeader eyebrow="01 Access" title="Reset your password" subtitle="Rivet will email you a one-time link." status="Password reset" />
      {forgot.isSuccess ? (
        <Alert live>
          {session?.features.email
            ? `If ${email} has an account, a reset link is on its way. It expires in 30 minutes.`
            : `If ${email} has an account, a reset link is waiting in the dev outbox. It expires in 30 minutes.`}
        </Alert>
      ) : null}
      {forgot.formError && !forgot.fieldErrors.email ? <Alert tone="danger">{forgot.formError}</Alert> : null}
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          forgot.mutate();
        }}
        noValidate
        style={{ display: 'contents' }}
      >
        <Workspace
          rail={
            <ContextRail>
              <RailNote>Rivet never asks for a password by email. The link only lets you choose a new one.</RailNote>
            </ContextRail>
          }
        >
          <Section title="Which account?" kind="form">
            <FieldInput label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" required error={forgot.fieldErrors.email} />
          </Section>
          <p>
            <Link className="text-link" to="/signin">
              Back to sign in
            </Link>
          </p>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={forgot.isPending} busyLabel="Sending the reset link">
            Send reset link
          </Button>
          {forgot.isSuccess && !session?.features.email ? <LinkButton to="/dev/outbox">Open dev outbox</LinkButton> : null}
        </Actions>
      </form>
    </Page>
  );
}
