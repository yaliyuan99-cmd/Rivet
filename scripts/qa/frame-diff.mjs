// Measures each seeded page against its Figma frame: copy, type styles, positions. Run against a server
// started with a fresh database: QA_BASE=http://localhost:8790 node scripts/qa/frame-diff.mjs [filter]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { frameLines, parseFrame } from './frame-parse.mjs';

const BASE = process.env.QA_BASE ?? 'http://localhost:8790';
const OUT = process.env.QA_OUT ?? '/private/tmp/claude-501/rivet-qa/frames';
const PASSWORD = 'rivet-demo-2026';
const filter = process.argv[2];

const USERS = { maya: 'maya@helixlab.example', samira: 'samira@northbridge.example', alex: 'alex@rivet.example', lena: 'lena@northbridge.example' };

const clickText = async (page, name) => {
  await page.getByRole('button', { name, exact: false }).first().click();
};

async function signUpFresh(page, verify = true) {
  const email = `qa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@lab.example`;
  const res = await page.request.post(`${BASE}/api/auth/signup`, { headers: { 'X-Rivet-Request': '1' }, data: { name: 'Maya Chen', email, password: 'correct-horse-battery', acceptTerms: true } });
  if (!res.ok()) throw new Error(`signup ${res.status()}`);
  if (verify) {
    const outbox = await (await page.request.get(`${BASE}/api/dev/outbox`)).json();
    const message = outbox.messages.find((m) => m.to === email);
    const token = new URL(message.link).searchParams.get('token');
    await page.request.post(`${BASE}/api/auth/verify`, { headers: { 'X-Rivet-Request': '1' }, data: { token } });
  }
  return email;
}

// frame file -> how to reach the state with the seeded story.
const SCREENS = [
  { frame: '01-access-signup', path: '/signup' },
  { frame: '01-access-verify', fresh: 'unverified', path: '/verify' },
  { frame: '01-access-home', fresh: 'verified', path: '/' },
  { frame: '02-evaluation-editor', user: 'maya', path: '/tasks/new?starter=1' },
  { frame: '02-evaluation-freeze', user: 'maya', path: '/tasks/BIO-043/freeze' },
  { frame: '02-evaluation-running', user: 'maya', path: '/tasks/BIO-042', run: 'running' },
  { frame: '02-evaluation-interrupted', user: 'maya', path: '/tasks/BIO-042', run: 'interrupted' },
  { frame: '02-evaluation-results', user: 'maya', path: '/runs/RUN-1042' },
  { frame: '02-evaluation-evidence', user: 'maya', path: '/evidence/EV-1042-A' },
  { frame: '03-expert-apply', fresh: 'verified', path: '/review/apply' },
  { frame: '03-expert-pending', user: 'lena', path: '/review/application' },
  { frame: '03-expert-credentials', user: 'alex', path: '/admin/credentials/APP-029' },
  { frame: '03-expert-expert', user: 'samira', path: '/review/REVIEW-042' },
  { frame: '03-expert-adjudication', user: 'alex', path: '/admin/adjudications/REVIEW-042' },
  { frame: '04-published-leaderboard', user: 'maya', path: '/leaderboards' },
  { frame: '04-published-report', user: 'maya', path: '/reports/RPT-BIO-042/v1.0' },
  { frame: '04-published-copied', user: 'maya', path: '/reports/RPT-BIO-042/v1.0', after: (page) => clickText(page, 'Copy citation') },
  { frame: '05-workspace-create', user: 'maya', path: '/workspace/new' },
  { frame: '05-workspace-members', user: 'maya', path: '/workspace' },
  { frame: '05-workspace-private', user: 'maya', path: '/tasks/BIO-042' },
  { frame: '06-datasets-upload', user: 'maya', path: '/datasets/upload' },
  { frame: '06-datasets-list', user: 'maya', path: '/datasets' },
  { frame: '06-datasets-detail', user: 'maya', path: '/datasets/DS-BIO-07' },
  { frame: '06-datasets-delete', user: 'maya', path: '/datasets/DS-BIO-07/delete' },
  { frame: '07-agent-trace', user: 'samira', path: '/assurance/traces/TRACE-042' },
  { frame: '07-agent-regression', user: 'maya', path: '/assurance/regressions/REG-BIO-042' },
  { frame: '07-agent-blocked', user: 'maya', path: '/assurance/gates/GATE-019/rc.18' },
  { frame: '07-agent-passed', user: 'maya', path: '/assurance/gates/GATE-019/rc.19' },
  { frame: '08-external-consent', user: 'maya', oauth: 'consent' },
  { frame: '08-external-approved', user: 'maya', oauth: 'approved' },
  { frame: '08-external-denied', user: 'maya', oauth: 'denied' },
  { frame: '09-discovery-browse', user: 'maya', path: '/tasks' },
  { frame: '09-discovery-profile', user: 'maya', path: '/profile' },
  { frame: '10-advisor-advisor', user: 'maya', path: '/advisor?task=BIO-042' },
  { frame: '11-admin-models', user: 'alex', path: '/admin/models' },
  { frame: '11-admin-checks', user: 'alex', path: '/admin/checks' },
];

