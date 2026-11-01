import type { Hono } from 'hono';
import type { AttentionItem, HomeData, RecentReport, RecentTask } from '../../shared/types/workspace.ts';
import type { AppContext, AppEnv, UserRow } from '../context.ts';
import { requireVerified } from '../lib/auth.ts';
import { STARTER_TITLE } from '../lib/demoFixtures.ts';
import { activeWorkspace, reviewBiologyVerdict } from './workspaces.ts';

const ATTENTION_LIMIT = 5;
const RECENT_LIMIT = 5;

const count = async (ctx: AppContext, sql: string, params: (string | null)[]) => (await ctx.db.get<{ n: number }>(sql, params))?.n ?? 0;

const taskLabel = (code: string, title: string) => `${code} · ${title || 'Untitled draft'}`;

/** Only work in workspaces the person still belongs to: removal takes it off this page too. */
const STILL_A_MEMBER = `EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = t.workspace_id AND m.user_id = ? AND m.status = 'active')`;

async function runItems(ctx: AppContext, user: UserRow): Promise<AttentionItem[]> {
  const rows = await ctx.db.all<{ code: string; status: string; stages_done: number; stages_total: number; last_checkpoint_code: string | null; interrupted_at: string | null; started_at: string | null; created_at: string; task_code: string; task_title: string }>(
    `SELECT r.code, r.status, r.stages_done, r.stages_total, r.last_checkpoint_code, r.interrupted_at, r.started_at, r.created_at, t.code AS task_code, t.title AS task_title
     FROM runs r JOIN tasks t ON t.id = r.task_id
     WHERE r.owner_id = ? AND r.status IN ('interrupted', 'queued', 'running', 'stopping') AND ${STILL_A_MEMBER}
     ORDER BY CASE r.status WHEN 'interrupted' THEN 0 ELSE 1 END, r.created_at DESC LIMIT ?`,
    [user.id, user.id, ATTENTION_LIMIT],
  );
  return rows.map((row) => {
    const progress = `${row.stages_done} / ${row.stages_total} stages committed`;
    return row.status === 'interrupted'
      ? {
          kind: 'interrupted_run',
          code: row.code,
          title: `${row.code} · ${taskLabel(row.task_code, row.task_title)}`,
          detail: `Interrupted${row.last_checkpoint_code ? ` at ${row.last_checkpoint_code}` : ''} · ${progress}`,
          at: row.interrupted_at,
          atLabel: 'Since',
          href: `/runs/${row.code}`,
          action: 'Resume run',
        }
      : {
          kind: 'active_run',
          code: row.code,
          title: `${row.code} · ${taskLabel(row.task_code, row.task_title)}`,
          detail: `${row.status === 'queued' ? 'Queued' : row.status === 'stopping' ? 'Stopping' : 'Running'} · ${progress}`,
          at: row.started_at ?? row.created_at,
          atLabel: 'Started',
          href: `/runs/${row.code}`,
          action: 'Open run',
        };
  });
}

async function reviewItems(ctx: AppContext, user: UserRow): Promise<AttentionItem[]> {
  // Your own claimed reviews first, then requests in a domain you hold, never on your own task.
  const rows = await ctx.db.all<{ code: string; status: string; created_at: string; draft_saved_at: string | null; task_code: string; task_title: string; domain: string; returned_note: string | null }>(
    `SELECT rv.code, rv.status, rv.created_at, rv.draft_saved_at, rv.returned_note, t.code AS task_code, t.title AS task_title, d.name AS domain
     FROM reviews rv JOIN tasks t ON t.id = rv.task_id JOIN domains d ON d.id = t.domain_id
     WHERE t.owner_id <> ?
       AND ((rv.expert_id = ? AND rv.status IN ('draft', 'returned'))
         OR (rv.status = 'requested' AND EXISTS (SELECT 1 FROM credentials c WHERE c.user_id = ? AND c.domain_id = t.domain_id AND c.revoked_at IS NULL)))
     ORDER BY CASE rv.status WHEN 'returned' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, rv.created_at DESC LIMIT ?`,
    [user.id, user.id, user.id, ATTENTION_LIMIT],
  );
  return rows.map((row) => ({
    kind: 'review',
    code: row.code,
    title: `${row.code} · ${taskLabel(row.task_code, row.task_title)}`,
    detail: row.status === 'returned' ? `${row.domain} review returned to you` : row.status === 'draft' ? `Your ${row.domain} review draft` : `${row.domain} review waiting`,
    at: row.status === 'draft' ? row.draft_saved_at : row.created_at,
    atLabel: row.status === 'draft' ? 'Saved' : 'Requested',
    href: `/review/${row.code}`,
    action: row.status === 'requested' ? 'Open review' : 'Continue review',
  }));
}

