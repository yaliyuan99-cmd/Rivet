import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

/**
 * The evaluation slice in a real browser: browse, draft, freeze, run, stop, resume, results, evidence.
 * Anything that changes data does it on a fresh account, so BIO-042 and BIO-043 stay as seeded for the
 * other specs. Runs depend on a short stage delay: RIVET_STAGE_MS=300 or so.
 */

const PASSWORD = 'rivet-demo-2026';
const MAYA = 'maya@helixlab.example';
const SAMIRA = 'samira@northbridge.example';
const HEADERS = { 'X-Rivet-Request': '1' };
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Cookies = Awaited<ReturnType<BrowserContext['storageState']>>;
const seededStates = new Map<string, Cookies>();

async function contextFor(browser: Browser, email: string, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  if (!seededStates.has(email)) {
    const signIn = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const res = await signIn.request.post('/api/auth/signin', { headers: HEADERS, data: { email, password: PASSWORD } });
    expect(res.ok(), `signing in ${email}`).toBe(true);
    seededStates.set(email, await signIn.storageState());
    await signIn.close();
  }
  return browser.newContext({ baseURL: test.info().project.use.baseURL, storageState: seededStates.get(email), viewport });
}

async function freshAccount(browser: Browser, { workspace = true } = {}): Promise<BrowserContext> {
  const email = `eval-${unique()}@lab.example`;
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const signUp = await context.request.post('/api/auth/signup', { headers: HEADERS, data: { name: 'Ada Lane', email, password: 'correct-horse-battery', acceptTerms: true } });
  expect(signUp.status()).toBe(201);
  const outbox = (await (await context.request.get('/api/dev/outbox')).json()) as { messages: { to: string; purpose: string; link: string }[] };
  const message = outbox.messages.find((row) => row.to === email && row.purpose === 'verify');
  expect(message, `a verification message to ${email}`).toBeTruthy();
  const token = new URL((message as { link: string }).link).searchParams.get('token');
  expect((await context.request.post('/api/auth/verify', { headers: HEADERS, data: { token } })).ok()).toBe(true);
  if (workspace) {
    const created = await context.request.post('/api/workspaces', { headers: HEADERS, data: { name: 'Lane Lab', slug: `lane-${unique()}`, researchFocus: '', defaultVisibility: 'private', keepPrivate: true } });
    expect(created.status(), await created.text()).toBe(201);
  }
  return context;
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

const PROMPT = 'Assess whether a fluorescent reporter leaks into the medium during stationary phase, and name what would separate leakage from lysis in this culture system.';

/** Fills a brand-new draft through the editor and returns its code. */
async function fillDraft(page: Page): Promise<string> {
  await page.goto('/tasks/new');
  await expect(heading(page, 'Build an evaluation')).toBeVisible();
  await page.getByLabel('Task title').fill('Does the reporter leak?');
  await page.getByLabel('Domain').selectOption('biology');
  await expect(page.getByRole('status').getByText(/Saved \d\d:\d\d UTC/)).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/BIO-\d+\/edit$/);
  const code = /\/tasks\/(BIO-\d+)\/edit$/.exec(page.url())?.[1] as string;
  await page.getByLabel('Prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await page.getByRole('group', { name: 'Criterion 1' }).getByLabel('Criterion').fill('Interpretation');
  await page.getByRole('group', { name: 'Criterion 1' }).getByLabel('Points').fill('70');
  await page.getByRole('group', { name: 'Criterion 1' }).getByLabel('Guidance').fill('Say what the signal can and cannot show.');
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Criterion').fill('Controls');
  await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Points').fill('30');
  for (const name of ['Aster 3.2', 'Meridian 2.1', 'Lumen 4 Mini']) await page.getByRole('checkbox', { name }).check();
  return code;
}

async function freezeFromEditor(page: Page, code: string) {
  await page.getByRole('button', { name: 'Review & freeze' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${code}/freeze$`));
  await expect(page.getByRole('heading', { name: new RegExp(`^Contamination check / SCAN-`) })).toBeVisible();
  await page.getByRole('checkbox', { name: /Training exposure cannot be ruled out/ }).check();
  await page.getByRole('checkbox', { name: /Retain the scan/ }).check();
  await page.getByRole('button', { name: `Freeze ${code} v1.0` }).click();
  await page.getByRole('dialog', { name: 'Freeze version 1.0?' }).getByRole('button', { name: 'Freeze version' }).click();
  await expect(heading(page, 'Private by design.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/tasks/${code}$`));
}

test.describe('browse', () => {
  test('rows, rail, search, filters and empty states come from real data', async ({ browser }) => {
    const context = await contextFor(browser, MAYA);
    const page = await context.newPage();
    await page.goto('/tasks');
    await expect(heading(page, 'Real tasks. Open questions.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'BIO-042 v1.0 / Antibiotic resistance mechanism' })).toBeVisible();
    await expect(page.getByText('Maya Chen · Private · 3 models · Run / Resume / Revise')).toBeVisible();
    await expect(page.getByText('Dr. Samira Patel · Demo shared · Read only')).toBeVisible();
    await expect(page.getByText('Maya Chen · Private draft · No runs yet')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Featured / BIO-042' })).toBeVisible();
    await expect(page.getByText('Review BIO-042 · You own this task')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review BIO-042' })).toHaveAttribute('aria-disabled', 'true');

    await page.getByLabel('Search tasks').fill('antibiotic resistance');
    await expect(page.getByRole('link', { name: /BIO-041/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^BIO-042 v1.0/ })).toBeVisible();
    await expect(page).toHaveURL(/q=antibiotic/);
    await expect(page.getByLabel('Search tasks')).toBeFocused();

    await page.getByLabel('Search tasks').fill('');
    await page.getByLabel('Status').selectOption('draft');
    await expect(page.getByRole('link', { name: /^BIO-043 v0.1/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^BIO-042 v1.0/ })).toHaveCount(0);
    await expect(page).toHaveURL(/status=draft/);

    await page.getByLabel('Domain').selectOption('chemistry');
    await expect(page.getByText('No tasks match this search and these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.getByRole('link', { name: /^BIO-042 v1.0/ })).toBeVisible();

    // The search box follows the address, so the navigation link clears a search for good.
    await page.getByLabel('Search tasks').fill('antibiotic');
    await expect(page).toHaveURL(/q=antibiotic/);
    await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
    await expect(page.getByLabel('Search tasks')).toHaveValue('');
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/q=/);

    await page.getByRole('link', { name: 'Open BIO-042' }).click();
    await expect(heading(page, 'Private by design.')).toBeVisible();
    await context.close();
  });

  test('another account sees only what it may read', async ({ browser }) => {
    const context = await freshAccount(browser);
    const page = await context.newPage();
    await page.goto('/tasks');
    await expect(page.getByRole('link', { name: /^BIO-041 v1.0/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^BIO-042/ })).toHaveCount(0);
    await expect(page.getByText('Review BIO-041 · Verified Biology credential required')).toBeVisible();

    await page.goto('/tasks/BIO-042');
    await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
    await page.goto('/runs/RUN-1042');
    await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
    await page.goto('/evidence/EV-1042-A');
    await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();

    await page.goto('/tasks/BIO-041');
    await expect(heading(page, 'Shared for inspection.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run evaluation' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Run evaluation · Only the task owner can run this task.')).toBeVisible();
    await expect(page.getByText('Only the task owner can change visibility.', { exact: false })).toBeVisible();
    await context.close();
  });
});

test.describe('from a draft to sealed evidence', () => {
  test('editor validation, autosave, freeze, run, stop, resume, results, evidence and revision', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await freshAccount(browser);
    const page = await context.newPage();

    /* ----- Editor ----- */
    await page.goto('/tasks/new');
    await expect(page.getByRole('status').getByText('Draft / Private / Not saved yet')).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Enter a task title to continue.')).toBeVisible();
    await expect(page.getByLabel('Task title')).toBeFocused();

    const code = await fillDraft(page);

    // Points must total 100, live.
    await expect(page.getByText('Total 100 / 100')).toBeVisible();
    await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Points').fill('20');
    await expect(page.getByText('Total 90 / 100 · 10 left to assign')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Meridian 2.1' }).uncheck();
    await page.getByRole('checkbox', { name: 'Lumen 4 Mini' }).uncheck();

    // Review & freeze refuses with field-level reasons and stays put.
    await page.getByRole('button', { name: 'Review & freeze' }).click();
    await expect(page.getByText('Rubric points must total 100. They total 90.')).toBeVisible();
    await expect(page.getByText('Select 2–4 models. 1 selected.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/tasks/${code}/edit$`));
    await expectNoAxeViolations(page);

    await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Points').fill('30');
    await page.getByRole('checkbox', { name: 'Meridian 2.1' }).check();
    await page.getByRole('checkbox', { name: 'Lumen 4 Mini' }).check();
    await expect(page.getByText('Total 100 / 100')).toBeVisible();

    // Autosave really saved: a reload brings it all back.
    await expect(page.getByRole('status').getByText(/Saved \d\d:\d\d UTC/)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Prompt')).toHaveValue(PROMPT);
    await expect(page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Criterion')).toHaveValue('Controls');
    await expect(page.getByRole('checkbox', { name: 'Lumen 4 Mini' })).toBeChecked();
    await page.getByRole('group', { name: 'Criterion 2' }).getByRole('button', { name: 'Remove Controls' }).click();
    await expect(page.getByText('Total 70 / 100 · 30 left to assign')).toBeVisible();
    await page.getByRole('button', { name: 'Add criterion' }).click();
    await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Criterion').fill('Controls');
    await page.getByRole('group', { name: 'Criterion 2' }).getByLabel('Points').fill('30');

    /* ----- Freeze ----- */
    await page.getByRole('button', { name: 'Review & freeze' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${code}/freeze$`));
    await expect(heading(page, 'Freeze the evidence contract')).toBeVisible();
    await expect(page.getByRole('status').getByText('Freeze preview / v1.0')).toBeVisible();
    const number = code.split('-')[1];
    await expect(page.getByRole('heading', { name: `Contamination check / SCAN-${number}` })).toBeVisible();
    await expect(page.getByText('Not accessible to Rivet · Unknown')).toBeVisible();

    // Both acknowledgements are required, and the page says so.
    await page.getByRole('button', { name: `Freeze ${code} v1.0` }).click();
    await expect(page.getByText('Acknowledge the scan findings to freeze this version.')).toBeVisible();
    await expect(page.getByText('Agree to retain the scan and its limitations to freeze this version.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Training exposure cannot be ruled out/ }).check();
    await page.getByRole('checkbox', { name: /Retain the scan/ }).check();
    await page.getByRole('button', { name: `Freeze ${code} v1.0` }).click();
    const dialog = page.getByRole('dialog', { name: 'Freeze version 1.0?' });
    await expect(dialog.getByText('The prompt, rubric and model revisions become immutable.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: `Freeze ${code} v1.0` }).click();
    await dialog.getByRole('button', { name: 'Freeze version' }).click();

    /* ----- Task page ----- */
    await expect(heading(page, 'Private by design.')).toBeVisible();
    await expect(page.getByText(`${code} v1.0 · Lane Lab · Owner Ada Lane`)).toBeVisible();
    await expect(page.getByRole('status').getByText('Private / Lane Lab / Frozen')).toBeVisible();
    await expect(page.getByText('Only Lane Lab members and explicitly authorized reviewers can access this task and its evidence.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review this task' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Review this task · You own this task')).toBeVisible();

    // Visibility saves.
    await page.getByLabel('Task visibility').selectOption('shared');
    await expect(page.getByText('Visibility saved')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Task visibility')).toHaveValue('shared');
    await expect(heading(page, 'Shared for inspection.')).toBeVisible();
    await page.getByLabel('Task visibility').selectOption('private');
    await expect(heading(page, 'Private by design.')).toBeVisible();

    /* ----- Running ----- */
    await page.getByRole('button', { name: 'Run evaluation' }).click();
    await expect(heading(page, 'Evaluation in progress')).toBeVisible();
    await expect(page).toHaveURL(/\/runs\/RUN-\d+$/);
    const runCode = /\/runs\/(RUN-\d+)$/.exec(page.url())?.[1] as string;
    await expect(page.getByText(`${code} v1.0 · ${runCode} · Three models, one frozen task.`)).toBeVisible();
    await expect(page.getByText(/\d+% complete\. Evidence is captured at every checkpoint; you can leave this page\./)).toBeVisible();

    /* ----- Stop, then the interrupted state ----- */
    await page.getByRole('button', { name: 'Stop after checkpoint' }).click();
    await expect(heading(page, 'Resume from the last checkpoint')).toBeVisible();
    await expect(page.getByRole('status').getByText(`Safe stop / ${runCode}`)).toBeVisible();
    await expect(page.getByText(/^Stopped by the owner at \d\d:\d\d UTC\. No evidence lost\. Resume only incomplete work\.$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Preserved work' })).toBeVisible();
    await expect(page.getByText(/Only the task owner can resume a run/)).toBeVisible();
    await expectNoAxeViolations(page);

    /* ----- Resume, then results ----- */
    await page.getByRole('button', { name: `Resume ${runCode}` }).click();
    await expect(heading(page, 'What does the evidence support?')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status').getByText('Run complete / Expert review pending')).toBeVisible();
    await expect(page.getByText('Synthetic demo scores. n = 1 task; no population confidence interval is estimated.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rubric comparison / Aster · Meridian · Lumen' })).toBeVisible();
    await expect(page.getByText('3 sealed output snapshots')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The consequential difference' })).toBeVisible();
    await expect(page.getByText(/^Aster scored highest at \d+ \/ 100 demo/)).toBeVisible();
    const evidenceCode = `EV-${runCode.slice(4)}-A`;
    await expect(page.getByText(new RegExp(`^\\d+ / 100 demo · ${evidenceCode}$`))).toBeVisible();

    /* ----- Evidence ----- */
    await page.getByRole('link', { name: 'Inspect Aster evidence' }).click();
    await expect(heading(page, 'Evidence, not just a score.')).toBeVisible();
    await expect(page.getByText(`${evidenceCode} · Aster 3.2 · ${code} v1.0`)).toBeVisible();
    await expect(page.getByText(/^TAMPER-EVIDENT \/ HASH VERIFIED$/i)).toBeVisible();
    await expect(page.getByText(/Synthetic demo response from Aster 3\.2/)).toBeVisible();
    await expect(page.getByText('No source pack is pinned to this version.')).toBeVisible();
    await expect(page.getByText('No expert has reviewed this output yet. An annotation appears here once a review is submitted.')).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download evidence' }).click()]);
    expect(download.suggestedFilename()).toBe(`${evidenceCode}.json`);
    const file = JSON.parse(await readFile((await download.path()) as string, 'utf8')) as { manifest: Record<string, unknown>; sha256: string; verification: { verified: boolean } };
    expect(file.verification.verified).toBe(true);
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => [key, sortKeys(item)]));
      return value;
    };
    expect(createHash('sha256').update(JSON.stringify(sortKeys(file.manifest))).digest('hex')).toBe(file.sha256);

    await page.getByRole('link', { name: 'Back to comparison' }).click();
    await expect(heading(page, 'What does the evidence support?')).toBeVisible();

    /* ----- Request review ----- */
    await page.getByRole('button', { name: 'Request expert review' }).click();
    await expect(page.getByRole('status').getByText('Run complete / Expert review requested')).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open REVIEW-\d+$/ })).toBeVisible();

    /* ----- Revise ----- */
    await page.goto(`/tasks/${code}`);
    await expect(page.getByRole('link', { name: `${runCode} / ${code} v1.0` })).toBeVisible();
    await page.getByRole('button', { name: 'Revise as v1.1' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${code}/edit$`));
    await expect(page.getByRole('status').getByText(/Draft v1\.1 \/ Private/)).toBeVisible();
    await expect(page.getByLabel('Domain')).toBeDisabled();
    await page.goto(`/tasks/${code}`);
    await expect(page.getByText(`${code} v1.0 · Lane Lab · Owner Ada Lane`)).toBeVisible();
    await expect(page.getByRole('status').getByText('Private / Lane Lab / Frozen / v1.1 draft')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue editing v1.1' })).toBeVisible();
    await context.close();
  });

  test('a run can be left and found again, and finishes on its own', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await freshAccount(browser);
    const page = await context.newPage();
    const code = await fillDraft(page);
    await freezeFromEditor(page, code);
    await page.getByRole('button', { name: 'Run evaluation' }).click();
    await expect(heading(page, 'Evaluation in progress')).toBeVisible();
    const runCode = /\/runs\/(RUN-\d+)$/.exec(page.url())?.[1] as string;
    await expectNoAxeViolations(page);

    await page.goto(`/tasks/${code}`);
    await page.getByRole('link', { name: new RegExp(`^Open ${runCode}$|^${runCode} / `) }).first().click();
    await expect(heading(page, 'What does the evidence support?')).toBeVisible({ timeout: 30_000 });
    await context.close();
  });
});

test.describe('the seeded story', () => {
  test('RUN-1042 reads as the frames do', async ({ browser }) => {
    const context = await contextFor(browser, MAYA);
    const page = await context.newPage();
    await page.goto('/runs/RUN-1042');
    await expect(heading(page, 'What does the evidence support?')).toBeVisible();
    await expect(page.getByText('BIO-042 v1.0 · Assess evidence for an antibiotic resistance mechanism')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Aster 3.2' })).toBeVisible();
    await expect(page.getByText('86 / 100 demo · EV-1042-A')).toBeVisible();
    await expect(page.getByText('81 / 100 demo · EV-1042-M')).toBeVisible();
    await expect(page.getByText('74 / 100 demo · EV-1042-L')).toBeVisible();
    await expect(page.getByText('28 · 26 · 24')).toBeVisible();
    await expect(page.getByText('Mechanistic reasoning / 30')).toBeVisible();
    await expect(page.getByText('Aster distinguishes a plausible efflux mechanism from a causal claim. Its attribution deduction reflects a missing inhibitor-specificity caveat.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open REVIEW-042' })).toHaveAttribute('href', '/review/REVIEW-042');
    await expect(page.getByRole('link', { name: 'Open RPT-BIO-042 v1.0' })).toHaveAttribute('href', '/reports/RPT-BIO-042/v1.0');
    await expect(page.getByRole('link', { name: 'Tasks', exact: true }).first()).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: 'Inspect Aster evidence' }).click();
    await expect(page.getByText('E01 / MIC assay')).toBeVisible();
    await expect(page.getByText('0.25 → 1.00 µg/mL ciprofloxacin')).toBeVisible();
    await expect(page.getByText(/^Attribution 25\/30: E03 is not pump-specific causal evidence/)).toBeVisible();
    await expect(page.getByText('aster-3.2-20261001')).toBeVisible();
    await expect(page.getByText('86 / 100 demo · 4 criteria')).toBeVisible();
    await context.close();
  });

  test('a non-owner gets the exact reasons, and a reviewer gets a real link', async ({ browser }) => {
    const context = await contextFor(browser, SAMIRA);
    const page = await context.newPage();
    await page.goto('/tasks/BIO-042');
    await expect(page.getByRole('button', { name: 'Run evaluation' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Run evaluation · Only the task owner can run this task.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revise as v1.1' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('link', { name: 'Review this task' })).toHaveAttribute('href', '/review/REVIEW-042');
    await expect(page.getByRole('combobox', { name: 'Task visibility' })).toHaveCount(0);

    await page.goto('/runs/RUN-1042');
    await expect(page.getByRole('link', { name: 'Review this task' })).toHaveAttribute('href', '/review/REVIEW-042');
    await page.goto('/tasks/BIO-042/edit');
    await expect(page.getByRole('heading', { level: 1, name: 'You do not have access' })).toBeVisible();
    await expect(page.getByText('Only the task owner can edit this task.')).toBeVisible();
    await context.close();
  });

  test('editing a frozen version offers a revision instead', async ({ browser }) => {
    const context = await contextFor(browser, MAYA);
    const page = await context.newPage();
    await page.goto('/tasks/BIO-042/edit');
    await expect(page.getByText('BIO-042 v1.0 is frozen. Frozen versions are never edited. Revise it as v1.1 to make changes.')).toBeVisible();
    await expect(page.getByLabel('Prompt')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revise as v1.1' })).toBeVisible();
    await context.close();
  });

  test('the frozen scan stays readable', async ({ browser }) => {
    const context = await contextFor(browser, MAYA);
    const page = await context.newPage();
    await page.goto('/tasks/BIO-042/freeze');
    await expect(page.getByRole('heading', { name: 'Contamination check / SCAN-042' })).toBeVisible();
    await expect(page.getByText('“increased AcrAB-TolC efflux” · Low risk')).toBeVisible();
    await expect(page.getByText('One possible terminology overlap. This signal is not proof of training contamination.')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Retain the scan/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /Retain the scan/ })).toBeChecked();
    await context.close();
  });
});

test.describe('the starter and a new workspace', () => {
  test('without a workspace, a new task sends you to create one', async ({ browser }) => {
    const context = await freshAccount(browser, { workspace: false });
    const page = await context.newPage();
    await page.goto('/tasks/new');
    await expect(page).toHaveURL(/\/workspace\/new/);
    await context.close();
  });

  test('the starter prefills, and adds the records it cites in one step', async ({ browser }) => {
    const context = await freshAccount(browser);
    const page = await context.newPage();
    await page.goto('/tasks/new?starter=1');
    await expect(page.getByLabel('Task title')).toHaveValue('Assess evidence for an antibiotic resistance mechanism');
    await expect(page.getByLabel('Prompt')).toHaveValue(/^Using E01–E03, assess whether increased AcrAB-TolC efflux/);
    await expect(page.getByRole('checkbox', { name: 'Aster 3.2' })).toBeChecked();
    await expect(page.getByText('Total 100 / 100')).toBeVisible();
    await expect(page.getByRole('status').getByText('Draft / Private / Not saved yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add the authored source pack' }).click();
    await expect(page.getByLabel('Dataset')).toHaveValue(/.+/);
    await expect(page.getByLabel('Dataset').locator('option:checked')).toContainText('Resistance evidence pack');
    await expect(page).toHaveURL(/\/tasks\/BIO-\d+\/edit$/);
    await context.close();
  });

  test('in a workspace that has the pack, the starter attaches it', async ({ browser }) => {
    const context = await contextFor(browser, MAYA);
    const page = await context.newPage();
    await page.goto('/tasks/new?starter=1');
    await expect(page.getByLabel('Dataset')).toContainText('DS-BIO-07 v1.0');
    await expect(page.getByLabel('Dataset').locator('option:checked')).toContainText('DS-BIO-07 v1.0');
    await expect(page.getByRole('link', { name: 'Download the authored source pack' })).toHaveCount(0);
    await context.close();
  });
});

test.describe('accessibility and small screens', () => {
  const PATHS = ['/tasks', '/tasks?q=nothing-matches-this', '/tasks/new?starter=1', '/tasks/BIO-042', '/tasks/BIO-043/edit', '/tasks/BIO-042/freeze', '/runs/RUN-1042', '/evidence/EV-1042-A'];

  for (const theme of ['light', 'dark'] as const) {
    test(`no WCAG A or AA violations in the ${theme} theme`, async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await contextFor(browser, MAYA);
      await context.addInitScript((value) => localStorage.setItem('rivet-theme', value), theme);
      const page = await context.newPage();
      for (const path of PATHS) {
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
        await expectNoAxeViolations(page);
      }
      await context.close();
    });
  }

  test('nothing scrolls sideways at 390px', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await contextFor(browser, MAYA, { width: 390, height: 844 });
    const page = await context.newPage();
    for (const path of PATHS) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
      await expectNoSidewaysScroll(page);
    }
    await context.close();
  });

  test('the freeze flow works from the keyboard', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await freshAccount(browser);
    const page = await context.newPage();
    const code = await fillDraft(page);
    await page.getByRole('button', { name: 'Review & freeze' }).click();
    await expect(page.getByRole('heading', { name: /^Contamination check \/ SCAN-/ })).toBeVisible();
    for (const name of [/Training exposure cannot be ruled out/, /Retain the scan/]) {
      await page.getByRole('checkbox', { name }).focus();
      await page.keyboard.press('Space');
      await expect(page.getByRole('checkbox', { name })).toBeChecked();
    }
    await page.getByRole('button', { name: `Freeze ${code} v1.0` }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Freeze version 1.0?' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: `Freeze ${code} v1.0` }).focus();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Freeze version' }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page, 'Private by design.')).toBeVisible();
    await context.close();
  });
});
