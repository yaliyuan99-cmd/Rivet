import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, LinkButton, Page, PageHeader, Actions } from '../../components/index.ts';
import { ApiError, api } from '../../lib/api.ts';

/** Where the email link lands. POSTs the token so a mail scanner's GET cannot consume it. */
export default function VerifyLinkPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get('token') ?? '';
    api
      .post('/api/auth/verify', { token })
      .then(async () => {
        await client.invalidateQueries({ queryKey: ['session'] });
        navigate('/', { replace: true });
      })
      .catch((failure: unknown) => setError(failure instanceof ApiError ? failure.message : 'This link could not be checked. Try again.'));
  }, [client, navigate, params]);

  return (
    <Page title="Verifying your email">
      <PageHeader eyebrow="01 Access" title={error ? 'This link can no longer verify your email' : 'Verifying your email…'} status={error ? 'Verification failed' : 'Checking your link'} statusTone={error ? 'warning' : 'accent'} />
      {error ? (
        <>
          <Alert tone="warning">{error}</Alert>
          <Actions>
            <LinkButton variant="primary" to="/verify">
              Request a fresh link
            </LinkButton>
          </Actions>
        </>
      ) : null}
    </Page>
  );
}
