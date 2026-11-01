import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Page, PageHeader, QueryBoundary, Skeleton } from '../../components/index.ts';
import { ApiError, api } from '../../lib/api.ts';
import { useApiQuery } from '../../lib/query.ts';
import './workspace.css';

function Opening({ workspace }: { workspace: { id: string; name: string } }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .post('/api/workspaces/switch', { workspaceId: workspace.id })
      .then(async () => {
        await client.invalidateQueries();
        navigate('/workspace', { replace: true });
      })
      .catch((failure: unknown) => setError(failure instanceof ApiError ? failure.message : 'This workspace could not be opened. Try again.'));
  }, [client, navigate, workspace.id]);

  if (!error) return <Skeleton lines={2} />;
  return (
    <Page title={workspace.name}>
      <PageHeader eyebrow="05 Workspace" title={workspace.name} status="Could not open" statusTone="warning" />
      <Alert tone="danger">{error}</Alert>
    </Page>
  );
}

/** A workspace URL opens the workspace for its members. For anyone else it reads as not found. */
export default function WorkspaceUrlPage() {
  const { slug = '' } = useParams();
  const query = useApiQuery<{ id: string; name: string }>(`/api/workspaces/by-slug/${encodeURIComponent(slug)}`);
  return <QueryBoundary query={query}>{(workspace) => <Opening workspace={workspace} />}</QueryBoundary>;
}
