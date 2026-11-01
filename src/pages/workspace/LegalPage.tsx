import { Link, useLocation } from 'react-router-dom';
import { Actions, Alert, LinkButton, Page, PageHeader, Section } from '../../components/index.ts';
import { useSession } from '../../lib/session.tsx';

const DOCUMENTS = {
  terms: { title: 'Terms of Service', other: { to: '/legal/privacy', label: 'Privacy Policy' } },
  privacy: { title: 'Privacy Policy', other: { to: '/legal/terms', label: 'Terms of Service' } },
};

/** The real legal text has not been provided. This page says so and states no terms of its own. */
export default function LegalPage() {
  const { pathname } = useLocation();
  const { data: session } = useSession();
  const legal = pathname.endsWith('/privacy') ? DOCUMENTS.privacy : DOCUMENTS.terms;
  return (
    <Page title={legal.title}>
      <PageHeader eyebrow="Legal" title={legal.title} subtitle="The text of this document has not been supplied yet." status="Text not supplied" statusTone="warning" />
      <Alert tone="warning">{session?.demo ? 'This instance is a demo. Its legal text has not been supplied yet.' : 'The operator of this instance has not supplied its legal text yet.'}</Alert>
      <Section title="What this page is">
        <p>This is a placeholder, not a legal document. It sets out no terms and makes no commitments. Once the text is supplied, it will appear here.</p>
        <p>
          Also not yet supplied:{' '}
          <Link className="text-link" to={legal.other.to}>
            {legal.other.label}
          </Link>
          .
        </p>
      </Section>
      <Actions>
        {session?.user ? (
          <LinkButton variant="primary" to="/">
            Return to Home
          </LinkButton>
        ) : (
          <>
            <LinkButton variant="primary" to="/signup">
              Back to sign up
            </LinkButton>
            <LinkButton to="/signin">Sign in</LinkButton>
          </>
        )}
      </Actions>
    </Page>
  );
}