async function draftItems(ctx: AppContext, user: UserRow): Promise<AttentionItem[]> {
  const rows = await ctx.db.all<{ code: string; title: string; draft_version: string; draft_saved_at: string | null; updated_at: string }>(
    `SELECT t.code, t.title, t.draft_version, t.draft_saved_at, t.updated_at FROM tasks t
     WHERE t.owner_id = ? AND t.status = 'draft' AND ${STILL_A_MEMBER}
     ORDER BY t.updated_at DESC LIMIT ?`,
    [user.id, user.id, ATTENTION_LIMIT],
  );
  return rows.map((row) => ({
    kind: 'draft',
    code: row.code,
    title: taskLabel(row.code, row.title),
    detail: `Draft ${row.draft_version}`,
    at: row.draft_saved_at ?? row.updated_at,
    atLabel: 'Saved',
    href: `/tasks/${row.code}/edit`,
    action: 'Continue draft',
  }));
}

const APPLICATION_STATES: Record<string, { detail: string; action: string; href: string }> = {
  draft: { detail: 'Application not submitted', action: 'Continue application', href: '/review/apply' },
  pending: { detail: 'Pending verification', action: 'View application', href: '/review/application' },
  more_evidence: { detail: 'More evidence requested', action: 'View application', href: '/review/application' },
  declined: { detail: 'Not approved', action: 'View application', href: '/review/application' },
};

async function applicationItems(ctx: AppContext, user: UserRow): Promise<AttentionItem[]> {
  const row = await ctx.db.get<{ code: string; status: string; submitted_at: string | null; updated_at: string; domain: string }>(
    `SELECT a.code, a.status, a.submitted_at, a.updated_at, d.name AS domain
     FROM applications a JOIN domains d ON d.id = a.domain_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 1`,
    [user.id],
  );
  const state = row ? APPLICATION_STATES[row.status] : undefined;
  if (!row || !state) return [];
  return [
    {
      kind: 'application',
      code: row.code,
      title: `${row.code} · ${row.domain} reviewer application`,
      detail: state.detail,
      at: row.submitted_at ?? row.updated_at,
      atLabel: row.submitted_at ? 'Submitted' : 'Saved',
      href: state.href,
      action: state.action,
    },
  ];
}

/** An invitation only its email link can accept: Rivet keeps the hash, never the token. */
async function invitationItems(ctx: AppContext, user: UserRow): Promise<AttentionItem[]> {
  const rows = await ctx.db.all<{ created_at: string; workspace_name: string; invited_by: string }>(
    `SELECT i.created_at, w.name AS workspace_name, u.name AS invited_by
     FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
     WHERE i.email = ? AND i.status = 'sent' AND i.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = i.workspace_id AND m.user_id = ? AND m.status = 'active')
     ORDER BY i.created_at DESC LIMIT ?`,
    [user.email.toLowerCase(), ctx.now().toISOString(), user.id, ATTENTION_LIMIT],
  );
  return rows.map((row) => ({
    kind: 'invitation',
    code: null,
    title: `Invitation to ${row.workspace_name}`,
    detail: `From ${row.invited_by} · Open the link sent to ${user.email} to accept`,
    at: row.created_at,
    atLabel: 'Sent',
    href: null,
    action: null,
  }));
}

