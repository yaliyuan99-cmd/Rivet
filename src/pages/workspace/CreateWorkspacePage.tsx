import { useEffect, useState, type FormEvent } from 'react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { CreateWorkspaceInput, SlugCheck, Visibility, WorkspaceDetail } from '../../../shared/types/workspace.ts';
import { Actions, Alert, Button, Checkbox, ContextRail, FieldInput, FieldSelect, LinkButton, Page, PageHeader, RailItem, RailNote, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useUser } from '../../lib/session.tsx';
import './workspace.css';

const SLUG_MAX = 48;

/** Helix Lab -> helix-lab */
function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** "rivet.example/w/helix-lab · Available". The kit's field has no prefix, so this composes its parts. */
function SlugField({ host, slug, onChange, check, checking, failed, stillTyping, error }: { host: string; slug: string; onChange: (value: string) => void; check: SlugCheck | undefined; checking: boolean; failed: boolean; stillTyping: boolean; error?: string }) {
  const status = !slug || stillTyping ? '' : checking ? 'Checking…' : failed ? 'Could not check' : check?.status === 'available' ? 'Available' : check?.status === 'taken' ? 'Taken' : check?.status === 'invalid' ? 'Not valid' : '';
  const problem = !checking && slug && !stillTyping ? check?.reason : null;
  const message = error ?? problem ?? (!checking && failed ? 'Availability could not be checked. Rivet checks again when you create the workspace.' : null);
  const danger = Boolean(error || problem);
  return (
    <div>
      <label className="field" data-invalid={danger ? 'true' : undefined}>
        <span className="field-label">Workspace URL</span>
        <span className="slug-value">
          <span>{host}/w/</span>
          <span className="slug-sizer" data-value={slug || ' '}>
            <input
              className="field-control"
              size={1}
              aria-label="Workspace URL"
              aria-invalid={danger ? true : undefined}
              aria-describedby={message ? 'workspace-url-message' : 'workspace-url-status'}
              value={slug}
              maxLength={SLUG_MAX}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              onChange={(event) => onChange(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
            />
          </span>
          <span id="workspace-url-status" className="slug-status" role="status">
            {status ? `· ${status}` : ''}
          </span>
        </span>
      </label>
      {message ? (
        <p id="workspace-url-message" className="field-message" data-tone={danger ? 'danger' : undefined}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

export default function CreateWorkspacePage() {
  const user = useUser();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [researchFocus, setResearchFocus] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');

  const shownSlug = slugEdited ? slug : slugFrom(name);
  const settledSlug = useDebounced(shownSlug);
  const check = useApiQuery<SlugCheck>(`/api/workspaces/slug-check?slug=${encodeURIComponent(settledSlug)}`, { placeholderData: keepPreviousData, staleTime: 0, gcTime: 0 });
  const checking = shownSlug !== settledSlug || check.isPlaceholderData || (check.isFetching && check.data?.slug !== settledSlug);

  const create = useApiMutation((input: CreateWorkspaceInput) => api.post<{ workspace: WorkspaceDetail }>('/api/workspaces', input), {
    onSuccess: async ({ workspace }) => {
      // Everything on screen belongs to the previous workspace now.
      await client.invalidateQueries();
      toast.success(`${workspace.name} created`, `${workspace.code} is now your active workspace.`);
      navigate('/workspace', { replace: true });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name, slug: shownSlug, researchFocus, defaultVisibility: visibility, keepPrivate: visibility === 'private' });
  };

  const code = check.data?.status === 'available' && !checking ? check.data.code : null;
  const label = name.trim() ? `Create ${name.trim()}` : 'Create workspace';

  return (
    <Page title="Create a workspace">
      <PageHeader eyebrow="05 Workspace" title="A shared place for rigorous work." subtitle="Create a workspace. Keep your research private by default." status="New workspace / Member access" />
      {create.formError ? <Alert tone="danger">{create.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Workspace owner">{user.name}</RailItem>
              <RailItem term="Workspace ID">{code ?? 'Set from the workspace URL'}</RailItem>
              <RailItem term="Invite members">Owner only</RailItem>
              <RailItem term="Create tasks and data">Members</RailItem>
              <RailNote>Workspace ownership does not grant administrator powers or expert domain credentials. Task owners retain run, resume and revision permissions.</RailNote>
            </ContextRail>
          }
        >
          <Section title="Create your workspace" kind="form">
            <FieldInput
              label="Workspace name"
              value={name}
              onChange={(value) => {
                setName(value);
                // The name drives the suggested URL, so an old refusal may no longer apply.
                if (create.formError) create.clearErrors();
              }}
              autoComplete="organization"
              required
              maxLength={80}
              error={create.fieldErrors.name}
            />
            <SlugField
              host={check.data?.host ?? window.location.host}
              slug={shownSlug}
              onChange={(value) => {
                setSlugEdited(true);
                setSlug(value);
                if (create.formError) create.clearErrors();
              }}
              check={check.data}
              checking={checking}
              failed={check.isError}
              // A name of one or two letters is someone mid-word, not a mistake to flag in red.
              stillTyping={!slugEdited && shownSlug.length < 3}
              error={create.fieldErrors.slug}
            />
            <FieldInput label="Research focus" value={researchFocus} onChange={setResearchFocus} maxLength={500} error={create.fieldErrors.researchFocus} />
            <FieldSelect
              label="Default visibility"
              value={visibility}
              onChange={(value) => setVisibility(value as Visibility)}
              options={[
                { value: 'private', label: 'Private / Workspace members only' },
                { value: 'shared', label: 'Shared / Any verified account can read frozen work' },
              ]}
              error={create.fieldErrors.defaultVisibility}
            />
          </Section>
          <Section title="Privacy by default">
            <div>
              <Checkbox checked={visibility === 'private'} onChange={(checked) => setVisibility(checked ? 'private' : 'shared')} error={create.fieldErrors.keepPrivate}>
                Keep new tasks and datasets private. Workspace URLs do not bypass membership checks.
              </Checkbox>
            </div>
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={create.isPending} busyLabel="Creating your workspace">
            {label}
          </Button>
          <LinkButton to={user.workspace ? '/workspace' : '/'}>Cancel</LinkButton>
        </Actions>
      </form>
    </Page>
  );
}
