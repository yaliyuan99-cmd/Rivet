import { useSearchParams } from 'react-router-dom';
import { Actions, Alert, AnchorButton, ContextRail, DisabledAction, LinkButton, Page, PageHeader, RailNote, Section, Workspace } from '../../components/index.ts';
import { useSession } from '../../lib/session.tsx';

const REASONS: Record<string, string> = {
  state: 'This sign-in attempt expired or was started in another browser. Start again from this browser.',
  denied: 'GitHub did not grant access, so you were not signed in.',
  email: 'Your GitHub account has no verified primary email address. Verify one on GitHub, then try again.',
  unavailable: 'GitHub could not be reached, or it refused the sign-in. Nothing was changed. Try again in a moment.',
  not_configured: 'GitHub sign-in is not configured on this server.',
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
};

/** Where every failed GitHub sign-in lands. Nobody is signed in by reaching this page. */
export default function GitHubFailedPage() {
  const [params] = useSearchParams();
  const { data: session } = useSession();
  const reason = REASONS[params.get('reason') ?? ''] ?? REASONS.unavailable;
  return (
    <Page title="GitHub sign-in did not complete">
      <PageHeader eyebrow="01 Access" title="GitHub sign-in did not complete." subtitle="You have not been signed in." status="Not signed in" statusTone="warning" />
      <Alert tone="warning">{reason}</Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailNote>Rivet only accepts the verified primary email address on your GitHub account. It keeps your public identity and discards the access token.</RailNote>
          </ContextRail>
        }
      >
        <Section title="Other ways in">
          <p>You can also sign in with your email address and password, or reset your password by email.</p>
        </Section>
      </Workspace>
      <Actions>
        {session?.features.github ? (
          <AnchorButton variant="primary" href="/api/auth/github/start">
            Try GitHub again
          </AnchorButton>
        ) : (
          <DisabledAction reason="GitHub sign-in is not configured on this server">Try GitHub again</DisabledAction>
        )}
        <LinkButton to="/signin">Sign in with email</LinkButton>
      </Actions>
    </Page>
  );
}