export function registerHome(app: Hono<AppEnv>) {
  app.get('/api/home', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspace(ctx, user);
    const tasksAnywhere = await count(ctx, `SELECT COUNT(*) AS n FROM tasks t WHERE ${STILL_A_MEMBER}`, [user.id]);
    const evaluations = await count(ctx, 'SELECT COUNT(*) AS n FROM runs WHERE owner_id = ?', [user.id]);

    const domain = await ctx.db.get<{ name: string; field: string }>(`SELECT name, field FROM domains WHERE id = 'biology'`);
    const models = await ctx.db.all<{ display_name: string }>('SELECT display_name FROM models WHERE enabled = 1 ORDER BY sort');
    const credentials = await ctx.db.all<{ domain_id: string; name: string; granted_at: string }>(
      `SELECT c.domain_id, d.name, c.granted_at FROM credentials c JOIN domains d ON d.id = c.domain_id WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY c.granted_at`,
      [user.id],
    );

    const attention = [...(await runItems(ctx, user)), ...(await reviewItems(ctx, user)), ...(await draftItems(ctx, user)), ...(await applicationItems(ctx, user)), ...(await invitationItems(ctx, user))];

    const taskRows = workspace
      ? await ctx.db.all<{ code: string; title: string; status: string; draft_version: string; version: string | null; updated_at: string; is_synthetic: number }>(
          `SELECT t.code, t.title, t.status, t.draft_version, tv.version, t.updated_at, t.is_synthetic
           FROM tasks t LEFT JOIN task_versions tv ON tv.id = t.latest_version_id
           WHERE t.workspace_id = ? ORDER BY t.updated_at DESC, t.code DESC LIMIT ?`,
          [workspace.id, RECENT_LIMIT],
        )
      : [];
    const recentTasks: RecentTask[] = taskRows.map((row) => ({
      code: row.code,
      title: row.title || 'Untitled draft',
      state: row.status === 'frozen' && row.version ? `Frozen v${row.version}` : `Draft ${row.draft_version}`,
      updatedAt: row.updated_at,
      isSynthetic: Boolean(row.is_synthetic),
      href: `/tasks/${row.code}`,
    }));

    // Reports from this workspace, plus any the person owns or reviewed, wherever they sit now.
    const reportScope = `(t.workspace_id = ? OR r.owner_id = ? OR r.expert_id = ?)`;
    const reportParams = [workspace?.id ?? null, user.id, user.id];
    const reportRows = await ctx.db.all<{ code: string; version: string; headline: string; frozen_at: string; is_synthetic: number; task_code: string }>(
      `SELECT r.code, r.version, r.headline, r.frozen_at, r.is_synthetic, t.code AS task_code
       FROM reports r JOIN tasks t ON t.id = r.task_id
       WHERE ${reportScope} ORDER BY r.frozen_at DESC LIMIT ?`,
      [...reportParams, RECENT_LIMIT],
    );
    const recentReports: RecentReport[] = reportRows.map((row) => ({
      code: row.code,
      version: row.version,
      taskCode: row.task_code,
      headline: row.headline,
      frozenAt: row.frozen_at,
      isSynthetic: Boolean(row.is_synthetic),
      href: `/reports/${row.code}/v${row.version}`,
    }));

    const body: HomeData = {
      firstRun: !workspace || tasksAnywhere === 0,
      workspace: workspace ? { name: workspace.name, role: workspace.role, defaultVisibility: workspace.default_visibility } : null,
      starter: {
        title: STARTER_TITLE,
        domain: domain ? `${domain.name} / ${domain.field}` : '',
        models: models.map((model) => model.display_name).join(' · '),
      },
      evaluations,
      attention,
      counts: {
        tasks: workspace ? await count(ctx, 'SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?', [workspace.id]) : 0,
        reports: await count(ctx, `SELECT COUNT(*) AS n FROM reports r JOIN tasks t ON t.id = r.task_id WHERE ${reportScope}`, reportParams),
      },
      recentTasks,
      recentReports,
      credentials: credentials.map((row) => ({ domainId: row.domain_id, domainName: row.name, grantedAt: row.granted_at })),
      reviewBiology: await reviewBiologyVerdict(ctx, user),
    };
    return c.json(body);
  });
}
