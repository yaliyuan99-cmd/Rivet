import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { Client, lastMail, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';
import { PDF_BYTES, PNG_BYTES, applicationBody, grantCredential, member, signedIn, uploadFile } from './expertFixtures.ts';

let test: TestApp;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
});
afterEach(() => test.close());

const json = (res: Response) => res.json() as Promise<any>;

async function applicant(email = 'ada@lab.example', name = 'Dr. Ada Lane') {
  const { id, client } = await member(test, email, name);
  return { id, client };
}

async function submitted(client: Client, overrides: Record<string, unknown> = {}) {
  const upload = await json(await uploadFile(client));
  const draft = await json(await client.post('/api/applications', applicationBody(upload.id, overrides)));
  const res = await client.post(`/api/applications/${draft.code}/submit`);
  expect(res.status).toBe(200);
  return json(res);
}

describe('credential evidence uploads', () => {
  it('stores a PDF through storage with an uploads row', async () => {
    const { client, id } = await applicant();
    const res = await uploadFile(client);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ filename: 'phd-certificate.pdf', mime: 'application/pdf', size: PDF_BYTES.length, sha256: sha256Hex(PDF_BYTES) });
    const row = await test.ctx.db.get<any>('SELECT * FROM uploads WHERE id = ?', [body.id]);
    expect(row).toMatchObject({ owner_id: id, purpose: 'credential', sha256: sha256Hex(PDF_BYTES) });
    expect(test.ctx.storage.exists(body.sha256)).toBe(true);
    expect(Buffer.from(await test.ctx.storage.read(body.sha256)).equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it('accepts an image and takes the type from the bytes, not the claim', async () => {
    const { client } = await applicant();
    const res = await uploadFile(client, PNG_BYTES, 'scan.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    expect((await json(res)).mime).toBe('image/png');
  });

  it('refuses anything that is not a PDF or image, with a clear message', async () => {
    const { client } = await applicant();
    const res = await uploadFile(client, new TextEncoder().encode('<svg onload="alert(1)"/>'), 'cv.pdf', 'application/pdf');
    expect(res.status).toBe(422);
    const { error } = await json(res);
    expect(error.fields.file).toMatch(/PDF, PNG, JPEG or WebP/);
  });

  it('refuses an empty file and a missing file', async () => {
    const { client } = await applicant();
    expect((await json(await uploadFile(client, new Uint8Array(0)))).error.fields.file).toMatch(/empty/);
    expect((await json(await client.request('POST', '/api/uploads', new FormData()))).error.fields.file).toMatch(/Choose a PDF/);
  });

  it('refuses a file over 10 MB', async () => {
    const { client } = await applicant();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF_BYTES);
    const res = await uploadFile(client, big);
    expect(res.status).toBe(413);
    expect((await json(res)).error.message).toMatch(/10 MB/);
  });

  it('requires a verified account', async () => {
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const client = await signedIn(test, 'new@lab.example');
    expect((await uploadFile(client)).status).toBe(403);
    expect((await uploadFile(new Client(test))).status).toBe(401);
  });

  it('serves the document only to its owner and admins, on every request', async () => {
    const { client } = await applicant();
    const upload = await json(await uploadFile(client));

    const own = await client.get(upload.downloadUrl);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-disposition')).toContain('attachment; filename="phd-certificate.pdf"');
    expect(own.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await own.arrayBuffer()).equals(Buffer.from(PDF_BYTES))).toBe(true);

    const alex = await signedIn(test, 'alex@rivet.example');
    expect((await alex.get(upload.downloadUrl)).status).toBe(200);
    const opened = await test.ctx.db.get<any>(`SELECT * FROM audit_log WHERE action = 'credential.document_opened' AND subject_id = ?`, [upload.id]);
    expect(opened).toBeTruthy();

    const maya = await signedIn(test, 'maya@helixlab.example');
    expect((await maya.get(upload.downloadUrl)).status).toBe(404);
    expect((await new Client(test).get(upload.downloadUrl)).status).toBe(401);
  });

  it('does not serve dataset uploads through the credential route', async () => {
    const row = await test.ctx.db.get<{ id: string }>(`SELECT id FROM uploads WHERE purpose = 'dataset' LIMIT 1`);
    const alex = await signedIn(test, 'alex@rivet.example');
    expect((await alex.get(`/api/uploads/${row?.id}/download`)).status).toBe(404);
  });

  it('refuses a download when the stored bytes changed', async () => {
    const { client } = await applicant();
    const upload = await json(await uploadFile(client));
    writeFileSync(path.join(test.ctx.config.dataDir, 'uploads', upload.sha256), 'tampered');
    const res = await client.get(upload.downloadUrl);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('hash_mismatch');
  });
});

