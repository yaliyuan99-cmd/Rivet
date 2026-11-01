import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { validateDatasetFile } from '../../server/lib/csv.ts';
import { newId } from '../../server/lib/ids.ts';
import { Client, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

const MB = 1024 * 1024;
const MAYA = 'maya@helixlab.example';
const SAMIRA = 'samira@northbridge.example';
const GOOD = 'source_id,observation,provenance\nE01,"MIC shift, fourfold",Authored fixture\nE02,acrB up,Authored fixture\nE03,Partial reversal,Authored fixture\n';

const fileForm = (content: string | Uint8Array, filename = 'resistance-evidence-demo.csv', extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append('file', new File([content as BlobPart], filename, { type: 'text/csv' }));
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
};

const upload = async (client: Client, content: string | Uint8Array, filename?: string, extra?: Record<string, string>) => {
  const res = await client.post('/api/datasets/uploads', fileForm(content, filename, extra));
  return { res, body: (await res.json()) as any };
};

const CREATE = { name: 'New evidence', version: '1.0', provenance: 'Authored fixtures for testing. No personal data.', domainId: 'biology', rightsAck: true };

const create = async (client: Client, draftId: string, overrides: Record<string, unknown> = {}) => {
  const res = await client.post('/api/datasets', { draftId, ...CREATE, ...overrides });
  return { res, body: (await res.json()) as any };
};

const addMember = async (test: TestApp, workspaceId: string, userId: string, role: 'owner' | 'member' = 'member') => {
  await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, [newId(), workspaceId, userId, role, test.ctx.now().toISOString()]);
  await test.ctx.db.run(`UPDATE users SET active_workspace_id = ? WHERE id = ?`, [workspaceId, userId]);
};

const blobPath = (test: TestApp, sha256: string) => path.join(test.ctx.config.dataDir, 'uploads', sha256);

