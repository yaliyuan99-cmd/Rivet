import type { AppContext } from '../context.ts';
import { newId } from './ids.ts';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  subjectCode?: string | null;
  workspaceId?: string | null;
  detail?: Record<string, unknown>;
}

/** Every consequential decision is recorded here. The table refuses edits and deletes. */
export async function audit(ctx: AppContext, entry: AuditEntry): Promise<void> {
  await ctx.db.run(
    `INSERT INTO audit_log (id, actor_id, action, subject_type, subject_id, subject_code, workspace_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), entry.actorId ?? null, entry.action, entry.subjectType, entry.subjectId ?? null, entry.subjectCode ?? null, entry.workspaceId ?? null, JSON.stringify(entry.detail ?? {}), ctx.now().toISOString()],
  );
}
