import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openDb } from '../../server/db/index.ts';
import { ALEX, DEMO_PASSWORD, MAYA, SAMIRA, signIn } from './helpers.ts';

/**
 * External access, Audit Advisor and Administration in a browser. Point RIVET_E2E_DATA_DIR at the
 * server's data directory: the expiry case moves a consent deadline with SQL rather than waiting ten minutes.
 */
const dataDir = process.env.RIVET_E2E_DATA_DIR ?? '.e2e-data';

test.describe.configure({ mode: 'serial' });
test.use({ acceptDownloads: true });

/** Repeatable on a used instance: other specs spend the sign-in allowance, and earlier runs add to Maya's thread. */
test.beforeAll(async () => {
  const db = openDb(path.join(dataDir, 'rivet.db'));
  await db.run(`DELETE FROM rate_limits WHERE key LIKE 'signin:%'`);
  await db.run(
    `DELETE FROM advisor_messages WHERE seq > 2 AND thread_id IN (SELECT th.id FROM advisor_threads th JOIN users u ON u.id = th.user_id WHERE u.email = ?)`,
    [MAYA],
  );
  db.close();
});

/** One sign-in per account per file: sign-in is rate limited, and that is not what these tests are about. */
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

async function asUser(browser: Browser, email: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const stored = sessions.get(email);
  const context = await browser.newContext({ ...options, viewport: options.viewport ?? { width: 1440, height: 1024 }, ...(stored ? { storageState: stored } : {}) });
  const page = await context.newPage();
  if (!stored) {
    await signIn(page, email);
    sessions.set(email, await context.storageState());
  }
  return page;
}

async function startFromAtlas(page: Page, taskCode?: string) {
  await page.goto('/atlas-demo');
  await expect(page.getByRole('heading', { name: 'Atlas Research Client', level: 1 })).toBeVisible();
  await expect(page.getByText('This page stands in for an external client')).toBeVisible();
  if (taskCode) await page.getByLabel('Task code').fill(taskCode);
  await page.getByRole('button', { name: 'Connect to Rivet' }).click();
}

async function expectNoViolations(page: Page, label: string) {
  await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const problems = results.violations.flatMap((violation) => violation.nodes.slice(0, 3).map((node) => `${label} ${violation.id}: ${node.target.join(' ')} :: ${(node.any[0]?.message ?? violation.help).slice(0, 160)}`));
  expect(problems, problems.join('\n')).toEqual([]);
}