describe('applying', () => {
  it('saves a partial draft without a real code, then submits with the next APP-n', async () => {
    const { client } = await applicant();
    const draft = await json(await client.post('/api/applications', { domainId: 'biology', legalName: 'Dr. Ada Lane' }));
    expect(draft).toMatchObject({ status: 'draft', hasCode: false, legalName: 'Dr. Ada Lane' });
    expect(draft.code).toMatch(/^DRAFT-/);

    const listed = await json(await client.get('/api/applications'));
    expect(listed.draft.code).toBe(draft.code);
    expect(listed.active).toBeNull();

    const upload = await json(await uploadFile(client));
    const saved = await json(await client.put(`/api/applications/${draft.code}`, applicationBody(upload.id)));
    expect(saved.evidence.filename).toBe('phd-certificate.pdf');
    expect(saved.commitmentAck).toBe(true);

    const res = await client.post(`/api/applications/${draft.code}/submit`);
    expect(res.status).toBe(200);
    const app = await json(res);
    expect(app).toMatchObject({ code: 'APP-030', hasCode: true, status: 'pending' });
    expect(app.submittedAt).toBeTruthy();
    const audited = await test.ctx.db.get<any>(`SELECT * FROM audit_log WHERE action = 'application.submitted' AND subject_code = 'APP-030'`);
    expect(audited).toBeTruthy();
  });

  it('keeps one draft: a second create continues the first', async () => {
    const { client } = await applicant();
    const first = await json(await client.post('/api/applications', { domainId: 'biology' }));
    const second = await json(await client.post('/api/applications', { domainId: 'chemistry', legalName: 'Ada' }));
    expect(second.code).toBe(first.code);
    expect(second.domain.id).toBe('chemistry');
    const count = await test.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM applications WHERE code = ?`, [first.code]);
    expect(count?.n).toBe(1);
  });

  it('validates everything at submission, field by field', async () => {
    const { client } = await applicant();
    const draft = await json(await client.post('/api/applications', { domainId: 'biology', institutionalEmail: 'nope', researchProfileUrl: 'not a link' }));
    const res = await client.post(`/api/applications/${draft.code}/submit`);
    expect(res.status).toBe(422);
    const { error } = await json(res);
    expect(Object.keys(error.fields).sort()).toEqual(['commitmentAck', 'evidenceUploadId', 'institutionalEmail', 'legalName', 'researchBackground', 'researchProfileUrl']);
    expect((await json(await client.get(`/api/applications/${draft.code}`))).status).toBe('draft');
  });

  it('refuses another person’s upload as evidence', async () => {
    const lena = await signedIn(test, 'lena@northbridge.example');
    const theirs = await json(await uploadFile(lena));
    const { client } = await applicant();
    const res = await client.post('/api/applications', applicationBody(theirs.id));
    expect(res.status).toBe(422);
    expect((await json(res)).error.fields.evidenceUploadId).toBeTruthy();
  });

  it('allows only one open application per domain', async () => {
    const { client } = await applicant();
    await submitted(client);
    const again = await client.post('/api/applications', { domainId: 'biology' });
    expect(again.status).toBe(409);
    expect((await json(again)).error.fields.domainId).toMatch(/open Biology application \(APP-030\)/);

    const options = (await json(await client.get('/api/applications'))).domains;
    expect(options.find((d: any) => d.id === 'biology')).toMatchObject({ available: false, reason: 'APP-030 open' });
    expect(options.find((d: any) => d.id === 'chemistry')).toMatchObject({ available: true });

    // The database enforces it too.
    await expect(
      test.ctx.db.run(`INSERT INTO applications (id, code, user_id, domain_id, status, created_at, updated_at) SELECT 'x', 'APP-999', user_id, domain_id, 'pending', created_at, updated_at FROM applications WHERE code = 'APP-030'`),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('refuses a domain the applicant already holds', async () => {
    const samira = await signedIn(test, 'samira@northbridge.example');
    const res = await samira.post('/api/applications', { domainId: 'biology' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toMatch(/already hold a verified Biology credential/);
    const chem = await samira.post('/api/applications', { domainId: 'chemistry' });
    expect(chem.status).toBe(201);
  });

  it('hides other people’s applications', async () => {
    const maya = await signedIn(test, 'maya@helixlab.example');
    expect((await maya.get('/api/applications/APP-029')).status).toBe(404);
    expect((await maya.post('/api/applications/APP-029/withdraw')).status).toBe(404);
    expect((await maya.put('/api/applications/APP-029', { legalName: 'Mallory' })).status).toBe(404);
  });
});

describe('your application', () => {
  it('computes the timeline from the row', async () => {
    const lena = await signedIn(test, 'lena@northbridge.example');
    const { active } = await json(await lena.get('/api/applications'));
    expect(active.code).toBe('APP-029');
    expect(active.timeline).toEqual([
      { term: 'Identity and affiliation', detail: 'Received / Dr. Lena Ortiz' },
      { term: 'Biology credential', detail: 'Admin verification in progress' },
      { term: 'Conflict commitment', detail: 'Acknowledged' },
      { term: 'Independent review access', detail: 'Locked until credential approval' },
    ]);
  });

  it('really withdraws, and frees the domain', async () => {
    const lena = await signedIn(test, 'lena@northbridge.example');
    const res = await lena.post('/api/applications/APP-029/withdraw');
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('withdrawn');
    const row = await test.ctx.db.get<any>(`SELECT status FROM applications WHERE code = 'APP-029'`);
    expect(row.status).toBe('withdrawn');
    expect((await lena.post('/api/applications/APP-029/withdraw')).status).toBe(409);

    const state = await json(await lena.get('/api/reviews'));
    expect(state.state).toBe('apply');
    expect((await lena.post('/api/applications', { domainId: 'biology' })).status).toBe(201);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'application.withdrawn' AND subject_code = 'APP-029'`)).toBeTruthy();
  });

  it('refuses edits once submitted', async () => {
    const lena = await signedIn(test, 'lena@northbridge.example');
    expect((await lena.put('/api/applications/APP-029', { legalName: 'Changed' })).status).toBe(409);
    expect((await lena.post('/api/applications/APP-029/submit')).status).toBe(409);
  });

  it('decides /review by state', async () => {
    const stateOf = async (email: string) => (await json(await (await signedIn(test, email)).get('/api/reviews'))).state;
    expect(await stateOf('maya@helixlab.example')).toBe('apply');
    expect(await stateOf('lena@northbridge.example')).toBe('application');
    expect(await stateOf('samira@northbridge.example')).toBe('queue');
  });
});

