import type { Hono } from 'hono';
import { z } from 'zod';
import type { InvitationPreview, InvitationRow, InvitationSent, InvitationView, MemberRow, MembersData, SlugCheck, Verdict, Visibility, WorkspaceDetail } from '../../shared/types/workspace.ts';
import type { WorkspaceRole } from '../../shared/types/session.ts';
import { addMinutes, type AppContext, type AppEnv, type UserRow } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { requireUser, requireVerified } from '../lib/auth.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { badRequest, forbidden, invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { sendMail } from '../lib/mail.ts';
import { canManageMembers, hasCredential, workspaceRole } from '../lib/permissions.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { readJson, trimmed } from '../lib/validate.ts';

export const INVITATION_DAYS = 7;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MIN = 3;
const SLUG_MAX = 48;
const SLUG_INVALID = `Use ${SLUG_MIN} to ${SLUG_MAX} lowercase letters, numbers and single hyphens.`;
const SLUG_TAKEN = 'This workspace URL is taken. Choose another.';
const OWNER_ONLY = 'Workspace owner only';

interface WorkspaceRow {
  id: string;
  code: string;
  name: string;
  slug: string;
  research_focus: string;
  default_visibility: Visibility;
  owner_id: string;
  created_at: string;
}

interface InvitationDbRow {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  status: 'sent' | 'accepted' | 'revoked';
  expires_at: string;
}

const yes: Verdict = { allowed: true };
const no = (reason: string): Verdict => ({ allowed: false, reason });

const emailField = z.string({ error: 'Enter an email address.' }).trim().toLowerCase().email('Enter a valid email address.').max(254, 'Keep this under 254 characters.');

const hostOf = (ctx: AppContext) => new URL(ctx.config.publicUrl).host;

function slugProblem(slug: string): string | null {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX || !SLUG_PATTERN.test(slug)) return SLUG_INVALID;
  return null;
}

/** WS-HELIX from helix-lab. A code already in use falls back to the whole slug, then a number. */
async function freeWorkspaceCode(ctx: AppContext, slug: string): Promise<string> {
  const whole = `WS-${slug.toUpperCase()}`;
  const candidates = [`WS-${(slug.split('-')[0] as string).toUpperCase()}`, whole];
  for (const code of candidates) {
    if (!(await ctx.db.get('SELECT 1 AS ok FROM workspaces WHERE code = ?', [code]))) return code;
  }
  for (let suffix = 2; ; suffix += 1) {
    const code = `${whole}-${suffix}`;
    if (!(await ctx.db.get('SELECT 1 AS ok FROM workspaces WHERE code = ?', [code]))) return code;
  }
}

/**
 * The workspace a person is working in: the one they last chose while they still belong to it,
 * otherwise their oldest active membership. Read fresh each request, so removal applies at once.
 */
export async function activeWorkspace(ctx: AppContext, user: UserRow): Promise<(WorkspaceRow & { role: WorkspaceRole }) | null> {
  const rows = await ctx.db.all<WorkspaceRow & { role: WorkspaceRole }>(
    `SELECT w.id, w.code, w.name, w.slug, w.research_focus, w.default_visibility, w.owner_id, w.created_at, m.role
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at`,
    [user.id],
  );
  return rows.find((row) => row.id === user.active_workspace_id) ?? rows[0] ?? null;
}

/** "Review Biology tasks · Verified Biology credential required" */
export async function reviewBiologyVerdict(ctx: AppContext, user: UserRow): Promise<Verdict> {
  if (await hasCredential(ctx, user.id, 'biology')) return yes;
  const domain = await ctx.db.get<{ name: string }>(`SELECT name FROM domains WHERE id = 'biology'`);
  return no(`Verified ${domain?.name ?? 'Biology'} credential required`);
}

async function ownerName(ctx: AppContext, ownerId: string): Promise<string> {
  const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [ownerId]);
  return owner?.name ?? '';
}

