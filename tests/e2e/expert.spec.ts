import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openDb } from '../../server/db/index.ts';
import { DEMO_PASSWORD } from '../../server/db/seed/backbone.ts';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { frozenRun, type FrozenRun } from '../api/expertFixtures.ts';

/**
 * The whole expert and published journey in a browser. Frozen runs are inserted with SQL so this
 * does not depend on the run engine: point RIVET_E2E_DATA_DIR at the server's data directory.
 * Decisions change the database, so run it against a freshly seeded instance.
 */
const dataDir = process.env.RIVET_E2E_DATA_DIR ?? '.e2e-data';
const BASE_URL = process.env.RIVET_E2E_BASE_URL ?? `http://localhost:${process.env.RIVET_E2E_PORT ?? 8797}`;

test.describe.configure({ mode: 'serial' });
test.use({ acceptDownloads: true });

async function insertRun(): Promise<FrozenRun> {
  const db = openDb(path.join(dataDir, 'rivet.db'));
  try {
    const maya = await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`);
    const helix = await db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`);
    const stamp = String(Date.now()).slice(-7);
    return await frozenRun({ ctx: { db, now: () => new Date() } } as never, { ownerId: maya?.id as string, workspaceId: helix?.id as string, taskCode: `BIO-E${stamp}`, stamp });
  } finally {
    db.close();
  }
}

// One sign-in per account for the whole file: sign-in attempts are rate limited per account.
const sessions = new Map<string, BrowserContext>();

async function signIn(browser: Browser, email: string): Promise<Page> {
  const existing = sessions.get(email);
  if (existing) return existing.newPage();
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1024 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  sessions.set(email, context);
  const page = await context.newPage();
  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
  return page;
}

const PDF = { name: 'chen-phd.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n') };