describe('with the demo story', () => {
  let test: TestApp;
  let maya: Client;

  beforeEach(async () => {
    test = await makeTestApp({ seed: true });
    maya = await new Client(test).signIn(MAYA);
  });
  afterEach(() => test.close());

  const workspaceId = async (name: string) => (await test.ctx.db.get<{ id: string }>('SELECT id FROM workspaces WHERE name = ?', [name]))!.id;

  describe('the seeded library reads like the frames', () => {
    it('lists the three private datasets with real attachments', async () => {
      const res = await maya.get('/api/datasets');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workspace).toMatchObject({ name: 'Helix Lab', visibility: 'private' });
      expect(body.filter).toBe('private');
      expect(body.canCreate).toEqual({ allowed: true });
      expect(body.items.map((item: any) => [item.name, item.code, item.version, item.recordsCount, item.attachment])).toEqual([
        ['Resistance evidence pack', 'DS-BIO-07', '1.0', 3, 'Attached to BIO-042'],
        ['Efflux control checklist', 'DS-BIO-08', '1.0', 12, 'Authored demo'],
        ['Rubric calibration notes', 'DS-BIO-09', '0.2', 8, 'Authored demo'],
      ]);
      expect(body.items[0].downloadPath).toBe('/api/datasets/DS-BIO-07/versions/1.0/download');
    });

    it('shows the activity from dataset_activity, newest first', async () => {
      const { activity } = await (await maya.get('/api/datasets')).json();
      expect(activity.map((row: any) => [row.createdAt.slice(11, 16), row.kind, row.message])).toEqual([
        ['14:20', 'Task attachment', 'DS-BIO-07 v1.0 pinned to BIO-042'],
        ['14:12', 'Validation', '3 records parsed; no missing source IDs'],
        ['14:10', 'Upload', 'Maya Chen uploaded resistance-evidence-demo.csv'],
      ]);
    });

    it('keeps DS-BIO-07 a real 48 KB file that the real validator passes', async () => {
      const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      expect(Math.round(version.size / 1024)).toBe(48);
      const bytes = await test.ctx.storage.read(version.sha256);
      expect(bytes.length).toBe(version.size);
      const validated = validateDatasetFile({ bytes, filename: version.filename });
      expect(validated.receipt).toMatchObject({ passed: true, recordsParsed: 3, duplicateSourceIds: 0, missingSourceIds: 0, synthetic: true, sensitiveData: { flags: [] } });
      const stored = await test.ctx.db.get<{ records: string }>(`SELECT records FROM dataset_versions WHERE sha256 = ?`, [version.sha256]);
      expect(JSON.parse(stored!.records)).toEqual(validated.records);
    });

    it('prints the detail page from data', async () => {
      const res = await maya.get('/api/datasets/DS-BIO-07');
      expect(res.status).toBe(200);
      const detail = await res.json();
      expect(detail).toMatchObject({ code: 'DS-BIO-07', name: 'Resistance evidence pack', ownerName: 'Maya Chen', visibility: 'private', deleted: null, canDelete: { allowed: true }, canUploadVersion: { allowed: true } });
      expect(detail.version).toMatchObject({ version: '1.0', verified: true, rowsTotal: 3, hasLimits: true, isSynthetic: true, pinnedBy: ['BIO-042 v1.0'], createdByName: 'Maya Chen', createdAt: '2026-10-15T14:10:00.000Z', format: 'csv' });
      expect(detail.version.rows.map((row: any) => [row.term, row.detail])).toEqual([
        ['E01 / MIC assay', '0.25 → 1.00 µg/mL · Association, not causality'],
        ['E02 / qPCR', 'acrB 3.1× control · Transcript ≠ pump activity'],
        ['E03 / Inhibitor assay', 'Partial MIC reversal · Specificity unknown'],
      ]);
      expect(detail.version.provenance).toContain('Authored by Maya Chen');
      expect(detail.version.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(detail.versions).toHaveLength(1);
    });

    it('falls back to source_id and observation without the label columns, and has no limits to claim', async () => {
      const detail = await (await maya.get('/api/datasets/DS-BIO-08')).json();
      expect(detail.version.rowsTotal).toBe(12);
      expect(detail.version.hasLimits).toBe(false);
      expect(detail.version.rows[0]).toMatchObject({ term: 'C01', detail: 'Deletion strain confirmed by sequencing' });
    });

    it('reports the upload context with the code the next dataset gets', async () => {
      const context = await (await maya.get('/api/datasets/upload-context')).json();
      expect(context.workspace.name).toBe('Helix Lab');
      expect(context.ownerName).toBe('Maya Chen');
      expect(context.maxBytes).toBe(100 * MB);
      expect(context.formats).toEqual(['CSV', 'JSONL', 'PDF']);
      expect(context.domains.find((domain: any) => domain.id === 'biology').nextCode).toBe('DS-BIO-10');
      expect(context.domains.find((domain: any) => domain.id === 'chemistry').nextCode).toBe('DS-CHEM-01');
      expect(context.target).toBeNull();
    });
  });

  describe('uploading', () => {
    it('stores the bytes with an uploads row and writes a draft with the receipt', async () => {
      const { res, body } = await upload(maya, GOOD);
      expect(res.status).toBe(201);
      expect(body).toMatchObject({ filename: 'resistance-evidence-demo.csv', size: GOOD.length, format: 'csv', recordsCount: 3, passed: true, visibility: 'private', targetCode: null });
      expect(body.receipt).toMatchObject({ encoding: 'UTF-8', synthetic: true, sensitiveData: { note: 'No flags' }, requiredColumns: { passed: 3, total: 3 }, recordsParsed: 3, duplicateSourceIds: 0 });
      expect(body.sha256).toBe(sha256Hex(GOOD));
      expect(test.ctx.storage.exists(body.sha256)).toBe(true);
      const row = await test.ctx.db.get<any>(`SELECT u.sha256, u.purpose, u.filename, u.size, d.passed, d.records_count, d.receipt FROM dataset_drafts d JOIN uploads u ON u.id = d.upload_id WHERE d.id = ?`, [body.id]);
      expect(row).toMatchObject({ sha256: sha256Hex(GOOD), purpose: 'dataset', filename: 'resistance-evidence-demo.csv', size: GOOD.length, passed: 1, records_count: 3 });
      expect(JSON.parse(row.receipt).passed).toBe(true);
    });

    it('can be read back, and only by the person who uploaded', async () => {
      const { body } = await upload(maya, GOOD);
      expect((await maya.get(`/api/datasets/uploads/${body.id}`)).status).toBe(200);
      const samira = await new Client(test).signIn(SAMIRA);
      expect((await samira.get(`/api/datasets/uploads/${body.id}`)).status).toBe(404);
    });

    it('writes library activity for the upload and its validation', async () => {
      await upload(maya, GOOD, 'fresh.csv');
      const { activity } = await (await maya.get('/api/datasets')).json();
      expect(activity.slice(0, 2).map((row: any) => [row.kind, row.message])).toEqual([
        ['Validation', '3 records parsed; no missing source IDs'],
        ['Upload', 'Maya Chen uploaded fresh.csv'],
      ]);
    });

    it('needs a file and a multipart body', async () => {
      const empty = new FormData();
      empty.append('nothing', 'here');
      const res = await maya.post('/api/datasets/uploads', empty);
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields.file).toBe('Choose a CSV, JSONL or PDF file to upload.');
      const json = await maya.post('/api/datasets/uploads', { hello: 'world' });
      expect(json.status).toBe(400);
    });

    it('keeps only the base name of the file', async () => {
      const { body } = await upload(maya, GOOD, '../../etc/passwd.csv');
      expect(body.filename).toBe('passwd.csv');
    });

    it('refuses a file over 100 MB with a clear error and keeps nothing', async () => {
      const before = await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM uploads');
      const res = await maya.post('/api/datasets/uploads', fileForm(new Uint8Array(100 * MB + 1), 'huge.csv'));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatchObject({ code: 'too_large', message: 'This file is larger than the 100 MB upload limit.' });
      const after = await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM uploads');
      expect(after!.n).toBe(before!.n);
    });

    it('refuses a body past the 105 MB limit before reading it', async () => {
      const res = await maya.post('/api/datasets/uploads', fileForm(new Uint8Array(106 * MB), 'huger.csv'));
      expect(res.status).toBe(413);
      expect((await res.json()).error.message).toBe('This file is larger than the 100 MB upload limit.');
    });

    it('accepts a file of exactly 100 MB', async () => {
      const bytes = new Uint8Array(100 * MB);
      bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
      const { res, body } = await upload(maya, bytes, 'exact.pdf');
      expect(res.status).toBe(201);
      expect(body).toMatchObject({ size: 100 * MB, passed: true, format: 'pdf' });
      rmSync(blobPath(test, body.sha256));
    });

    it('stays private to people with a workspace', async () => {
      const lena = await new Client(test).signIn('lena@northbridge.example');
      const { res, body } = await upload(lena, GOOD);
      expect(res.status).toBe(403);
      expect(body.error.message).toBe('Create a workspace before uploading a dataset.');
    });

    it('refuses visitors and unverified accounts', async () => {
      const visitor = await new Client(test).post('/api/datasets/uploads', fileForm(GOOD));
      expect(visitor.status).toBe(401);
      await makeUser(test, { email: 'new@lab.example', verified: false });
      const unverified = await new Client(test).signIn('new@lab.example');
      expect((await unverified.post('/api/datasets/uploads', fileForm(GOOD))).status).toBe(403);
      expect((await unverified.get('/api/datasets')).status).toBe(403);
    });
  });

  describe('a failed validation', () => {
    const BAD = 'source_id,observation\nE01,a\nE01,b\n';

    it('says exactly what failed, keeps no bytes and blocks creation', async () => {
      const { res, body } = await upload(maya, BAD, 'bad.csv');
      expect(res.status).toBe(201);
      expect(body.passed).toBe(false);
      expect(body.receipt.failures.map((failure: any) => failure.message)).toEqual(['Missing required column: provenance.', '1 duplicate source ID: E01 (rows 2, 3).']);
      expect(test.ctx.storage.exists(sha256Hex(BAD))).toBe(false);
      const draft = await test.ctx.db.get<any>('SELECT upload_id, passed, records FROM dataset_drafts WHERE id = ?', [body.id]);
      expect(draft).toEqual({ upload_id: null, passed: 0, records: '[]' });

      const attempt = await create(maya, body.id);
      expect(attempt.res.status).toBe(422);
      expect(attempt.body.error.message).toContain('Missing required column: provenance.');
      const code = await test.ctx.db.get(`SELECT 1 AS ok FROM datasets WHERE name = 'New evidence'`);
      expect(code).toBeUndefined();
    });

    it('blocks creation on a sensitive-data flag and does not keep the value', async () => {
      const content = 'source_id,observation,provenance\nE01,Contact maya@helixlab.example,Authored\n';
      const { body } = await upload(maya, content, 'pii.csv');
      expect(body.passed).toBe(false);
      expect(body.receipt.sensitiveData.flags[0]).toMatchObject({ kind: 'email', count: 1, locations: ['row 2, observation'] });
      expect(JSON.stringify(body)).not.toContain('maya@helixlab.example');
      expect(test.ctx.storage.exists(sha256Hex(content))).toBe(false);
      expect((await create(maya, body.id)).res.status).toBe(422);
    });

    it('blocks creation on bad encoding', async () => {
      const { body } = await upload(maya, Uint8Array.from([0x61, 0x2c, 0xff, 0x0a]), 'latin.csv');
      expect(body.passed).toBe(false);
      expect(body.receipt.encoding).toBe('Not UTF-8');
      expect((await create(maya, body.id)).res.status).toBe(422);
    });

    it('records the failure in the library activity', async () => {
      await upload(maya, BAD, 'bad.csv');
      const { activity } = await (await maya.get('/api/datasets')).json();
      expect(activity[0].message).toBe('bad.csv failed validation: Missing required column: provenance.');
    });
  });

  describe('a PDF', () => {
    const PDF = '%PDF-1.7\nnot parsed\n%%EOF\n';

    it('is stored, says records were not parsed and creates a version with no records', async () => {
      const { body } = await upload(maya, PDF, 'protocol.pdf');
      expect(body).toMatchObject({ passed: true, format: 'pdf', recordsCount: 0 });
      expect(body.receipt.recordsNote).toContain('not parsed');
      const created = await create(maya, body.id, { name: 'Protocol' });
      expect(created.res.status).toBe(201);
      const detail = await (await maya.get(`/api/datasets/${created.body.code}`)).json();
      expect(detail.version).toMatchObject({ format: 'pdf', recordsCount: 0, rowsTotal: 0, rows: [], verified: true, isSynthetic: false });
      const download = await maya.get(detail.version.downloadPath);
      expect(download.headers.get('content-type')).toBe('application/pdf');
      expect(await download.text()).toBe(PDF);
    });
  });

  describe('creating a dataset', () => {
    it('gets the promised code, and the counter moves on', async () => {
      const { body: draft } = await upload(maya, GOOD);
      const { res, body } = await create(maya, draft.id, { expectedCode: 'DS-BIO-10' });
      expect(res.status).toBe(201);
      expect(body).toEqual({ code: 'DS-BIO-10', version: '1.0' });

      const context = await (await maya.get('/api/datasets/upload-context')).json();
      expect(context.domains.find((domain: any) => domain.id === 'biology').nextCode).toBe('DS-BIO-11');

      const row = await test.ctx.db.get<any>(`SELECT d.name, d.visibility, d.is_synthetic, u.email AS owner, w.name AS workspace FROM datasets d JOIN users u ON u.id = d.owner_id JOIN workspaces w ON w.id = d.workspace_id WHERE d.code = 'DS-BIO-10'`);
      expect(row).toEqual({ name: 'New evidence', visibility: 'private', is_synthetic: 1, owner: MAYA, workspace: 'Helix Lab' });

      const { items } = await (await maya.get('/api/datasets')).json();
      expect(items[0]).toMatchObject({ code: 'DS-BIO-10', version: '1.0', recordsCount: 3, attachment: 'Authored demo' });
    });

    it('takes its prefix from the domain and starts that counter', async () => {
      const { body: draft } = await upload(maya, GOOD);
      const { body } = await create(maya, draft.id, { domainId: 'chemistry' });
      expect(body.code).toBe('DS-CHEM-01');
      const { body: second } = await upload(maya, `${GOOD}E04,Another,Authored fixture\n`);
      expect((await create(maya, second.id, { domainId: 'chemistry' })).body.code).toBe('DS-CHEM-02');
      const { body: bio } = await upload(maya, `${GOOD}E05,Another,Authored fixture\n`);
      expect((await create(maya, bio.id)).body.code).toBe('DS-BIO-10');
    });

    it('refuses when the promised code has gone', async () => {
      const { body: first } = await upload(maya, GOOD);
      const taken = await create(maya, first.id, { expectedCode: 'DS-BIO-10' });
      expect(taken.res.status).toBe(201);
      const { body: second } = await upload(maya, `${GOOD}E09,x,Authored\n`);
      const { res, body } = await create(maya, second.id, { expectedCode: 'DS-BIO-10' });
      expect(res.status).toBe(409);
      expect(body.error.message).toBe('The next code is now DS-BIO-11. Check the button and confirm again.');
    });

    it('reports every missing field at once', async () => {
      const { body: draft } = await upload(maya, GOOD);
      const res = await maya.post('/api/datasets', { draftId: draft.id, name: ' ', version: 'one', provenance: '', domainId: 'nope', rightsAck: false });
      expect(res.status).toBe(422);
      const { error } = await res.json();
      expect(error.fields).toEqual({
        name: 'Enter a dataset name to continue.',
        version: 'Enter a version such as 1.0.',
        provenance: 'Describe where this file came from to continue.',
        rightsAck: 'Confirm you have permission to upload this file.',
        domainId: 'Choose a domain for this dataset.',
      });
    });

    it('makes one dataset from one draft even when asked twice at once', async () => {
      const { body: draft } = await upload(maya, GOOD);
      const [first, second] = await Promise.all([create(maya, draft.id), create(maya, draft.id)]);
      expect([first.res.status, second.res.status].sort()).toEqual([201, 409]);
      const made = await test.ctx.db.all(`SELECT code FROM datasets WHERE name = 'New evidence'`);
      expect(made).toHaveLength(1);
    });

    it('cannot use a draft twice, or another person’s draft', async () => {
      const { body: draft } = await upload(maya, GOOD);
      const samira = await new Client(test).signIn(SAMIRA);
      expect((await create(samira, draft.id)).res.status).toBe(404);
      expect((await create(maya, draft.id)).res.status).toBe(201);
      const again = await create(maya, draft.id);
      expect(again.res.status).toBe(409);
      expect(again.body.error.code).toBe('draft_used');
    });

    it('stops a removed member creating from an earlier draft', async () => {
      const memberId = await makeUser(test, { email: 'member@helixlab.example', name: 'Pat Member' });
      await addMember(test, await workspaceId('Helix Lab'), memberId);
      const member = await new Client(test).signIn('member@helixlab.example');
      const { body: draft } = await upload(member, GOOD);
      await test.ctx.db.run(`UPDATE memberships SET status = 'removed' WHERE user_id = ?`, [memberId]);
      expect((await create(member, draft.id)).res.status).toBe(403);
      expect((await member.get(`/api/datasets/uploads/${draft.id}`)).status).toBe(404);
    });

    it('records an audit entry with the hash and the rights attestation', async () => {
      const { body: draft } = await upload(maya, GOOD);
      await create(maya, draft.id);
      const entry = await test.ctx.db.get<any>(`SELECT action, subject_code, detail FROM audit_log WHERE subject_code = 'DS-BIO-10'`);
      expect(entry.action).toBe('dataset.created');
      expect(JSON.parse(entry.detail)).toMatchObject({ sha256: sha256Hex(GOOD), rightsAttested: true, version: '1.0' });
    });

    it('refuses to pin bytes that changed after validation', async () => {
      const { body: draft } = await upload(maya, GOOD);
      writeFileSync(blobPath(test, draft.sha256), 'changed after validation');
      const { res, body } = await create(maya, draft.id);
      expect(res.status).toBe(409);
      expect(body.error.code).toBe('hash_mismatch');
      expect(await test.ctx.db.get(`SELECT 1 AS ok FROM datasets WHERE name = 'New evidence'`)).toBeUndefined();
    });

    it('uses the workspace default visibility', async () => {
      await test.ctx.db.run(`UPDATE workspaces SET default_visibility = 'shared' WHERE name = 'Helix Lab'`);
      const { body: draft } = await upload(maya, GOOD);
      expect(draft.visibility).toBe('shared');
      await create(maya, draft.id);
      const row = await test.ctx.db.get<any>(`SELECT visibility FROM datasets WHERE code = 'DS-BIO-10'`);
      expect(row.visibility).toBe('shared');
    });

    it('a discarded draft can no longer create anything', async () => {
      const { body: draft } = await upload(maya, GOOD);
      expect((await maya.delete(`/api/datasets/uploads/${draft.id}`)).status).toBe(204);
      expect((await create(maya, draft.id)).res.status).toBe(404);
    });

    it('choosing another file replaces the earlier draft', async () => {
      const { body: first } = await upload(maya, GOOD);
      const { body: second } = await upload(maya, `${GOOD}E07,x,Authored\n`);
      expect((await maya.get(`/api/datasets/uploads/${first.id}`)).status).toBe(404);
      expect((await maya.get(`/api/datasets/uploads/${second.id}`)).status).toBe(200);
    });
  });

  describe('a new version', () => {
    const CHANGED = `${GOOD}E04,A fourth observation,Authored fixture\n`;

    it('offers the next version in the context', async () => {
      const context = await (await maya.get('/api/datasets/upload-context?dataset=DS-BIO-07')).json();
      expect(context.target).toMatchObject({ code: 'DS-BIO-07', name: 'Resistance evidence pack', latestVersion: '1.0', nextVersion: '1.1', canUpload: { allowed: true } });
      const nine = await (await maya.get('/api/datasets/upload-context?dataset=DS-BIO-09')).json();
      expect(nine.target.nextVersion).toBe('0.3');
    });

    it('creates v1.1 from new bytes and leaves v1.0 exactly as it was', async () => {
      const before = await (await maya.get('/api/datasets/DS-BIO-07?version=1.0')).json();
      const beforeBytes = await (await maya.get(before.version.downloadPath)).text();

      const { body: draft } = await upload(maya, CHANGED, 'second.csv', { dataset: 'DS-BIO-07' });
      expect(draft).toMatchObject({ passed: true, targetCode: 'DS-BIO-07' });
      const { res, body } = await create(maya, draft.id, { version: '1.1', provenance: 'Second version statement.', name: undefined, domainId: undefined });
      expect(res.status).toBe(201);
      expect(body).toEqual({ code: 'DS-BIO-07', version: '1.1' });

      const latest = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      expect(latest.version).toMatchObject({ version: '1.1', rowsTotal: 4, isLatest: true, provenance: 'Second version statement.', pinnedBy: [] });
      expect(latest.versions.map((row: any) => [row.version, row.isCurrent, row.pinnedBy])).toEqual([
        ['1.1', true, []],
        ['1.0', false, ['BIO-042 v1.0']],
      ]);

      const old = await (await maya.get('/api/datasets/DS-BIO-07?version=1.0')).json();
      expect(old.version).toMatchObject({ version: '1.0', rowsTotal: 3, isLatest: false, sha256: before.version.sha256, verified: true });
      expect(old.version.provenance).toBe(before.version.provenance);
      expect(await (await maya.get(old.version.downloadPath)).text()).toBe(beforeBytes);

      const { items } = await (await maya.get('/api/datasets')).json();
      expect(items.find((item: any) => item.code === 'DS-BIO-07')).toMatchObject({ version: '1.1', recordsCount: 4, attachment: 'Attached to BIO-042' });
      const entry = await test.ctx.db.get<any>(`SELECT action FROM audit_log WHERE subject_code = 'DS-BIO-07' AND action = 'dataset.version_created'`);
      expect(entry).toBeTruthy();
    });

    it('refuses identical bytes with a reason, at upload and at creation', async () => {
      const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      const bytes = await test.ctx.storage.read(version.sha256);
      const { body: draft } = await upload(maya, bytes, 'resistance-evidence-demo.csv', { dataset: 'DS-BIO-07' });
      expect(draft.passed).toBe(false);
      const reason = 'These bytes are identical to DS-BIO-07 v1.0. A new version needs new bytes, so nothing was created.';
      expect(draft.receipt.failures.map((failure: any) => failure.message)).toEqual([reason]);
      const attempt = await create(maya, draft.id, { version: '1.1' });
      expect(attempt.res.status).toBe(422);
      expect(attempt.body.error.message).toContain(reason);
    });

    it('allows the same bytes as a different dataset', async () => {
      const { body: first } = await upload(maya, CHANGED, 'a.csv', { dataset: 'DS-BIO-08' });
      const { body: other } = await upload(maya, CHANGED, 'a.csv', { dataset: 'DS-BIO-09' });
      expect(first.passed && other.passed).toBe(true);
    });

    it('re-checks identical bytes at creation', async () => {
      const memberId = await makeUser(test, { email: 'member@helixlab.example', name: 'Pat Member' });
      await addMember(test, await workspaceId('Helix Lab'), memberId);
      const member = await new Client(test).signIn('member@helixlab.example');
      const { body: mine } = await upload(maya, CHANGED, 'a.csv', { dataset: 'DS-BIO-07' });
      const { body: theirs } = await upload(member, CHANGED, 'b.csv', { dataset: 'DS-BIO-07' });
      expect((await create(maya, mine.id, { version: '1.1' })).res.status).toBe(201);
      const late = await create(member, theirs.id, { version: '1.2' });
      expect(late.res.status).toBe(409);
      expect(late.body.error.code).toBe('identical_bytes');
    });

    it('refuses a version that exists or goes backwards', async () => {
      const { body: draft } = await upload(maya, CHANGED, 'a.csv', { dataset: 'DS-BIO-07' });
      const same = await create(maya, draft.id, { version: '1.0' });
      expect(same.res.status).toBe(422);
      expect(same.body.error.fields.version).toBe('Version 1.0 already exists. Existing snapshots are never replaced.');
      const back = await create(maya, draft.id, { version: '0.9' });
      expect(back.body.error.fields.version).toBe('Use a version after 1.0.');
      expect((await create(maya, draft.id, { version: '2.0' })).res.status).toBe(201);
    });

    it('is open to members but not to other workspaces', async () => {
      const samira = await new Client(test).signIn(SAMIRA);
      const denied = await upload(samira, CHANGED, 'a.csv', { dataset: 'DS-BIO-07' });
      expect(denied.res.status).toBe(404);
      expect((await samira.get('/api/datasets/upload-context?dataset=DS-BIO-07')).status).toBe(404);

      const memberId = await makeUser(test, { email: 'member@helixlab.example' });
      await addMember(test, await workspaceId('Helix Lab'), memberId);
      const member = await new Client(test).signIn('member@helixlab.example');
      const allowed = await upload(member, CHANGED, 'a.csv', { dataset: 'DS-BIO-07' });
      expect(allowed.res.status).toBe(201);
    });

    it('cannot be added to a deleted dataset', async () => {
      const { body: draft } = await upload(maya, CHANGED, 'a.csv', { dataset: 'DS-BIO-08' });
      await maya.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
      const late = await create(maya, draft.id, { version: '1.1' });
      expect(late.res.status).toBe(409);
      expect(late.body.error.code).toBe('dataset_deleted');
      const fresh = await upload(maya, `${CHANGED}E08,x,Authored\n`, 'b.csv', { dataset: 'DS-BIO-08' });
      expect(fresh.res.status).toBe(403);
      const context = await (await maya.get('/api/datasets/upload-context?dataset=DS-BIO-08')).json();
      expect(context.target.canUpload.allowed).toBe(false);
    });
  });

  describe('the filter', () => {
    const shareFixture = async () => {
      const samira = await new Client(test).signIn(SAMIRA);
      await test.ctx.db.run(`UPDATE workspaces SET default_visibility = 'shared' WHERE name = 'Northbridge Microbiology'`);
      const { body: draft } = await upload(samira, `${GOOD}E11,x,Authored fixture\n`, 'shared.csv');
      const created = await create(samira, draft.id, { name: 'Northbridge notes' });
      expect(created.res.status).toBe(201);
      return { samira, code: created.body.code as string };
    };

    it('separates private, shared and all', async () => {
      const { code } = await shareFixture();
      const codes = async (visibility?: string) => {
        const body = await (await maya.get(`/api/datasets${visibility ? `?visibility=${visibility}` : ''}`)).json();
        return { filter: body.filter, codes: body.items.map((item: any) => item.code).filter((c: string) => /DS-BIO-0[789]|DS-BIO-1/.test(c)) };
      };
      expect(await codes()).toEqual({ filter: 'private', codes: ['DS-BIO-07', 'DS-BIO-08', 'DS-BIO-09'] });
      expect(await codes('private')).toEqual({ filter: 'private', codes: ['DS-BIO-07', 'DS-BIO-08', 'DS-BIO-09'] });
      expect((await codes('shared')).codes).toEqual([code]);
      expect((await codes('all')).codes.sort()).toEqual(['DS-BIO-07', 'DS-BIO-08', 'DS-BIO-09', code].sort());
      expect((await codes('nonsense')).filter).toBe('private');
    });

    it('marks a shared dataset from another workspace', async () => {
      const { code } = await shareFixture();
      const { items } = await (await maya.get('/api/datasets?visibility=shared')).json();
      expect(items.find((item: any) => item.code === code)).toMatchObject({ inActiveWorkspace: false, workspaceName: 'Northbridge Microbiology', ownerName: 'Dr. Samira Patel' });
    });

    it('never names a private task to someone outside the workspace', async () => {
      await test.ctx.db.run(`UPDATE datasets SET visibility = 'shared' WHERE code = 'DS-BIO-07'`);
      const samira = await new Client(test).signIn(SAMIRA);
      const { items } = await (await samira.get('/api/datasets?visibility=shared')).json();
      expect(items.find((item: any) => item.code === 'DS-BIO-07').attachment).toBe('Authored demo');
      const detail = await (await samira.get('/api/datasets/DS-BIO-07')).json();
      expect(detail.version.pinnedBy).toEqual([]);
      expect(JSON.stringify(detail)).not.toContain('BIO-042');
      const deletion = await (await samira.get('/api/datasets/DS-BIO-07/deletion')).json();
      expect(JSON.stringify(deletion)).not.toContain('BIO-042');
      const own = await (await maya.get('/api/datasets?visibility=shared')).json();
      expect(own.items.find((item: any) => item.code === 'DS-BIO-07').attachment).toBe('Attached to BIO-042');
    });
  });

  describe('permissions', () => {
    it('hides a private dataset from other workspaces', async () => {
      const samira = await new Client(test).signIn(SAMIRA);
      expect((await samira.get('/api/datasets/DS-BIO-07')).status).toBe(404);
      expect((await samira.get('/api/datasets/DS-BIO-07/versions/1.0/download')).status).toBe(404);
      expect((await samira.get('/api/datasets/DS-BIO-07/versions/1.0/manifest')).status).toBe(404);
      expect((await samira.get('/api/datasets/DS-BIO-07/deletion')).status).toBe(404);
      expect((await samira.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-07', acknowledged: true })).status).toBe(404);
      const list = await (await samira.get('/api/datasets')).json();
      expect(list.items.map((item: any) => item.code)).not.toContain('DS-BIO-07');
    });

    it('requires a verified session everywhere', async () => {
      const visitor = new Client(test);
      for (const url of ['/api/datasets', '/api/datasets/upload-context', '/api/datasets/DS-BIO-07', '/api/datasets/DS-BIO-07/versions/1.0/download', '/api/datasets/DS-BIO-07/versions/1.0/manifest', '/api/datasets/DS-BIO-07/deletion']) {
        expect((await visitor.get(url)).status, url).toBe(401);
      }
    });

    it('revokes access on the next request after a membership is removed', async () => {
      const memberId = await makeUser(test, { email: 'member@helixlab.example' });
      await addMember(test, await workspaceId('Helix Lab'), memberId);
      const member = await new Client(test).signIn('member@helixlab.example');
      expect((await member.get('/api/datasets/DS-BIO-07')).status).toBe(200);
      await test.ctx.db.run(`UPDATE memberships SET status = 'removed' WHERE user_id = ?`, [memberId]);
      expect((await member.get('/api/datasets/DS-BIO-07')).status).toBe(404);
      const list = await (await member.get('/api/datasets')).json();
      expect(list.workspace).toBeNull();
      expect(list.items).toEqual([]);
    });

    it('shows the empty state data to someone with no workspace', async () => {
      const lena = await new Client(test).signIn('lena@northbridge.example');
      const body = await (await lena.get('/api/datasets')).json();
      expect(body).toEqual({ workspace: null, filter: 'private', items: [], activity: [], canCreate: { allowed: false, reason: 'Create a workspace before uploading a dataset.' } });
      const context = await (await lena.get('/api/datasets/upload-context')).json();
      expect(context.canCreate).toEqual({ allowed: false, reason: 'Create a workspace before uploading a dataset.' });
    });
  });

  describe('downloading', () => {
    it('streams the exact bytes with the name and checksum, and logs the download', async () => {
      const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      const res = await maya.get(version.downloadPath);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toContain('attachment; filename="resistance-evidence-demo.csv"');
      expect(res.headers.get('x-rivet-sha256')).toBe(version.sha256);
      expect(res.headers.get('content-length')).toBe(String(version.size));
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(sha256Hex(bytes)).toBe(version.sha256);
      const { activity } = await (await maya.get('/api/datasets')).json();
      expect(activity[0]).toMatchObject({ kind: 'Download', message: 'Maya Chen downloaded DS-BIO-07 v1.0' });
    });

    it('keeps an unusual file name safe in the download headers', async () => {
      const { body: draft } = await upload(maya, GOOD, `résumé "o'brien" (final)*.csv`);
      const { body } = await create(maya, draft.id);
      const { version } = await (await maya.get(`/api/datasets/${body.code}`)).json();
      const header = (await maya.get(version.downloadPath)).headers.get('content-disposition') as string;
      expect(header).toBe(`attachment; filename="r_sum___o_brien___final__.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22o%27brien%22%20%28final%29%2A.csv`);
    });

    it('gives a separate manifest with the checksum', async () => {
      const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      const res = await maya.get(version.manifestPath);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('DS-BIO-07-v1.0.manifest.json');
      const manifest = await res.json();
      expect(manifest).toMatchObject({
        schema: 'rivet.dataset_version.v1',
        dataset: { code: 'DS-BIO-07', name: 'Resistance evidence pack', domain: 'Biology', workspace: 'Helix Lab' },
        version: { version: '1.0', filename: 'resistance-evidence-demo.csv', format: 'csv', size: version.size, records: 3, createdBy: 'Maya Chen', synthetic: true },
        checksum: { algorithm: 'SHA-256', value: version.sha256, line: `${version.sha256}  resistance-evidence-demo.csv` },
        validation: { passed: true },
        pinnedBy: ['BIO-042 v1.0'],
      });
      expect(manifest.version.columns).toContain('source_id');
    });

    it('404s an unknown version', async () => {
      expect((await maya.get('/api/datasets/DS-BIO-07/versions/9.9/download')).status).toBe(404);
      expect((await maya.get('/api/datasets/DS-BIO-07?version=9.9')).status).toBe(404);
    });

    describe('tampered bytes', () => {
      const tamper = async () => {
        const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
        const original = readFileSync(blobPath(test, version.sha256));
        writeFileSync(blobPath(test, version.sha256), Buffer.concat([original, Buffer.from('tampered')]));
        return version;
      };

      it('are detected on the detail page', async () => {
        await tamper();
        const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
        expect(version.verified).toBe(false);
      });

      it('are refused on download, with an audit entry and no activity', async () => {
        const version = await tamper();
        const res = await maya.get(version.downloadPath);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatchObject({ code: 'hash_mismatch', message: expect.stringContaining('no longer match their SHA-256') });
        expect((await maya.get(version.manifestPath)).status).toBe(409);
        const entry = await test.ctx.db.get<any>(`SELECT action, detail FROM audit_log WHERE action = 'dataset.hash_mismatch' AND subject_code = 'DS-BIO-07'`);
        expect(JSON.parse(entry.detail)).toMatchObject({ version: '1.0', sha256: version.sha256 });
        const { activity } = await (await maya.get('/api/datasets')).json();
        expect(activity.some((row: any) => row.kind === 'Download')).toBe(false);
      });

      it('send a browser to the page that explains', async () => {
        const version = await tamper();
        const res = await maya.request('GET', version.downloadPath, undefined, { Accept: 'text/html,application/xhtml+xml' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/datasets/DS-BIO-07?version=1.0');
      });

      it('are detected when the file is gone', async () => {
        const { version } = await (await maya.get('/api/datasets/DS-BIO-08')).json();
        rmSync(blobPath(test, version.sha256));
        expect((await (await maya.get('/api/datasets/DS-BIO-08')).json()).version.verified).toBe(false);
        expect((await maya.get(version.downloadPath)).status).toBe(409);
      });
    });
  });

  describe('deleting', () => {
    it('computes the impact from real references', async () => {
      const res = await maya.get('/api/datasets/DS-BIO-07/deletion');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'DS-BIO-07', name: 'Resistance evidence pack', version: '1.0', ownerName: 'Maya Chen', canDelete: { allowed: true } });
      expect(body.references.frozenTasks).toEqual(['BIO-042 v1.0']);
      expect(body.references.draftTasks).toEqual(['BIO-043']);
      expect(body.references.reports).toEqual(['RPT-BIO-042 v1.0']);
      expect(body.impact).toEqual({ library: 'Removed', attachments: 'Prevented', snapshots: 'Retained for authorized audit', reports: 'Unchanged' });
    });

    it('says when nothing references the dataset', async () => {
      const { impact, references } = await (await maya.get('/api/datasets/DS-BIO-09/deletion')).json();
      expect(references).toEqual({ frozenTasks: [], draftTasks: [], reports: [], traces: [] });
      expect(impact.snapshots).toContain('None reference this dataset');
      expect(impact.reports).toBe('None reference this dataset');
    });

    it('needs the typed code and the tick, checked by the server', async () => {
      const none = await maya.delete('/api/datasets/DS-BIO-07', {});
      expect(none.status).toBe(422);
      expect((await none.json()).error.fields).toEqual({ confirmCode: 'Type DS-BIO-07 exactly to confirm.', acknowledged: 'Tick this box to confirm you understand what deletion does.' });
      const wrong = await maya.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-7', acknowledged: true });
      expect((await wrong.json()).error.fields).toEqual({ confirmCode: 'Type DS-BIO-07 exactly to confirm.' });
      const lower = await maya.delete('/api/datasets/DS-BIO-07', { confirmCode: 'ds-bio-07', acknowledged: true });
      expect(lower.status).toBe(422);
      const untick = await maya.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-07', acknowledged: false });
      expect((await untick.json()).error.fields).toEqual({ acknowledged: 'Tick this box to confirm you understand what deletion does.' });
      const row = await test.ctx.db.get<any>(`SELECT deleted_at FROM datasets WHERE code = 'DS-BIO-07'`);
      expect(row.deleted_at).toBeNull();
    });

    it('removes the library entry, retains versions and bytes, and records it', async () => {
      const before = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      test.setNow('2026-11-01T10:00:00Z');
      const res = await maya.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-07', acknowledged: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ code: 'DS-BIO-07', deletedAt: '2026-11-01T10:00:00.000Z' });

      const { items, activity } = await (await maya.get('/api/datasets')).json();
      expect(items.map((item: any) => item.code)).toEqual(['DS-BIO-08', 'DS-BIO-09']);
      expect(activity[0]).toMatchObject({ kind: 'Deletion', message: 'Maya Chen deleted DS-BIO-07 from the library' });

      const entry = await test.ctx.db.get<any>(`SELECT action, actor_id, detail FROM audit_log WHERE action = 'dataset.deleted' AND subject_code = 'DS-BIO-07'`);
      expect(JSON.parse(entry.detail).retained).toMatchObject({ frozenTasks: ['BIO-042 v1.0'], reports: ['RPT-BIO-042 v1.0'] });

      // Audit reads still work: same rows, same bytes, verified.
      const after = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      expect(after.deleted).toEqual({ at: '2026-11-01T10:00:00.000Z', byName: 'Maya Chen' });
      expect(after.version).toMatchObject({ sha256: before.version.sha256, verified: true });
      expect(after.canDelete).toEqual({ allowed: false, reason: 'This dataset was already deleted from the library.' });
      expect(after.canUploadVersion).toEqual({ allowed: false, reason: 'This dataset was deleted from the library, so it cannot take new versions.' });
      const bytes = new Uint8Array(await (await maya.get(after.version.downloadPath)).arrayBuffer());
      expect(sha256Hex(bytes)).toBe(before.version.sha256);
      const versions = await test.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = 'DS-BIO-07'`);
      expect(versions!.n).toBe(1);

      // Frozen references and reports are unchanged.
      const pin = await test.ctx.db.get<any>(`SELECT tv.sha256, v.version FROM task_versions tv JOIN dataset_versions v ON v.id = tv.dataset_version_id JOIN tasks t ON t.id = tv.task_id WHERE t.code = 'BIO-042'`);
      expect(pin.version).toBe('1.0');
      const report = await test.ctx.db.get<any>(`SELECT sha256 FROM reports WHERE code = 'RPT-BIO-042'`);
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('cannot be repeated', async () => {
      await maya.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
      const again = await maya.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
      expect(again.status).toBe(409);
      expect((await again.json()).error.code).toBe('already_deleted');
    });

    it('prevents new attachments, whichever route tries', async () => {
      await maya.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
      const version = await test.ctx.db.get<{ id: string }>(`SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = 'DS-BIO-08'`);
      await expect(test.ctx.db.run(`UPDATE tasks SET dataset_version_id = ? WHERE code = 'BIO-043'`, [version!.id])).rejects.toThrow(/deleted from the library/);
      const task = await test.ctx.db.get<any>(`SELECT workspace_id, owner_id FROM tasks WHERE code = 'BIO-043'`);
      const now = test.ctx.now().toISOString();
      await expect(
        test.ctx.db.run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, dataset_version_id, created_at, updated_at) VALUES (?, 'BIO-900', ?, ?, 'biology', ?, ?, ?)`, [newId(), task.workspace_id, task.owner_id, version!.id, now, now]),
      ).rejects.toThrow(/deleted from the library/);
    });

    it('keeps an existing draft attachment but refuses to freeze it', async () => {
      await maya.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-07', acknowledged: true });
      const task = await test.ctx.db.get<any>(`SELECT id, dataset_version_id, owner_id FROM tasks WHERE code = 'BIO-043'`);
      expect(task.dataset_version_id).toBeTruthy();
      await test.ctx.db.run(`UPDATE tasks SET title = 'Still editable' WHERE code = 'BIO-043'`);
      await expect(
        test.ctx.db.run(`INSERT INTO task_versions (id, task_id, version, title, prompt, rubric, models, settings, dataset_version_id, acknowledgements, sha256, frozen_by, frozen_at) VALUES (?, ?, '1.0', 't', 'p', '[]', '[]', '{}', ?, '[]', 'x', ?, ?)`, [newId(), task.id, task.dataset_version_id, task.owner_id, test.ctx.now().toISOString()]),
      ).rejects.toThrow(/deleted from the library/);
    });

    describe('rules', () => {
      const asMember = async () => {
        const memberId = await makeUser(test, { email: 'member@helixlab.example', name: 'Pat Member' });
        await addMember(test, await workspaceId('Helix Lab'), memberId);
        return { memberId, member: await new Client(test).signIn('member@helixlab.example') };
      };

      it('refuses a member who neither owns the dataset nor the workspace, with the reason', async () => {
        const { member } = await asMember();
        const detail = await (await member.get('/api/datasets/DS-BIO-07')).json();
        expect(detail.canDelete).toEqual({ allowed: false, reason: 'Dataset owner or workspace owner only' });
        const deletion = await (await member.get('/api/datasets/DS-BIO-07/deletion')).json();
        expect(deletion.canDelete).toEqual({ allowed: false, reason: 'Dataset owner or workspace owner only' });
        const res = await member.delete('/api/datasets/DS-BIO-07', { confirmCode: 'DS-BIO-07', acknowledged: true });
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('Dataset owner or workspace owner only');
      });

      it('lets a member delete their own dataset', async () => {
        const { member } = await asMember();
        const { body: draft } = await upload(member, GOOD);
        const { body } = await create(member, draft.id);
        expect((await member.delete(`/api/datasets/${body.code}`, { confirmCode: body.code, acknowledged: true })).status).toBe(200);
      });

      it('lets the workspace owner delete a member’s dataset', async () => {
        const { member } = await asMember();
        const { body: draft } = await upload(member, GOOD);
        const { body } = await create(member, draft.id);
        const detail = await (await maya.get(`/api/datasets/${body.code}`)).json();
        expect(detail.canDelete).toEqual({ allowed: true });
        expect((await maya.delete(`/api/datasets/${body.code}`, { confirmCode: body.code, acknowledged: true })).status).toBe(200);
      });

      it('refuses someone reading a shared dataset from outside, and hides it once deleted', async () => {
        await test.ctx.db.run(`UPDATE datasets SET visibility = 'shared' WHERE code = 'DS-BIO-08'`);
        const samira = await new Client(test).signIn(SAMIRA);
        const detail = await (await samira.get('/api/datasets/DS-BIO-08')).json();
        expect(detail.canDelete).toEqual({ allowed: false, reason: 'Dataset owner or workspace owner only' });
        expect(detail.canUploadVersion).toEqual({ allowed: false, reason: 'Join this workspace to create here.' });
        expect((await samira.get(detail.version.downloadPath)).status).toBe(200);
        const denied = await samira.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
        expect(denied.status).toBe(403);
        await maya.delete('/api/datasets/DS-BIO-08', { confirmCode: 'DS-BIO-08', acknowledged: true });
        expect((await samira.get('/api/datasets/DS-BIO-08')).status).toBe(404);
        expect((await samira.get(detail.version.downloadPath)).status).toBe(404);
      });
    });
  });

  describe('immutability', () => {
    it('refuses to change or remove a version row', async () => {
      await expect(test.ctx.db.run(`UPDATE dataset_versions SET sha256 = 'x'`)).rejects.toThrow(/immutable/);
      await expect(test.ctx.db.run(`DELETE FROM dataset_versions`)).rejects.toThrow(/immutable/);
    });
  });

  describe('task attachments', () => {
    it('reach the library activity when a task is created with a dataset, unless it is authored', async () => {
      const version = await test.ctx.db.get<{ id: string }>(`SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = 'DS-BIO-09'`);
      const task = await test.ctx.db.get<any>(`SELECT workspace_id, owner_id FROM tasks WHERE code = 'BIO-043'`);
      test.setNow('2026-11-01T11:00:00Z');
      const now = test.ctx.now().toISOString();
      const insert = (code: string, synthetic: number) =>
        test.ctx.db.run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, dataset_version_id, is_synthetic, created_at, updated_at) VALUES (?, ?, ?, ?, 'biology', ?, ?, ?, ?)`, [newId(), code, task.workspace_id, task.owner_id, version!.id, synthetic, now, now]);
      await insert('BIO-901', 1);
      expect((await (await maya.get('/api/datasets')).json()).activity[0].message).toBe('DS-BIO-07 v1.0 pinned to BIO-042');
      await insert('BIO-902', 0);
      expect((await (await maya.get('/api/datasets')).json()).activity[0]).toMatchObject({ kind: 'Task attachment', message: 'DS-BIO-09 v0.2 attached to BIO-902', createdAt: now });
    });

    it('reach the library activity when a task changes its dataset', async () => {
      const version = await test.ctx.db.get<{ id: string }>(`SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = 'DS-BIO-08'`);
      test.setNow('2026-11-01T11:00:00Z');
      await test.ctx.db.run(`UPDATE tasks SET dataset_version_id = ?, updated_at = ? WHERE code = 'BIO-043'`, [version!.id, test.ctx.now().toISOString()]);
      const { activity, items } = await (await maya.get('/api/datasets')).json();
      expect(activity[0]).toMatchObject({ kind: 'Task attachment', message: 'DS-BIO-08 v1.0 attached to BIO-043' });
      expect(items.find((item: any) => item.code === 'DS-BIO-08').attachment).toBe('Attached to BIO-043 (draft)');
    });
  });
});

describe('on an empty instance', () => {
  let test: TestApp;

  beforeEach(async () => {
    test = await makeTestApp();
  });
  afterEach(() => test.close());

  it('takes a brand-new user from upload to download', async () => {
    const id = await makeUser(test, { email: 'ada@lab.example', name: 'Ada Lane' });
    await makeWorkspace(test, id, 'Ada Lab');
    const ada = await new Client(test).signIn('ada@lab.example');
    const empty = await (await ada.get('/api/datasets')).json();
    expect(empty.items).toEqual([]);
    expect(empty.canCreate).toEqual({ allowed: true });
    const context = await (await ada.get('/api/datasets/upload-context')).json();
    expect(context.domains[0].nextCode).toBe('DS-BIO-01');

    const content = 'source_id,observation,provenance\nS1,Bench reading,Notebook 7 page 12\n';
    const { body: draft } = await upload(ada, content, 'bench.csv');
    expect(draft).toMatchObject({ passed: true, recordsCount: 1 });
    expect(draft.receipt.synthetic).toBe(false);
    const { body } = await create(ada, draft.id, { name: 'Bench readings', expectedCode: 'DS-BIO-01' });
    expect(body.code).toBe('DS-BIO-01');

    const { items } = await (await ada.get('/api/datasets')).json();
    expect(items[0]).toMatchObject({ code: 'DS-BIO-01', attachment: 'Not attached', isSynthetic: false, recordsCount: 1 });
    const detail = await (await ada.get('/api/datasets/DS-BIO-01')).json();
    expect(detail.version).toMatchObject({ rowsTotal: 1, hasLimits: false, verified: true, isSynthetic: false, pinnedBy: [] });
    expect(await (await ada.get(detail.version.downloadPath)).text()).toBe(content);
  });

  it('never sees another workspace’s entries', async () => {
    const a = await makeUser(test, { email: 'a@lab.example' });
    await makeWorkspace(test, a, 'A Lab');
    const b = await makeUser(test, { email: 'b@lab.example' });
    await makeWorkspace(test, b, 'B Lab');
    const clientA = await new Client(test).signIn('a@lab.example');
    const clientB = await new Client(test).signIn('b@lab.example');
    const { body: draft } = await upload(clientA, 'source_id,observation,provenance\nS1,x,Notes\n', 'a.csv');
    await create(clientA, draft.id, { name: 'A data' });
    expect((await (await clientB.get('/api/datasets?visibility=all')).json()).items).toEqual([]);
    expect((await (await clientB.get('/api/datasets')).json()).activity).toEqual([]);
    expect((await clientB.get('/api/datasets/DS-BIO-01')).status).toBe(404);
  });
});
