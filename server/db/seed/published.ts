import type { AppContext } from '../../context.ts';
import { newId } from '../../lib/ids.ts';
import type { SeedRefs } from './backbone.ts';

const SNAPSHOT = '2026-10-15T15:30:00.000Z';

/**
 * The Biology leaderboard sample: 24 authored tasks, as [label, Aster 3.2, Meridian 2.1, Lumen 4 Mini].
 * Not real measurements. BIO-042 v1.0 carries its seeded report's scores; the other 23 came from
 * scripts/tune-leaderboard-fixtures.ts, so the real bootstrap prints exactly what the frame shows:
 * Aster 87.4 [83.1, 91.2], Meridian 83.1 [78.5, 87.6], Lumen 77.8 [72.0, 83.4], n=24.
 */
export const AUTHORED_SCORES: [string, number, number, number][] = [
  ['BIO-042 v1.0', 86, 81, 74],
  ['BIO-F01 v1.0', 90, 99, 90],
  ['BIO-F02 v1.0', 90, 78, 79],
  ['BIO-F03 v1.0', 87, 98, 87],
  ['BIO-F04 v1.0', 87, 75, 90],
  ['BIO-F05 v1.0', 89, 92, 57],
  ['BIO-F06 v1.0', 91, 59, 75],
  ['BIO-F07 v1.0', 98, 73, 98],
  ['BIO-F08 v1.0', 100, 99, 83],
  ['BIO-F09 v1.0', 86, 78, 45],
  ['BIO-F10 v1.0', 81, 75, 63],
  ['BIO-F11 v1.0', 95, 76, 95],
  ['BIO-F12 v1.0', 96, 91, 71],
  ['BIO-F13 v1.0', 81, 79, 82],
  ['BIO-F14 v1.0', 62, 97, 77],
  ['BIO-F15 v1.0', 88, 89, 63],
  ['BIO-F16 v1.0', 82, 74, 75],
  ['BIO-F17 v1.0', 98, 95, 98],
  ['BIO-F18 v1.0', 83, 97, 69],
  ['BIO-F19 v1.0', 61, 62, 59],
  ['BIO-F20 v1.0', 77, 73, 68],
  ['BIO-F21 v1.0', 97, 80, 74],
  ['BIO-F22 v1.0', 93, 82, 95],
  ['BIO-F23 v1.0', 100, 92, 100],
];

const MODELS = ['aster-3.2', 'meridian-2.1', 'lumen-4-mini'];

export async function seedPublished(ctx: AppContext, refs: SeedRefs): Promise<void> {
  for (const [label, ...scores] of AUTHORED_SCORES) {
    const reportId = label === 'BIO-042 v1.0' ? refs.report042 : null;
    for (const [index, score] of scores.entries()) {
      await ctx.db.run(
        `INSERT INTO leaderboard_scores (id, domain_id, task_label, model_id, score, report_id, is_fixture, created_at) VALUES (?, 'biology', ?, ?, ?, ?, 1, ?)`,
        [newId(), label, MODELS[index], score, reportId, SNAPSHOT],
      );
    }
  }

  // REVIEW-042's one submission, so its history reads the same as a live review's.
  await ctx.db.run(
    `INSERT INTO review_submissions (id, review_id, seq, expert_id, assessment, recommendations, rationale, finding, conflict_ack, submitted_at)
     SELECT ?, id, 1, expert_id, assessment, recommendations, rationale, finding, conflict_ack, submitted_at FROM reviews WHERE id = ?`,
    [newId(), refs.review042],
  );
}
