import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Actions, AnchorButton, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldInput, Page, PageHeader, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { passwordStrength } from './passwordStrength.ts';

export default function SignUpPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);

  const signUp = useApiMutation(() => api.post('/api/auth/signup', { name, email, password, acceptTerms }), {
    invalidate: [['session']],
    onSuccess: () => navigate('/verify'),
  });
  const strength = password ? passwordStrength(password) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    signUp.mutate();
  };

  return (
    <Page title="Create your account">
      <PageHeader eyebrow="01 Access" title="Make evidence your advantage." subtitle="Real tasks. Real evaluation. Better AI." status="Member access" />
      {signUp.formError ? <Alert tone="danger">{signUp.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="01 / Define">Freeze the prompt and rubric before measuring.</RailItem>
              <RailItem term="02 / Trace">Inspect every output, source and hash.</RailItem>
              <RailItem term="03 / Review">Separate model claims from expert findings.</RailItem>
              <RailNote>Visitors can sign up or sign in only. Tasks, datasets and reports require a verified account.</RailNote>
              <RailNote>Real tasks. Real evaluation. Better AI.</RailNote>
            </ContextRail>
          }
        >
          <Section title="Create your account" kind="form">
            <FieldInput label="Full name" value={name} onChange={setName} autoComplete="name" required error={signUp.fieldErrors.name} />
            <FieldInput label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" required error={signUp.fieldErrors.email} />
            <FieldInput
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
              error={signUp.fieldErrors.password}
              suffix={strength ? `· ${strength}` : undefined}
              hint={password && password.length < 10 ? 'Use at least 10 characters.' : undefined}
            />
          </Section>
          <Section title="Your research, your responsibility">
            <div>
              <Checkbox checked={acceptTerms} onChange={setAcceptTerms} error={signUp.fieldErrors.acceptTerms}>
                I agree to the{' '}
                <Link className="text-link" to="/legal/terms">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link className="text-link" to="/legal/privacy">
                  Privacy Policy
                </Link>
                .
              </Checkbox>
              <p>
                Already have an account?{' '}
                <Link className="text-link" to="/signin">
                  Sign in →
                </Link>
              </p>
            </div>
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={signUp.isPending} busyLabel="Creating your account">
            Create account
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
