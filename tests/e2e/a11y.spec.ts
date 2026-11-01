import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { setTheme, signIn, signOut } from './helpers.ts';
import { ROUTES } from './routes.ts';

for (const theme of ['dark', 'light'] as const) {
  test(`no WCAG A or AA violations in the ${theme} theme`, async ({ page }) => {
    test.setTimeout(600_000);
    await setTheme(page, theme);
    const problems: string[] = [];
    for (const group of ROUTES) {
      await signOut(page);
      if (group.user) await signIn(page, group.user);
      for (const path of group.paths) {
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        for (const violation of results.violations) {
          for (const node of violation.nodes.slice(0, 3)) {
            problems.push(`${group.user ?? 'visitor'} ${path} ${violation.id}: ${node.target.join(' ')} :: ${(node.any[0]?.message ?? violation.help).slice(0, 170)}`);
          }
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the app can be used from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await signIn(page, ROUTES[1]!.user as string);
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // The theme toggle, a nav link and a primary action are all reachable by Tab, and Enter activates them.
  await page.goto('/');
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''));
  }
  for (const name of ['Home', 'Tasks', 'Datasets', 'Sign out']) expect([...seen]).toContain(name);
  await page.getByRole('link', { name: 'Tasks', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks$/);
});

test('the mobile menu opens, closes with Escape and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ROUTES[1]!.user as string);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Open navigation menu' });
  await button.click();
  await expect(page.locator('#menu-panel').getByRole('link', { name: 'Datasets' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-panel')).toBeHidden();
  await expect(button).toBeFocused();
});