describe('admin credential decisions', () => {
  const decisionPaths = ['verify', 'request-evidence', 'decline'];

  it('is refused to everyone but admins, whatever their workspace role or credential', async () => {
    for (const email of ['maya@helixlab.example', 'samira@northbridge.example', 'lena@northbridge.example']) {
      const client = await signedIn(test, email);
      expect((await client.get('/api/admin/credentials')).status).toBe(403);
      expect((await client.get('/api/admin/credentials/APP-029')).status).toBe(403);
      for (const action of decisionPaths) {
        const res = await client.post(`/api/admin/credentials/APP-029/${action}`, { approvedDomainId: 'biology', rationale: 'Trying to self-approve this.', basisAck: true });
        expect(res.status).toBe(403);
        expect((await json(res)).error.message).toBe('Admin role required');
      }
    }
    expect((await test.ctx.db.get<any>(`SELECT status FROM applications WHERE code = 'APP-029'`)).status).toBe('pending');
    expect((await new Client(test).get('/api/admin/credentials')).status).toBe(401);
  });

  it('lists the queue with the seeded items', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const body = await json(await alex.get('/api/admin/credentials'));
    expect(body.awaiting.map((item: any) => item.code)).toEqual(['APP-029']);
    expect(body.decided.map((item: any) => item.code)).toEqual(['APP-028']);
    expect(body.awaiting[0]).toMatchObject({ applicantName: 'Dr. Lena Ortiz', domainName: 'Biology', status: 'pending' });
  });

  it('computes the evidence rows for real', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const body = await json(await alex.get('/api/admin/credentials/APP-029'));
    const row = (key: string) => body.evidenceRows.find((item: any) => item.key === key);
    expect(row('email')).toMatchObject({ detail: 'Domain and name match / Confirmed', confirmed: true });
    expect(row('document')).toMatchObject({ detail: 'ortiz-phd-demo.pdf / Fixture hash verified', confirmed: true });
    expect(row('identity')).toMatchObject({ detail: 'No mismatched name or affiliation', confirmed: true });
    expect(body.documentVerified).toBe(true);
    expect(body.actions.verify.allowed).toBe(true);
  });

  it('flags a mismatched email domain and name', async () => {
    const { client } = await applicant('ada@lab.example', 'Ada Lane');
    await submitted(client, { legalName: 'Someone Else', institutionalEmail: 'someone@other.example' });
    const alex = await signedIn(test, 'alex@rivet.example');
    const body = await json(await alex.get('/api/admin/credentials/APP-030'));
    const row = (key: string) => body.evidenceRows.find((item: any) => item.key === key);
    expect(row('email').confirmed).toBe(false);
    expect(row('email').detail).toMatch(/Not confirmed/);
    expect(row('identity').confirmed).toBe(false);
    expect(row('identity').detail).toMatch(/Legal name “Someone Else” differs from account name “Ada Lane”/);
    expect(row('document').detail).toBe('phd-certificate.pdf / Hash verified');
  });

  it('reports a failed hash after re-reading the bytes, and refuses verification', async () => {
    const { client } = await applicant();
    const app = await submitted(client);
    writeFileSync(path.join(test.ctx.config.dataDir, 'uploads', app.evidence.sha256), 'tampered bytes');
    const alex = await signedIn(test, 'alex@rivet.example');
    const body = await json(await alex.get(`/api/admin/credentials/${app.code}`));
    expect(body.documentVerified).toBe(false);
    expect(body.evidenceRows.find((item: any) => item.key === 'document').detail).toMatch(/Hash mismatch/);
    expect(body.actions.verify).toEqual({ allowed: false, reason: 'Hash mismatch · Evidence quarantined' });
    const res = await alex.post(`/api/admin/credentials/${app.code}/verify`, { approvedDomainId: 'biology', rationale: 'Trying to verify anyway.', basisAck: true });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('hash_mismatch');
  });

  it('verifies: creates the credential, audit entry and mail, and opens the queue', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const bad = await alex.post('/api/admin/credentials/APP-029/verify', { approvedDomainId: 'biology', rationale: 'Too short' });
    expect(bad.status).toBe(422);
    const res = await alex.post('/api/admin/credentials/APP-029/verify', { approvedDomainId: 'biology', rationale: 'Identity and domain evidence are consistent in this fixture.', basisAck: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'verified', mail: { sent: true } });

    const lenaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'lena@northbridge.example'`))?.id;
    const credential = await test.ctx.db.get<any>('SELECT * FROM credentials WHERE user_id = ?', [lenaId]);
    expect(credential).toMatchObject({ domain_id: 'biology', rationale: 'Identity and domain evidence are consistent in this fixture.' });
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'credential.verified' AND subject_code = 'APP-029'`)).toBeTruthy();
    expect((await lastMail(test, 'lena@northbridge.example'))?.subject).toMatch(/Biology credential is verified/);

    const lena = await signedIn(test, 'lena@northbridge.example');
    expect((await json(await lena.get('/api/reviews'))).state).toBe('queue');
    expect((await json(await lena.get('/api/session'))).user.credentials[0].domainName).toBe('Biology');

    // Decided: read-only now.
    const detail = await json(await alex.get('/api/admin/credentials/APP-029'));
    expect(detail.actions.verify.allowed).toBe(false);
    expect((await alex.post('/api/admin/credentials/APP-029/decline', { rationale: 'Changing my mind later.' })).status).toBe(409);
  });

  it('reads a revoked credential as locked, and lets the person apply again', async () => {
    const samira = await signedIn(test, 'samira@northbridge.example');
    await test.ctx.db.run(`UPDATE credentials SET revoked_at = ? WHERE application_id = (SELECT id FROM applications WHERE code = 'APP-028')`, [test.ctx.now().toISOString()]);
    const { active } = await json(await samira.get('/api/applications'));
    expect(active.approvedDomain).toBeNull();
    expect(active.timeline[1].detail).toBe('Verified, then revoked');
    expect(active.timeline[3].detail).toBe('Locked');
    expect((await json(await samira.get('/api/reviews'))).state).toBe('application');
    expect((await samira.post('/api/applications', { domainId: 'biology' })).status).toBe(201);
  });

  it('grants only the domain the admin approved', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    await alex.post('/api/admin/credentials/APP-029/verify', { approvedDomainId: 'chemistry', rationale: 'The evidence supports chemistry instead.', basisAck: true });
    const lena = await signedIn(test, 'lena@northbridge.example');
    const session = await json(await lena.get('/api/session'));
    expect(session.user.credentials.map((c: any) => c.domainId)).toEqual(['chemistry']);
    const { active } = await json(await lena.get('/api/applications'));
    expect(active.approvedDomain.id).toBe('chemistry');
    expect(active.timeline[3].detail).toBe('Open / Verified Chemistry');
  });

  it('shows APP-028 read-only with its seeded decision', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const body = await json(await alex.get('/api/admin/credentials/APP-028'));
    expect(body.application.status).toBe('verified');
    expect(body.credential).toMatchObject({ domainName: 'Biology', grantedByName: 'Alex Rivera' });
    for (const verdict of Object.values<any>(body.actions)) expect(verdict.allowed).toBe(false);
    expect((await alex.post('/api/admin/credentials/APP-028/verify', { approvedDomainId: 'biology', rationale: 'Verifying this again.', basisAck: true })).status).toBe(409);
    expect((await test.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM credentials`))?.n).toBe(1);
  });

  it('requests more evidence: emails the note, reopens the form, keeps the code on resubmission', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const note = 'Please add your degree certificate; the upload is unreadable.';
    const res = await alex.post('/api/admin/credentials/APP-029/request-evidence', { rationale: note });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'more_evidence', mail: { sent: true } });
    const mail = await lastMail(test, 'lena@northbridge.example');
    expect(mail?.subject).toBe('More evidence requested for APP-029');
    expect(mail?.body_text).toContain(note);

    const lena = await signedIn(test, 'lena@northbridge.example');
    const { active } = await json(await lena.get('/api/applications'));
    expect(active).toMatchObject({ code: 'APP-029', status: 'more_evidence', adminNote: note });
    expect(active.timeline[1].detail).toBe('More evidence requested');
    expect((await json(await lena.get('/api/reviews'))).state).toBe('application');

    // The domain is locked, the rest can change.
    expect((await lena.put('/api/applications/APP-029', { domainId: 'chemistry' })).status).toBe(422);
    const upload = await json(await uploadFile(lena, PNG_BYTES, 'better-scan.png', 'image/png'));
    expect((await lena.put('/api/applications/APP-029', { evidenceUploadId: upload.id, researchBackground: 'PhD in Microbiology with a readable certificate attached.' })).status).toBe(200);

    const resubmitted = await json(await lena.post('/api/applications/APP-029/submit'));
    expect(resubmitted).toMatchObject({ code: 'APP-029', status: 'pending' });
    expect(resubmitted.evidence.filename).toBe('better-scan.png');
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'application.resubmitted' AND subject_code = 'APP-029'`)).toBeTruthy();
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'credential.more_evidence' AND subject_code = 'APP-029'`)).toBeTruthy();
  });

  it('declines with a rationale, tells the applicant, and allows a fresh application', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    expect((await alex.post('/api/admin/credentials/APP-029/decline', {})).status).toBe(422);
    const res = await alex.post('/api/admin/credentials/APP-029/decline', { rationale: 'The certificate does not match the requested domain.' });
    expect(await json(res)).toMatchObject({ status: 'declined', mail: { sent: true } });
    expect((await lastMail(test, 'lena@northbridge.example'))?.body_text).toContain('does not match the requested domain');

    const lena = await signedIn(test, 'lena@northbridge.example');
    expect((await json(await lena.get('/api/reviews'))).state).toBe('application');
    const { active } = await json(await lena.get('/api/applications'));
    expect(active).toMatchObject({ status: 'declined', adminNote: 'The certificate does not match the requested domain.', decidedByName: 'Alex Rivera' });
    expect(active.timeline[3].detail).toBe('Locked');
    expect((await lena.post('/api/applications', { domainId: 'biology' })).status).toBe(201);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'credential.declined' AND subject_code = 'APP-029'`)).toBeTruthy();
  });

  it('reports a failed email honestly, keeping the decision', async () => {
    const noMail = await makeTestApp({ seed: true, config: { allowDevOutbox: false } });
    try {
      const alex = await new Client(noMail).signIn('alex@rivet.example');
      const body = await (await alex.post('/api/admin/credentials/APP-029/request-evidence', { rationale: 'Please add your degree certificate.' })).json();
      expect(body.status).toBe('more_evidence');
      expect(body.mail.sent).toBe(false);
      expect(body.mail.reason).toMatch(/not configured/);
    } finally {
      noMail.close();
    }
  });

  it('refuses to let an admin decide their own application', async () => {
    const alex = await signedIn(test, 'alex@rivet.example');
    const upload = await json(await uploadFile(alex));
    const draft = await json(await alex.post('/api/applications', applicationBody(upload.id, { legalName: 'Alex Rivera', institutionalEmail: 'alex@rivet.example' })));
    const app = await json(await alex.post(`/api/applications/${draft.code}/submit`));
    const detail = await json(await alex.get(`/api/admin/credentials/${app.code}`));
    expect(detail.actions.verify).toEqual({ allowed: false, reason: 'You cannot decide your own application.' });
    expect((await alex.post(`/api/admin/credentials/${app.code}/verify`, { approvedDomainId: 'biology', rationale: 'Approving myself, which must fail.', basisAck: true })).status).toBe(403);
  });

  it('does not show drafts to admins', async () => {
    const { client } = await applicant();
    const draft = await json(await client.post('/api/applications', { domainId: 'biology' }));
    const alex = await signedIn(test, 'alex@rivet.example');
    expect((await alex.get(`/api/admin/credentials/${draft.code}`)).status).toBe(404);
    const body = await json(await alex.get('/api/admin/credentials'));
    expect(JSON.stringify(body)).not.toContain(draft.code);
  });

  it('never lets a credential be granted twice for a domain', async () => {
    const { id, client } = await applicant();
    const app = await submitted(client);
    await grantCredential(test, id, 'biology');
    const alex = await signedIn(test, 'alex@rivet.example');
    const res = await alex.post(`/api/admin/credentials/${app.code}/verify`, { approvedDomainId: 'biology', rationale: 'Second grant, which must fail.', basisAck: true });
    expect(res.status).toBe(409);
    expect((await json(res)).error.fields.approvedDomainId).toMatch(/already holds/);
  });
});
