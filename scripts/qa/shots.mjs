// Full-page screenshots for looking at a page by eye. Usage:
// QA_BASE=http://localhost:8790 node scripts/qa/shots.mjs <width> <light|dark> <email|-> <outdir> <path> [path...]
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [width, theme, email, out, ...paths] = process.argv.slice(2);
const BASE = process.env.QA_BASE ?? 'http://localhost:8790';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: Number(width), height: 900 }, baseURL: BASE });
await context.addInitScript((value) => localStorage.setItem('rivet-theme', value), theme);
const page = await context.newPage();
if (email !== '-') {
  const res = await page.request.post('/api/auth/signin', { headers: { 'X-Rivet-Request': '1' }, data: { email, password: 'rivet-demo-2026' } });
  if (!res.ok()) throw new Error(`Sign-in failed: ${res.status()}`);
}
for (const target of paths) {
  await page.goto(target);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(250);
  const name = `${target.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}-${width}-${theme}.png`;
  await page.screenshot({ path: path.join(out, name), fullPage: true });
  console.log(name);
}
await browser.close();