async function workspaceDetail(ctx: AppContext, row: WorkspaceRow): Promise<WorkspaceDetail> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    slug: row.slug,
    url: `${hostOf(ctx)}/w/${row.slug}`,
    researchFocus: row.research_focus,
    defaultVisibility: row.default_visibility,
    ownerName: await ownerName(ctx, row.owner_id),
    createdAt: row.created_at,
  };
}

function removeVerdict(manage: Verdict, member: { id: string }, user: UserRow, workspace: Pick<WorkspaceRow, 'owner_id'>): Verdict {
  if (!manage.allowed) return manage;
  if (member.id === user.id) return no('You cannot remove yourself');
  if (member.id === workspace.owner_id) return no('The workspace creator cannot be removed');
  return yes;
}

async function membersData(ctx: AppContext, user: UserRow, workspace: WorkspaceRow & { role: WorkspaceRole }): Promise<MembersData> {
  const manage = await canManageMembers(ctx, user, workspace.id);
  const memberRows = await ctx.db.all<{ id: string; name: string; email: string; role: WorkspaceRole; created_at: string }>(
    `SELECT u.id, u.name, u.email, m.role, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.status = 'active'
     ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.created_at`,
    [workspace.id],
  );
  const members: MemberRow[] = memberRows.map((row) => ({
    userId: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isSelf: row.id === user.id,
    isCreator: row.id === workspace.owner_id,
    joinedAt: row.created_at,
    remove: removeVerdict(manage, row, user, workspace),
  }));
  const inviteRows = await ctx.db.all<{ id: string; email: string; role: WorkspaceRole; created_at: string; expires_at: string; invited_by_name: string; invitee_name: string | null }>(
    `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, inviter.name AS invited_by_name, invitee.name AS invitee_name
     FROM invitations i
     JOIN users inviter ON inviter.id = i.invited_by
     LEFT JOIN users invitee ON invitee.email = i.email AND invitee.email_verified_at IS NOT NULL
     WHERE i.workspace_id = ? AND i.status = 'sent'
     ORDER BY i.created_at DESC`,
    [workspace.id],
  );
  const now = ctx.now().toISOString();
  const invitations: InvitationRow[] = inviteRows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.invitee_name,
    role: row.role,
    state: row.expires_at <= now ? 'expired' : 'sent',
    invitedBy: row.invited_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revoke: manage,
  }));
  return { workspace: await workspaceDetail(ctx, workspace), viewerRole: workspace.role, manage, members, invitations };
}

async function requireManage(ctx: AppContext, user: UserRow, workspaceId: string): Promise<void> {
  const verdict = await canManageMembers(ctx, user, workspaceId);
  if (!verdict.allowed) throw forbidden(verdict.reason);
}

/** What the invite form would do for this address right now, shared by preview and send. */
async function inviteState(ctx: AppContext, workspaceId: string, email: string): Promise<'new' | 'member' | 'pending'> {
  const member = await ctx.db.get(
    `SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? AND m.status = 'active'`,
    [workspaceId, email],
  );
  if (member) return 'member';
  const pending = await ctx.db.get(`SELECT 1 AS ok FROM invitations WHERE workspace_id = ? AND email = ? AND status = 'sent' AND expires_at > ?`, [workspaceId, email, ctx.now().toISOString()]);
  return pending ? 'pending' : 'new';
}

const invitationHash = (token: string) => sha256Hex(token);

async function invitationByToken(ctx: AppContext, token: string) {
  return ctx.db.get<InvitationDbRow & { workspace_name: string; workspace_code: string; invited_by_name: string }>(
    `SELECT i.id, i.workspace_id, i.email, i.role, i.status, i.expires_at, w.name AS workspace_name, w.code AS workspace_code, u.name AS invited_by_name
     FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
     WHERE i.token_hash = ?`,
    [invitationHash(token)],
  );
}

function invitationState(ctx: AppContext, row: Pick<InvitationDbRow, 'status' | 'expires_at'>): InvitationView['state'] {
  if (row.status === 'accepted') return 'accepted';
  if (row.status === 'revoked') return 'revoked';
  return row.expires_at <= ctx.now().toISOString() ? 'expired' : 'valid';
}

