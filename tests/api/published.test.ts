import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { AUTHORED_SCORES } from '../../server/db/seed/published.ts';
import { citationAuthor, generateReportContent } from '../../server/routes/published.ts';
import { describeUncertainty, drawTaskResamples, mulberry32, pairedBootstrap, percentileIndices, readOverlap, round1 } from '../../server/lib/statistics.ts';
import { Client, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';
import { frozenRun, member, reviewBody, signedIn } from './expertFixtures.ts';

const json = (res: Response) => res.json() as Promise<any>;

describe('the statistic', () => {
  it('mulberry32 matches its published sequence and is deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 5 }, () => a());
    expect(values).toEqual(Array.from({ length: 5 }, () => b()));
    // The reference implementation, seeded with 42, starts here.
    expect(values[0]).toBeCloseTo(0.6011037519201636, 12);
    expect(values[1]).toBeCloseTo(0.44829055899754167, 12);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('uses positions 249 and 9749 of 10,000', () => {
    expect(percentileIndices(10_000)).toEqual({ low: 249, high: 9749 });
  });

  it('applies the same resample to every model', () => {
    const rows = [
      { taskLabel: 'T1', modelId: 'a', score: 10 },
      { taskLabel: 'T2', modelId: 'a', score: 20 },
      { taskLabel: 'T3', modelId: 'a', score: 90 },
      { taskLabel: 'T1', modelId: 'b', score: 15 },
      { taskLabel: 'T2', modelId: 'b', score: 25 },
      { taskLabel: 'T3', modelId: 'b', score: 95 },
    ];
    // b is a + 5 on every task, so with one shared draw its interval is a's shifted by exactly 5.
    const result = pairedBootstrap(rows);
    const a = result.models.find((model) => model.modelId === 'a');
    const b = result.models.find((model) => model.modelId === 'b');
    expect(b?.low).toBeCloseTo((a?.low as number) + 5, 9);
    expect(b?.high).toBeCloseTo((a?.high as number) + 5, 9);
    expect(result.models[0]?.modelId).toBe('b');
  });

  it('does not depend on row order, and changes when a task joins', () => {
    const rows = AUTHORED_SCORES.flatMap(([taskLabel, a, m, l]) => [
      { taskLabel, modelId: 'aster-3.2', score: a },
      { taskLabel, modelId: 'meridian-2.1', score: m },
      { taskLabel, modelId: 'lumen-4-mini', score: l },
    ]);
    const forward = pairedBootstrap(rows);
    const backward = pairedBootstrap([...rows].reverse());
    expect(backward).toEqual(forward);
    const grown = pairedBootstrap([...rows, { taskLabel: 'BIO-999 v1.0', modelId: 'aster-3.2', score: 10 }, { taskLabel: 'BIO-999 v1.0', modelId: 'meridian-2.1', score: 10 }, { taskLabel: 'BIO-999 v1.0', modelId: 'lumen-4-mini', score: 10 }]);
    expect(grown.models[0]?.mean).not.toBe(forward.models[0]?.mean);
  });

  it('reproduces the frame’s numbers exactly from the seeded fixtures', () => {
    expect(AUTHORED_SCORES).toHaveLength(24);
    expect(AUTHORED_SCORES.find(([label]) => label === 'BIO-042 v1.0')).toEqual(['BIO-042 v1.0', 86, 81, 74]);
    const rows = AUTHORED_SCORES.flatMap(([taskLabel, a, m, l]) => [
      { taskLabel, modelId: 'aster-3.2', score: a },
      { taskLabel, modelId: 'meridian-2.1', score: m },
      { taskLabel, modelId: 'lumen-4-mini', score: l },
    ]);
    const result = pairedBootstrap(rows);
    expect(result.models.map((model) => [model.modelId, round1(model.mean), round1(model.low as number), round1(model.high as number), model.n])).toEqual([
      ['aster-3.2', 87.4, 83.1, 91.2, 24],
      ['meridian-2.1', 83.1, 78.5, 87.6, 24],
      ['lumen-4-mini', 77.8, 72.0, 83.4, 24],
    ]);
    expect(result.missing).toBe(0);
    expect(result.resamples).toBe(10_000);
    expect(result.seed).toBe(42);
  });

  it('draws indices within range', () => {
    const draws = drawTaskResamples(5, 100, 42);
    expect(draws.length).toBe(500);
    expect(Math.max(...draws)).toBe(4);
    expect(Math.min(...draws)).toBe(0);
  });

  it('gives no interval below two tasks and counts missing runs', () => {
    const single = pairedBootstrap([{ taskLabel: 'T1', modelId: 'a', score: 80 }]);
    expect(single.models[0]).toEqual({ modelId: 'a', n: 1, mean: 80, low: null, high: null });
    const uneven = pairedBootstrap([
      { taskLabel: 'T1', modelId: 'a', score: 80 },
      { taskLabel: 'T2', modelId: 'a', score: 70 },
      { taskLabel: 'T1', modelId: 'b', score: 60 },
    ]);
    expect(uneven.missing).toBe(1);
    expect(uneven.models.find((model) => model.modelId === 'b')).toMatchObject({ n: 1, low: null });
    expect(uneven.models.find((model) => model.modelId === 'a')?.low).toBeGreaterThanOrEqual(70);
  });

  it('only says the intervals overlap when they do', () => {
    const interval = (label: string, low: number, high: number) => ({ label, low, high });
    expect(readOverlap([interval('A', 80, 90), interval('B', 85, 95), interval('C', 89, 99)]).state).toBe('all');
    const some = readOverlap([interval('A', 90, 95), interval('B', 80, 91), interval('C', 60, 70)]);
    expect(some.state).toBe('some');
    expect(some.separated).toEqual([['A', 'C'], ['B', 'C']]);
    expect(readOverlap([interval('A', 90, 95), interval('B', 60, 70)]).state).toBe('none');
    expect(readOverlap([interval('A', 90, 95)]).state).toBe('not_applicable');

    const base = { modelCount: 2, synthetic: true, missing: 0 };
    expect(describeUncertainty({ ...base, intervals: [interval('A', 80, 90), interval('B', 85, 95)] })).toBe(
      'Intervals overlap: these synthetic observations do not establish a statistically decisive ordering. Paired, task-level bootstrap; 10,000 resamples; seed 42. No missing runs.',
    );
    const apart = describeUncertainty({ ...base, intervals: [interval('A', 90, 95), interval('B', 60, 70)] });
    expect(apart).toMatch(/^Intervals do not overlap/);
    expect(apart).not.toMatch(/Intervals overlap/);
    const partly = describeUncertainty({ ...base, modelCount: 3, intervals: [interval('A', 90, 95), interval('B', 80, 91), interval('C', 60, 70)], missing: 2, synthetic: false });
    expect(partly).toMatch(/^Some intervals overlap: these observations separate only A and C; B and C\./);
    expect(partly).toContain('2 missing runs');
    expect(describeUncertainty({ ...base, intervals: [{ label: 'A', low: null, high: null }, { label: 'B', low: null, high: null }] })).toMatch(/at least two tasks/);
  });
});

describe('report text', () => {
  const input = {
    taskCode: 'BIO-044',
    title: 'A task',
    reportCode: 'RPT-BIO-044',
    version: '1.0',
    ownerName: 'Dr. Maya Q. Chen',
    frozenAt: '2026-11-02T10:00:00.000Z',
    finding: 'Uphold the ordering. Keep the caveat.',
    scores: [
      { modelId: 'a', displayName: 'Aster 3.2', score: 80, label: 'demo', evidenceCode: 'EV-A' },
      { modelId: 'm', displayName: 'Meridian 2.1', score: 80, label: 'demo', evidenceCode: 'EV-M' },
      { modelId: 'l', displayName: 'Lumen 4 Mini', score: 60, label: 'demo', evidenceCode: 'EV-L' },
    ],
    scan: { code: 'SCAN-044', risk: 'none', findings: {} },
    acknowledgements: ['Training exposure cannot be ruled out.'],
    synthetic: false,
    sourcesSynthetic: false,
  };

  it('states ties and uses no synthetic wording on a real report', () => {
    const content = generateReportContent(input);
    expect(content.headline).toBe('Uphold the ordering.');
    expect(content.summary).toContain('Aster 3.2 and Meridian 2.1 share the highest reviewed score on this task at 80 / 100, followed by Lumen 4 Mini at 60.');
    expect(content.summary).toContain('One task does not establish general model capability.');
    expect(content.limitations).toContain('Contamination scan SCAN-044 found no overlap in the indexes Rivet can scan.');
    expect(content.limitations).toContain('Model training exposure remains unknown.');
    expect(content.limitations).not.toContain('synthetic');
    expect(content.citation).toBe('Chen, M. Q. (2026). BIO-044: A task. Rivet, RPT-BIO-044 v1.0.');
  });

  it('labels synthetic sources and keeps a long first sentence readable', () => {
    const content = generateReportContent({ ...input, synthetic: true, sourcesSynthetic: true, finding: `${'word '.repeat(60)}end.` });
    expect(content.headline.length).toBeLessThanOrEqual(141);
    expect(content.headline.endsWith('…')).toBe(true);
    expect(content.limitations).toContain('Scores are synthetic demo scores');
    expect(content.limitations).toContain('Attached sources are authored fixtures');
    expect(content.citation).toContain('Synthetic demo report.');
  });

  it('formats the citation author', () => {
    expect(citationAuthor('Maya Chen')).toBe('Chen, M.');
    expect(citationAuthor('Dr. Samira Patel')).toBe('Patel, S.');
    expect(citationAuthor('Madonna')).toBe('Madonna');
  });
});

describe('published pages', () => {
  let test: TestApp;
  let maya: Client;

  beforeEach(async () => {
    test = await makeTestApp({ seed: true });
    maya = await signedIn(test, 'maya@helixlab.example');
  });
  afterEach(() => test.close());

  const liveReport = async (domainId = 'biology', taskCode?: string) => {
    const mayaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`))?.id as string;
    const workspaceId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`))?.id as string;
    const samira = await signedIn(test, 'samira@northbridge.example');
    const alex = await signedIn(test, 'alex@rivet.example');
    const run = await frozenRun(test, { ownerId: mayaId, workspaceId, domainId, taskCode });
    if (domainId !== 'biology') {
      const samiraId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'samira@northbridge.example'`))?.id as string;
      await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) VALUES (?, ?, ?, 'Test', ?)`, [`c-${domainId}-${run.taskCode}`, samiraId, domainId, test.ctx.now().toISOString()]).catch(() => undefined);
    }
    const { code } = await json(await maya.post('/api/reviews', { runCode: run.runCode }));
    await samira.post(`/api/reviews/${code}/claim`);
    await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
    const res = await alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Uphold the expert’s scores for this task.', checksAck: true });
    expect(res.status).toBe(200);
    return { run, reportCode: `RPT-${run.taskCode}` };
  };

  describe('leaderboard', () => {
    it('serves the frame’s exact numbers from seeded rows', async () => {
      const body = await json(await maya.get('/api/leaderboards'));
      expect(body.domain).toMatchObject({ id: 'biology', name: 'Biology', field: 'Microbiology' });
      expect(body.rows.map((row: any) => [row.displayName, row.summary])).toEqual([
        ['Aster 3.2', '87.4 [83.1, 91.2] n=24'],
        ['Meridian 2.1', '83.1 [78.5, 87.6] n=24'],
        ['Lumen 4 Mini', '77.8 [72.0, 83.4] n=24'],
      ]);
      expect(body.rows[2]).toMatchObject({ mean: 77.8, low: 72, high: 83.4, n: 24 });
      expect(body.axis).toEqual({ min: 60, max: 100 });
    });

    it('tells the truth about the fixtures', async () => {
      const body = await json(await maya.get('/api/leaderboards?domain=biology'));
      expect(body.alert).toBe('Synthetic domain aggregate, not real benchmark results. 24 authored task fixtures; 95% bootstrap intervals.');
      expect(body.receipts).toBe('1 sealed run receipt · 23 authored fixtures →');
      expect(body.sample).toMatchObject({ tasks: 24, models: 3, missing: 0, sealedReceipts: 1, authoredOnly: 23, fixtureTasks: 24, liveReports: 0, synthetic: true, snapshotAt: '2026-10-15T15:30:00.000Z' });
      expect(body.evidenceBoundary).toBe('Synthetic fixtures, not real Biology capability claims');
    });

    it('computes "Read the uncertainty"', async () => {
      const body = await json(await maya.get('/api/leaderboards?domain=biology'));
      expect(body.overlap).toBe('all');
      expect(body.uncertainty).toBe('Intervals overlap: these synthetic observations do not establish a statistically decisive ordering. Paired, task-level bootstrap; 10,000 resamples; seed 42. No missing runs.');
    });

    it('says something else when the data stops overlapping', async () => {
      // Sink one model far enough that its interval clears the others.
      await test.ctx.db.run(`UPDATE leaderboard_scores SET score = score - 40 WHERE model_id = 'lumen-4-mini'`);
      const body = await json(await maya.get('/api/leaderboards?domain=biology'));
      expect(body.overlap).toBe('some');
      expect(body.uncertainty).toMatch(/^Some intervals overlap: these synthetic observations separate only Aster and Lumen; Meridian and Lumen\./);
      expect(body.uncertainty).not.toMatch(/^Intervals overlap/);
      expect(body.axis.min).toBeLessThan(60);
    });

    it('names the included task with what the viewer may open', async () => {
      const own = await json(await maya.get('/api/leaderboards?domain=biology'));
      expect(own.included).toMatchObject({ label: 'BIO-042 v1.0', taskCode: 'BIO-042', modelCount: 3, ownerName: 'Maya Chen', expertName: 'Dr. Samira Patel', canReadEvidence: true, evidenceHref: '/evidence/EV-1042-A', reportHref: '/reports/RPT-BIO-042/v1.0' });
      const { client: stranger } = await member(test, 'stranger@lab.example');
      const theirs = await json(await stranger.get('/api/leaderboards?domain=biology'));
      expect(theirs.included).toMatchObject({ canReadEvidence: false, evidenceHref: '/reports/RPT-BIO-042/v1.0' });
    });

    it('really filters by domain, with an empty state for a domain with no data', async () => {
      const body = await json(await maya.get('/api/leaderboards?domain=chemistry'));
      expect(body.domain.name).toBe('Chemistry');
      expect(body.empty).toBe(true);
      expect(body.rows).toEqual([]);
      expect(body.included).toBeNull();
      expect(body.alert).toBe('No frozen tasks in Chemistry yet.');
      expect(body.uncertainty).toBe('');
      expect(body.domains.map((domain: any) => domain.id)).toEqual(['biology', 'chemistry', 'computer-science']);
      expect((await maya.get('/api/leaderboards?domain=astrology')).status).toBe(404);
    });

    it('shows one finalized task in a new domain with no interval', async () => {
      await liveReport('chemistry', 'CHEM-010');
      const body = await json(await maya.get('/api/leaderboards?domain=chemistry'));
      expect(body.empty).toBe(false);
      expect(body.rows.map((row: any) => [row.displayName, row.summary])).toEqual([
        ['Aster 3.2', '80.0 · no interval · n=1'],
        ['Meridian 2.1', '72.0 · no interval · n=1'],
        ['Lumen 4 Mini', '64.0 · no interval · n=1'],
      ]);
      expect(body.alert).toBe('Synthetic domain aggregate, not real benchmark results. 1 finalized report; no interval below two tasks.');
      expect(body.overlap).toBe('not_applicable');
      expect(body.uncertainty).toMatch(/^An interval needs at least two tasks per model/);
      expect(body.receipts).toBe('1 sealed run receipt →');
      expect(body.evidenceBoundary).toBe('Synthetic demo scores, not real Chemistry capability claims');
    });

    it('does not call a domain synthetic when nothing in it is', async () => {
      const mayaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`))?.id as string;
      const workspaceId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`))?.id as string;
      const samiraId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'samira@northbridge.example'`))?.id as string;
      await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) VALUES ('c-cs', ?, 'computer-science', 'Test', ?)`, [samiraId, test.ctx.now().toISOString()]);
      const samira = await signedIn(test, 'samira@northbridge.example');
      const alex = await signedIn(test, 'alex@rivet.example');
      for (const taskCode of ['CS-001', 'CS-002']) {
        const run = await frozenRun(test, { ownerId: mayaId, workspaceId, domainId: 'computer-science', taskCode, label: 'judge', synthetic: false });
        const { code } = await json(await maya.post('/api/reviews', { runCode: run.runCode }));
        await samira.post(`/api/reviews/${code}/claim`);
        await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
        await alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Uphold the expert’s scores for this task.', checksAck: true });
      }
      const body = await json(await maya.get('/api/leaderboards?domain=computer-science'));
      expect(body.sample.synthetic).toBe(false);
      expect(body.alert).toBe('Domain aggregate of 2 finalized reports; 95% bootstrap intervals.');
      expect(body.uncertainty).not.toContain('synthetic');
      expect(body.evidenceBoundary).toBe('These tasks only, not a general Computer science capability claim');
    });

    it('requires a verified account', async () => {
      expect((await new Client(test).get('/api/leaderboards')).status).toBe(401);
      await makeUser(test, { email: 'new@lab.example', verified: false });
      expect((await (await signedIn(test, 'new@lab.example')).get('/api/leaderboards')).status).toBe(403);
    });
  });

  describe('methodology', () => {
    it('lists every task and score, labelled fixture or report', async () => {
      const body = await json(await maya.get('/api/leaderboards/methodology?domain=biology'));
      expect(body).toMatchObject({ resamples: 10_000, seed: 42, percentiles: { low: 249, high: 9749 } });
      expect(body.models.map((model: any) => model.shortName)).toEqual(['Aster', 'Meridian', 'Lumen']);
      expect(body.tasks).toHaveLength(24);
      expect(body.tasks[0]).toEqual({
        label: 'BIO-042 v1.0',
        taskCode: 'BIO-042',
        version: 'v1.0',
        source: 'report',
        report: { code: 'RPT-BIO-042', version: '1.0' },
        scores: { 'aster-3.2': 86, 'meridian-2.1': 81, 'lumen-4-mini': 74 },
      });
      expect(body.tasks.filter((task: any) => task.source === 'fixture')).toHaveLength(23);
      expect(body.tasks[1]).toMatchObject({ taskCode: 'BIO-F01', source: 'fixture', report: null });
      // The table reproduces the headline number.
      const mean = body.tasks.reduce((sum: number, task: any) => sum + task.scores['aster-3.2'], 0) / body.tasks.length;
      expect(round1(mean)).toBe(87.4);
    });

    it('has an empty state and a real filter', async () => {
      const body = await json(await maya.get('/api/leaderboards/methodology?domain=computer-science'));
      expect(body.empty).toBe(true);
      expect(body.tasks).toEqual([]);
    });
  });

  describe('reports index', () => {
    it('lists reports to any verified account', async () => {
      const { client } = await member(test, 'stranger@lab.example');
      const body = await json(await client.get('/api/reports'));
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({ code: 'RPT-BIO-042', version: '1.0', href: '/reports/RPT-BIO-042/v1.0', taskLabel: 'BIO-042 v1.0', domainName: 'Biology', ownerName: 'Maya Chen', expertName: 'Dr. Samira Patel', isSynthetic: true, scoreLine: 'Aster 3.2 86 · Meridian 2.1 81 · Lumen 4 Mini 74' });
    });

    it('really filters, and keeps the total so the page can tell the empty states apart', async () => {
      await liveReport('chemistry', 'CHEM-011');
      const all = await json(await maya.get('/api/reports'));
      expect(all.items.map((item: any) => item.code).sort()).toEqual(['RPT-BIO-042', 'RPT-CHEM-011']);
      const biology = await json(await maya.get('/api/reports?domain=biology'));
      expect(biology.items.map((item: any) => item.code)).toEqual(['RPT-BIO-042']);
      expect(biology.total).toBe(2);
      const search = await json(await maya.get(`/api/reports?q=${encodeURIComponent('antibiotic')}`));
      expect(search.items.map((item: any) => item.code)).toEqual(['RPT-BIO-042']);
      const byCode = await json(await maya.get('/api/reports?q=chem-011'));
      expect(byCode.items.map((item: any) => item.code)).toEqual(['RPT-CHEM-011']);
      const none = await json(await maya.get('/api/reports?q=%25%25nothing'));
      expect(none.items).toEqual([]);
      expect(none.total).toBe(2);
      const wildcard = await json(await maya.get(`/api/reports?q=${encodeURIComponent('%')}`));
      expect(wildcard.items).toEqual([]);
    });
  });

  describe('a frozen report', () => {
    it('reads the same for any verified account, with sources still checked', async () => {
      const own = await json(await maya.get('/api/reports/RPT-BIO-042/v1.0'));
      expect(own).toMatchObject({
        code: 'RPT-BIO-042',
        version: '1.0',
        taskCode: 'BIO-042',
        headline: 'Efflux is supported; causality is not established.',
        ownerName: 'Maya Chen',
        expertName: 'Dr. Samira Patel',
        adminName: 'Alex Rivera',
        adjudicationCode: 'ADJ-042',
        verified: true,
        canReadSources: true,
        isSynthetic: true,
        download: { allowed: true },
      });
      expect(own.scores.map((score: any) => [score.displayName, score.score, score.label, score.evidenceCode])).toEqual([
        ['Aster 3.2', 86, 'demo', 'EV-1042-A'],
        ['Meridian 2.1', 81, 'demo', 'EV-1042-M'],
        ['Lumen 4 Mini', 74, 'demo', 'EV-1042-L'],
      ]);
      expect(own.evidence).toMatchObject({ code: 'EV-1042-A', runCode: 'RUN-1042', taskLabel: 'BIO-042 v1.0', runnerVersion: '2.4', verified: true });

      const { client: stranger } = await member(test, 'stranger@lab.example');
      const theirs = await json(await stranger.get('/api/reports/RPT-BIO-042/v1.0'));
      expect(theirs.headline).toBe(own.headline);
      expect(theirs.canReadSources).toBe(false);
      // The report is readable; the private evidence behind it is not opened by this route.
      expect(JSON.stringify(theirs)).not.toContain('The fourfold MIC shift');

      expect((await new Client(test).get('/api/reports/RPT-BIO-042/v1.0')).status).toBe(401);
      await makeUser(test, { email: 'new@lab.example', verified: false });
      expect((await (await signedIn(test, 'new@lab.example')).get('/api/reports/RPT-BIO-042/v1.0')).status).toBe(403);
    });

    it('accepts the version with or without the v, and 404s otherwise', async () => {
      expect((await maya.get('/api/reports/RPT-BIO-042/1.0')).status).toBe(200);
      expect((await maya.get('/api/reports/RPT-BIO-042/v9.9')).status).toBe(404);
      expect((await maya.get('/api/reports/RPT-NOPE/v1.0')).status).toBe(404);
    });

    it('builds the citation text with the versioned URL and evidence hash', async () => {
      const body = await json(await maya.get('/api/reports/RPT-BIO-042/v1.0'));
      expect(body.url).toBe('http://localhost:8787/reports/RPT-BIO-042/v1.0');
      expect(body.citation).toBe('Chen, M. (2026). BIO-042: Assess evidence for an antibiotic resistance mechanism. Rivet, RPT-BIO-042 v1.0. Synthetic demo report.');
      expect(body.citationText).toContain(body.citation);
      expect(body.citationText).toContain(body.url);
      expect(body.citationText).toContain(`Evidence EV-1042-A SHA-256 ${body.evidence.sha256}.`);
      expect(body.citationText).toContain(`Report SHA-256 ${body.sha256}.`);
    });

    it('serves a Markdown file with the manifest and its hash', async () => {
      const res = await maya.get('/api/reports/RPT-BIO-042/v1.0/download');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="RPT-BIO-042-v1.0.md"');
      const text = await res.text();
      expect(text.startsWith('# RPT-BIO-042 v1.0: Efflux is supported; causality is not established.')).toBe(true);
      expect(text).toContain('n = 1 task. No population confidence interval.');
      expect(text).toContain('| Aster 3.2 | 86 / 100 | demo | EV-1042-A |');
      expect(text).toContain('SYNTHETIC DEMO');
      const manifest = text.match(/```json\n(.*)\n```/s)?.[1] as string;
      const stated = text.match(/byte for byte: ([a-f0-9]{64})/)?.[1];
      expect(sha256Hex(manifest)).toBe(stated);
      expect(JSON.parse(manifest).code).toBe('RPT-BIO-042');
      const row = await test.ctx.db.get<any>(`SELECT sha256 FROM reports WHERE code = 'RPT-BIO-042'`);
      expect(stated).toBe(row.sha256);
    });

    it('restricts downloads to verified accounts', async () => {
      expect((await new Client(test).get('/api/reports/RPT-BIO-042/v1.0/download')).status).toBe(401);
      await makeUser(test, { email: 'new@lab.example', verified: false });
      expect((await (await signedIn(test, 'new@lab.example')).get('/api/reports/RPT-BIO-042/v1.0/download')).status).toBe(403);
      const { client: stranger } = await member(test, 'stranger@lab.example');
      expect((await stranger.get('/api/reports/RPT-BIO-042/v1.0/download')).status).toBe(200);
    });

    it('fails verification when the stored manifest changes, and refuses the download', async () => {
      await test.ctx.db.exec('DROP TRIGGER reports_no_update');
      const original = await test.ctx.db.get<any>(`SELECT canonical FROM reports WHERE code = 'RPT-BIO-042'`);
      await test.ctx.db.run(`UPDATE reports SET canonical = ? WHERE code = 'RPT-BIO-042'`, [original.canonical.replace('Efflux is supported', 'Efflux is proven')]);
      const body = await json(await maya.get('/api/reports/RPT-BIO-042/v1.0'));
      expect(body.verified).toBe(false);
      expect(body.download).toEqual({ allowed: false, reason: 'Hash mismatch · Evidence quarantined' });
      const res = await maya.get('/api/reports/RPT-BIO-042/v1.0/download');
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe('hash_mismatch');
    });

    it('fails verification when a shown column drifts from a still-valid manifest', async () => {
      await test.ctx.db.exec('DROP TRIGGER reports_no_update');
      await test.ctx.db.run(`UPDATE reports SET headline = 'Efflux is proven.' WHERE code = 'RPT-BIO-042'`);
      expect((await json(await maya.get('/api/reports/RPT-BIO-042/v1.0'))).verified).toBe(false);
    });

    it('fails verification when any evidence seal fails', async () => {
      await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
      await test.ctx.db.run(`UPDATE evidence SET output_text = 'edited' WHERE code = 'EV-1042-L'`);
      const body = await json(await maya.get('/api/reports/RPT-BIO-042/v1.0'));
      expect(body.verified).toBe(false);
      expect(body.evidence.verified).toBe(true);
      expect((await maya.get('/api/reports/RPT-BIO-042/v1.0/download')).status).toBe(409);
    });

    it('freezes a live report the same way', async () => {
      const { reportCode, run } = await liveReport();
      const body = await json(await maya.get(`/api/reports/${reportCode}/v1.0`));
      expect(body).toMatchObject({ code: reportCode, verified: true, headline: 'Uphold the ordering for this task.', taskCode: run.taskCode });
      expect(body.scores[0]).toMatchObject({ displayName: 'Aster 3.2', score: 80, sealedScore: 75, label: 'demo' });
      const text = await (await maya.get(body.downloadUrl)).text();
      expect(sha256Hex(text.match(/```json\n(.*)\n```/s)?.[1] as string)).toBe(body.sha256);
      expect(text).toContain('Model training exposure remains unknown.');
    });
  });
});
