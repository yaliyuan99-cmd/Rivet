import type { AppContext } from '../../context.ts';
import { canonicalJson, hashPassword } from '../../lib/crypto.ts';
import { DEFAULT_SETTINGS, DEMO_MODELS, DS_BIO_07_CSV, DS_BIO_08_CSV, DS_BIO_09_CSV, STARTER_PROMPT, STARTER_RUBRIC, STARTER_TITLE, demoPdf } from '../../lib/demoFixtures.ts';
import { RUNNER_VERSION, evidenceHash, reportHash, taskVersionHash } from '../../lib/evidence.ts';
import { newId, setCounter } from '../../lib/ids.ts';

/** Every demo account shares this password. It only ever exists on a seeded local instance. */
export const DEMO_PASSWORD = 'rivet-demo-2026';

export interface SeedRefs {
  users: { maya: string; samira: string; alex: string; lena: string };
  workspaces: { helix: string; northbridge: string };
  tasks: { bio041: string; bio042: string; bio043: string };
  versions: { bio041: string; bio042: string };
  run1042: string;
  evidence: { a: string; m: string; l: string };
  review042: string;
  adjudication042: string;
  report042: string;
  datasets: { ds07: string; ds08: string; ds09: string };
  datasetVersions: { ds07: string; ds08: string; ds09: string };
  scan042: string;
}

const at = (time: string) => `2026-10-15T${time}.000Z`;

function parseSimpleCsv(text: string): Record<string, string>[] {
  // Authored fixtures only; uploaded files go through the real parser in server/lib/csv.ts.
  const rows = text.trim().split('\n').map((line) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) {
        cells.push(cell);
        cell = '';
      } else cell += char;
    }
    cells.push(cell);
    return cells;
  });
  const header = rows[0] as string[];
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

/**
 * The frames show DS-BIO-07 as a 48 KB file. Each record carries an authored plate readout, so the
 * bytes really are that size. Deterministic, so the seeded hash never changes. Not real measurements.
 */
function withPlateReadouts(csv: string): string {
  const [header, ...rows] = csv.trim().split('\n');
  const two = (n: number) => String(n).padStart(2, '0');
  let state = 42;
  const readout = () => {
    const wells: string[] = [];
    for (let plate = 1; plate <= 12; plate += 1) {
      for (const row of 'ABCDEFGH') {
        for (let column = 1; column <= 12; column += 1) {
          state = (state * 48271) % 2147483647;
          wells.push(`P${two(plate)}:${row}${two(column)}=0.${String(state % 1000).padStart(3, '0')}`);
        }
      }
    }
    return wells.join(';');
  };
  return `${header},plate_readout\n${rows.map((row) => `${row},${readout()}`).join('\n')}\n`;
}