test('leaderboard: the frame’s numbers, an honest count, a domain filter that filters', async ({ browser }) => {
  const page = await signIn(browser, 'maya@helixlab.example');
  await page.goto('/leaderboards');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Biology, with uncertainty in view.');
  for (const text of ['87.4 [83.1, 91.2] n=24', '83.1 [78.5, 87.6] n=24', '77.8 [72.0, 83.4] n=24']) await expect(page.getByText(text)).toBeVisible();
  await expect(page.getByText('Synthetic domain aggregate, not real benchmark results. 24 authored task fixtures; 95% bootstrap intervals.')).toBeVisible();
  await expect(page.getByText(/^Intervals overlap: these synthetic observations/)).toBeVisible();
  await expect(page.getByRole('link', { name: '1 sealed run receipt · 23 authored fixtures →' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Aster 3.2: mean 87.4, 95% confidence interval 83.1 to 91.2/ })).toBeVisible();

  await page.getByLabel('Domain filter').selectOption('chemistry');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chemistry, with uncertainty in view.');
  await expect(page).toHaveURL(/domain=chemistry/);
  await expect(page.getByText(/No Chemistry tasks have been frozen/)).toBeVisible();
  await expect(page.getByText('87.4 [83.1, 91.2] n=24')).toHaveCount(0);

  await page.getByRole('link', { name: 'Read methodology' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How the interval is computed.');
  await page.getByLabel('Domain filter').selectOption('biology');
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(25);
  await expect(table.getByRole('row', { name: /BIO-042 v1.0 86 81 74/ })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Report RPT-BIO-042' })).toBeVisible();
  await expect(table.getByRole('row', { name: /BIO-F01 v1.0 90 99 90 Fixture/ })).toBeVisible();
});

test('report: copying really copies, and only then shows the copied state; the download verifies', async ({ browser }) => {
  const page = await signIn(browser, 'maya@helixlab.example');
  await page.goto('/reports/RPT-BIO-042/v1.0');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A report you can cite.');
  await expect(page.getByText('Frozen / Admin adjudicated / v1.0')).toBeVisible();
  await expect(page.getByText('TAMPER-EVIDENT / HASH VERIFIED')).toBeVisible();
  await expect(page.getByText('Citation copied.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Copy citation' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
  await expect(page.getByText('Frozen / Citation copied ✓')).toBeVisible();
  await expect(page.getByText('Citation copied. Versioned report URL and evidence hash are included.')).toBeVisible();
  await expect(page.getByText('Copied citation', { exact: true })).toBeVisible();
  await expect(page.getByText('RPT-BIO-042 v1.0', { exact: true })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('Chen, M. (2026). BIO-042: Assess evidence for an antibiotic resistance mechanism. Rivet, RPT-BIO-042 v1.0. Synthetic demo report.');
  expect(clipboard).toContain('/reports/RPT-BIO-042/v1.0');
  expect(clipboard).toMatch(/Evidence EV-1042-A SHA-256 [a-f0-9]{64}\./);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download frozen report' }).click()]);
  expect(download.suggestedFilename()).toBe('RPT-BIO-042-v1.0.md');
  const text = readFileSync(await download.path(), 'utf8');
  expect(sha256Hex(text.match(/```json\n(.*)\n```/s)?.[1] as string)).toBe(text.match(/byte for byte: ([a-f0-9]{64})/)?.[1]);

  // A failed clipboard call leaves the page as it was.
  await page.goto('/reports/RPT-BIO-042/v1.0');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    document.execCommand = () => false;
  });
  await page.getByRole('button', { name: 'Copy citation' }).click();
  await expect(page.getByText(/Your browser blocked the clipboard/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy citation' })).toBeVisible();
  await expect(page.getByText('Frozen / Admin adjudicated / v1.0')).toBeVisible();
});

test('reports index: filters and empty states', async ({ browser }) => {
  const page = await signIn(browser, 'lena@northbridge.example');
  await page.goto('/reports');
  await expect(page.getByRole('link', { name: 'RPT-BIO-042 v1.0' })).toBeVisible();
  await page.getByLabel('Domain').selectOption('chemistry');
  await expect(page.getByText('No reports match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('link', { name: 'RPT-BIO-042 v1.0' })).toBeVisible();
  await page.getByLabel('Search').fill('antibiotic');
  await expect(page).toHaveURL(/q=antibiotic/);
  await expect(page.getByRole('link', { name: 'RPT-BIO-042 v1.0' })).toBeVisible();
  await page.getByLabel('Search').fill('no such report');
  await expect(page.getByText('No reports match these filters.')).toBeVisible();
});

test('applying: upload, draft, submit, view, withdraw', async ({ browser }) => {
  const page = await signIn(browser, 'maya@helixlab.example');
  await page.goto('/review');
  await expect(page).toHaveURL(/\/review\/apply$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bring your expertise to the evidence.');
  await expect(page.getByText('Reviewer application / New')).toBeVisible();

  // Nothing filled in: every problem is named, on its own field.
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByText('Describe your research background in at least 20 characters.')).toBeVisible();
  await expect(page.getByText('Upload your credential evidence as a PDF or image.')).toBeVisible();
  await expect(page.getByText('Confirm the independent review commitment to submit.')).toBeVisible();

  // A file that is not a PDF or image is refused with a reason.
  await page.getByLabel('Credential evidence').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('just some text') });
  await expect(page.getByText('Credential evidence must be a PDF, PNG, JPEG or WebP file.')).toBeVisible();

  await page.getByLabel('Credential evidence').setInputFiles(PDF);
  await expect(page.getByText('chen-phd.pdf')).toBeVisible();
  await expect(page.getByText(/· \d+ B · Uploaded/)).toBeVisible();
  await page.getByLabel('Research background').fill('PhD in Microbiology; six years on resistance phenotypes.');
  await page.getByLabel('Research profile').fill('orcid.example/0000-0002-1825-0097');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Research background')).toHaveValue('PhD in Microbiology; six years on resistance phenotypes.');
  await expect(page.getByText('Reviewer application / Draft')).toBeVisible();
  await expect(page.getByText('chen-phd.pdf')).toBeVisible();

  await page.getByLabel('I will declare conflicts and never review my own tasks.').check();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your application is in review');
  await expect(page.getByText(/^Application pending \/ APP-\d+$/)).toBeVisible();
  await expect(page.getByText(/^Submitted .* UTC\. Member access is unchanged; expert privileges remain locked\.$/)).toBeVisible();
  await expect(page.getByText('Locked until credential approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open review queue' })).toHaveAttribute('aria-disabled', 'true');

  await page.getByRole('button', { name: 'View application' }).click();
  const viewing = page.getByRole('dialog');
  await expect(viewing.getByText('orcid.example/0000-0002-1825-0097')).toBeVisible();
  await expect(viewing.getByRole('link', { name: 'chen-phd.pdf' })).toBeVisible();
  await viewing.getByRole('button', { name: 'Close' }).click();
  await expect(viewing).toHaveCount(0);

  await page.getByRole('button', { name: 'Withdraw application' }).click();
  const withdrawing = page.getByRole('dialog');
  await withdrawing.getByRole('button', { name: 'Keep application' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your application is in review');
  await page.getByRole('button', { name: 'Withdraw application' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw application' }).click();
  await expect(page).toHaveURL(/\/review\/apply$/);
  await expect(page.getByText(/withdrawn/).first()).toBeVisible();
});

test('credentials: more evidence, resubmission, verification; non-admins refused', async ({ browser }) => {
  const maya = await signIn(browser, 'maya@helixlab.example');
  await maya.goto('/admin/credentials');
  await expect(maya.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
  await expect(maya.getByRole('main').getByText('Admin role required')).toBeVisible();
  await expect(maya.getByRole('link', { name: /APP-029/ })).toHaveCount(0);

  const alex = await signIn(browser, 'alex@rivet.example');
  await alex.goto('/admin/credentials');
  await expect(alex.getByRole('navigation', { name: 'Administration views' })).toBeVisible();
  await alex.getByRole('link', { name: /APP-028/ }).click();
  await expect(alex.getByText(/^Verified .* by Alex Rivera\. This decision is read-only\.$/)).toBeVisible();
  await expect(alex.getByRole('button', { name: /Verify/ })).toHaveCount(0);

  await alex.goto('/admin/credentials/APP-029');
  await expect(alex.getByRole('heading', { level: 1 })).toHaveText('Verify a domain credential');
  await expect(alex.getByText('Domain and name match / Confirmed')).toBeVisible();
  await expect(alex.getByText('/ Fixture hash verified')).toBeVisible();
  const [document] = await Promise.all([alex.waitForEvent('download'), alex.getByRole('link', { name: 'ortiz-phd-demo.pdf' }).first().click()]);
  expect(document.suggestedFilename()).toBe('ortiz-phd-demo.pdf');
  expect(readFileSync(await document.path(), 'latin1').startsWith('%PDF-')).toBe(true);

  await alex.getByRole('button', { name: 'Verify Biology credential' }).click();
  await expect(alex.getByText('Record the rationale for this decision.')).toBeVisible();
  await alex.getByRole('textbox', { name: 'Rationale' }).fill('Please add a readable degree certificate.');
  await alex.getByRole('button', { name: 'Request more evidence' }).click();
  await expect(alex).toHaveURL(/\/admin\/credentials$/);
  await expect(alex.getByRole('link', { name: /APP-029/ })).toBeVisible();
  await expect(alex.getByText('More evidence', { exact: true }).first()).toBeVisible();

  const lena = await signIn(browser, 'lena@northbridge.example');
  await lena.goto('/review');
  await expect(lena).toHaveURL(/\/review\/application$/);
  await expect(lena.getByText('An admin asked for more evidence: “Please add a readable degree certificate.”')).toBeVisible();
  await lena.getByLabel('Credential evidence').setInputFiles({ ...PDF, name: 'ortiz-readable.pdf' });
  await expect(lena.getByText('ortiz-readable.pdf')).toBeVisible();
  await expect(lena.getByText(/Uploaded/)).toBeVisible();
  await lena.getByRole('button', { name: 'Resubmit application' }).click();
  await expect(lena.getByRole('heading', { level: 1 })).toHaveText('Your application is in review');
  await expect(lena.getByText('Application pending / APP-029')).toBeVisible();

  await alex.goto('/admin/credentials/APP-029');
  await expect(alex.getByRole('link', { name: 'ortiz-readable.pdf' }).first()).toBeVisible();
  await expect(alex.getByText(/ortiz-readable\.pdf \/ Fixture hash verified/)).toBeVisible();
  await alex.getByRole('textbox', { name: 'Rationale' }).fill('Identity, affiliation and domain evidence are consistent. Grant Biology only.');
  await alex.getByRole('button', { name: 'Verify Biology credential' }).click();
  await expect(alex.getByText('Confirm you inspected the source documents and recorded the rationale.')).toBeVisible();
  await alex.getByLabel('I inspected the source documents and recorded the verification rationale.').check();
  await alex.getByRole('button', { name: 'Verify Biology credential' }).click();
  await expect(alex).toHaveURL(/\/admin\/credentials$/);
  await expect(alex.getByRole('link', { name: /APP-029/ })).toBeVisible();

  await lena.goto('/review');
  await expect(lena.getByRole('heading', { level: 1 })).toHaveText('Evidence waiting for an expert.');
  await expect(lena.getByText(/^Biology verified \/ \d+ requested$/)).toBeVisible();
});

test('review to report: request, claim, draft, submit, return, resubmit, finalize, cite', async ({ browser }) => {
  const run = await insertRun();
  const maya = await signIn(browser, 'maya@helixlab.example');

  // The run results page calls this; the owner can do so, once.
  const requestReview = async () => {
    const res = await maya.request.post('/api/reviews', { headers: { 'X-Rivet-Request': '1' }, data: { runCode: run.runCode } });
    return { status: res.status(), body: await res.json() };
  };
  const first = await requestReview();
  expect(first.status).toBe(201);
  const code: string = first.body.code;
  expect((await requestReview()).status).toBe(409);

  // The owner is refused, visibly, with the frame's reason.
  await maya.goto(`/review/${code}`);
  await expect(maya.getByText('You own this task').first()).toBeVisible();
  await expect(maya.getByRole('button', { name: 'Review this task' })).toHaveAttribute('aria-disabled', 'true');

  const samira = await signIn(browser, 'samira@northbridge.example');
  await samira.goto('/review');
  await expect(samira.getByRole('link', { name: new RegExp(run.label) })).toBeVisible();
  await samira.getByRole('button', { name: `Claim ${code}` }).click();
  await expect(samira).toHaveURL(new RegExp(`/review/${code}$`));
  await expect(samira.getByRole('heading', { level: 1 })).toHaveText('Independent expert review');
  await expect(samira.getByText('Biology verified / No ownership conflict')).toBeVisible();
  await expect(samira.getByText('TAMPER-EVIDENT / HASH VERIFIED')).toBeVisible();
  await expect(samira.getByRole('button', { name: 'Publish final adjudication' })).toHaveAttribute('aria-disabled', 'true');

  // Submitting nothing names every problem, including on the tabs out of view.
  await samira.getByRole('button', { name: 'Submit expert review' }).click();
  await expect(samira.getByText('Write your independent evidence assessment in at least 20 characters.')).toBeVisible();
  await expect(samira.getByRole('link', { name: 'Meridian 2.1 · 9 to fix' })).toBeVisible();

  const scoresByModel: [string, number[]][] = [
    ['Aster 3.2', [25, 22, 20, 13]],
    ['Meridian 2.1', [23, 20, 18, 11]],
    ['Lumen 4 Mini', [20, 18, 16, 10]],
  ];
  const criteria = ['Mechanistic reasoning / 30', 'Evidence attribution / 30', 'Alternative explanations / 25', 'Calibrated conclusion / 15'];
  await samira.getByLabel('Your assessment').fill('The outputs treat the observations as association and say where the evidence stops.');
  for (const [model, scores] of scoresByModel) {
    await samira.getByRole('link', { name: new RegExp(`^${model}`) }).click();
    await expect(samira.getByRole('link', { name: new RegExp(`^${model}`) })).toHaveAttribute('aria-current', 'page');
    for (const [index, label] of criteria.entries()) {
      await samira.getByLabel(label).fill(String(scores[index]));
      await samira.getByLabel('Note').nth(index).fill(`${model} note ${index + 1}`);
    }
    await samira.getByLabel(/Reviewer annotation/).fill(`${model}: the limits of the evidence are stated.`);
  }
  await samira.getByRole('button', { name: 'Save review draft' }).click();
  await expect(samira.getByText('Review draft saved')).toBeVisible();
  await expect(samira.getByText('Draft saved', { exact: true })).toBeVisible();

  // Nothing typed was lost across tabs, and the draft survives a reload.
  await samira.reload();
  await samira.getByRole('link', { name: 'Meridian 2.1' }).click();
  await expect(samira.getByLabel('Evidence attribution / 30')).toHaveValue('20');
  await expect(samira.getByLabel('Note').first()).toHaveValue('Meridian 2.1 note 1');
  await samira.getByRole('link', { name: 'Aster 3.2' }).click();
  await expect(samira.getByLabel('Evidence attribution / 30')).toHaveValue('22');

  await samira.getByLabel('Expert rationale').fill('Scores follow the rubric: attribution is present, but inhibitor specificity is unaddressed.');
  await samira.getByLabel('Finding').fill('Uphold the ordering for this task. These scores cannot be generalized beyond it.');
  await samira.getByLabel(new RegExp(`No ownership, financial or authorship conflict for ${run.taskCode}`)).check();
  await samira.getByRole('button', { name: 'Submit expert review' }).click();
  await expect(samira.getByText(/^Submitted .* UTC\. This review is read-only while an admin decides\.$/)).toBeVisible();
  await expect(samira.getByRole('button', { name: 'Submit expert review' })).toHaveCount(0);
  await expect(samira.getByText('25 / 30 · Aster 3.2 note 1')).toBeVisible();

  // The admin sends it back.
  const alex = await signIn(browser, 'alex@rivet.example');
  await alex.goto('/admin/adjudications');
  await alex.getByRole('link', { name: new RegExp(code) }).click();
  await expect(alex.getByRole('heading', { level: 1 })).toHaveText('Make the final determination');
  await expect(alex.getByText('Independent Biology review complete. No conflicts declared; evidence hashes match.')).toBeVisible();
  await expect(alex.getByText('80 / 100 demo', { exact: false }).first()).toBeVisible();
  await expect(alex.getByText('“Uphold the ordering for this task. These scores cannot be generalized beyond it.”')).toBeVisible();
  await alex.getByRole('textbox', { name: 'Rationale' }).fill('Please address inhibitor specificity in the Meridian annotation.');
  await alex.getByRole('button', { name: 'Return to expert' }).click();
  await expect(alex.getByText(/^Returned to Dr\. Samira Patel .*Please address inhibitor specificity/)).toBeVisible();

  // The expert sees the note and the review reopens.
  await samira.goto(`/review/${code}`);
  await expect(samira.getByText(/An admin returned this review: “Please address inhibitor specificity in the Meridian annotation\.”/)).toBeVisible();
  await samira.getByRole('link', { name: 'Meridian 2.1' }).click();
  await samira.getByLabel(/Reviewer annotation/).fill('Meridian 2.1: E03 is weighed against inhibitor specificity.');
  await samira.getByRole('button', { name: 'Submit expert review' }).click();
  await expect(samira.getByText(/^Submitted .* UTC\. This review is read-only while an admin decides\.$/)).toBeVisible();

  // The select decides; changing it swaps which action is live.
  await alex.goto(`/admin/adjudications/${code}`);
  await alex.getByRole('combobox', { name: 'Decision' }).selectOption('return');
  await expect(alex.getByRole('button', { name: 'Finalize & freeze report' })).toHaveAttribute('aria-disabled', 'true');
  await alex.getByRole('combobox', { name: 'Decision' }).selectOption('accept');
  await alex.getByRole('textbox', { name: 'Rationale' }).fill('Uphold the expert’s scores and keep every limit in the report.');
  await alex.getByRole('button', { name: 'Finalize & freeze report' }).click();
  await expect(alex.getByText('Confirm the evidence, reviewer eligibility and provenance checks are complete.')).toBeVisible();
  await alex.getByLabel('Evidence, reviewer eligibility and provenance checks are complete.').check();
  await alex.getByRole('button', { name: 'Finalize & freeze report' }).click();

  const reportName = `RPT-${run.taskCode} v1.0`;
  await expect(alex.getByRole('link', { name: `Open ${reportName}` })).toBeVisible();
  await expect(alex.getByText('Accept expert findings')).toBeVisible();
  await expect(alex.getByText(/Returned .* by Alex Rivera/)).toBeVisible();
  await alex.getByRole('link', { name: `Open ${reportName}` }).click();

  await expect(alex.getByRole('heading', { level: 2, name: 'Uphold the ordering for this task.' })).toBeVisible();
  await expect(alex.getByText(/n = 1 task\. No population confidence interval\./)).toBeVisible();
  await expect(alex.getByText(/Model training exposure remains unknown\./)).toBeVisible();
  await expect(alex.getByText('TAMPER-EVIDENT / HASH VERIFIED')).toBeVisible();

  // Any verified account can read it; the private sources stay checked.
  const lena = await signIn(browser, 'lena@northbridge.example');
  await lena.goto(`/reports/RPT-${run.taskCode}/v1.0`);
  await expect(lena.getByRole('heading', { level: 1 })).toHaveText('A report you can cite.');
  await expect(lena.getByText(/stay private to the task’s workspace/)).toBeVisible();

  // The leaderboard moved, and says why.
  await maya.goto('/leaderboards');
  await expect(maya.getByText('24 authored task fixtures and 1 finalized report', { exact: false })).toBeVisible();
  await expect(maya.getByRole('link', { name: '2 sealed run receipts · 23 authored fixtures →' })).toBeVisible();
  await expect(maya.getByText(/n=25/).first()).toBeVisible();
});
