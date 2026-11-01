import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Actions, Alert, Button, ContextRail, FieldInput, LinkButton, Page, PageHeader, RailNote, Section, Workspace } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation } from '../../lib/query.ts';
import { passwordStrength } from './passwordStrength.ts';

export default function ResetPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const token = params.get('token') ?? '';
  const reset = useApiMutation(() => api.post('/api/auth/reset', { token, password }), {
    invalidate: [['session']],
    onSuccess: () => navigate('/signin?reset=1', { replace: true }),
  });
  const linkFailed = Boolean(reset.formError && !reset.fieldErrors.password);

  return (
    <Page title="Choose a new password">
      <PageHeader eyebrow="01 Access" title="Choose a new password" subtitle="This signs you out on every device." status="Password reset" />
      {!token ? <Alert tone="warning">This page needs the one-time link from your email.</Alert> : null}
      {linkFailed ? <Alert tone="warning">{reset.formError}</Alert> : null}
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          reset.mutate();
        }}
        noValidate
        style={{ display: 'contents' }}
      >
        <Workspace
          rail={
            <ContextRail>
              <RailNote>Rivet stores only a salted hash of your password.</RailNote>
            </ContextRail>
          }
        >
          <Section title="New password" kind="form">
            <FieldInput
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
              disabled={!token}
              error={reset.fieldErrors.password}
              hint={password ? `Strength: ${passwordStrength(password)}. Use at least 10 characters.` : 'Use at least 10 characters.'}
            />
          </Section>
        </Workspace>
        <Actions>
          {linkFailed || !token ? (
            <LinkButton variant="primary" to="/forgot">
              Request a fresh link
            </LinkButton>
          ) : (
            <Button type="submit" variant="primary" busy={reset.isPending} busyLabel="Saving your new password">
              Save new password
            </Button>
          )}
        </Actions>
      </form>
    </Page>
  );
}
