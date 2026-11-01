import type { AdvisorCitation } from '../../../shared/types/advisor.ts';
import type { AppContext } from '../../context.ts';
import { runSystemChecks } from '../../engine/checks.ts';
import { audit } from '../../lib/audit.ts';
import { sha256Hex } from '../../lib/crypto.ts';
import { newId, setCounter } from '../../lib/ids.ts';
import type { SeedRefs } from './backbone.ts';

const at = (time: string) => `2026-10-15T${time}.000Z`;

/** The frame's question and answer, word for word. Authored, and labelled as such on the page. */
const SEEDED_QUESTION = 'Why did Aster lose points on evidence attribution? Does the inhibitor result prove efflux caused resistance?';
const SEEDED_ANSWER =
  'No. E03 supports an efflux hypothesis, but not pump-specific causality. Aster received 25/30 for attribution because it omitted inhibitor off-target effects. No pump deletion or rescue control is present. [1]\n\n' +
  'The expert upheld the deduction. E01’s MIC shift and E02’s increased acrB expression are consistent with the hypothesis, but alternatives remain. A deletion-and-complementation experiment would be more discriminating. [2, 3]';
const SEEDED_CITATIONS: AdvisorCitation[] = [
  { n: 1, label: 'EV-1042-A', detail: 'Attribution rationale / 25 of 30', to: '/evidence/EV-1042-A' },
  { n: 2, label: 'DS-BIO-07 v1.0', detail: 'E01–E03 synthetic source records', to: '/datasets/DS-BIO-07' },
  { n: 3, label: 'REVIEW-042', detail: 'Dr. Samira Patel / Verified Biology', to: '/review/REVIEW-042' },
];

export async function seedAdmin(ctx: AppContext, refs: SeedRefs): Promise<void> {
  const { db } = ctx;

  /* Maya's Advisor thread on BIO-042 v1.0. */
  const thread = newId();
  await db.run('INSERT INTO advisor_threads (id, user_id, task_version_id, created_at) VALUES (?, ?, ?, ?)', [thread, refs.users.maya, refs.versions.bio042, at('15:38:00')]);
  await db.run(
    `INSERT INTO advisor_messages (id, thread_id, role, content, citations, insufficient, mode, seq, created_at) VALUES (?, ?, 'user', ?, '[]', 0, 'authored', 1, ?)`,
    [newId(), thread, SEEDED_QUESTION, at('15:38:00')],
  );
  await db.run(
    `INSERT INTO advisor_messages (id, thread_id, role, content, citations, insufficient, mode, seq, created_at) VALUES (?, ?, 'assistant', ?, ?, 0, 'authored', 2, ?)`,
    [newId(), thread, SEEDED_ANSWER, JSON.stringify(SEEDED_CITATIONS), at('15:38:00')],
  );

  /* One earlier metadata revision, so the history has the frame's rationale in it. */
  await db.run(
    `INSERT INTO model_revisions (id, model_id, editor_id, rationale, changes, created_at) VALUES (?, 'aster-3.2', ?, ?, ?, ?)`,
    [newId(), refs.users.alex, 'Clarify provenance and cutoff disclosure. No change to the pinned revision.', JSON.stringify({ cutoffDisclosure: { from: 'Not stated', to: 'Unknown / Not claimed' } }), at('09:30:00')],
  );

  /* The operational events the frame lists. The dataset one is only written if the bytes really match. */
  const storyAt = (time: string): AppContext => ({ ...ctx, now: () => new Date(at(time)) });
  const pack = await db.get<{ sha256: string }>('SELECT sha256 FROM dataset_versions WHERE id = ?', [refs.datasetVersions.ds07]);
  if (pack && sha256Hex(await ctx.storage.read(pack.sha256)) === pack.sha256) {
    await audit(storyAt('14:32:00'), { actorId: refs.users.maya, action: 'dataset.manifest_verified', subjectType: 'dataset', subjectId: refs.datasets.ds07, subjectCode: 'DS-BIO-07', workspaceId: refs.workspaces.helix, detail: { message: 'Source manifest hash matched', sha256: pack.sha256 } });
  }
  await audit(storyAt('13:40:00'), { actorId: refs.users.alex, action: 'credential.granted', subjectType: 'application', subjectCode: 'APP-028', detail: { message: 'Biology credential verified / Dr. Samira Patel', domain: 'biology' } });

  /* Real receipts: the engine runs now, over everything every slice has seeded, on the story's clock. */
  await setCounter(db, 'check', 290);
  await runSystemChecks(storyAt('14:42:00'), refs.users.alex);
}