test.describe('external access', () => {
  test('a signed-out visitor signs in, approves, and the demo client proves the boundary', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    const page = await context.newPage();
    await startFromAtlas(page);

    // Through sign-in and back, with the whole request intact.
    await page.waitForURL(/\/signin\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toContain('/oauth/authorize?');
    await page.getByLabel('Work email').fill(MAYA);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/oauth\/consent\/OAUTH-\d+/);
    sessions.set(MAYA, await context.storageState());

    // The consent frame, with real values.
    await expect(page.getByRole('heading', { name: 'Connect an AI client', level: 1 })).toBeVisible();
    await expect(page.getByText(/OAUTH-\d+ \/ Maya Chen \/ Helix Lab/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Atlas Research Client requests access' })).toBeVisible();
    await expect(page.getByText('client_atlas_demo · External AI client')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Requested scopes / BIO-042 only' })).toBeVisible();
    await expect(page.getByText('Read RPT-BIO-042 and evidence metadata; no private source files.')).toBeVisible();
    await expect(page.getByText('PKCE S256 / State verified')).toBeVisible();
    await expect(page.getByText(`${new URL(page.url()).host}/atlas-demo/callback`)).toBeVisible();
    await expect(page.locator('nav[aria-label="Workspace navigation"]')).toHaveCount(0);
    await expectNoViolations(page, 'consent');

    // Approve from the keyboard.
    await page.getByRole('button', { name: 'Approve access' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Connection approved', level: 1 })).toBeVisible();
    await expect(page.getByText('Three read/query scopes granted for BIO-042. You can revoke access at any time.')).toBeVisible();
    await expect(page.getByText('Atlas Research Client / client_atlas_demo')).toBeVisible();
    await expect(page.getByText('tasks:read · reports:read · advisor:query')).toBeVisible();
    await expect(page.getByText(/Not issued yet/)).toBeVisible();
    await expectNoViolations(page, 'approved');
    const receiptUrl = page.url();

    await page.getByRole('button', { name: 'Return to Atlas' }).click();
    await page.waitForURL(/\/atlas-demo\/callback/);
    await expect(page.getByRole('heading', { name: 'Atlas is connected' })).toBeVisible();
    await expect(page.locator('.atlas-call').filter({ hasText: 'Read the allowed task' })).toContainText('200 · Allowed');
    await expect(page.locator('.atlas-call').filter({ hasText: 'Read report and evidence metadata' })).toContainText('200 · Allowed');
    await expect(page.locator('.atlas-call').filter({ hasText: 'Ask Audit Advisor' })).toContainText('200 · Allowed');
    const refused = page.locator('.atlas-call').filter({ hasText: 'Try another task, BIO-041' });
    await expect(refused).toContainText('403 · Refused, as it should be');
    await expect(refused).toContainText('This access token is limited to BIO-042 v1.0.');
    // The spent code does not stay in the address bar.
    expect(new URL(page.url()).search).toBe('');
    await expectNoViolations(page, 'callback');

    // The receipt now tells the truth about the token, and cannot send another code.
    const tab = await context.newPage();
    await tab.goto(receiptUrl);
    await expect(tab.getByText(/Issued \/ Expires \d\d:\d\d UTC/)).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Return to Atlas' })).toHaveAttribute('aria-disabled', 'true');

    // Revoke from Profile, then call again from the same demo client: every call stops.
    await tab.goto('/profile');
    await tab.getByRole('button', { name: 'Revoke Atlas Research Client' }).first().click();
    await expect(tab.getByText('Access revoked')).toBeVisible();
    await tab.goto(receiptUrl);
    await expect(tab.getByRole('heading', { name: 'Connection revoked', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Call the API again' }).click();
    await expect(page.locator('.atlas-call').filter({ hasText: 'Read the allowed task' })).toContainText('401');
    await expect(page.locator('.atlas-call').filter({ hasText: 'Read the allowed task' })).toContainText('This access token was revoked.');
    await context.close();
  });

  test('denying records it, and Atlas receives access_denied', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await startFromAtlas(page);
    await page.waitForURL(/\/oauth\/consent\//);
    const code = new URL(page.url()).pathname.split('/').pop() as string;
    await page.getByRole('button', { name: 'Deny request' }).click();

    await expect(page.getByRole('heading', { name: 'No access was granted', level: 1 })).toBeVisible();
    await expect(page.getByText(`${code} / Request denied`, { exact: false })).toBeVisible();
    await expect(page.getByText('Denied by Maya Chen')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to Rivet' })).toBeVisible();
    await expectNoViolations(page, 'denied');

    await page.getByRole('link', { name: 'Return to Atlas' }).click();
    await page.waitForURL(/\/atlas-demo\/callback/);
    await expect(page.getByRole('heading', { name: 'Atlas was not connected' })).toBeVisible();
    await expect(page.getByText(/Rivet returned access_denied/)).toBeVisible();
    await page.context().close();
  });

  test('an expired link cannot approve, on the page or at the server', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await startFromAtlas(page);
    await page.waitForURL(/\/oauth\/consent\//);
    const code = new URL(page.url()).pathname.split('/').pop() as string;
    await page.getByRole('button', { name: 'Approve access' }).waitFor();

    const db = openDb(path.join(dataDir, 'rivet.db'));
    await db.run(`UPDATE oauth_requests SET expires_at = ? WHERE code = ?`, [new Date(Date.now() - 1000).toISOString(), code]);
    db.close();

    // Approving from the stale page is refused, and the page moves to the expired state.
    await page.getByRole('button', { name: 'Approve access' }).click();
    await expect(page.getByRole('heading', { name: 'This request has expired', level: 1 })).toBeVisible();
    await expect(page.getByText(/The consent link expired at \d\d:\d\d UTC after ten minutes\. No token was issued\./)).toBeVisible();
    await expect(page.getByText('Approve expired request · A fresh authorization is required')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve expired request' })).toHaveAttribute('aria-disabled', 'true');
    await expectNoViolations(page, 'expired');

    const refused = await page.request.post(`/api/oauth/requests/${code}/approve`, { headers: { 'X-Rivet-Request': '1' } });
    expect(refused.status()).toBe(409);

    await page.getByRole('link', { name: 'Return to Atlas' }).click();
    await page.waitForURL(/\/atlas-demo\/callback/);
    await expect(page.getByText(/Rivet returned access_denied/)).toBeVisible();
    await page.context().close();
  });

  test('a bad client or redirect shows an error page and never redirects', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    const base = { response_type: 'code', scope: 'tasks:read', resource: 'task:BIO-042', state: 'abc', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

    for (const query of [
      { ...base, client_id: 'client_unknown', redirect_uri: 'https://evil.example/callback' },
      { ...base, client_id: 'client_atlas_demo', redirect_uri: 'https://evil.example/callback' },
    ]) {
      await page.goto(`/oauth/authorize?${new URLSearchParams(query).toString()}`);
      await expect(page.getByRole('heading', { name: 'This connection cannot continue', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Return to the client' })).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe('/oauth/authorize');
      expect(page.url().startsWith('https://evil.example')).toBe(false);
    }
    await expectNoViolations(page, 'refused');

    // A bad scope from a good client can go back, carrying the error.
    await page.goto(`/oauth/authorize?${new URLSearchParams({ ...base, client_id: 'client_atlas_demo', redirect_uri: `${new URL(page.url()).origin}/atlas-demo/callback`, scope: 'tasks:write' }).toString()}`);
    const back = page.getByRole('link', { name: 'Return to the client' });
    await expect(back).toBeVisible();
    expect(new URL((await back.getAttribute('href')) as string).searchParams.get('error')).toBe('invalid_scope');
    await page.context().close();
  });

  test('a task the user cannot read stops at the error page', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await startFromAtlas(page, 'BIO-999');
    await expect(page.getByRole('heading', { name: 'This connection cannot continue', level: 1 })).toBeVisible();
    await expect(page.getByText('This task does not exist or you do not have access to it.')).toBeVisible();
    await page.context().close();
  });

  test('consent is visible only to the requesting user', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await startFromAtlas(page);
    await page.waitForURL(/\/oauth\/consent\//);
    const url = page.url();
    await page.context().close();

    const other = await asUser(browser, SAMIRA);
    await other.goto(url);
    await expect(other.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await expect(other.getByRole('button', { name: 'Approve access' })).toHaveCount(0);
    await other.context().close();
  });

  test('a reloaded callback does nothing', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await page.goto('/atlas-demo/callback?code=stolen&state=whatever');
    await expect(page.getByRole('heading', { name: 'Nothing to complete here' })).toBeVisible();

    // A response whose state is not the one this tab sent is never exchanged.
    await startFromAtlas(page);
    await page.waitForURL(/\/oauth\/consent\//);
    await page.getByRole('button', { name: 'Approve access' }).click();
    await page.getByRole('button', { name: 'Return to Atlas' }).waitFor();
    await page.evaluate(() => {
      const raw = sessionStorage.getItem('atlas-demo:pending') as string;
      sessionStorage.setItem('atlas-demo:pending', JSON.stringify({ ...JSON.parse(raw), state: 'a-different-state' }));
    });
    await page.getByRole('button', { name: 'Return to Atlas' }).click();
    await expect(page.getByRole('heading', { name: 'Atlas refused this response' })).toBeVisible();
    await page.context().close();
  });
});

test.describe('at phone width', () => {
  const noSidewaysScroll = async (page: Page, label: string) => {
    await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, `${label} scrolls sideways`).toBe(false);
    expect(await page.locator('body').innerText(), label).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/);
  };

  test('every external state fits at 390px, with long hashes wrapped', async ({ browser }) => {
    const page = await asUser(browser, MAYA, { viewport: { width: 390, height: 844 } });
    await page.goto('/atlas-demo');
    await noSidewaysScroll(page, 'demo');
    await page.getByRole('button', { name: 'Connect to Rivet' }).click();
    await page.getByRole('button', { name: 'Approve access' }).waitFor();
    await noSidewaysScroll(page, 'consent');
    await page.getByRole('button', { name: 'Approve access' }).click();
    await page.getByRole('button', { name: 'Return to Atlas' }).waitFor();
    await noSidewaysScroll(page, 'approved');
    await page.getByRole('button', { name: 'Return to Atlas' }).click();
    await page.getByRole('heading', { name: 'Atlas is connected' }).waitFor();
    await noSidewaysScroll(page, 'callback');
    await page.goto('/oauth/authorize?client_id=client_unknown');
    await page.getByRole('heading', { name: 'This connection cannot continue' }).waitFor();
    await noSidewaysScroll(page, 'refused');
    await page.context().close();
  });
});

test.describe('Audit Advisor', () => {
  test('shows the seeded thread, answers follow-ups with citations, and copies the answer', async ({ browser }) => {
    const page = await asUser(browser, MAYA, { permissions: ['clipboard-read', 'clipboard-write'] });
    await page.goto('/advisor?task=BIO-042');
    await expect(page.getByRole('heading', { name: 'Ask the evidence.', level: 1 })).toBeVisible();
    await expect(page.getByText('Audit Advisor · Grounded in BIO-042 v1.0, not the open web.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Maya Chen / 15:38 UTC' })).toBeVisible();
    await expect(page.getByText('Why did Aster lose points on evidence attribution? Does the inhibitor result prove efflux caused resistance?')).toBeVisible();
    await expect(page.getByText('Audit Advisor / 3 cited records', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: /\[1\] EV-1042-A/ })).toHaveAttribute('href', '/evidence/EV-1042-A');
    await expect(page.getByText('TAMPER-EVIDENT / HASH VERIFIED')).toBeVisible();
    await expect(page.getByText('Retrieval / No model call')).toBeVisible();
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    await expectNoViolations(page, 'advisor');

    // Copy, with a confirmation only after it worked.
    await page.getByRole('button', { name: 'Copy cited answer' }).click();
    await expect(page.getByText('Cited answer copied')).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('No. E03 supports an efflux hypothesis');
    expect(copied).toContain('[1] EV-1042-A / Attribution rationale / 25 of 30');

    // A question with an empty box is refused on its field.
    await page.getByRole('button', { name: 'Ask Advisor' }).click();
    await expect(page.getByText('Enter a question to ask Audit Advisor.')).toBeVisible();

    // A real retrieval answer.
    const question = page.getByLabel('Message');
    await question.fill('What does E02 show?');
    await question.press('Enter');
    await expect(page.getByText(/E02 in DS-BIO-07 v1.0: acrB transcript 3\.1× control\./)).toBeVisible();
    await expect(page.getByText('Answered in retrieval mode', { exact: false }).last()).toBeVisible();
    await expect(question).toHaveValue('');

    // The insufficient state.
    await question.fill('Does efflux cause the resistance?');
    await page.getByRole('button', { name: 'Ask Advisor' }).click();
    await expect(page.getByRole('heading', { name: 'Audit Advisor / Insufficient evidence' }).last()).toBeVisible();
    await expect(page.getByText('The authorized evidence does not include causal controls. I cannot establish that claim.').last()).toBeVisible();
    await expect(page.getByText('Audit Advisor / Insufficient evidence', { exact: false }).first()).toBeVisible();
    await expectNoViolations(page, 'advisor-insufficient');

    // Reloading keeps the thread.
    await page.reload();
    await expect(page.getByText('Does efflux cause the resistance?').first()).toBeVisible();

    // Citations open real pages.
    for (const [link, url] of [[/\[1\] EV-1042-A/, /\/evidence\/EV-1042-A$/], [/\[2\] DS-BIO-07 v1\.0/, /\/datasets\/DS-BIO-07$/], [/\[3\] REVIEW-042/, /\/review\/REVIEW-042$/]] as const) {
      await page.goto('/advisor?task=BIO-042');
      await page.getByRole('link', { name: link }).first().click();
      await expect(page).toHaveURL(url);
      await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Not found|You do not have access/ })).toHaveCount(0);
    }
    await page.context().close();
  });

  test('the selector only offers what the user may read, and switching opens that task’s thread', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    await page.goto('/advisor');
    const select = page.getByLabel('Frozen task');
    await expect(select).toHaveValue(/^BIO-042\|/);
    const options = await select.locator('option').allTextContents();
    expect(options.some((option) => option.startsWith('BIO-041 v1.0'))).toBe(true);
    expect(options.some((option) => option.startsWith('BIO-043'))).toBe(false);

    await select.selectOption({ label: options.find((option) => option.startsWith('BIO-041')) as string });
    await page.waitForURL(/task=BIO-041/);
    await expect(page.getByText('Audit Advisor · Grounded in BIO-041 v1.0, not the open web.')).toBeVisible();
    await page.context().close();

    const samira = await asUser(browser, SAMIRA);
    await samira.goto('/advisor?task=BIO-042');
    await expect(samira.getByText('Withheld / You cannot read this dataset')).toBeVisible();
    await samira.context().close();
  });
});

test.describe('administration', () => {
  test('non-admins get the locked state on every page', async ({ browser }) => {
    const page = await asUser(browser, MAYA);
    for (const path of ['/admin', '/admin/models', '/admin/checks']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Administration locked', level: 1 })).toBeVisible();
      await expect(page.getByText('Admin role required').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Save metadata revision|Run system checks/ })).toHaveCount(0);
    }
    await expectNoViolations(page, 'locked');
    await page.context().close();
  });

  test('the index shows real queue counts and links', async ({ browser }) => {
    const page = await asUser(browser, ALEX);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Administration views' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Credential queue →' })).toHaveAttribute('href', '/admin/credentials');
    await expect(page.getByText(/\d+ applications? waiting for a decision/)).toBeVisible();
    await expect(page.getByText(/\d+ of \d+ models? available for new evaluations/)).toBeVisible();
    await expectNoViolations(page, 'admin index');
    await page.context().close();
  });

  test('models: select, validate, cancel, save, and see the history', async ({ browser }) => {
    const page = await asUser(browser, ALEX);
    await page.goto('/admin/models');
    await expect(page.getByRole('heading', { name: 'Edit Aster metadata' })).toBeVisible();
    await expect(page.getByText('Aster, Meridian and Lumen are fictional. Metadata is demo content, not provider claims.')).toBeVisible();
    await expect(page.getByText('Rivet Demo / Synthetic response adapter')).toBeVisible();
    await expectNoViolations(page, 'models');

    await page.getByRole('link', { name: /^Meridian/ }).click();
    await page.waitForURL(/model=meridian-2\.1/);
    await expect(page.getByRole('heading', { name: 'Edit Meridian metadata' })).toBeVisible();

    // Required rationale.
    const name = page.getByLabel('Display name');
    const stamp = `Meridian 2.1 ${Date.now()}`;
    await name.fill(stamp);
    await page.getByRole('button', { name: 'Save metadata revision' }).click();
    await expect(page.getByText('Explain why this metadata is changing.')).toBeVisible();

    // Cancel puts back what is stored.
    const before = (await page.getByLabel('Cutoff disclosure').inputValue()) as string;
    await page.getByLabel('Cutoff disclosure').fill('Something else');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Cutoff disclosure')).toHaveValue(before);
    await expect(name).not.toHaveValue(stamp);
    await expect(page.getByText('Explain why this metadata is changing.')).toHaveCount(0);

    // Save.
    await name.fill(stamp);
    const rationale = `End-to-end test of the metadata history, ${stamp}.`;
    await page.getByLabel('Change rationale').fill(rationale);
    await page.getByRole('button', { name: 'Save metadata revision' }).click();
    await expect(page.getByText('Metadata revision saved')).toBeVisible();
    await expect(page.getByRole('link', { name: `${stamp} / Enabled` })).toBeVisible();
    await expect(page.getByText(rationale)).toBeVisible();
    await expect(page.getByLabel('Change rationale')).toHaveValue('');
    // The checkbox is real, and unchanged by the save.
    await expect(page.getByRole('checkbox', { name: 'Available for new evaluations.' })).toBeChecked();
    // Nothing on this form can edit the pin.
    await expect(page.getByText('meridian-2.1-20260918 · 128k / 8k')).toBeVisible();

    // Put the name back: other specs share this database and read the registry.
    await name.fill('Meridian 2.1');
    await page.getByLabel('Change rationale').fill('Restore the display name after this test.');
    await page.getByRole('button', { name: 'Save metadata revision' }).click();
    await expect(page.getByRole('link', { name: 'Meridian 2.1 / Enabled' })).toBeVisible();
    await page.context().close();
  });

  test('checks: runs for real, then exports a real file', async ({ browser }) => {
    const page = await asUser(browser, ALEX);
    await page.goto('/admin/checks');
    await expect(page.getByRole('heading', { name: 'Trust is an operational practice.', level: 1 })).toBeVisible();
    await expect(page.getByText(/Check receipts are computed for real/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Operational events' })).toBeVisible();
    await expectNoViolations(page, 'checks');

    const firstCode = async () => Number(((await page.getByText(/^CHECK-\d+ \/ Artifact hashes$/).textContent()) as string).match(/CHECK-(\d+)/)?.[1]);
    const before = await firstCode();
    await page.getByRole('button', { name: 'Run system checks' }).click();
    await expect(page.getByText('System checks finished')).toBeVisible();
    await expect.poll(firstCode).toBe(before + 6);
    await expect(page.getByText(/^Passed · \d+ of \d+ verified$/)).toBeVisible();
    await expect(page.getByText('Passed · No frozen-version mutation')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export check log' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^rivet-check-log-\d{8}T\d{4}Z\.json$/);
    const parsed = JSON.parse(readFileSync(await file.path(), 'utf8'));
    expect(parsed.schema).toBe('rivet.check_log.v1');
    expect(parsed.runs[0].receipts[0].code).toBe(`CHECK-${before + 6}`);
    await page.context().close();
  });
});