const STATE_REFUSALS: Record<Exclude<InvitationView['state'], 'valid'>, { reason: string; code: string }> = {
  accepted: { reason: 'This invitation has already been used.', code: 'invitation_used' },
  revoked: { reason: 'This invitation was revoked. Ask the workspace owner to send a new one.', code: 'invitation_revoked' },
  expired: { reason: 'This invitation has expired. Ask the workspace owner to send a new one.', code: 'invitation_expired' },
};
const WRONG_EMAIL = 'This invitation was sent to a different email address.';
const UNVERIFIED = 'Verify your email address to accept this invitation.';
const SIGNED_OUT = 'Sign in with the invited email address to accept this invitation.';

function acceptVerdict(state: InvitationView['state'], email: string, user: UserRow | null): Verdict {
  if (state !== 'valid') return no(STATE_REFUSALS[state].reason);
  if (!user) return no(SIGNED_OUT);
  if (user.email.toLowerCase() !== email) return no(WRONG_EMAIL);
  if (!user.email_verified_at) return no(UNVERIFIED);
  return yes;
}

function formatMailDate(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ', ')} UTC`;
}

export function registerWorkspaces(app: Hono<AppEnv>) {
  /* ---------- Create ---------- */

  app.get('/api/workspaces/slug-check', async (c) => {
    const ctx = c.get('ctx');
    requireVerified(c);
    const slug = (c.req.query('slug') ?? '').trim().toLowerCase();
    const base = { slug, host: hostOf(ctx) };
    let body: SlugCheck;
    if (!slug) body = { ...base, status: 'empty', reason: null, code: null };
    else if (slugProblem(slug)) body = { ...base, status: 'invalid', reason: slugProblem(slug), code: null };
    else if (await ctx.db.get('SELECT 1 AS ok FROM workspaces WHERE slug = ?', [slug])) body = { ...base, status: 'taken', reason: SLUG_TAKEN, code: null };
    else body = { ...base, status: 'available', reason: null, code: await freeWorkspaceCode(ctx, slug) };
    return c.json(body);
  });

  app.post('/api/workspaces', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(
      c,
      z.object({
        name: trimmed('Enter a workspace name.', 80),
        slug: z.string({ error: 'Enter a workspace URL.' }).trim().toLowerCase().refine((value) => !slugProblem(value), SLUG_INVALID),
        researchFocus: z.string({ error: 'Enter a research focus.' }).trim().max(500, 'Keep this under 500 characters.').default(''),
        defaultVisibility: z.enum(['private', 'shared'], { error: 'Choose a default visibility.' }),
        keepPrivate: z.boolean({ error: 'Choose whether new tasks and datasets stay private.' }).default(true),
      }),
    );
    if (input.keepPrivate && input.defaultVisibility === 'shared') {
      throw invalid({ keepPrivate: 'Untick this box to make new tasks and datasets shared by default.' });
    }
    await rateLimit(ctx, `workspace-create:${user.id}`, 20, 3600, 'Too many workspaces created. Wait a while and try again.');
    const created = await ctx.db.tx(async () => {
      if (await ctx.db.get('SELECT 1 AS ok FROM workspaces WHERE slug = ?', [input.slug])) throw invalid({ slug: SLUG_TAKEN });
      const now = ctx.now().toISOString();
      const row: WorkspaceRow = {
        id: newId(),
        code: await freeWorkspaceCode(ctx, input.slug),
        name: input.name,
        slug: input.slug,
        research_focus: input.researchFocus,
        default_visibility: input.defaultVisibility,
        owner_id: user.id,
        created_at: now,
      };
      await ctx.db.run(
        `INSERT INTO workspaces (id, code, name, slug, research_focus, default_visibility, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.code, row.name, row.slug, row.research_focus, row.default_visibility, row.owner_id, row.created_at],
      );
      await ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`, [newId(), row.id, user.id, now]);
      await ctx.db.run('UPDATE users SET active_workspace_id = ?, updated_at = ? WHERE id = ?', [row.id, now, user.id]);
      await audit(ctx, { actorId: user.id, action: 'workspace.created', subjectType: 'workspace', subjectId: row.id, subjectCode: row.code, workspaceId: row.id, detail: { slug: row.slug, defaultVisibility: row.default_visibility } });
      return row;
    });
    return c.json({ workspace: await workspaceDetail(ctx, created) }, 201);
  });

  /* ---------- The active workspace ---------- */

  app.get('/api/workspaces/current', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspace(ctx, user);
    if (!workspace) {
      const empty: MembersData = { workspace: null, viewerRole: null, manage: no(OWNER_ONLY), members: [], invitations: [] };
      return c.json(empty);
    }
    return c.json(await membersData(ctx, user, workspace));
  });

  app.post('/api/workspaces/switch', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, z.object({ workspaceId: z.string({ error: 'Choose a workspace.' }).min(1, 'Choose a workspace.') }));
    // One answer for unknown and not-yours: this route never reveals that a workspace exists.
    if (!(await workspaceRole(ctx, user.id, input.workspaceId))) throw forbidden('You are not an active member of this workspace.');
    await ctx.db.run('UPDATE users SET active_workspace_id = ?, updated_at = ? WHERE id = ?', [input.workspaceId, ctx.now().toISOString(), user.id]);
    return c.json({ ok: true, workspaceId: input.workspaceId });
  });

  /** "Workspace URLs do not bypass membership checks." Not a member reads the same as not found. */
  app.get('/api/workspaces/by-slug/:slug', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await ctx.db.get<{ id: string; name: string; code: string }>(
      `SELECT w.id, w.name, w.code FROM workspaces w
       JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active'
       WHERE w.slug = ?`,
      [user.id, c.req.param('slug').toLowerCase()],
    );
    if (!row) throw notFound();
    return c.json(row);
  });

  /* ---------- Invitations ---------- */

  app.post('/api/workspaces/:id/invitations/preview', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspaceId = c.req.param('id');
    await requireManage(ctx, user, workspaceId);
    const input = await readJson(c, z.object({ email: emailField }));
    await rateLimit(ctx, `invite-preview:${user.id}`, 60, 600, 'Too many lookups. Wait a moment and try again.');
    const person = await ctx.db.get<{ id: string; name: string }>('SELECT id, name FROM users WHERE email = ? AND email_verified_at IS NOT NULL', [input.email]);
    const credentials = person
      ? await ctx.db.all<{ name: string }>(
          `SELECT d.name FROM credentials c JOIN domains d ON d.id = c.domain_id WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY c.granted_at`,
          [person.id],
        )
      : [];
    const body: InvitationPreview = { email: input.email, name: person?.name ?? null, credentials: credentials.map((row) => row.name), state: await inviteState(ctx, workspaceId, input.email) };
    return c.json(body);
  });

  app.post('/api/workspaces/:id/invitations', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspaceId = c.req.param('id');
    await requireManage(ctx, user, workspaceId);
    const input = await readJson(c, z.object({ email: emailField, role: z.enum(['member', 'owner'], { error: 'Choose a workspace role.' }) }));
    await rateLimit(ctx, `invite:${user.id}`, 30, 3600, 'Too many invitations sent. Wait a while and try again.');

    const token = randomToken();
    const now = ctx.now();
    const expiresAt = addMinutes(now, INVITATION_DAYS * 24 * 60);
    const { id, workspace } = await ctx.db.tx(async () => {
      const state = await inviteState(ctx, workspaceId, input.email);
      if (state === 'member') throw invalid({ email: 'This person is already a member of this workspace.' });
      if (state === 'pending') throw invalid({ email: 'An invitation to this address is already pending. Revoke it to send a new one.' });
      const row = (await ctx.db.get<{ name: string; code: string }>('SELECT name, code FROM workspaces WHERE id = ?', [workspaceId])) as { name: string; code: string };
      // A lapsed invitation for this address has done its job; the new one replaces it in the list.
      await ctx.db.run(`UPDATE invitations SET status = 'revoked' WHERE workspace_id = ? AND email = ? AND status = 'sent'`, [workspaceId, input.email]);
      const invitationId = newId();
      await ctx.db.run(
        `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [invitationId, workspaceId, input.email, input.role, invitationHash(token), user.id, now.toISOString(), expiresAt.toISOString()],
      );
      await audit(ctx, { actorId: user.id, action: 'workspace.invitation_sent', subjectType: 'invitation', subjectId: invitationId, subjectCode: row.code, workspaceId, detail: { email: input.email, role: input.role } });
      return { id: invitationId, workspace: row };
    });

    const link = `${ctx.config.publicUrl}/invitations/${token}`;
    try {
      await sendMail(ctx, {
        to: input.email,
        subject: `${user.name} invited you to ${workspace.name} on Rivet`,
        text: `Hello,\n\n${user.name} invited ${input.email} to join ${workspace.name} on Rivet as ${input.role === 'owner' ? 'an owner' : 'a member'}. Joining gives access to ${workspace.name} private tasks and datasets. It does not change any verified domain credential.\n\nOpen this link to accept. It works once, expires on ${formatMailDate(expiresAt)}, and only for a verified account using this email address.\n\n${link}\n\nIf you were not expecting this, ignore this message.`,
        link,
        purpose: 'invitation',
      });
    } catch (error) {
      // Nothing was delivered, so nothing may read as sent. The token dies with the row.
      await ctx.db.run(`UPDATE invitations SET status = 'revoked' WHERE id = ?`, [id]);
      await audit(ctx, { actorId: user.id, action: 'workspace.invitation_failed', subjectType: 'invitation', subjectId: id, subjectCode: workspace.code, workspaceId, detail: { email: input.email } });
      throw error;
    }
    const body: InvitationSent = { id, email: input.email, role: input.role, expiresAt: expiresAt.toISOString() };
    return c.json(body, 201);
  });

  app.post('/api/workspaces/:id/invitations/:invitationId/revoke', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspaceId = c.req.param('id');
    await requireManage(ctx, user, workspaceId);
    const row = await ctx.db.get<InvitationDbRow>(`SELECT id, workspace_id, email, role, status, expires_at FROM invitations WHERE id = ? AND workspace_id = ?`, [c.req.param('invitationId'), workspaceId]);
    if (!row) throw notFound();
    if (row.status !== 'sent') throw badRequest(row.status === 'accepted' ? 'This invitation has already been accepted.' : 'This invitation was already revoked.', 'invitation_closed');
    await ctx.db.run(`UPDATE invitations SET status = 'revoked' WHERE id = ?`, [row.id]);
    await audit(ctx, { actorId: user.id, action: 'workspace.invitation_revoked', subjectType: 'invitation', subjectId: row.id, workspaceId, detail: { email: row.email } });
    return c.json({ ok: true });
  });

  /** Public: the person holding the link may not have an account yet. Changes nothing, so a mail scanner's GET is harmless. */
  app.get('/api/invitations/:token', async (c) => {
    const ctx = c.get('ctx');
    const row = await invitationByToken(ctx, c.req.param('token'));
    if (!row) throw notFound('This invitation link is not valid.');
    const user = c.get('user');
    const state = invitationState(ctx, row);
    const body: InvitationView = {
      state,
      workspaceName: row.workspace_name,
      workspaceCode: row.workspace_code,
      invitedBy: row.invited_by_name,
      email: row.email,
      role: row.role,
      expiresAt: row.expires_at,
      viewer: {
        signedIn: Boolean(user),
        email: user?.email ?? null,
        emailVerified: Boolean(user?.email_verified_at),
        emailMatches: user?.email.toLowerCase() === row.email,
      },
      accept: acceptVerdict(state, row.email, user),
    };
    return c.json(body);
  });

  app.post('/api/invitations/:token/accept', async (c) => {
    const ctx = c.get('ctx');
    const user = requireUser(c);
    const row = await invitationByToken(ctx, c.req.param('token'));
    if (!row) throw notFound('This invitation link is not valid.');
    const state = invitationState(ctx, row);
    if (state !== 'valid') throw badRequest(STATE_REFUSALS[state].reason, STATE_REFUSALS[state].code);
    if (user.email.toLowerCase() !== row.email) {
      await audit(ctx, { actorId: user.id, action: 'workspace.invitation_refused', subjectType: 'invitation', subjectId: row.id, subjectCode: row.workspace_code, workspaceId: row.workspace_id, detail: { reason: 'wrong_email' } });
      throw forbidden(WRONG_EMAIL, 'wrong_email');
    }
    if (!user.email_verified_at) throw forbidden(UNVERIFIED, 'email_unverified');

    await ctx.db.tx(async () => {
      // Read again inside the transaction, so two tabs cannot both spend the one-time link.
      const current = await ctx.db.get<{ status: string }>('SELECT status FROM invitations WHERE id = ?', [row.id]);
      if (current?.status !== 'sent') throw badRequest(STATE_REFUSALS.accepted.reason, STATE_REFUSALS.accepted.code);
      const now = ctx.now().toISOString();
      const existing = await ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM memberships WHERE workspace_id = ? AND user_id = ?', [row.workspace_id, user.id]);
      if (!existing) {
        await ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, [newId(), row.workspace_id, user.id, row.role, now]);
      } else if (existing.status === 'removed') {
        await ctx.db.run(`UPDATE memberships SET status = 'active', role = ?, removed_at = NULL WHERE id = ?`, [row.role, existing.id]);
      }
      await ctx.db.run(`UPDATE invitations SET status = 'accepted', accepted_at = ?, accepted_by = ? WHERE id = ?`, [now, user.id, row.id]);
      await ctx.db.run('UPDATE users SET active_workspace_id = ?, updated_at = ? WHERE id = ?', [row.workspace_id, now, user.id]);
      await audit(ctx, { actorId: user.id, action: 'workspace.invitation_accepted', subjectType: 'invitation', subjectId: row.id, subjectCode: row.workspace_code, workspaceId: row.workspace_id, detail: { email: row.email, role: row.role } });
      await audit(ctx, { actorId: user.id, action: 'workspace.member_added', subjectType: 'membership', subjectId: user.id, subjectCode: row.workspace_code, workspaceId: row.workspace_id, detail: { role: row.role, via: 'invitation' } });
    });
    return c.json({ ok: true, workspaceId: row.workspace_id });
  });

  /* ---------- Removing a member ---------- */

  app.post('/api/workspaces/:id/members/:userId/remove', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspaceId = c.req.param('id');
    const targetId = c.req.param('userId');
    await requireManage(ctx, user, workspaceId);
    const workspace = (await ctx.db.get<Pick<WorkspaceRow, 'owner_id' | 'code'>>('SELECT owner_id, code FROM workspaces WHERE id = ?', [workspaceId])) as Pick<WorkspaceRow, 'owner_id' | 'code'>;
    const verdict = removeVerdict(yes, { id: targetId }, user, workspace);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    if (!(await workspaceRole(ctx, targetId, workspaceId))) throw notFound('This person is not a member of this workspace.');
    await ctx.db.tx(async () => {
      const now = ctx.now().toISOString();
      await ctx.db.run(`UPDATE memberships SET status = 'removed', removed_at = ? WHERE workspace_id = ? AND user_id = ?`, [now, workspaceId, targetId]);
      // Their next request lands in another workspace of theirs, or none.
      await ctx.db.run(
        `UPDATE users SET active_workspace_id = (SELECT m.workspace_id FROM memberships m WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at LIMIT 1), updated_at = ?
         WHERE id = ? AND active_workspace_id = ?`,
        [targetId, now, targetId, workspaceId],
      );
      await audit(ctx, { actorId: user.id, action: 'workspace.member_removed', subjectType: 'membership', subjectId: targetId, subjectCode: workspace.code, workspaceId });
    });
    return c.json({ ok: true });
  });
}