const hex = (color) => {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(color);
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : color;
};

const collect = () => {
  const out = [];
  const add = (text, rect, el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    const clip = el.closest('.sr-only');
    if (clip) return;
    out.push({ text: text.replace(/\s+/g, ' ').trim(), x: rect.x + scrollX, y: rect.y + scrollY, h: rect.height, size: parseFloat(cs.fontSize), weight: cs.fontWeight, family: cs.fontFamily, color: cs.color });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue.trim()) continue;
    if (node.parentElement.closest('option,script,style')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (rect) add(node.nodeValue, rect, node.parentElement);
  }
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=file]),textarea')) {
    if (el.value) add(el.value, el.getBoundingClientRect(), el);
  }
  for (const el of document.querySelectorAll('select')) {
    const option = el.options[el.selectedIndex];
    if (option) add(option.text, el.getBoundingClientRect(), el);
  }
  return { nodes: out, height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth };
};

const norm = (text) => text.replace(/[▾☑●]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const weightOf = { Regular: 400, Medium: 500, SemiBold: 600, 'Semi Bold': 600, Bold: 700 };

/** The same words can appear twice on a page, so pick the node closest in style, then in position. */
function bestMatch(line, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const node of candidates) {
    let score = Math.abs(node.y - line.y) + Math.abs(node.x - line.x);
    if (node.size !== line.size) score += 2000;
    if (line.mono !== /Plex Mono/.test(node.family)) score += 2000;
    if (line.color && hex(node.color) !== line.color) score += 500;
    if (weightOf[line.weight] && Number(node.weight) !== weightOf[line.weight]) score += 500;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

function compare(frameFile, dom) {
  const lines = frameLines(parseFrame(frameFile));
  const missing = [];
  const offs = [];
  const styles = [];
  for (const line of lines) {
    const wanted = norm(line.text);
    if (!wanted || /^\/? ?(desktop|mobile)$/.test(wanted)) continue;
    const target = wanted.replace(/ \/ (desktop|mobile)$/, '');
    const exact = dom.nodes.filter((node) => norm(node.text) === target);
    const loose = exact.length ? exact : dom.nodes.filter((node) => (norm(node.text).includes(target) && target.length > 6) || (target.includes(norm(node.text)) && norm(node.text).length > 12));
    const hit = bestMatch(line, loose);
    if (!hit) {
      missing.push(line.text);
      continue;
    }
    if (line.blockStart) {
      const dy = Math.round(hit.y - line.y);
      const dx = Math.round(hit.x - line.x);
      if (Math.abs(dy) > 4 || Math.abs(dx) > 4) offs.push(`${line.text.slice(0, 44)} dx=${dx} dy=${dy}`);
    }
    if (line.size && hit.size !== line.size) styles.push(`${line.text.slice(0, 40)} size ${hit.size} want ${line.size}`);
    if (line.color && hex(hit.color) !== line.color) styles.push(`${line.text.slice(0, 40)} color ${hex(hit.color)} want ${line.color}`);
    const wantWeight = weightOf[line.weight];
    if (wantWeight && Number(hit.weight) !== wantWeight) styles.push(`${line.text.slice(0, 40)} weight ${hit.weight} want ${wantWeight}`);
    if (line.mono !== /Plex Mono/.test(hit.family)) styles.push(`${line.text.slice(0, 40)} family ${line.mono ? 'want mono' : 'want sans'}`);
  }
  return { total: lines.length, missing, offs, styles };
}

async function startOauth(page, decision) {
  await page.goto(`${BASE}/atlas-demo`);
  await page.getByRole('button', { name: /connect|authorize|start/i }).first().click();
  await page.waitForURL(/oauth\/consent/);
  if (decision === 'approved') await clickText(page, 'Approve access');
  if (decision === 'denied') await clickText(page, 'Deny request');
}

async function prepareRun(page, state) {
  // One active run per task: wait for an earlier one to finish.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.goto(`${BASE}/tasks/BIO-042`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    const run = page.getByRole('button', { name: 'Run evaluation' }).first();
    if ((await run.count()) && (await run.getAttribute('aria-disabled')) !== 'true') break;
    await page.waitForTimeout(1000);
  }
  await clickText(page, 'Run evaluation');
  await page.waitForURL(/runs\/RUN-/);
  if (state === 'interrupted') {
    await clickText(page, 'Stop after checkpoint');
    await page.getByRole('button', { name: /^Resume RUN/ }).waitFor({ timeout: 30000 });
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const report = [];
  for (const screen of SCREENS) {
    if (filter && !screen.frame.includes(filter)) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, permissions: ['clipboard-read', 'clipboard-write'], baseURL: BASE });
    await context.addInitScript(() => localStorage.setItem('rivet-theme', 'light'));
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text().slice(0, 160));
    });
    page.on('pageerror', (error) => errors.push(`pageerror ${error.message.slice(0, 160)}`));
    let status = 'ok';
    try {
      if (screen.fresh) await signUpFresh(page, screen.fresh === 'verified');
      if (screen.user) {
        const res = await page.request.post(`${BASE}/api/auth/signin`, { headers: { 'X-Rivet-Request': '1' }, data: { email: USERS[screen.user], password: PASSWORD } });
        if (!res.ok()) throw new Error(`signin ${res.status()}`);
      }
      if (screen.run) await prepareRun(page, screen.run);
      else if (screen.oauth) await startOauth(page, screen.oauth);
      else await page.goto(`${BASE}${screen.path}`);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (screen.after) {
        await screen.after(page);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(400);
      const dom = await page.evaluate(collect);
      const result = compare(`docs/figma/frames/${screen.frame}-desktop-light.txt`, dom);
      await page.screenshot({ path: path.join(OUT, `${screen.frame}-1440-light.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      const mobile = await page.evaluate(collect);
      await page.screenshot({ path: path.join(OUT, `${screen.frame}-390-light.png`), fullPage: true });
      report.push({ frame: screen.frame, url: page.url().replace(BASE, ''), ...result, height: dom.height, overflow1440: dom.width > 1440, overflow390: mobile.width > 390, errors: [...new Set(errors)] });
      const mobileFrame = `docs/figma/frames/${screen.frame}-mobile-light.txt`;
      if (existsSync(mobileFrame)) report.push({ frame: `${screen.frame} (mobile)`, url: page.url().replace(BASE, ''), ...compare(mobileFrame, mobile), height: mobile.height, overflow1440: false, overflow390: mobile.width > 390, errors: [] });
    } catch (error) {
      status = String(error.message ?? error).slice(0, 200);
      report.push({ frame: screen.frame, failed: status, errors });
    }
    await context.close();
  }
  await browser.close();
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  for (const item of report) {
    if (item.failed) {
      console.log(`\n# ${item.frame}: FAILED ${item.failed}`);
      continue;
    }
    console.log(`\n# ${item.frame} (${item.url}) lines=${item.total} missing=${item.missing.length} moved=${item.offs.length} style=${item.styles.length}${item.overflow1440 ? ' OVERFLOW-1440' : ''}${item.overflow390 ? ' OVERFLOW-390' : ''}`);
    if (item.errors.length) console.log('  console:', item.errors.join(' | '));
    for (const line of item.missing.slice(0, process.env.QA_MISSING ? 40 : 0)) console.log('  missing:', line.slice(0, 110));
    for (const line of item.offs.slice(0, 12)) console.log('  moved:', line);
    for (const line of [...new Set(item.styles)].slice(0, 12)) console.log('  style:', line);
  }
}

await main();
