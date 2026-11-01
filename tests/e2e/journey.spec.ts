import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { ALEX, DEMO_PASSWORD, SAMIRA, outboxLink, uniqueEmail } from './helpers.ts';

/**
 * The product in one test, through the interface only: a brand-new researcher takes a question from
 * sign-up to a published, citable report, with a real expert and a real administrator on the way.
 */
test('a new researcher takes a question all the way to a published report', async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const email = uniqueEmail('ada');
  const workspaceName = `Lane Lab ${Date.now() % 100000}`;
  const researcher = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1024 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await researcher.newPage();

  /* ----- Sign up and verify ----- */
  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/signin\?next=%2Ftasks/);
  await page.getByRole('link', { name: 'Create an account →' }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Enter your full name.')).toBeVisible();
  await expect(page.getByText('Accept the Terms of Service and Privacy Policy to continue.')).toBeVisible();
  await page.getByLabel('Full name').fill('Ada Lane');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('checkbox', { name: /I agree to the/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend link' })).toHaveAttribute('aria-disabled', 'true');

  // Unverified accounts cannot reach research data.
  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/verify$/);
  const unverified = await page.request.get('/api/tasks/editor-options');
  expect(unverified.status()).toBe(403);

  await page.goto(await outboxLink(page.request, email, 'verify'));
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Rivet, Ada.' })).toBeVisible();
  await expect(page.getByText('Email verified / First run')).toBeVisible();

  /* ----- Workspace ----- */
  await page.getByRole('link', { name: 'Create workspace' }).first().click();
  await page.getByLabel('Workspace name').fill(workspaceName);
  await page.getByLabel('Research focus').fill('Evidence-grounded evaluation of resistance mechanisms.');
  await page.getByRole('button', { name: `Create ${workspaceName}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'The people behind the evidence.' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).first().getByRole('link', { name: 'Home' }).click();
  await expect(page.getByText(`01 / Create ${workspaceName}`)).toBeVisible();

  /* ----- Draft from the starter task, with its source pack ----- */
  await page.getByRole('link', { name: 'Use the starter task' }).click();
  await expect(page.getByLabel('Task title')).toHaveValue('Assess evidence for an antibiotic resistance mechanism');
  await page.getByRole('button', { name: 'Add the authored source pack' }).click();
  await expect(page.getByLabel('Dataset')).toHaveValue(/.+/);
  await expect(page).toHaveURL(/\/tasks\/BIO-\d+\/edit$/);
  const code = /\/tasks\/(BIO-\d+)\//.exec(page.url())?.[1] as string;
  await expect(page.getByRole('status').getByText(/Saved \d\d:\d\d UTC/)).toBeVisible();

  /* ----- Freeze ----- */
  await page.getByRole('button', { name: 'Review & freeze' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${code}/freeze$`));
  await expect(page.getByRole('heading', { name: /^Contamination check \/ SCAN-/ })).toBeVisible();
  await expect(page.getByText('Not accessible to Rivet · Unknown')).toBeVisible();
  for (const box of await page.getByRole('checkbox').all()) await box.check();
  await page.getByRole('button', { name: `Freeze ${code} v1.0` }).click();
  await page.getByRole('dialog', { name: 'Freeze version 1.0?' }).getByRole('button', { name: 'Freeze version' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${code}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Private by design.' })).toBeVisible();

  /* ----- Run: stop safely, resume, finish ----- */
  await page.getByRole('button', { name: 'Run evaluation' }).click();
  await expect(page).toHaveURL(/\/runs\/RUN-\d+$/);
  const runCode = /RUN-\d+/.exec(page.url())?.[0] as string;
  await expect(page.getByRole('heading', { level: 1, name: 'Evaluation in progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop after checkpoint' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Resume from the last checkpoint' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Stopped by/)).toBeVisible();
  await page.getByRole('button', { name: `Resume ${runCode}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'What does the evidence support?' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('86 / 100 demo').first()).toBeVisible();

  /* ----- Evidence: a real seal, a real download ----- */
  await page.getByRole('link', { name: 'Inspect Aster evidence' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Evidence, not just a score.' })).toBeVisible();
  await expect(page.getByText('TAMPER-EVIDENT / HASH VERIFIED')).toBeVisible();
  const [evidenceFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download evidence' }).click()]);
  const evidence = JSON.parse(readFileSync(await evidenceFile.path(), 'utf8'));
  expect(JSON.stringify(evidence)).toContain(runCode);
  await page.getByRole('link', { name: 'Back to comparison' }).click();

  /* ----- Request expert review ----- */
  await page.getByRole('button', { name: 'Request expert review' }).click();
  await expect(page.getByText(/REVIEW-\d+/).first()).toBeVisible();
  const reviewCode = /REVIEW-\d+/.exec((await page.getByText(/REVIEW-\d+/).first().textContent()) as string)?.[0] as string;
  await expect(page.getByRole('button', { name: 'Review this task' })).toHaveAttribute('aria-disabled', 'true');

  /* ----- An independent expert ----- */
  const expertContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1024 } });
  const expert = await expertContext.newPage();
  await expert.goto('/signin');
  await expert.getByLabel('Work email').fill(SAMIRA);
  await expert.getByLabel('Password').fill(DEMO_PASSWORD);
  await expert.getByRole('button', { name: 'Sign in' }).click();
  await expect(expert).toHaveURL((url) => !url.pathname.startsWith('/signin'));
  await expert.goto('/review');
  await expert.getByRole('button', { name: `Claim ${reviewCode}` }).click();
  await expect(expert.getByRole('heading', { level: 1, name: 'Independent expert review' })).toBeVisible();
  await expert.getByLabel('Your assessment').fill('The outputs treat the observations as association and say where the evidence stops.');
  const models: [string, number[]][] = [
    ['Aster 3.2', [28, 25, 20, 13]],
    ['Meridian 2.1', [26, 23, 20, 12]],
    ['Lumen 4 Mini', [24, 20, 18, 12]],
  ];
  const criteria = ['Mechanistic reasoning / 30', 'Evidence attribution / 30', 'Alternative explanations / 25', 'Calibrated conclusion / 15'];
  for (const [model, scores] of models) {
    await expert.getByRole('link', { name: new RegExp(`^${model}`) }).click();
    await expect(expert.getByRole('link', { name: new RegExp(`^${model}`) })).toHaveAttribute('aria-current', 'page');
    for (const [index, label] of criteria.entries()) {
      await expert.getByLabel(label).fill(String(scores[index]));
      await expert.getByLabel('Note').nth(index).fill(`${model}: reasoned note ${index + 1}`);
    }
    await expert.getByLabel(/Reviewer annotation/).fill(`${model}: the limits of the evidence are stated.`);
  }
  await expert.getByLabel('Expert rationale').fill('The scores follow the rubric; attribution is present but inhibitor specificity is unaddressed.');
  await expert.getByLabel('Finding').fill('Uphold the ordering for this task. These scores cannot be generalized beyond it.');
  await expert.getByLabel(new RegExp(`No ownership, financial or authorship conflict for ${code}`)).check();
  await expert.getByRole('button', { name: 'Submit expert review' }).click();
  await expect(expert.getByText(/^Submitted .* UTC\. This review is read-only while an admin decides\.$/)).toBeVisible();

  /* ----- The final determination ----- */
  const adminContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1024 } });
  const admin = await adminContext.newPage();
  await admin.goto(`/signin?next=${encodeURIComponent('/admin/adjudications')}`);
  await admin.getByLabel('Work email').fill(ALEX);
  await admin.getByLabel('Password').fill(DEMO_PASSWORD);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin).toHaveURL(/\/admin\/adjudications$/);
  await admin.getByRole('link', { name: new RegExp(reviewCode) }).click();
  await expect(admin.getByRole('heading', { level: 1, name: 'Make the final determination' })).toBeVisible();
  await admin.getByRole('textbox', { name: 'Rationale' }).fill('Uphold the expert’s scores and keep every limit in the report.');
  await admin.getByLabel('Evidence, reviewer eligibility and provenance checks are complete.').check();
  await admin.getByRole('button', { name: 'Finalize & freeze report' }).click();
  await expect(admin.getByRole('link', { name: `Open RPT-${code} v1.0` })).toBeVisible();

  /* ----- The report, cited and downloaded by its owner ----- */
  await page.goto(`/reports/RPT-${code}/v1.0`);
  await expect(page.getByRole('heading', { level: 1, name: 'A report you can cite.' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy citation' }).click();
  await expect(page.getByRole('button', { name: 'Copied ✓' })).toBeVisible();
  const citation = await page.evaluate(() => navigator.clipboard.readText());
  expect(citation).toContain(`RPT-${code} v1.0`);
  expect(citation).toContain(`/reports/RPT-${code}/v1.0`);
  const [reportFile] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download frozen report' }).click()]);
  const report = readFileSync(await reportFile.path(), 'utf8');
  expect(sha256Hex(/```json\n(.*)\n```/s.exec(report)?.[1] as string)).toBe(/byte for byte: ([a-f0-9]{64})/.exec(report)?.[1]);

  /* ----- It now counts on the leaderboard, and the sample grew ----- */
  await page.goto('/leaderboards/methodology');
  await expect(page.getByRole('row', { name: new RegExp(`^${code} v1.0 86 81 74`) })).toBeVisible();

  await researcher.close();
  await expertContext.close();
  await adminContext.close();
});
