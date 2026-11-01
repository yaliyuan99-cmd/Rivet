import type { AppContext, UserRow } from '../context.ts';

/**
 * The permission rules from the frames, in one place:
 * - Account role member/admin; workspace role owner/member; domain credentials per domain.
 * - Only the task owner runs, resumes or revises. Nobody reviews their own task.
 * - Expert review needs a verified credential in the task's domain. Final adjudication is admin only.
 * - A workspace role never grants credentials. Removing a membership revokes access on the next request.
 * - Every check reads current state; nothing is cached in the session.
 */

export type Verdict = { allowed: true } | { allowed: false; reason: string };
const yes: Verdict = { allowed: true };
const no = (reason: string): Verdict => ({ allowed: false, reason });

export interface TaskAccessRow {
  id: string;
  code: string;
  workspace_id: string;
  owner_id: string;
  domain_id: string;
  visibility: 'private' | 'shared';
  status: 'draft' | 'frozen';
}

export async function workspaceRole(ctx: AppContext, userId: string, workspaceId: string): Promise<'owner' | 'member' | null> {
  const row = await ctx.db.get<{ role: 'owner' | 'member' }>(`SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'`, [workspaceId, userId]);
  return row?.role ?? null;
}

export async function hasCredential(ctx: AppContext, userId: string, domainId: string): Promise<boolean> {
  const row = await ctx.db.get(`SELECT 1 AS ok FROM credentials WHERE user_id = ? AND domain_id = ? AND revoked_at IS NULL`, [userId, domainId]);
  return Boolean(row);
}

async function domainName(ctx: AppContext, domainId: string): Promise<string> {
  const row = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [domainId]);
  return row?.name ?? domainId;
}

/** Workspace members; the assigned expert; admins once a review exists; anyone verified if shared. */
export async function canReadTask(ctx: AppContext, user: UserRow, task: TaskAccessRow): Promise<Verdict> {
  if (task.owner_id === user.id) return yes;
  if (await workspaceRole(ctx, user.id, task.workspace_id)) return yes;
  if (task.visibility === 'shared' && task.status === 'frozen') return yes;
  const review = await ctx.db.get<{ expert_id: string | null; status: string }>(
    `SELECT expert_id, status FROM reviews WHERE task_id = ? AND (expert_id = ? OR status = 'requested') ORDER BY created_at DESC LIMIT 1`,
    [task.id, user.id],
  );
  if (review?.expert_id === user.id) return yes;
  if (review?.status === 'requested' && (await hasCredential(ctx, user.id, task.domain_id))) return yes;
  if (user.role === 'admin' && (await ctx.db.get('SELECT 1 AS ok FROM reviews WHERE task_id = ?', [task.id]))) return yes;
  return no('Only workspace members and explicitly authorized reviewers can access this task.');
}

export function canRunTask(user: UserRow, task: Pick<TaskAccessRow, 'owner_id'>): Verdict {
  return task.owner_id === user.id ? yes : no('Only the task owner can run this task.');
}

export function canResumeRun(user: UserRow, run: { owner_id: string }): Verdict {
  return run.owner_id === user.id ? yes : no('Only the task owner can resume a run.');
}

export function canReviseTask(user: UserRow, task: Pick<TaskAccessRow, 'owner_id'>): Verdict {
  return task.owner_id === user.id ? yes : no('Only the task owner can revise this task.');
}

/** "Review this task · You own this task" / "Verified Biology credential required" */
export async function canReviewTask(ctx: AppContext, user: UserRow, task: Pick<TaskAccessRow, 'owner_id' | 'domain_id'>): Promise<Verdict> {
  if (task.owner_id === user.id) return no('You own this task');
  if (await hasCredential(ctx, user.id, task.domain_id)) return yes;
  return no(`Verified ${await domainName(ctx, task.domain_id)} credential required`);
}

export function canAdjudicate(user: UserRow): Verdict {
  return user.role === 'admin' ? yes : no('Admin role required');
}

export function canVerifyCredential(user: UserRow): Verdict {
  return user.role === 'admin' ? yes : no('Admin role required');
}

export async function canManageMembers(ctx: AppContext, user: UserRow, workspaceId: string): Promise<Verdict> {
  return (await workspaceRole(ctx, user.id, workspaceId)) === 'owner' ? yes : no('Workspace owner only');
}

/** Members can create tasks and datasets inside a workspace they belong to. */
export async function canCreateInWorkspace(ctx: AppContext, user: UserRow, workspaceId: string): Promise<Verdict> {
  return (await workspaceRole(ctx, user.id, workspaceId)) ? yes : no('Join this workspace to create here.');
}

/** "Deletion requires dataset ownership or workspace-owner permission." */
export async function canDeleteDataset(ctx: AppContext, user: UserRow, dataset: { owner_id: string; workspace_id: string }): Promise<Verdict> {
  if (dataset.owner_id === user.id) return yes;
  if ((await workspaceRole(ctx, user.id, dataset.workspace_id)) === 'owner') return yes;
  return no('Dataset owner or workspace owner only');
}

export async function canReadDataset(ctx: AppContext, user: UserRow, dataset: { workspace_id: string; visibility: string; deleted_at?: string | null }): Promise<Verdict> {
  if (await workspaceRole(ctx, user.id, dataset.workspace_id)) return yes;
  if (dataset.visibility === 'shared' && !dataset.deleted_at) return yes;
  return no('Only members of this workspace can open this dataset.');
}
