import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Actions, Alert, AnchorButton, Button, ContextRail, DisabledAction, FieldInput, Page, PageHeader, Pairs, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation } from '../../lib/query.ts';
import { safeNext, useSession } from '../../lib/session.tsx';

const DEMO_ACCOUNTS = [
  { email: 'maya@helixlab.example', label: 'Maya Chen', role: 'Member · Workspace owner' },
  { email: 'samira@northbridge.example', label: 'Dr. Samira Patel', role: 'Member · Verified Biology' },
  { email: 'alex@rivet.example', label: 'Alex Rivera', role: 'Admin' },
];
const DEMO_PASSWORD = 'rivet-demo-2026';

export default function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: session } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const next = safeNext(params.get('next'));
  const reset = params.get('reset') === '1';

  const signIn = useApiMutation(() => api.post<{ emailVerified: boolean }>('/api/auth/signin', { email, password }), {
    invalidate: [['session']],
    onSuccess: (result) => navigate(result.emailVerified ? next : '/verify', { replace: true }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate();
  };

  return (
    <Page title="Sign in">
      <PageHeader eyebrow="01 Access" title="Welcome back." subtitle="Real tasks. Real evaluation. Better AI." status="Member access" />
      {reset ? <Alert>Your password has been changed. Sign in with the new one.</Alert> : null}
      {signIn.formError ? <Alert tone="danger">{signIn.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailNote>Visitors can sign up or sign in only. Tasks, datasets and reports require a verified account.</RailNote>
              {session?.demo ? (
                <RailItem term="Demo accounts">
                  Choose an account below to fill this form. These accounts exist only on this synthetic demo instance.
                </RailItem>
              ) : null}
            </ContextRail>
          }
        >
          <Section title="Sign in to Rivet" kind="form">
            <FieldInput label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" required error={signIn.fieldErrors.email} />
            <FieldInput label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required error={signIn.fieldErrors.password} />
          </Section>
          <Section title="Need help?">
            <Pairs
              items={[
                {
                  term: 'New to Rivet?',
                  detail: (
                    <Link className="text-link" to="/signup">
                      Create an account →
                    </Link>
                  ),
                },
                {
                  term: 'Forgotten your password?',
                  detail: (
                    <Link className="text-link" to="/forgot">
                      Reset it by email →
                    </Link>
                  ),
                },
              ]}
            />
          </Section>
          {session?.demo ? (
            <Section title="Synthetic demo accounts">
              <Pairs
                items={DEMO_ACCOUNTS.map((account) => ({
                  key: account.email,
                  term: account.label,
                  detail: (
                    <>
                      {account.role} ·{' '}
                      <button
                        type="button"
                        className="text-link"
                        style={{ background: 'none', border: 0, padding: 0 }}
                        onClick={() => {
                          setEmail(account.email);
                          setPassword(DEMO_PASSWORD);
                        }}
                      >
                        Use this account
                      </button>
                    </>
                  ),
                }))}
              />
            </Section>
          ) : null}
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={signIn.isPending} busyLabel="Signing in">
            Sign in
          </Button>
          {session?.features.github ? (
            <AnchorButton href="/api/auth/github/start">Continue with GitHub</AnchorButton>
          ) : (
            <DisabledAction reason="GitHub sign-in is not configured on this server">Continue with GitHub</DisabledAction>
          )}
        </Actions>
      </form>
    </Page>
  );
}
