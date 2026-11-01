import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * The workspace slice in a real browser. Seeded accounts are signed in once and their cookies
 * reused, so this file stays well inside the sign-in rate limit shared with other specs.
 * Anything that changes data does it on a fresh account, or puts the seeded story back.
 *
 * GitHub runs only when the API was started against this spec's mock provider:
 *   GITHUB_CLIENT_ID=e2e-id GITHUB_CLIENT_SECRET=e2e-secret RIVET_OAUTH_GITHUB_BASE_URL=http://localhost:8802 node server/index.ts
 *   RIVET_E2E_GITHUB_MOCK_PORT=8802 npx playwright test tests/e2e/workspace.spec.ts
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

/** Signs up and verifies through the same routes the pages use. */
async function freshAccount(browser: Browser, name = 'Ada Lane'): Promise<{ context: BrowserContext; email: string; name: string }> {
  const email = `e2e-${unique()}@lab.example`;
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const signUp = await context.request.post('/api/auth/signup', { headers: HEADERS, data: { name, email, password: 'correct-horse-battery', acceptTerms: true } });
  expect(signUp.status()).toBe(201);
  const link = await outboxLink(context, email, 'verify');
  const verified = await context.request.post('/api/auth/verify', { headers: HEADERS, data: { token: new URL(link).searchParams.get('token') } });
  expect(verified.ok()).toBe(true);
  return { context, email, name };
}

async function outboxLink(context: BrowserContext, to: string, purpose: string): Promise<string> {
  const res = await context.request.get('/api/dev/outbox');
  const { messages } = (await res.json()) as { messages: { to: string; purpose: string; link: string }[] };
  const message = messages.find((row) => row.to === to && row.purpose === purpose);
  expect(message, `a ${purpose} message to ${to}`).toBeTruthy();
  return (message as { link: string }).link;
}

const pathOf = (link: string) => new URL(link).pathname;

