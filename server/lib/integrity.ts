import type { AppContext } from '../context.ts';

/**
 * Why a new run may not start, for a route that wants to show the reason. The triggers at the end of
 * 60-advisor-admin.sql enforce the same rule underneath, so nothing depends on a route calling this.
 */
export async function integrityBlockReason(ctx: AppContext): Promise<string | null> {
  const failed = await ctx.db.get<{ code: string; label: string }>(
    `SELECT r.code, r.label FROM check_receipts r
     WHERE r.status = 'failed' AND r.check_key IN ('artifact_hashes', 'immutability')
       AND r.check_run_id = (SELECT id FROM check_runs ORDER BY rowid DESC LIMIT 1) ORDER BY r.rowid LIMIT 1`,
  );
  return failed ? `${failed.code} / ${failed.label} failed. Runs are blocked until the system checks pass.` : null;
}
