import { expect, test } from '@playwright/test';
import { MAYA, signIn } from './helpers.ts';

/** Loading and failure states, forced at the network, so they are proven and not assumed. */
test.beforeEach(async ({ page }) => {
  await signIn(page, MAYA);
});

test('a slow page shows a loading state, not an empty one', async ({ page }) => {
  await page.route('**/api/tasks?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.route('**/api/tasks', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto('/tasks');
  await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Real tasks. Open questions.' })).toBeVisible();
});

test('a failed page explains itself and recovers with Try again', async ({ page }) => {
  await page.route('**/api/datasets**', (route) => route.abort());
  await page.goto('/datasets');
  await expect(page.getByRole('alert').getByRole('heading', { name: 'This page could not load' })).toBeVisible();
  await expect(page.getByText('Rivet could not reach the server. Check your connection and try again.')).toBeVisible();
  await page.unroute('**/api/datasets**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Data with a paper trail.' })).toBeVisible();
});

test('a server error on a write leaves the form as it was and says so', async ({ page }) => {
  await page.goto('/profile');
  const bio = page.getByLabel('Bio');
  await bio.fill('A changed biography.');
  await page.route('**/api/profile', (route) => (route.request().method() === 'GET' ? route.continue() : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'server_error', message: 'Something went wrong on the server.' } }) })));
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Something went wrong on the server.')).toBeVisible();
  await expect(bio).toHaveValue('A changed biography.');
  await expect(page.getByText('Profile saved')).toHaveCount(0);
});

test('a private item reads as not found to someone without access', async ({ page }) => {
  await page.goto('/evidence/EV-0000-X');
  await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to Home' })).toBeVisible();
});

test('a session that ends sends the next page to sign in, then back', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Real tasks. Open questions.' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/signin/);
  await page.goto('/datasets');
  await expect(page).toHaveURL(/\/signin\?next=%2Fdatasets/);
  await page.getByLabel('Work email').fill(MAYA);
  await page.getByLabel('Password').fill('rivet-demo-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/datasets$/);
});

test('the theme starts dark, toggles, and is remembered', async ({ page }) => {
  await page.goto('/');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  expect(await theme()).toBe('dark');
  await page.getByRole('button', { name: /^Theme: dark/ }).first().click();
  expect(await theme()).toBe('light');
  await expect(page.locator('.bar-theme').first()).toHaveText('light');
  await page.reload();
  expect(await theme()).toBe('light');
  await page.getByRole('button', { name: /^Theme: light/ }).first().click();
  expect(await theme()).toBe('dark');
});
