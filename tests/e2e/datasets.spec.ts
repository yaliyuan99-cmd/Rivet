import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Cookie, type Page } from '@playwright/test';
import { LENA, MAYA, SAMIRA, signIn } from './helpers.ts';

/** Sign-in is rate limited per account, so each person signs in once and later tests reuse the session. */
const sessions = new Map<string, Cookie[]>();
async function become(page: Page, email: string) {
  await page.context().clearCookies();
  const saved = sessions.get(email);
  if (saved) {
    await page.context().addCookies(saved);
    return;
  }
  await signIn(page, email);
  sessions.set(email, await page.context().cookies());
}

const dir = mkdtempSync(path.join(tmpdir(), 'rivet-e2e-datasets-'));
const write = (name: string, content: string | Buffer) => {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
};
const GOOD = 'source_id,observation,provenance\nE01,"MIC shift, fourfold",Authored fixture\nE02,acrB up,Authored fixture\nE03,Partial reversal,Authored fixture\n';

const chooseFile = (page: Page, file: string) => page.locator('input[type="file"]').setInputFiles(file);

test.describe('datasets', () => {
  test.beforeEach(async ({ page }) => {
    await become(page, MAYA);
  });

  test('the library reads like the frame and the filter really filters', async ({ page }) => {
    await page.goto('/datasets');
    await expect(page.getByRole('heading', { name: 'Data with a paper trail.' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Dataset library \/ \d+ private datasets/i })).toBeVisible();
    await expect(page.getByText('Resistance evidence pack / DS-BIO-07')).toBeVisible();
    await expect(page.getByText('v1.0 · 3 records · Attached to BIO-042')).toBeVisible();
    await expect(page.getByText('v0.2 · 8 records')).toBeVisible();
    await expect(page.getByText('MIC reporting notes / DS-BIO-06')).toHaveCount(0);

    const filter = page.getByRole('combobox', { name: 'Show datasets by visibility' });
    await filter.selectOption('shared');
    await expect(page).toHaveURL(/visibility=shared/);
    await expect(page.getByText('MIC reporting notes / DS-BIO-06')).toBeVisible();
    await expect(page.getByText('Shared by Northbridge Microbiology')).toBeVisible();
    await expect(page.getByText('Resistance evidence pack / DS-BIO-07')).toHaveCount(0);
    await filter.selectOption('all');
    await expect(page.getByText('MIC reporting notes / DS-BIO-06')).toBeVisible();
    await expect(page.getByText('Resistance evidence pack / DS-BIO-07')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Dataset library \/ \d+ datasets/i })).toBeVisible();
    await filter.selectOption('private');
    await expect(page.getByText('MIC reporting notes / DS-BIO-06')).toHaveCount(0);
  });

  test('someone without a workspace gets the empty state', async ({ page }) => {
    await become(page, LENA);
    await page.goto('/datasets');
    await expect(page.getByText(/not in a workspace yet/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a workspace' }).first()).toBeVisible();
    const upload = page.getByRole('button', { name: 'Upload dataset' });
    await expect(upload).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Upload dataset · Create a workspace before uploading a dataset.')).toBeVisible();
  });

  test('upload, create, new version, download and delete really happen', async ({ page }) => {
    await page.goto('/datasets');
    await page.getByRole('link', { name: 'Upload dataset' }).click();
    await expect(page).toHaveURL(/\/datasets\/upload/);
    await expect(page.getByRole('heading', { name: 'Bring your source material.' })).toBeVisible();

    // Nothing can be created before a file passes validation.
    const planned = page.getByRole('button', { name: /^Create DS-BIO-\d+ v1\.0$/ });
    await expect(planned).toHaveAttribute('aria-disabled', 'true');
    const label = (await planned.textContent()) as string;
    const code = /DS-BIO-\d+/.exec(label)?.[0] as string;

    // A file that fails says exactly what failed and blocks creation.
    await chooseFile(page, write('broken.csv', 'source_id,observation\nE01,one\nE01,two\n,three\n'));
    await expect(page.getByRole('heading', { name: 'What failed' })).toBeVisible();
    await expect(page.getByText('Missing required column: provenance.')).toBeVisible();
    await expect(page.getByText('1 duplicate source ID: E01 (rows 2, 3).')).toBeVisible();
    await expect(page.getByText('1 record has no source ID: row 4.')).toBeVisible();
    await expect(page.getByText('Validation failed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-disabled', 'true');

    // So does sensitive data.
    await chooseFile(page, write('pii.csv', 'source_id,observation,provenance\nE01,Contact maya@helixlab.example,Authored\n'));
    await expect(page.getByText(/Sensitive data scan flagged 1 email address: row 2, observation/)).toBeVisible();
    await expect(page.getByText('maya@helixlab.example')).toHaveCount(0);

    // A good file shows the frame's receipt, from real values.
    await chooseFile(page, write('resistance-evidence-demo.csv', GOOD));
    await expect(page.getByText(`resistance-evidence-demo.csv · ${GOOD.length} B · 3 synthetic source records · UTF-8`)).toBeVisible();
    await expect(page.getByText('Upload complete / Validation passed')).toBeVisible();
    await expect(page.getByText('source_id, observation, provenance · 3/3 passed')).toBeVisible();
    await expect(page.getByText('3 / Duplicate source IDs: 0')).toBeVisible();
    await expect(page.getByText('No flags · Private workspace visibility')).toBeVisible();
    await expect(page.getByText('resistance-evidence-demo.csv').first()).toBeVisible();
    await expect(page.getByText('· Choose another')).toBeVisible();

    // The server checks the form too.
    await page.getByRole('button', { name: label }).click();
    await expect(page.getByText('Enter a dataset name to continue.')).toBeVisible();
    await expect(page.getByText('Describe where this file came from to continue.')).toBeVisible();
    await expect(page.getByText('Confirm you have permission to upload this file.')).toBeVisible();

    // A reload keeps the validated upload.
    await page.reload();
    await expect(page.getByText('Upload complete / Validation passed')).toBeVisible();

    await page.getByLabel('Dataset name').fill('E2E evidence pack');
    await page.getByLabel('Provenance statement').fill('Authored fixtures for testing. No personal data or licensed publication text.');
    await page.getByRole('checkbox', { name: /I have permission to upload this file/ }).check();
    await page.getByRole('button', { name: label }).click();

    await expect(page).toHaveURL(new RegExp(`/datasets/${code}$`));
    await expect(page.getByRole('heading', { name: 'E2E evidence pack' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Three observations.' })).toBeVisible();
    await expect(page.getByText('Validated / Private / Synthetic')).toBeVisible();
    await expect(page.getByText('Verified download')).toBeVisible();

    // The download is the real bytes.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: `Download CSV · ${GOOD.length} B` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('resistance-evidence-demo.csv');
    expect(readFileSync(await download.path(), 'utf8')).toBe(GOOD);

    const manifestPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download version manifest and checksum' }).click();
    const manifest = JSON.parse(readFileSync(await (await manifestPromise).path(), 'utf8'));
    expect(manifest.dataset.code).toBe(code);
    expect(manifest.checksum.line).toContain('resistance-evidence-demo.csv');

    // Identical bytes are refused for a new version; new bytes make one.
    await page.getByRole('link', { name: 'Upload new version' }).click();
    await expect(page).toHaveURL(new RegExp(`dataset=${code}`));
    await chooseFile(page, path.join(dir, 'resistance-evidence-demo.csv'));
    await expect(page.getByText(`These bytes are identical to ${code} v1.0. A new version needs new bytes, so nothing was created.`)).toBeVisible();
    await chooseFile(page, write('second.csv', `${GOOD}E04,A fourth,Authored fixture\n`));
    await expect(page.getByText('second.csv').first()).toBeVisible();
    await page.getByRole('checkbox', { name: /I have permission to upload this file/ }).check();
    await page.getByRole('button', { name: `Create ${code} v1.1` }).click();
    await expect(page).toHaveURL(new RegExp(`/datasets/${code}$`));
    await expect(page.getByRole('heading', { name: 'Four observations.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'v1.0' })).toBeVisible();
    await page.getByRole('link', { name: 'v1.0' }).click();
    await expect(page.getByRole('heading', { name: 'Three observations.' })).toBeVisible();
    await expect(page.getByText(/You are viewing v1\.0\. The latest version is v1\.1\./)).toBeVisible();

    // Delete needs the code and the tick; Keep dataset changes nothing.
    await page.goto(`/datasets/${code}`);
    await page.getByRole('link', { name: 'Delete dataset…' }).click();
    await expect(page.getByRole('heading', { name: 'Delete this dataset?' })).toBeVisible();
    await expect(page.getByText('Not referenced by frozen evidence.')).toBeVisible();
    await page.getByRole('link', { name: 'Keep dataset' }).click();
    await expect(page).toHaveURL(new RegExp(`/datasets/${code}$`));
    await page.getByRole('link', { name: 'Delete dataset…' }).click();
    await page.getByRole('button', { name: 'Delete dataset' }).click();
    await expect(page.getByText(`Type ${code} exactly to confirm.`)).toBeVisible();
    await expect(page.getByText('Tick this box to confirm you understand what deletion does.')).toBeVisible();
    await page.getByLabel(`Type ${code} to confirm`).fill(code);
    await page.getByRole('checkbox', { name: /I understand this removes the library entry/ }).check();
    await page.getByRole('button', { name: 'Delete dataset' }).click();
    await expect(page).toHaveURL(/\/datasets$/);
    await expect(page.getByText(`E2E evidence pack / ${code}`)).toHaveCount(0);
    await expect(page.getByText(`Maya Chen deleted ${code} from the library`)).toBeVisible();

    // Bytes are retained for authorized audit.
    await page.goto(`/datasets/${code}`);
    await expect(page.getByText(/Deleted from the library on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete dataset…' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText(/Upload new version · This dataset was deleted/)).toBeVisible();
  });

  test('the seeded dataset prints the frame, and a frozen reference warns before delete', async ({ page }) => {
    await page.goto('/datasets/DS-BIO-07');
    await expect(page.getByRole('heading', { name: 'Three observations. Explicit limits.' })).toBeVisible();
    await expect(page.getByText('DS-BIO-07 v1.0 · Uploaded by Maya Chen · 15 Oct 2026')).toBeVisible();
    await expect(page.getByText('0.25 → 1.00 µg/mL · Association, not causality')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download CSV · 48 KB' })).toBeVisible();
    await expect(page.getByText('48 KB / 3 records')).toBeVisible();
    await page.goto('/datasets/DS-BIO-07/delete');
    await expect(page.getByText(/Referenced by frozen BIO-042 v1\.0.*Audit snapshots will be retained\./)).toBeVisible();
    await expect(page.getByText('Retained for authorized audit')).toBeVisible();
    await expect(page.getByText('RPT-BIO-042 v1.0')).toBeVisible();
  });

  test('another workspace’s shared dataset cannot be deleted, and says why', async ({ page }) => {
    await page.goto('/datasets/DS-BIO-06');
    await expect(page.getByRole('heading', { name: 'MIC reporting notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete dataset…' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Delete dataset · Dataset owner or workspace owner only')).toBeVisible();
    await expect(page.getByText('Upload new version · Join this workspace to create here.')).toBeVisible();
    await page.goto('/datasets/DS-BIO-06/delete');
    await expect(page.getByRole('button', { name: 'Delete dataset' })).toHaveAttribute('aria-disabled', 'true');
  });
});

test.describe('agent assurance', () => {
  test('the whole release story works, live', async ({ page }) => {
    /* Dr. Patel adjudicates the waiting trace. */
    await become(page, SAMIRA);
    await page.goto('/assurance');
    await expect(page.getByRole('heading', { name: 'Traces for expert review' })).toBeVisible();
    await page.getByRole('link', { name: 'TRACE-044' }).click();
    await expect(page.getByRole('heading', { name: 'Follow every consequential step.' })).toBeVisible();
    await expect(page.getByText('Biology verified / Trace adjudication')).toBeVisible();
    await expect(page.getByText('“Reduced permeability plays no role in this phenotype.” · Unsupported')).toBeVisible();
    await expect(page.getByText('Pending · ADJ-TRACE-044 on confirmation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Override release policy' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Override release policy · Reviewer cannot bypass a gate')).toBeVisible();

    // The server checks the form.
    await page.getByRole('button', { name: 'Confirm finding' }).click();
    await expect(page.getByText('Explain your rationale to continue.')).toBeVisible();
    await expect(page.getByText('Confirm you have no ownership or financial conflict.')).toBeVisible();

    // A clarification appends and emails the owner.
    await page.getByLabel('Rationale').fill('Was a permeability assay run but left out of the pack?');
    await page.getByRole('checkbox', { name: 'I have no ownership or financial conflict.' }).check();
    await page.getByRole('button', { name: 'Request clarification' }).click();
    await expect(page.getByText('CLAR-TRACE-001 / Clarification requested')).toBeVisible();
    const outbox = await (await page.request.get('/api/dev/outbox')).json();
    expect(outbox.messages[0]).toMatchObject({ to: MAYA, purpose: 'trace_clarification' });

    // A confirmed finding appends a code.
    await page.getByLabel('Finding').selectOption('Alternative explanation dismissed');
    await page.getByLabel('Severity').selectOption('high');
    await page.getByLabel('Rationale').fill('Step 03 dismisses permeability; no permeability assay exists among E01–E03.');
    await page.getByRole('checkbox', { name: 'I have no ownership or financial conflict.' }).check();
    await page.getByRole('button', { name: 'Confirm finding' }).click();
    await expect(page.getByText('ADJ-TRACE-044 / Alternative explanation dismissed')).toBeVisible();
    await expect(page.getByText('CLAR-TRACE-001 / Clarification requested')).toBeVisible();

    // A reviewer cannot act as an owner.
    await expect(page.getByRole('button', { name: 'Turn into a regression' })).toHaveCount(0);

    /* Maya owns the trace, so she cannot adjudicate it, but she can make the regression. */
    await become(page, MAYA);
    await page.goto('/assurance/traces/TRACE-044');
    await expect(page.getByText('Read only / Trace adjudication')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm finding' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Confirm finding · You own this trace')).toBeVisible();
    await page.getByRole('button', { name: 'Turn into a regression' }).click();
    await expect(page).toHaveURL(/\/assurance\/regressions\/REG-BIO-044$/);
    await expect(page.getByRole('heading', { name: 'Turn a finding into a safeguard.' })).toBeVisible();
    await expect(page.getByText('Confirmed finding / Ready to activate')).toBeVisible();
    await expect(page.getByText('ADJ-TRACE-044 · Alternative explanation dismissed · High severity')).toBeVisible();

    // Save draft writes a new rule version.
    await page.getByLabel('Regression name').fill('Alternatives stay open');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('v2 / Current / Alternatives stay open')).toBeVisible();
    await expect(page.getByText('v1 / Alternative explanations stay open')).toBeVisible();

    // Activating needs the scope tick.
    await page.getByRole('button', { name: 'Activate regression' }).click();
    await expect(page.getByText('Tick the activation scope to activate this regression.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Run for every Helix Lab Biology agent release candidate/ }).check();
    await page.getByRole('button', { name: 'Activate regression' }).click();
    await expect(page.getByText('Active / Gating').first()).toBeVisible();

    /* The blocked gate stays blocked. */
    await page.goto('/assurance/gates/GATE-019/rc.18');
    await expect(page.getByRole('heading', { name: 'The release gate is blocked.' })).toBeVisible();
    await expect(page.getByText('One high-severity regression failed. Release is not eligible and cannot be bypassed.')).toBeVisible();
    await expect(page.getByText('29 / 30', { exact: true })).toBeVisible();
    await expect(page.getByText('Failed · TRACE-042, step 03')).toBeVisible();
    await expect(page.getByText('Passed · E01–E03 citations retained')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve release' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Approve release · High-severity REG-BIO-042 failed')).toBeVisible();
    await page.getByText('All 30 checks').click();
    await expect(page.getByText('Causal claims cite a causal control')).toBeVisible();
    const reportPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download gate report' }).click();
    const report = JSON.parse(readFileSync(await (await reportPromise).path(), 'utf8'));
    expect(report).toMatchObject({ status: 'blocked', result: '29 / 30', policy: 'No manual bypass' });
    expect(report.checks).toHaveLength(30);
    await page.getByRole('link', { name: 'Open failed trace' }).click();
    await expect(page).toHaveURL(/\/assurance\/traces\/TRACE-042$/);

    /* Maya runs rc.19 and gets a real pass. */
    await page.goto('/assurance/gates/GATE-019/rc.19');
    await expect(page.getByRole('heading', { name: 'The release gate has not run.' })).toBeVisible();
    await page.getByRole('button', { name: 'Run gate' }).click();
    await expect(page.getByRole('heading', { name: 'The release gate has passed.' })).toBeVisible();
    await expect(page.getByText('30 / 30', { exact: true })).toBeVisible();
    await expect(page.getByText('All required checks passed. Eligibility is not deployment; approval creates a separate audited decision.')).toBeVisible();
    await expect(page.getByText('Passed · TRACE-043, qualified causal claim')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What changed in rc.19' })).toBeVisible();
    await expect(page.getByText('rc.18 / Blocked, retained')).toBeVisible();

    /* Approval is a separate, recorded decision. */
    await page.getByRole('button', { name: 'Approve eligible release' }).click();
    await expect(page.getByText(/Approved by Maya Chen on/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve eligible release' })).toHaveAttribute('aria-disabled', 'true');

    /* An earlier failure is still there. */
    await page.goto('/assurance/gates/GATE-019/rc.18');
    await expect(page.getByRole('heading', { name: 'The release gate is blocked.' })).toBeVisible();

    /* A trace can be imported and takes the next immutable code. */
    await page.goto('/assurance');
    await page.getByRole('button', { name: 'Import trace' }).click();
    await expect(page.getByText('Paste the trace JSON to import it.')).toBeVisible();
    await page.getByLabel('Trace JSON').fill('{ not json');
    await page.getByRole('button', { name: 'Import trace' }).click();
    await expect(page.getByText(/This is not valid JSON/)).toBeVisible();
    await page.getByRole('button', { name: 'Fill in an example' }).click();
    await page.getByRole('button', { name: 'Import trace' }).click();
    await expect(page).toHaveURL(/\/assurance\/traces\/TRACE-\d+$/);
    await expect(page.getByText('“consistent with efflux involvement; not proven.” · Qualified')).toBeVisible();
  });

  test('every control can be reached and used from the keyboard on the upload page', async ({ page }) => {
    await become(page, MAYA);
    await page.goto('/datasets/upload');
    await page.getByLabel('Dataset name').focus();
    await page.keyboard.type('Keyboard pack');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Domain')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Version', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('input[type="file"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Provenance statement')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: /I have permission/ })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: /I have permission/ })).toBeChecked();
  });
});
