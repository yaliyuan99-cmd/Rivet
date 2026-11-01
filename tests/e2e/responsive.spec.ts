import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers.ts';
import { ROUTES } from './routes.ts';

for (const width of [1440, 1024, 820, 390]) {
  test(`no horizontal overflow or broken values at ${width}px`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height: 900 });
    const problems: string[] = [];
    for (const group of ROUTES) {
      await signOut(page);
      if (group.user) await signIn(page, group.user);
      for (const path of group.paths) {
        const errors: string[] = [];
        const onError = (error: Error) => errors.push(error.message);
        page.on('pageerror', onError);
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.locator('.skeleton').waitFor({ state: 'detached' }).catch(() => undefined);
        const result = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const offenders: string[] = [];
          for (const el of document.querySelectorAll('main *, header *, nav *')) {
            if (el.closest('.sr-only, .skip-link, .table-wrap, select, option')) continue;
            const box = el.getBoundingClientRect();
            if (box.width > 0 && box.right > viewport + 1) offenders.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').slice(0, 30)} right=${Math.round(box.right)}`);
          }
          const text = document.body.innerText;
          return {
            overflow: document.documentElement.scrollWidth > viewport,
            offenders: offenders.slice(0, 3),
            broken: /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/.exec(text)?.[0] ?? null,
          };
        });
        const who = group.user ?? 'visitor';
        if (result.overflow) problems.push(`${who} ${path}: page scrolls sideways ${result.offenders.join(', ')}`);
        else if (result.offenders.length) problems.push(`${who} ${path}: off-screen ${result.offenders.join(', ')}`);
        if (result.broken) problems.push(`${who} ${path}: shows "${result.broken}"`);
        if (errors.length) problems.push(`${who} ${path}: page error ${errors[0]}`);
        page.off('pageerror', onError);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