/** Checks the page as it stands in both themes, then leaves it in the theme it was in. */
async function expectNoAxeViolations(page: Page) {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((violation) => `${theme} ${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
  }
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, before);
}

async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

const workspaceField = (page: Page) => page.getByRole('textbox', { name: 'Workspace URL' });

test.describe('first run and creating a workspace', () => {
  test('a brand-new account sees the frame, creates a workspace, and the steps adapt', async ({ browser }) => {
    const { context, name } = await freshAccount(browser);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Rivet, Ada.' })).toBeVisible();
    await expect(page.getByText('Start with a real question. Build a body of evidence.')).toBeVisible();
    await expect(page.getByText('Email verified / First run')).toBeVisible();
    await expect(page.getByText('Your account is ready. Start a private workspace to create your first evaluation.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'From a real question to inspectable evidence' })).toBeVisible();
    await expect(page.getByText('01 / Create your workspace')).toBeVisible();
    await expect(page.getByText('Assess evidence for an antibiotic resistance mechanism')).toBeVisible();
    await expect(page.getByText('Biology / Microbiology')).toBeVisible();
    await expect(page.getByText('Aster 3.2 · Meridian 2.1 · Lumen 4 Mini')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse demo tasks' })).toHaveAttribute('href', '/tasks');
    const review = page.getByRole('button', { name: 'Review Biology tasks' });
    await expect(review).toHaveAttribute('aria-disabled', 'true');
    await expect(review).toHaveAttribute('title', 'Verified Biology credential required');
    await expect(page.getByLabel('Context and provenance')).toContainText('Review Biology tasks · Verified Biology credential required');
    await expectNoAxeViolations(page);

    await page.getByRole('link', { name: 'Create workspace', exact: true }).first().click();
    await expect(page).toHaveURL(/\/workspace\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'A shared place for rigorous work.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create workspace' })).toBeVisible();
    const rail = page.getByLabel('Context and provenance');
    await expect(rail).toContainText(name);

    const suffix = unique();
    const workspaceName = `Lab ${suffix}`;
    const slug = `lab-${suffix}`;
    await page.getByLabel('Workspace name').fill(workspaceName);
    await expect(workspaceField(page)).toHaveValue(slug);
    await expect(page.getByRole('status').filter({ hasText: 'Available' })).toBeVisible();
    await expect(rail).toContainText(`WS-LAB`);
    await expect(page.getByRole('button', { name: `Create ${workspaceName}` })).toBeVisible();

    // A taken slug is reported live, and creating with it is refused on the field.
    await workspaceField(page).fill('helix-lab');
    await expect(page.getByRole('status').filter({ hasText: 'Taken' })).toBeVisible();
    await expect(page.getByText('This workspace URL is taken. Choose another.')).toBeVisible();
    await page.getByRole('button', { name: `Create ${workspaceName}` }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Check the highlighted fields.' })).toBeVisible();
    await expect(page).toHaveURL(/\/workspace\/new$/);
    await expectNoAxeViolations(page);

    await workspaceField(page).fill('no');
    await expect(page.getByText('Use 3 to 48 lowercase letters, numbers and single hyphens.')).toBeVisible();
    await workspaceField(page).fill(slug);
    await expect(page.getByRole('status').filter({ hasText: 'Available' })).toBeVisible();

    // The select and the privacy checkbox are one setting.
    const visibility = page.getByLabel('Default visibility');
    const privacy = page.getByRole('checkbox', { name: /Keep new tasks and datasets private/ });
    await expect(visibility).toHaveValue('private');
    await expect(privacy).toBeChecked();
    await privacy.uncheck();
    await expect(visibility).toHaveValue('shared');
    await visibility.selectOption('private');
    await expect(privacy).toBeChecked();

    await page.getByLabel('Research focus').fill('A research focus for this test.');
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: `Create ${workspaceName}` }).click();

    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole('heading', { level: 1, name: 'The people behind the evidence.' })).toBeVisible();
    await expect(page.getByText(`${workspaceName} · Workspace settings · ${name}, owner`)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).first()).toContainText(workspaceName.toUpperCase().slice(0, 3), { ignoreCase: true });

    // Home now knows step 1 is done, and the primary action moves on.
    await page.getByRole('navigation', { name: 'Workspace navigation' }).first().getByRole('link', { name: 'Home' }).click();
    await expect(page.getByText(`01 / Create ${workspaceName}`)).toBeVisible();
    await expect(page.getByText('Done · Private tasks and datasets by default.')).toBeVisible();
    await expect(page.getByText(`${workspaceName} is ready. Use the starter task to create your first evaluation.`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Use the starter task' })).toHaveAttribute('href', '/tasks/new?starter=1');
    await expect(page.getByRole('link', { name: 'Create workspace', exact: true })).toHaveCount(0);

    // Its URL is real, and Cancel on the create page goes back.
    await page.goto(`/w/${slug}`);
    await expect(page).toHaveURL(/\/workspace$/);
    await page.getByRole('link', { name: 'Create another workspace' }).click();
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await context.close();
  });

  test('switching workspace from the shell moves everything over', async ({ browser }) => {
    const { context } = await freshAccount(browser);
    const create = async (name: string, slug: string) => (await context.request.post('/api/workspaces', { headers: HEADERS, data: { name, slug, researchFocus: '', defaultVisibility: 'private', keepPrivate: true } })).status();
    const suffix = unique();
    expect(await create(`First ${suffix}`, `first-${suffix}`)).toBe(201);
    expect(await create(`Second ${suffix}`, `second-${suffix}`)).toBe(201);
    const page = await context.newPage();
    await page.goto('/workspace');
    await expect(page.getByText(`Second ${suffix} · Workspace settings`)).toBeVisible();
    const switcher = page.getByLabel('Switch workspace');
    await switcher.selectOption({ label: `First ${suffix}` });
    await expect(page.getByText(`First ${suffix} · Workspace settings`)).toBeVisible();
    await page.reload();
    await expect(page.getByText(`First ${suffix} · Workspace settings`)).toBeVisible();
    await context.close();
  });

  test('someone with no workspace gets a state of their own, and the policy modal works by keyboard', async ({ browser }) => {
    const { context } = await freshAccount(browser);
    const page = await context.newPage();
    await page.goto('/workspace');
    await expect(page.getByText('You are not in a workspace yet.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No workspace yet' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Create workspace' })).toHaveAttribute('href', '/workspace/new');
    const grant = page.getByRole('button', { name: 'Grant Biology credential' });
    await expect(grant).toHaveAttribute('aria-disabled', 'true');
    await expect(grant).toHaveAttribute('title', 'Admin role required');

    const policy = page.getByRole('button', { name: 'View access policy' });
    await policy.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Access policy' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Workspace owner only');
    await expect(dialog).toContainText('Verified domain, never own task');
    await expect(dialog).toContainText('Removing membership revokes workspace access on subsequent requests.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(policy).toBeFocused();
    await expectNoAxeViolations(page);
    await context.close();
  });
});

/** Leaves Helix Lab as the frame draws it, whatever an earlier interrupted run left behind. */
async function resetHelixLab(maya: BrowserContext) {
  const data = await (await maya.request.get('/api/workspaces/current')).json();
  for (const invitation of data.invitations.filter((row: { email: string }) => row.email === SAMIRA)) {
    await maya.request.post(`/api/workspaces/${data.workspace.id}/invitations/${invitation.id}/revoke`, { headers: HEADERS });
  }
  for (const member of data.members.filter((row: { email: string }) => row.email === SAMIRA)) {
    await maya.request.post(`/api/workspaces/${data.workspace.id}/members/${member.userId}/remove`, { headers: HEADERS });
  }
}

test.describe('members and invitations', () => {
  test('an invitation runs from preview to membership to removal', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    await resetHelixLab(maya);
    const page = await maya.newPage();
    await page.goto('/workspace');

    // The frame: Maya's own row, then what is typed, marked as not yet sent.
    await expect(page.getByRole('heading', { level: 1, name: 'The people behind the evidence.' })).toBeVisible();
    await expect(page.getByText('Helix Lab · Workspace settings · Maya Chen, owner')).toBeVisible();
    await expect(page.getByText('Helix Lab / Workspace owner')).toBeVisible();
    await expect(page.getByText('Owner · Active · maya@helixlab.example')).toBeVisible();
    await expect(page.getByText('Invitation not yet sent')).toHaveCount(0);
    await expect(page.getByLabel('Context and provenance')).toContainText('Grant Biology credential · Admin role required');
    const grant = page.getByRole('button', { name: 'Grant Biology credential' });
    await expect(grant).toHaveAttribute('aria-disabled', 'true');

    await page.getByLabel('Email address').fill(SAMIRA);
    await expect(page.getByText('Dr. Samira Patel')).toBeVisible();
    await expect(page.getByText('Member · Invitation not yet sent')).toBeVisible();
    await expect(page.getByText('Dr. Patel will receive access to Helix Lab private tasks and datasets. Their verified Biology credential is independent of workspace membership.')).toBeVisible();
    await expectNoAxeViolations(page);

    // Keyboard: the form submits from the field.
    await page.getByLabel('Email address').press('Enter');
    await expect(page.getByText(/Member · Invitation sent · samira@northbridge\.example/)).toBeVisible();
    await expect(page.getByText('Invitation not yet sent')).toHaveCount(0);
    await expect(page.getByLabel('Email address')).toHaveValue('');
    await expect(page.getByRole('status').filter({ hasText: SAMIRA })).toBeVisible();

    // A second send to the same address is refused with the reason.
    await page.getByLabel('Email address').fill(SAMIRA);
    await expect(page.getByText('An invitation to this address is already pending. Revoke it to send a new one.')).toBeVisible();
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Check the highlighted fields.' })).toBeVisible();
    await page.getByLabel('Email address').fill('');

    const link = pathOf(await outboxLink(maya, SAMIRA, 'invitation'));

    // A different signed-in account is refused, and can sign out to switch.
    const wrong = await freshAccount(browser, 'Wrong Person');
    const wrongPage = await wrong.context.newPage();
    await wrongPage.goto(link);
    await expect(wrongPage.getByRole('heading', { level: 1, name: 'Join Helix Lab.' })).toBeVisible();
    await expect(wrongPage.getByText(`This invitation was sent to a different email address. You are signed in as ${wrong.email}.`)).toBeVisible();
    await expect(wrongPage.getByRole('button', { name: 'Accept invitation' })).toHaveAttribute('aria-disabled', 'true');
    const refused = await wrong.context.request.post(`/api${link}/accept`, { headers: HEADERS });
    expect(refused.status()).toBe(403);
    await expectNoAxeViolations(wrongPage);
    await wrongPage.getByRole('button', { name: 'Sign out to switch account' }).click();

    // Signed out: told what to do, then signing in comes straight back to this link.
    await expect(wrongPage.getByText('Sign in with the invited email address to accept this invitation.')).toBeVisible();
    await expect(wrongPage.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup');
    await expectNoAxeViolations(wrongPage);
    await wrongPage.getByRole('link', { name: 'Sign in' }).click();
    await wrongPage.getByLabel('Work email').fill(SAMIRA);
    await wrongPage.getByLabel('Password').fill(PASSWORD);
    await wrongPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(wrongPage).toHaveURL(new RegExp(`${link}$`));
    await expect(wrongPage.getByText(`This invitation is for your verified address, ${SAMIRA}. Accept it to join.`)).toBeVisible();
    await expectNoAxeViolations(wrongPage);
    await wrongPage.getByRole('button', { name: 'Accept invitation' }).click();

    // Samira is now in Helix Lab, read-only, with the reason on every control.
    await expect(wrongPage).toHaveURL(/\/workspace$/);
    await expect(wrongPage.getByText('Helix Lab · Workspace settings · Maya Chen, owner')).toBeVisible();
    await expect(wrongPage.getByText('Helix Lab / Workspace member')).toBeVisible();
    await expect(wrongPage.getByLabel('Email address')).toBeDisabled();
    await expect(wrongPage.getByLabel('Workspace role')).toBeDisabled();
    await expect(wrongPage.getByText('Workspace owner only').first()).toBeVisible();
    const sendDisabled = wrongPage.getByRole('button', { name: 'Send invitation' });
    await expect(sendDisabled).toHaveAttribute('aria-disabled', 'true');
    await expect(sendDisabled).toHaveAttribute('title', 'Workspace owner only');
    await expect(wrongPage.getByLabel('Context and provenance')).toContainText('Send invitation · Workspace owner only');
    await expectNoAxeViolations(wrongPage);

    // The workspace URL now opens for her, and the one-time link is spent.
    await wrongPage.goto(link);
    await expect(wrongPage.getByText('This invitation has already been used.')).toBeVisible();
    await wrongPage.getByRole('link', { name: 'Return to Home' }).click();
    await expect(wrongPage.getByRole('heading', { level: 1, name: /Welcome back, Samira/ })).toBeVisible();
    await wrongPage.goto('/w/helix-lab');
    await expect(wrongPage).toHaveURL(/\/workspace$/);

    // Maya removes her through the confirmation.
    await page.reload();
    await expect(page.getByText('Member · Active · samira@northbridge.example')).toBeVisible();
    await page.getByRole('button', { name: 'Remove Dr. Samira Patel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove Dr. Samira Patel?' });
    await expect(dialog).toContainText('loses access to Helix Lab on their next request');
    await expectNoAxeViolations(page);
    await dialog.getByRole('button', { name: 'Remove member' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Member · Active · samira@northbridge.example')).toHaveCount(0);

    // Her very next request is back in her own workspace, and the URL reads as not found.
    await wrongPage.reload();
    await expect(wrongPage.getByText('Northbridge Microbiology · Workspace settings')).toBeVisible();
    await wrongPage.goto('/w/helix-lab');
    await expect(wrongPage.getByRole('heading', { name: 'Not found' })).toBeVisible();

    await wrong.context.close();
    await maya.close();
  });

  test('revoking an invitation kills its link', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    const page = await maya.newPage();
    const invitee = `e2e-${unique()}@lab.example`;
    await page.goto('/workspace');
    await page.getByLabel('Email address').fill(invitee);
    await expect(page.getByText('Member · Invitation not yet sent')).toBeVisible();
    await page.getByLabel('Workspace role').selectOption('owner');
    await expect(page.getByText('Owner · Invitation not yet sent')).toBeVisible();
    await expect(page.getByText('As an owner they can also invite and remove members.')).toBeVisible();
    await page.getByLabel('Workspace role').selectOption('member');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const revoke = page.getByRole('button', { name: `Revoke invitation to ${invitee}` });
    await expect(revoke).toBeVisible();

    const link = pathOf(await outboxLink(maya, invitee, 'invitation'));
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    await expect(page.getByText(invitee)).toHaveCount(0);

    const visitor = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const visitorPage = await visitor.newPage();
    await visitorPage.goto(link);
    await expect(visitorPage.getByText('This invitation was revoked. Ask the workspace owner to send a new one.')).toBeVisible();
    await visitor.close();
    await maya.close();
  });
});

test.describe('profile', () => {
  test('reads as the frame for seeded Maya', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    const page = await maya.newPage();
    await page.goto('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Your identity, connected.' })).toBeVisible();
    await expect(page.getByText('Maya Chen · Member · Helix Lab')).toBeVisible();
    await expect(page.getByText('Maya Chen / Member / Workspace owner')).toBeVisible();
    await expect(page.getByLabel('Display name')).toHaveValue('Maya Chen');
    await expect(page.getByText('maya@helixlab.example · Verified')).toBeVisible();
    await expect(page.getByLabel('Bio')).toHaveValue('Microbiology researcher exploring evidence-grounded AI evaluation at Helix Lab.');
    await expect(page.getByText('GitHub / @mayachen-demo')).toBeVisible();
    await expect(page.getByText('Connected · Public identity')).toBeVisible();
    const rail = page.getByLabel('Context and provenance');
    await expect(rail).toContainText('GitHub, LinkedIn and Hugging Face identity connections do not grant private-content access or verified reviewer credentials.');
    await expect(rail).toContainText('Review Biology tasks · Verified Biology credential required');
    await expect(page.getByRole('link', { name: 'Apply to review' })).toHaveAttribute('href', '/review/apply');
    const review = page.getByRole('button', { name: 'Review Biology tasks' });
    await expect(review).toHaveAttribute('aria-disabled', 'true');
    await expect(review).toHaveAttribute('title', 'Verified Biology credential required');
    await expectNoAxeViolations(page);
    await maya.close();

    const samira = await contextFor(browser, SAMIRA);
    const expert = await samira.newPage();
    await expert.goto('/profile');
    await expect(expert.getByRole('link', { name: 'Review Biology tasks' })).toHaveAttribute('href', '/review');
    await expect(expert.getByLabel('Context and provenance')).toContainText('Biology');
    await expect(expert.getByLabel('Context and provenance')).not.toContainText('Action unavailable', { ignoreCase: true });
    await samira.close();
  });

  test('saves for real, refuses an empty name, and shows the empty AI client state', async ({ browser }) => {
    const { context, email } = await freshAccount(browser);
    const page = await context.newPage();
    await page.goto('/profile');
    await expect(page.getByText(`${email} · Verified`)).toBeVisible();
    await expect(page.getByText('No AI clients are authorized on your account.')).toBeVisible();

    await page.getByLabel('Display name').fill('');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Enter your display name.')).toBeVisible();

    await page.getByLabel('Display name').fill('Ada L. Lane');
    await page.getByLabel('Bio').fill('Studies efflux.');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();
    await expect(page.getByText('Ada L. Lane · Member · No workspace')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).first()).toContainText('Ada L. Lane');

    await page.reload();
    await expect(page.getByLabel('Display name')).toHaveValue('Ada L. Lane');
    await expect(page.getByLabel('Bio')).toHaveValue('Studies efflux.');
    await context.close();
  });

  test('a disconnected profile is really gone, and Connect says why it cannot run', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    const page = await maya.newPage();
    await page.goto('/profile');
    const session = await (await maya.request.get('/api/session')).json();
    if (!session.features.linkedin) {
      await expect(page.getByText('Not connected · Connect LinkedIn · LinkedIn connection is not configured on this server')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Connect LinkedIn' })).toHaveAttribute('aria-disabled', 'true');
    }
    const row = page.getByText('Hugging Face / @maya-helix-demo');
    if (await row.count()) {
      await page.getByRole('button', { name: 'Disconnect Hugging Face' }).click();
      const dialog = page.getByRole('dialog', { name: 'Disconnect Hugging Face?' });
      await expect(dialog).toContainText('@maya-helix-demo');
      await dialog.getByRole('button', { name: 'Disconnect' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Hugging Face / @maya-helix-demo')).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('Hugging Face', { exact: true })).toBeVisible();
    }
    await maya.close();
  });
});

test.describe('authorized AI clients', () => {
  test('a client someone approved reads as the frame prints it, and Revoke ends it', async ({ browser }) => {
    const { context } = await freshAccount(browser);
    const suffix = unique();
    await context.request.post('/api/workspaces', { headers: HEADERS, data: { name: `Lab ${suffix}`, slug: `lab-${suffix}`, researchFocus: '', defaultVisibility: 'private', keepPrivate: true } });
    const page = await context.newPage();
    await page.goto('/profile');
    await expect(page.getByText('No AI clients are authorized on your account.')).toBeVisible();

    // The real OAuth flow, over its public contract: BIO-041 is the frozen task any verified account can read.
    const verifier = randomBytes(32).toString('base64url');
    const client = await (await context.request.get('/api/oauth/clients/client_atlas_demo')).json();
    const created = await context.request.post('/api/oauth/requests', {
      headers: HEADERS,
      data: { response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, scope: 'tasks:read reports:read advisor:query', resource: 'task:BIO-041', state: unique(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' },
    });
    expect(created.ok()).toBe(true);
    const approved = await context.request.post(`/api/oauth/requests/${(await created.json()).code}/approve`, { headers: HEADERS });
    expect(approved.ok()).toBe(true);
    const { redirectTo } = await approved.json();
    const issued = await context.request.post('/oauth/token', { form: { grant_type: 'authorization_code', client_id: client.clientId, code: new URL(redirectTo).searchParams.get('code') as string, redirect_uri: client.redirectUri, code_verifier: verifier } });
    expect(issued.ok()).toBe(true);
    const accessToken = (await issued.json()).access_token as string;

    await page.reload();
    await expect(page.getByText('Atlas Research Client')).toBeVisible();
    await expect(page.getByText(/BIO-041 only · Read\/query · Expires .*UTC/)).toBeVisible();
    await expectNoAxeViolations(page);
    await expect((await context.request.get('/api/external/tasks/BIO-041', { headers: { Authorization: `Bearer ${accessToken}` } })).status()).toBe(200);

    await page.getByRole('button', { name: 'Revoke Atlas Research Client' }).click();
    await expect(page.getByText('No AI clients are authorized on your account.')).toBeVisible();
    await expect((await context.request.get('/api/external/tasks/BIO-041', { headers: { Authorization: `Bearer ${accessToken}` } })).status()).toBe(401);
    await context.close();
  });
});

test.describe('home for a returning user', () => {
  test('seeded Maya sees what needs attention, with real links', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    const page = await maya.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Maya.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What needs attention' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue draft: BIO-043 · Limits of inhibitor controls' })).toHaveAttribute('href', '/tasks/BIO-043/edit');
    await expect(page.getByRole('link', { name: /BIO-042 · Assess evidence/ })).toHaveAttribute('href', '/tasks/BIO-042');
    await expect(page.getByRole('link', { name: /RPT-BIO-042 v1\.0/ })).toHaveAttribute('href', '/reports/RPT-BIO-042/v1.0');
    await expect(page.getByRole('link', { name: 'Create task' })).toHaveAttribute('href', '/tasks/new');
    await expect(page.getByRole('button', { name: 'Review Biology tasks' })).toHaveAttribute('aria-disabled', 'true');
    await expectNoAxeViolations(page);
    await maya.close();
  });

  test('a credentialed expert gets a real link to review', async ({ browser }) => {
    const samira = await contextFor(browser, SAMIRA);
    const page = await samira.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Samira.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review Biology tasks' })).toHaveAttribute('href', '/review');
    await samira.close();
  });
});

test.describe('legal pages', () => {
  for (const [path, title, other] of [
    ['/legal/terms', 'Terms of Service', 'Privacy Policy'],
    ['/legal/privacy', 'Privacy Policy', 'Terms of Service'],
  ] as const) {
    test(`${path} says plainly that the text has not been supplied`, async ({ browser }) => {
      const visitor = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const page = await visitor.newPage();
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText('The text of this document has not been supplied yet.')).toBeVisible();
      await expect(page.getByText('This instance is a demo. Its legal text has not been supplied yet.')).toBeVisible();
      await expect(page.getByRole('link', { name: other })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to sign up' })).toHaveAttribute('href', '/signup');
      await expectNoAxeViolations(page);
      await visitor.close();
    });
  }
});

test.describe('at phone width', () => {
  test('nothing scrolls sideways', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA, { width: 390, height: 844 });
    const page = await maya.newPage();
    for (const path of ['/', '/workspace', '/workspace/new', '/profile']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(page);
    }
    await page.goto('/workspace');
    await page.getByLabel('Email address').fill(`a-rather-long-address-for-a-narrow-screen-${unique()}@a-long-domain.example`);
    await expect(page.getByText('Member · Invitation not yet sent')).toBeVisible();
    await expectNoSidewaysScroll(page);
    await maya.close();
  });
});

test.describe('GitHub against a mock provider', () => {
  const mockPort = Number(process.env.RIVET_E2E_GITHUB_MOCK_PORT ?? 0);
  test.skip(!mockPort, 'Set RIVET_E2E_GITHUB_MOCK_PORT and start the API against it: see the top of this file.');

  const account = { id: 0, login: '', email: '', verified: true };
  let server: Server;

  test.beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url as string, `http://localhost:${mockPort}`);
      for await (const _chunk of req) void _chunk;
      const json = (value: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/login/oauth/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri') as string);
        back.searchParams.set('code', 'mock-code');
        back.searchParams.set('state', url.searchParams.get('state') as string);
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/login/oauth/access_token') return json({ access_token: 'mock-token' });
      if (url.pathname === '/user') return json({ id: account.id, login: account.login, name: 'Grace Hub', html_url: `https://github.example/${account.login}` });
      if (url.pathname === '/user/emails') return json([{ email: account.email, primary: true, verified: account.verified }]);
      res.writeHead(404);
      return res.end();
    });
    await new Promise<void>((resolve) => server.listen(mockPort, resolve));
  });

  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test.beforeEach(() => {
    const suffix = unique();
    account.id = Date.now();
    account.login = `grace-${suffix}`;
    account.email = `grace-${suffix}@lab.example`;
    account.verified = true;
  });

  test('signs up, shows the connection, disconnects, and connects again from Profile', async ({ browser }) => {
    const visitor = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await visitor.newPage();
    await page.goto('/signin');
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Rivet, Grace.' })).toBeVisible();

    await page.goto('/profile');
    await expect(page.getByText(`${account.email} · Verified`)).toBeVisible();
    await expect(page.getByText(`GitHub / @${account.login}`)).toBeVisible();

    await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
    await page.getByRole('dialog', { name: 'Disconnect GitHub?' }).getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('link', { name: 'Connect GitHub →' })).toBeVisible();

    await page.getByRole('link', { name: 'Connect GitHub →' }).click();
    await expect(page.getByText('GitHub is connected. This does not grant private-content access or verified reviewer credentials.')).toBeVisible();
    await expect(page.getByText(`GitHub / @${account.login}`)).toBeVisible();
    await expect(page).toHaveURL(/\/profile$/);
    await visitor.close();
  });

  test('an unverified primary email lands on an honest failure page, signed out', async ({ browser }) => {
    account.verified = false;
    const visitor = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await visitor.newPage();
    await page.goto('/signup');
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'GitHub sign-in did not complete.' })).toBeVisible();
    await expect(page.getByText('Your GitHub account has no verified primary email address.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try GitHub again' })).toHaveAttribute('href', '/api/auth/github/start');
    await expectNoAxeViolations(page);
    const session = await (await visitor.request.get('/api/session')).json();
    expect(session.user).toBeNull();
    await visitor.close();
  });

  test('an invitation can be accepted after signing in with GitHub', async ({ browser }) => {
    const maya = await contextFor(browser, MAYA);
    const { user } = await (await maya.request.get('/api/session')).json();
    const sent = await maya.request.post(`/api/workspaces/${user.workspace.id}/invitations`, { headers: HEADERS, data: { email: account.email, role: 'member' } });
    expect(sent.status()).toBe(201);
    const link = pathOf(await outboxLink(maya, account.email, 'invitation'));

    const visitor = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await visitor.newPage();
    await page.goto(link);
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    await expect(page).toHaveURL(new RegExp(`${link}$`));
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByText('Helix Lab · Workspace settings · Maya Chen, owner')).toBeVisible();

    const members = await (await maya.request.get('/api/workspaces/current')).json();
    const joined = members.members.find((row: { email: string }) => row.email === account.email);
    expect((await maya.request.post(`/api/workspaces/${user.workspace.id}/members/${joined.userId}/remove`, { headers: HEADERS })).status()).toBe(200);
    await visitor.close();
    await maya.close();
  });
});