export async function seedBackbone(ctx: AppContext): Promise<SeedRefs> {
  const { db, storage } = ctx;
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  /* ---------- People ---------- */
  const users = { maya: newId(), samira: newId(), alex: newId(), lena: newId() };
  const workspaces = { helix: newId(), northbridge: newId() };
  const people = [
    [users.maya, 'maya@helixlab.example', 'Maya Chen', 'member', 'Microbiology researcher exploring evidence-grounded AI evaluation at Helix Lab.', workspaces.helix, at('13:00:00')],
    [users.samira, 'samira@northbridge.example', 'Dr. Samira Patel', 'member', 'Microbiologist studying efflux and antimicrobial susceptibility. Synthetic demo profile.', workspaces.northbridge, at('12:50:00')],
    [users.alex, 'alex@rivet.example', 'Alex Rivera', 'admin', 'Rivet administrator. Synthetic demo profile.', null, at('09:00:00')],
    [users.lena, 'lena@northbridge.example', 'Dr. Lena Ortiz', 'member', 'Synthetic demo profile.', null, at('13:10:00')],
  ] as const;
  for (const [id, email, name, role, bio, workspace, created] of people) {
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified_at, role, bio, active_workspace_id, terms_accepted_at, is_synthetic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, email, name, passwordHash, created, role, bio, workspace, created, created, created],
    );
  }

  await db.run(
    `INSERT INTO workspaces (id, code, name, slug, research_focus, default_visibility, owner_id, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, 'private', ?, 1, ?)`,
    [workspaces.helix, 'WS-HELIX', 'Helix Lab', 'helix-lab', 'Evidence-grounded evaluation for microbiology and antimicrobial resistance.', users.maya, at('13:20:00')],
  );
  await db.run(
    `INSERT INTO workspaces (id, code, name, slug, research_focus, default_visibility, owner_id, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, 'private', ?, 1, ?)`,
    [workspaces.northbridge, 'WS-NORTHBRIDGE', 'Northbridge Microbiology', 'northbridge-microbiology', 'Synthetic demo workspace for shared review tasks.', users.samira, at('12:55:00')],
  );
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`, [newId(), workspaces.helix, users.maya, at('13:20:00')]);
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`, [newId(), workspaces.northbridge, users.samira, at('12:55:00')]);

  /* ---------- Illustrative models ---------- */
  for (const model of DEMO_MODELS) {
    await db.run(
      `INSERT INTO models (id, display_name, short_name, letter, revision, adapter, adapter_label, context_k, output_k, cutoff_disclosure, enabled, is_illustrative, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'demo', 'Rivet Demo / Synthetic response adapter', ?, ?, 'Unknown / Not claimed', 1, 1, ?, ?, ?)`,
      [model.id, model.displayName, model.shortName, model.letter, model.revision, model.contextK, model.outputK, model.sort, at('09:00:00'), at('09:00:00')],
    );
  }

  /* ---------- Reviewer applications and credentials ---------- */
  const putUpload = async (bytes: Uint8Array, filename: string, mime: string, ownerId: string, purpose: string, created: string) => {
    const stored = await storage.put(bytes);
    const id = newId();
    await db.run(`INSERT INTO uploads (id, sha256, filename, size, mime, owner_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, stored.sha256, filename, stored.size, mime, ownerId, purpose, created]);
    return { id, ...stored };
  };

  const patelPdf = await putUpload(demoPdf(['SYNTHETIC DEMO FIXTURE', 'Not a real certificate.', 'Dr. Samira Patel', 'PhD, Microbiology, 2018', 'Northbridge (fictional institution)']), 'patel-phd-demo.pdf', 'application/pdf', users.samira, 'credential', at('13:04:00'));
  const app028 = newId();
  await db.run(
    `INSERT INTO applications (id, code, user_id, domain_id, legal_name, institutional_email, research_background, evidence_upload_id, research_profile_url, commitment_ack, status, admin_note, submitted_at, decided_at, decided_by, is_synthetic, created_at, updated_at)
     VALUES (?, 'APP-028', ?, 'biology', 'Dr. Samira Patel', 'samira@northbridge.example', ?, ?, 'orcid.example/0000-0002-0420-0280', 1, 'verified', ?, ?, ?, ?, 1, ?, ?)`,
    [
      app028,
      users.samira,
      'PhD in Microbiology; eight years studying efflux and antimicrobial susceptibility. Expertise in experimental controls, source attribution and mechanistic claims.',
      patelPdf.id,
      'Identity, affiliation and domain evidence are consistent in this synthetic fixture. Grant Biology only; no other review domains.',
      at('13:05:00'),
      at('13:40:00'),
      users.alex,
      at('13:02:00'),
      at('13:40:00'),
    ],
  );
  await db.run(
    `INSERT INTO credentials (id, user_id, domain_id, application_id, rationale, granted_by, granted_at) VALUES (?, ?, 'biology', ?, ?, ?, ?)`,
    [newId(), users.samira, app028, 'Identity, affiliation and domain evidence are consistent in this synthetic fixture. Grant Biology only; no other review domains.', users.alex, at('13:40:00')],
  );

  // A waiting application, so an administrator has a real credential decision to make.
  const ortizPdf = await putUpload(demoPdf(['SYNTHETIC DEMO FIXTURE', 'Not a real certificate.', 'Dr. Lena Ortiz', 'PhD, Microbiology, 2020', 'Northbridge (fictional institution)']), 'ortiz-phd-demo.pdf', 'application/pdf', users.lena, 'credential', at('13:12:00'));
  await db.run(
    `INSERT INTO applications (id, code, user_id, domain_id, legal_name, institutional_email, research_background, evidence_upload_id, research_profile_url, commitment_ack, status, submitted_at, is_synthetic, created_at, updated_at)
     VALUES (?, 'APP-029', ?, 'biology', 'Dr. Lena Ortiz', 'lena@northbridge.example', ?, ?, 'orcid.example/0000-0002-0420-0299', 1, 'pending', ?, 1, ?, ?)`,
    [newId(), users.lena, 'PhD in Microbiology; six years studying membrane permeability and resistance phenotypes. Synthetic demo application.', ortizPdf.id, at('13:15:00'), at('13:12:00'), at('13:15:00')],
  );

  /* ---------- Datasets ---------- */
  const encoder = new TextEncoder();
  const datasetSeed = async (spec: { code: string; name: string; provenance: string; version: string; filename: string; csv: string; created: string; columns: string[] }) => {
    const datasetId = newId();
    const versionId = newId();
    const upload = await putUpload(encoder.encode(spec.csv), spec.filename, 'text/csv', users.maya, 'dataset', spec.created);
    const records = parseSimpleCsv(spec.csv);
    const receipt = {
      format: 'csv',
      encoding: 'UTF-8',
      requiredColumns: { expected: ['source_id', 'observation', 'provenance'], missing: [], passed: 3, total: 3 },
      columns: Object.keys(records[0] ?? {}),
      recordsParsed: records.length,
      duplicateSourceIds: 0,
      missingSourceIds: 0,
      sensitiveData: { flags: [], note: 'No flags', scanned: true },
      synthetic: true,
      failures: [],
      passed: true,
    };
    await db.run(
      `INSERT INTO datasets (id, code, workspace_id, owner_id, domain_id, name, provenance, visibility, is_synthetic, created_at) VALUES (?, ?, ?, ?, 'biology', ?, ?, 'private', 1, ?)`,
      [datasetId, spec.code, workspaces.helix, users.maya, spec.name, spec.provenance, spec.created],
    );
    await db.run(
      `INSERT INTO dataset_versions (id, dataset_id, version, upload_id, filename, size, format, sha256, records_count, records, receipt, provenance, is_synthetic, rights_ack, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'csv', ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [versionId, datasetId, spec.version, upload.id, spec.filename, upload.size, upload.sha256, records.length, JSON.stringify(records), JSON.stringify(receipt), spec.provenance, users.maya, spec.created],
    );
    return { datasetId, versionId, sha256: upload.sha256 };
  };
  const ds07 = await datasetSeed({
    code: 'DS-BIO-07',
    name: 'Resistance evidence pack',
    provenance: 'Authored by Maya Chen for this evaluation-design demo. CC0 demo fixtures. Not real laboratory data; never use for clinical or scientific recommendations.',
    version: '1.0',
    filename: 'resistance-evidence-demo.csv',
    csv: withPlateReadouts(DS_BIO_07_CSV),
    created: at('14:10:00'),
    columns: [],
  });
  const ds08 = await datasetSeed({ code: 'DS-BIO-08', name: 'Efflux control checklist', provenance: 'Authored demo checklist. Not experimental data.', version: '1.0', filename: 'efflux-control-checklist-demo.csv', csv: DS_BIO_08_CSV, created: at('14:05:00'), columns: [] });
  const ds09 = await datasetSeed({ code: 'DS-BIO-09', name: 'Rubric calibration notes', provenance: 'Authored demo notes. Not experimental data.', version: '0.2', filename: 'rubric-calibration-notes-demo.csv', csv: DS_BIO_09_CSV, created: at('14:00:00'), columns: [] });

  const activity = [
    [ds07.datasetId, 'Upload', 'Maya Chen uploaded resistance-evidence-demo.csv', at('14:10:00')],
    [ds07.datasetId, 'Validation', '3 records parsed; no missing source IDs', at('14:12:00')],
    [ds07.datasetId, 'Task attachment', 'DS-BIO-07 v1.0 pinned to BIO-042', at('14:20:00')],
  ] as const;
  for (const [datasetId, kind, message, created] of activity) {
    await db.run(`INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [newId(), workspaces.helix, datasetId, kind, message, users.maya, created]);
  }

  /* ---------- Tasks ---------- */
  const tasks = { bio041: newId(), bio042: newId(), bio043: newId() };
  const versions = { bio041: newId(), bio042: newId() };
  const pinnedModels = DEMO_MODELS.map((model) => ({ id: model.id, displayName: model.displayName, shortName: model.shortName, letter: model.letter, revision: model.revision, adapter: 'demo', contextK: model.contextK, outputK: model.outputK }));
  const scan042 = newId();

  const findings = {
    exactPrompt: { status: 'clear', label: 'Exact prompt match', detail: 'No match in scanned indexes.' },
    nearDuplicate: { status: 'low', label: 'Near-duplicate phrase', detail: '“increased AcrAB-TolC efflux” · Low risk', phrases: ['increased AcrAB-TolC efflux'] },
    sourceExposure: { status: 'clear', label: 'Source exposure', detail: 'E01–E03 synthetic and private; no public match.' },
    trainingCoverage: { status: 'unknown', label: 'Training corpus coverage', detail: 'Not accessible to Rivet · Unknown' },
    summary: 'One possible terminology overlap. This signal is not proof of training contamination.',
    acknowledgementText: 'The matching phrase is standard terminology. These source records were authored for this synthetic demo. Training exposure cannot be ruled out.',
    retentionText: 'Retain the scan and its limitations with every frozen report.',
  };
  const acknowledgements = [findings.acknowledgementText, findings.retentionText];

  await db.run(
    `INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, prompt, rubric, model_ids, settings, dataset_version_id, visibility, status, draft_version, latest_version_id, is_synthetic, draft_saved_at, created_at, updated_at)
     VALUES (?, 'BIO-042', ?, ?, 'biology', ?, ?, ?, ?, ?, ?, 'private', 'frozen', '1.1', ?, 1, ?, ?, ?)`,
    [tasks.bio042, workspaces.helix, users.maya, STARTER_TITLE, STARTER_PROMPT, JSON.stringify(STARTER_RUBRIC), JSON.stringify(DEMO_MODELS.map((m) => m.id)), JSON.stringify(DEFAULT_SETTINGS), ds07.versionId, versions.bio042, at('14:20:00'), at('14:15:00'), at('14:25:00')],
  );
  await db.run(`UPDATE tasks SET short_title = ?, featured_note = ? WHERE id = ?`, [
    'Antibiotic resistance mechanism',
    'Evaluate a causal claim against three source fixtures. Compare mechanistic reasoning, source attribution, alternatives and calibrated conclusions with a 100-point rubric.',
    tasks.bio042,
  ]);
  await db.run(
    `INSERT INTO scans (id, code, task_id, input_hash, findings, risk, created_by, created_at) VALUES (?, 'SCAN-042', ?, ?, ?, 'low', ?, ?)`,
    [scan042, tasks.bio042, 'seed', JSON.stringify(findings), users.maya, at('14:24:00')],
  );
  const bio042Hash = taskVersionHash({
    task_code: 'BIO-042',
    version: '1.0',
    title: STARTER_TITLE,
    prompt: STARTER_PROMPT,
    rubric: STARTER_RUBRIC,
    models: pinnedModels,
    settings: DEFAULT_SETTINGS,
    dataset_sha256: ds07.sha256,
    scan_code: 'SCAN-042',
    acknowledgements,
  });
  await db.run(
    `INSERT INTO task_versions (id, task_id, version, title, prompt, rubric, models, settings, dataset_version_id, scan_id, acknowledgements, sha256, frozen_by, frozen_at)
     VALUES (?, ?, '1.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versions.bio042, tasks.bio042, STARTER_TITLE, STARTER_PROMPT, JSON.stringify(STARTER_RUBRIC), JSON.stringify(pinnedModels), JSON.stringify(DEFAULT_SETTINGS), ds07.versionId, scan042, JSON.stringify(acknowledgements), bio042Hash, users.maya, at('14:25:00')],
  );

  // BIO-041: shared and read-only for everyone but its owner.
  const bio041Title = 'Efflux versus permeability';
  const bio041Prompt = 'Using the supplied observations, compare increased efflux and reduced outer-membrane permeability as explanations for the resistance phenotype. State what each observation can and cannot distinguish, then propose one experiment that separates the two.';
  const bio041Rubric = [
    { name: 'Distinguishing evidence', short: 'Distinguishing evidence', points: 40, guidance: 'Say what each observation can and cannot separate.' },
    { name: 'Experimental design', short: 'Experiment', points: 40, guidance: 'Propose a controlled experiment that separates the explanations.' },
    { name: 'Calibrated conclusion', short: 'Calibration', points: 20, guidance: 'State uncertainty; do not overclaim.' },
  ];
  await db.run(
    `INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, prompt, rubric, model_ids, settings, visibility, status, draft_version, latest_version_id, is_synthetic, draft_saved_at, created_at, updated_at)
     VALUES (?, 'BIO-041', ?, ?, 'biology', ?, ?, ?, ?, ?, 'shared', 'frozen', '1.1', ?, 1, ?, ?, ?)`,
    [tasks.bio041, workspaces.northbridge, users.samira, bio041Title, bio041Prompt, JSON.stringify(bio041Rubric), JSON.stringify(DEMO_MODELS.map((m) => m.id)), JSON.stringify(DEFAULT_SETTINGS), versions.bio041, at('12:58:00'), at('12:56:00'), at('13:00:00')],
  );
  const bio041Findings = {
    exactPrompt: { status: 'clear', label: 'Exact prompt match', detail: 'No match in scanned indexes.' },
    nearDuplicate: { status: 'clear', label: 'Near-duplicate phrase', detail: 'No match in scanned indexes.', phrases: [] },
    sourceExposure: { status: 'clear', label: 'Source exposure', detail: 'No attached source pack.' },
    trainingCoverage: { status: 'unknown', label: 'Training corpus coverage', detail: 'Not accessible to Rivet · Unknown' },
    summary: 'No overlap found in the indexes Rivet can scan.',
    acknowledgementText: 'Training exposure cannot be ruled out.',
    retentionText: 'Retain the scan and its limitations with every frozen report.',
  };
  const scan041 = newId();
  await db.run(`INSERT INTO scans (id, code, task_id, input_hash, findings, risk, created_by, created_at) VALUES (?, 'SCAN-041', ?, ?, ?, 'none', ?, ?)`, [scan041, tasks.bio041, 'seed', JSON.stringify(bio041Findings), users.samira, at('12:59:00')]);
  const bio041Ack = [bio041Findings.acknowledgementText, bio041Findings.retentionText];
  await db.run(
    `INSERT INTO task_versions (id, task_id, version, title, prompt, rubric, models, settings, dataset_version_id, scan_id, acknowledgements, sha256, frozen_by, frozen_at)
     VALUES (?, ?, '1.0', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      versions.bio041,
      tasks.bio041,
      bio041Title,
      bio041Prompt,
      JSON.stringify(bio041Rubric),
      JSON.stringify(pinnedModels),
      JSON.stringify(DEFAULT_SETTINGS),
      scan041,
      JSON.stringify(bio041Ack),
      taskVersionHash({ task_code: 'BIO-041', version: '1.0', title: bio041Title, prompt: bio041Prompt, rubric: bio041Rubric, models: pinnedModels, settings: DEFAULT_SETTINGS, dataset_sha256: null, scan_code: 'SCAN-041', acknowledgements: bio041Ack }),
      users.samira,
      at('13:00:00'),
    ],
  );

  // BIO-043: a draft Maya can take through the whole flow live.
  await db.run(
    `INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, prompt, rubric, model_ids, settings, dataset_version_id, visibility, status, draft_version, is_synthetic, draft_saved_at, created_at, updated_at)
     VALUES (?, 'BIO-043', ?, ?, 'biology', 'Limits of inhibitor controls', ?, ?, ?, ?, ?, 'private', 'draft', '0.1', 1, ?, ?, ?)`,
    [
      tasks.bio043,
      workspaces.helix,
      users.maya,
      'Using E03 and the control checklist, explain what an efflux-pump inhibitor result can and cannot show about mechanism. Name the off-target effects that must be excluded before a causal claim, and propose the controls that would exclude them.',
      JSON.stringify([
        { name: 'Inhibitor interpretation', short: 'Interpretation', points: 40, guidance: 'Separate what the inhibitor result shows from what it does not.' },
        { name: 'Off-target reasoning', short: 'Off-target', points: 30, guidance: 'Name specific off-target effects and why they matter.' },
        { name: 'Control design', short: 'Controls', points: 30, guidance: 'Propose controls that exclude the named effects.' },
      ]),
      JSON.stringify(DEMO_MODELS.map((m) => m.id)),
      JSON.stringify(DEFAULT_SETTINGS),
      ds07.versionId,
      at('14:50:00'),
      at('14:45:00'),
      at('14:50:00'),
    ],
  );

  /* ---------- RUN-1042: complete, on its second attempt ---------- */
  const run1042 = newId();
  await db.run(
    `INSERT INTO runs (id, code, task_id, task_version_id, owner_id, status, interrupt_reason, interrupt_message, interrupted_at, stages_total, stages_done, attempt, last_checkpoint_code, last_checkpoint_at, active_ms, started_at, finished_at, created_at)
     VALUES (?, 'RUN-1042', ?, ?, ?, 'complete', NULL, NULL, NULL, 9, 9, 2, 'CP-009', ?, ?, ?, ?, ?)`,
    [run1042, tasks.bio042, versions.bio042, users.maya, at('14:43:10'), 283_000, at('14:31:44'), at('14:43:10'), at('14:31:44')],
  );
  await db.run(`UPDATE runs SET consequential_difference = ? WHERE id = ?`, ['Aster distinguishes a plausible efflux mechanism from a causal claim. Its attribution deduction reflects a missing inhibitor-specificity caveat.', run1042]);

  const authored = [
    {
      model: DEMO_MODELS[0]!,
      code: 'EV-1042-A',
      output: 'The fourfold MIC shift is consistent with an efflux contribution [E01]. Increased acrB expression and inhibitor sensitivity support this hypothesis [E02, E03]. These observations do not establish AcrAB-TolC as the sole cause. A controlled deletion and complementation experiment would discriminate alternatives.',
      scores: [28, 25, 20, 13],
      notes: ['Plausible, not proven', 'Inhibitor caveat missing', 'Permeability discussed briefly', 'Discriminating follow-up'],
      times: ['14:32:08', '14:32:10', '14:32:11'],
    },
    {
      model: DEMO_MODELS[1]!,
      code: 'EV-1042-M',
      output: 'The MIC rises from 0.25 to 1.00 µg/mL [E01] and acrB transcript is 3.1× control [E02], which together suggest that efflux contributes to the phenotype. Partial MIC reversal with the inhibitor points the same way [E03]. Reduced permeability could also contribute and has not been excluded. A deletion strain would help confirm the mechanism.',
      scores: [26, 23, 20, 12],
      notes: ['Reasonable link to the MIC shift', 'E03 specificity not questioned', 'Permeability named, not examined', 'Follow-up stated without controls'],
      times: ['14:33:46', '14:33:58', '14:34:02'],
    },
    {
      model: DEMO_MODELS[2]!,
      code: 'EV-1042-L',
      output: 'Ciprofloxacin resistance here is probably driven by increased AcrAB-TolC efflux: the MIC increased fourfold [E01], acrB expression is higher [E02], and the inhibitor partly reverses the shift [E03]. Other mechanisms may play a role. Further experiments are recommended.',
      scores: [24, 20, 18, 12],
      notes: ['Leans towards causal language', 'Citations present; limits not stated', 'Alternatives only gestured at', 'No discriminating experiment named'],
      times: ['14:42:40', '14:43:02', '14:43:10'],
    },
  ];

  let stageSeq = 1;
  const logLines: [string, string][] = [[at('14:31:44'), 'Attempt 1 started on the frozen BIO-042 v1.0 contract']];
  const evidence = { a: '', m: '', l: '' };
  for (const item of authored) {
    const scores = STARTER_RUBRIC.map((criterion, index) => ({ name: criterion.name, short: criterion.short, points: criterion.points, score: item.scores[index], rationale: item.notes[index] }));
    const total = item.scores.reduce((sum, value) => sum + value, 0);
    const meta = { adapter: 'demo', synthetic: true };
    const captured = at(item.times[2]!);
    const sha256 = evidenceHash({
      code: item.code,
      run_code: 'RUN-1042',
      task_version_hash: bio042Hash,
      model_id: item.model.id,
      model_revision: item.model.revision,
      output_text: item.output,
      output_meta: meta,
      scores,
      total_score: total,
      score_label: 'demo',
      runner_version: RUNNER_VERSION,
      captured_at: captured,
    });
    const id = newId();
    await db.run(
      `INSERT INTO evidence (id, code, run_id, task_id, task_version_id, model_id, model_revision, output_text, output_meta, scores, total_score, score_label, runner_version, sha256, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?, ?)`,
      [id, item.code, run1042, tasks.bio042, versions.bio042, item.model.id, item.model.revision, item.output, JSON.stringify(meta), JSON.stringify(scores), total, RUNNER_VERSION, sha256, captured],
    );
    if (item.model.letter === 'A') evidence.a = id;
    if (item.model.letter === 'M') evidence.m = id;
    if (item.model.letter === 'L') evidence.l = id;
    await db.run(`INSERT INTO run_outputs (run_id, model_id, output_text, output_meta, scores, total_score, score_label) VALUES (?, ?, ?, ?, ?, ?, 'demo')`, [run1042, item.model.id, item.output, JSON.stringify(meta), JSON.stringify(scores), total]);
    const kinds = ['output', 'score', 'seal'] as const;
    for (const [index, kind] of kinds.entries()) {
      const finished = at(item.times[index]!);
      await db.run(
        `INSERT INTO run_stages (id, run_id, model_id, seq, kind, status, attempt, started_at, finished_at) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?)`,
        [newId(), run1042, item.model.id, stageSeq, kind, item.model.letter === 'L' ? 2 : 1, finished, finished],
      );
      await db.run(`INSERT INTO checkpoints (id, run_id, code, stages_done, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [newId(), run1042, `CP-${String(stageSeq).padStart(3, '0')}`, stageSeq, item.model.letter === 'L' ? 2 : 1, finished]);
      stageSeq += 1;
    }
    logLines.push([at(item.times[0]!), `${item.model.shortName} output captured`]);
    logLines.push([at(item.times[1]!), `${item.model.shortName} rubric score committed`]);
    logLines.push([at(item.times[2]!), `${item.code} hash verified`]);
    if (item.model.letter === 'M') {
      logLines.push([at('14:34:02'), 'CP-006 committed']);
      logLines.push([at('14:34:03'), 'Rubric scoring started']);
      logLines.push([at('14:34:41'), 'Provider timeout. Safe checkpoint at CP-006; owner can resume']);
      logLines.push([at('14:41:20'), 'Attempt 2 started from CP-006. Only unfinished stages are retried']);
    }
  }
  logLines.push([at('14:43:10'), 'CP-009 committed. Run complete']);
  for (const [index, [when, message]] of logLines.entries()) {
    await db.run(`INSERT INTO run_log (id, run_id, at, message, seq) VALUES (?, ?, ?, ?, ?)`, [newId(), run1042, when, message, index + 1]);
  }

  /* ---------- REVIEW-042, ADJ-042, RPT-BIO-042 v1.0 ---------- */
  const review042 = newId();
  const recommendations = Object.fromEntries(
    authored.map((item) => [
      item.code,
      {
        annotation:
          item.code === 'EV-1042-A'
            ? 'Attribution 25/30: E03 is not pump-specific causal evidence. Five points withheld for the missing inhibitor off-target caveat. All sources are authored synthetic fixtures.'
            : item.code === 'EV-1042-M'
              ? 'Attribution 23/30: citations are present, but E03 is treated as stronger than it is. All sources are authored synthetic fixtures.'
              : 'Attribution 20/30: the phrase “probably driven” overstates E01–E03. All sources are authored synthetic fixtures.',
        criteria: STARTER_RUBRIC.map((criterion, index) => ({ name: criterion.name, short: criterion.short, points: criterion.points, score: item.scores[index], note: item.notes[index] })),
      },
    ]),
  );
  const finding = 'Uphold the ordering for this task. The report must retain the inhibitor-specificity caveat, n = 1 limitation and unknown training exposure. These scores cannot be generalized to Biology performance.';
  await db.run(
    `INSERT INTO reviews (id, code, task_id, task_version_id, run_id, requested_by, expert_id, status, assessment, recommendations, rationale, finding, conflict_ack, draft_saved_at, submitted_at, created_at)
     VALUES (?, 'REVIEW-042', ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      review042,
      tasks.bio042,
      versions.bio042,
      run1042,
      users.maya,
      users.samira,
      'The model treats the MIC shift as association. E03 supports efflux involvement but does not establish pump specificity. A deletion-and-rescue experiment is an appropriate follow-up.',
      JSON.stringify(recommendations),
      'Uphold Aster 86/100. E01–E03 support an efflux hypothesis, not causal attribution. Meridian 81 and Lumen 74 are consistent with the same rubric.',
      finding,
      at('15:05:00'),
      at('15:10:00'),
      at('14:50:00'),
    ],
  );

  const report042 = newId();
  const adjudication042 = newId();
  const adjudicationRationale = 'Uphold all three demo scores. Preserve evidence limits and contamination-scan acknowledgement. Freeze as RPT-BIO-042 v1.0.';
  await db.run(
    `INSERT INTO adjudications (id, code, review_id, task_version_id, admin_id, decision, rationale, checks_ack, report_id, created_at) VALUES (?, 'ADJ-042', ?, ?, ?, 'accept', ?, 1, ?, ?)`,
    [adjudication042, review042, versions.bio042, users.alex, adjudicationRationale, report042, at('15:30:00')],
  );

  const reportScores = authored.map((item) => ({ modelId: item.model.id, displayName: item.model.displayName, score: item.scores.reduce((sum, value) => sum + value, 0), label: 'demo', evidenceCode: item.code }));
  const headline = 'Efflux is supported; causality is not established.';
  const summary = 'Aster provides the strongest evidence-grounded answer to this synthetic task. Every output would benefit from explicit discussion of inhibitor specificity. These findings do not establish real model capability.';
  const limitations = 'n = 1 task. No population confidence interval. E01–E03 are authored fixtures, not measurements. A low-risk terminology overlap was acknowledged; model training exposure remains unknown.';
  const citation = `Chen, M. (2026). BIO-042: ${STARTER_TITLE}. Rivet, RPT-BIO-042 v1.0. Synthetic demo report.`;
  const canonical = canonicalJson({
    schema: 'rivet.report.v1',
    code: 'RPT-BIO-042',
    version: '1.0',
    task: { code: 'BIO-042', version: '1.0', sha256: bio042Hash },
    run: 'RUN-1042',
    evidence: authored.map((item) => item.code),
    review: 'REVIEW-042',
    adjudication: 'ADJ-042',
    scan: 'SCAN-042',
    owner: 'Maya Chen',
    expert: 'Dr. Samira Patel',
    admin: 'Alex Rivera',
    headline,
    summary,
    limitations,
    scores: reportScores,
    citation,
    frozenAt: at('15:30:00'),
    synthetic: true,
  });
  await db.run(
    `INSERT INTO reports (id, code, version, task_id, task_version_id, run_id, review_id, adjudication_id, owner_id, expert_id, admin_id, domain_id, headline, summary, limitations, scores, citation, canonical, sha256, frozen_at, is_synthetic)
     VALUES (?, 'RPT-BIO-042', '1.0', ?, ?, ?, ?, ?, ?, ?, ?, 'biology', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [report042, tasks.bio042, versions.bio042, run1042, review042, adjudication042, users.maya, users.samira, users.alex, headline, summary, limitations, JSON.stringify(reportScores), citation, canonical, reportHash(canonical), at('15:30:00')],
  );

  /* ---------- Counters continue from the authored fixtures ---------- */
  await setCounter(db, 'task:BIO', 43);
  await setCounter(db, 'run', 1042);
  await setCounter(db, 'dataset:BIO', 9);
  await setCounter(db, 'application', 29);
  await setCounter(db, 'review', 42);
  await setCounter(db, 'adjudication', 42);

  return {
    users,
    workspaces,
    tasks,
    versions,
    run1042,
    evidence,
    review042,
    adjudication042,
    report042,
    datasets: { ds07: ds07.datasetId, ds08: ds08.datasetId, ds09: ds09.datasetId },
    datasetVersions: { ds07: ds07.versionId, ds08: ds08.versionId, ds09: ds09.versionId },
    scan042,
  };
}
