import { describe, expect, it } from 'vitest';
import type { TraceStep } from '../../shared/types/assurance.ts';
import { BIOLOGY_GATE_V1, citationRange, evaluateTrace, GROUP_LABELS, isCausalAssertion, isCausalControlRecord, isQualifiedClaim, suiteForDomain, type GateInput } from '../../server/engine/gate.ts';
import { traceHash } from '../../server/lib/evidence.ts';

const RECORDS = [
  { source_id: 'E01', assay: 'MIC assay', observation: '0.25 → 1.00 µg/mL ciprofloxacin', provenance: 'Authored fixture' },
  { source_id: 'E02', assay: 'qPCR', observation: 'acrB transcript 3.1× control', provenance: 'Authored fixture' },
  { source_id: 'E03', assay: 'Inhibitor assay', observation: 'Partial MIC reversal; specificity unknown', provenance: 'Authored fixture' },
  { source_id: 'E04', assay: 'Deletion and rescue', observation: 'ΔacrB restores susceptibility; complementation restores resistance', provenance: 'Authored fixture' },
];

const READ: TraceStep = { n: 1, title: 'Retrieve sources', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' };
const COMPARE: TraceStep = { n: 2, title: 'Compare observations', sources: ['E01', 'E02', 'E03'], status: 'Grounded' };

function inputFor(claim: string | null, overrides: Partial<GateInput> = {}, sources = ['E01', 'E02', 'E03']): GateInput {
  const steps: TraceStep[] = [READ, COMPARE];
  if (claim !== null) steps.push({ n: 3, title: 'Draft claim', claim, sources, status: 'Drafted' });
  const sha256 = traceHash({ code: 'TRACE-1', agent_label: 'Agent', harness_version: '1.0.0', steps });
  return {
    trace: { code: 'TRACE-1', agentLabel: 'Agent', harnessVersion: '1.0.0', candidate: 'rc.1', steps, sha256, computedSha256: sha256 },
    dataset: { code: 'DS-BIO-07', version: '1.0', records: RECORDS, bytesVerified: true },
    task: { label: 'BIO-042 v1.0', hashVerified: true },
    datasetsRead: [{ code: 'DS-BIO-07', found: true, allowed: true }],
    adjudications: [],
    regressions: [],
    ...overrides,
  };
}

const stepsInput = (steps: TraceStep[], overrides: Partial<GateInput> = {}): GateInput => {
  const base = inputFor('consistent with efflux involvement; not proven.', overrides);
  return { ...base, trace: { ...base.trace, steps } };
};

const failing = (input: GateInput) =>
  evaluateTrace(input)
    .checks.filter((check) => check.status === 'failed')
    .map((check) => check.id);

describe('biology-gate v1', () => {
  it('is an actual list of 30 named, unique checks in four groups', () => {
    expect(BIOLOGY_GATE_V1.name).toBe('biology-gate v1');
    expect(BIOLOGY_GATE_V1.checks).toHaveLength(30);
    expect(new Set(BIOLOGY_GATE_V1.checks.map((check) => check.id)).size).toBe(30);
    expect(new Set(BIOLOGY_GATE_V1.checks.map((check) => check.label)).size).toBe(30);
    expect(Object.keys(GROUP_LABELS)).toEqual(['claim', 'source', 'private', 'integrity']);
    const counts = Object.fromEntries(Object.keys(GROUP_LABELS).map((group) => [group, BIOLOGY_GATE_V1.checks.filter((check) => check.group === group).length]));
    expect(counts).toEqual({ claim: 10, source: 8, private: 7, integrity: 5 });
  });

  it('covers Biology only', () => {
    expect(suiteForDomain('biology')).toBe(BIOLOGY_GATE_V1);
    expect(suiteForDomain('chemistry')).toBeNull();
  });

  it('passes 30 / 30 on a qualified claim', () => {
    const result = evaluateTrace(inputFor('consistent with efflux involvement; not proven.'));
    expect(result).toMatchObject({ status: 'passed', passedCount: 30, totalCount: 30, blockingReason: null });
    expect(result.groups.map((group) => [group.title, group.status, group.detail])).toEqual([
      ['Claim consistency', 'passed', 'TRACE-1, qualified causal claim'],
      ['Source attribution', 'passed', 'E01–E03 citations retained'],
      ['Private data boundary', 'passed', 'No external exposure'],
      ['Evidence integrity', 'passed', 'Artifact hashes verified'],
    ]);
  });

  it('fails exactly one check on the frame’s unsupported claim', () => {
    const result = evaluateTrace(inputFor('Efflux is proven to cause resistance.'));
    expect(result).toMatchObject({ status: 'blocked', passedCount: 29, totalCount: 30 });
    expect(result.checks.filter((check) => check.status === 'failed').map((check) => check.id)).toEqual(['causal_claim_requires_control']);
    expect(result.groups[0]).toMatchObject({ title: 'Claim consistency', status: 'failed', detail: 'TRACE-1, step 03' });
    expect(result.blockingReason).toBe('Required check failed: Causal claims cite a causal control');
  });

  it('passes the same causal claim once it cites a causal control', () => {
    const result = evaluateTrace(inputFor('Efflux is proven to cause resistance.', {}, ['E01', 'E02', 'E03', 'E04']));
    expect(result.status).toBe('passed');
    expect(result.passedCount).toBe(30);
  });

  it('names the regression when one holds the failing check', () => {
    const regression = { code: 'REG-BIO-042', version: 1, name: 'Claim-to-source', rule: 'causal_claim_requires_control', policy: 'block_high' as const, severity: 'high' as const, sourceAdjudicationId: null, sourceCode: 'ADJ-TRACE-042', sourceTraceCode: 'TRACE-042' };
    const result = evaluateTrace(inputFor('Efflux is proven to cause resistance.', { regressions: [regression] }));
    expect(result.groups[0]?.title).toBe('REG-BIO-042 / Claim consistency');
    expect(result.blockingReason).toBe('High-severity REG-BIO-042 failed');
    expect(result.regressions).toEqual([{ code: 'REG-BIO-042', version: 1, name: 'Claim-to-source', rule: 'causal_claim_requires_control', policy: 'block_high', severity: 'high' }]);
  });

  it('is deterministic and does not consider who is asking', () => {
    const input = inputFor('Efflux is proven to cause resistance.');
    expect(evaluateTrace(input)).toEqual(evaluateTrace(JSON.parse(JSON.stringify(input))));
    expect(evaluateTrace.length).toBeLessThanOrEqual(2);
  });
});

describe('the causal rule', () => {
  it.each([
    'Efflux is proven to cause resistance.',
    'Efflux causes resistance.',
    'AcrAB-TolC is responsible for the shift.',
    'Resistance is driven by efflux.',
    'Ciprofloxacin resistance here is probably driven by increased AcrAB-TolC efflux.',
    'The inhibitor result proves the mechanism.',
    'The MIC shift is due to efflux.',
    'Efflux causes resistance, not permeability.',
    'Efflux explains the phenotype.',
  ])('flags %s', (claim) => {
    expect(evaluateTrace(inputFor(claim)).checks[0]).toMatchObject({ id: 'causal_claim_requires_control', status: 'failed' });
  });

  it.each([
    'consistent with efflux involvement; not proven.',
    'These observations do not establish AcrAB-TolC as the sole cause.',
    'Efflux is not proven to cause resistance.',
    'Efflux is unproven as a cause of resistance.',
    'The fourfold MIC shift is consistent with an efflux contribution.',
    'Efflux may cause resistance, which would need a deletion control.',
    'A deletion experiment could show whether efflux causes the shift.',
    'The cause remains unknown.',
    'Because of limited data, no conclusion is possible.',
    'Causation is not established.',
    'Partial MIC reversal is observed.',
    'acrB transcript rises.',
  ])('does not flag %s', (claim) => {
    expect(evaluateTrace(inputFor(claim)).checks[0]).toMatchObject({ id: 'causal_claim_requires_control', status: 'passed' });
  });

  it('reads each clause on its own', () => {
    expect(isCausalAssertion('Efflux causes resistance')).toBe(true);
    expect(isCausalAssertion('not proven')).toBe(false);
    const mixed = evaluateTrace(inputFor('Efflux is consistent with involvement; efflux causes resistance.'));
    expect(mixed.checks[0]?.status).toBe('failed');
  });

  it('does not count a citation that says the control is missing', () => {
    expect(isCausalControlRecord({ source_id: 'X', observation: 'No deletion or rescue control is present' })).toBe(false);
    expect(isCausalControlRecord({ source_id: 'X', assay: 'Complementation', observation: 'Restores the phenotype' })).toBe(true);
    const records = [...RECORDS, { source_id: 'E05', observation: 'No deletion control was run', provenance: 'Authored' }];
    const input = inputFor('Efflux causes resistance.', { dataset: { code: 'DS-BIO-07', version: '1.0', records, bytesVerified: true } }, ['E05']);
    expect(failing(input)).toContain('causal_claim_requires_control');
  });

  it('recognises a qualified claim', () => {
    expect(isQualifiedClaim('consistent with efflux involvement; not proven.')).toBe(true);
    expect(isQualifiedClaim('Efflux is proven to cause resistance.')).toBe(false);
  });
});

describe('each group fails for its own reasons', () => {
  it('claim: no claim drafted', () => {
    expect(failing(inputFor(null))).toContain('claim_present');
  });

  it('claim: a flag with no adjudication, then a finding with no regression, then held', () => {
    const steps: TraceStep[] = [READ, COMPARE, { n: 3, title: 'Draft', claim: 'consistent with efflux involvement; not proven.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' }, { n: 4, title: 'Prepare answer', detail: 'Human adjudication required', status: 'Flagged' }];
    expect(failing(stepsInput(steps))).toEqual(['claim_flags_resolved']);
    const finding = { id: 'a1', code: 'ADJ-1', kind: 'finding' as const, finding: 'Unsupported causal claim', severity: 'high' };
    expect(evaluateTrace(stepsInput(steps, { adjudications: [finding] })).checks.find((check) => check.id === 'claim_flags_resolved')?.detail).toBe('ADJ-1 has no active regression');
    const clarification = { ...finding, kind: 'clarification' as const };
    expect(failing(stepsInput(steps, { adjudications: [clarification] }))).toEqual(['claim_flags_resolved']);
    const held = { code: 'REG-1', version: 1, name: 'x', rule: 'causal_claim_requires_control', policy: 'block_high' as const, severity: 'high' as const, sourceAdjudicationId: 'a1', sourceCode: 'ADJ-1', sourceTraceCode: 'TRACE-OTHER' };
    expect(failing(stepsInput(steps, { adjudications: [finding], regressions: [held] }))).toEqual([]);
  });

  it('claim: advisory checks are recorded without blocking', () => {
    const result = evaluateTrace(inputFor('Reduced permeability plays no role in this phenotype.'));
    expect(result.status).toBe('passed');
    expect(result.passedCount).toBe(29);
    expect(result.checks.find((check) => check.id === 'claim_alternatives_open')).toMatchObject({ status: 'failed', required: false, blocking: false });
    expect(result.groups[0]?.detail).toContain('1 advisory check failed');
  });

  it('claim: a discriminating control clears a dismissed alternative', () => {
    expect(failing(inputFor('Reduced permeability plays no role in this phenotype.', {}, ['E01', 'E04']))).toEqual(['source_citations_retained']);
  });

  it('claim: an active regression makes an advisory check block', () => {
    const regression = { code: 'REG-2', version: 1, name: 'x', rule: 'claim_no_absolute_language', policy: 'block_high' as const, severity: 'high' as const, sourceAdjudicationId: null, sourceCode: null, sourceTraceCode: null };
    const claim = 'The role of efflux is certainly open to question.';
    expect(evaluateTrace(inputFor(claim)).status).toBe('passed');
    const held = evaluateTrace(inputFor(claim, { regressions: [regression] }));
    expect(held.status).toBe('blocked');
    expect(held.blockingReason).toBe('High-severity REG-2 failed');
    const medium = evaluateTrace(inputFor(claim, { regressions: [{ ...regression, severity: 'medium' }] }));
    expect(medium.status).toBe('passed');
    const strict = evaluateTrace(inputFor(claim, { regressions: [{ ...regression, severity: 'medium', policy: 'block_any' }] }));
    expect(strict.status).toBe('blocked');
    expect(strict.blockingReason).toBe('REG-2 failed under its policy');
  });

  it.each([
    ['AcrAB-TolC is the sole mechanism here.', 'claim_no_sole_cause', 'passed'],
    ['The inhibitor result confirms pump involvement.', 'claim_inhibitor_specificity', 'blocked'],
    ['Transcript abundance demonstrates pump activity.', 'claim_transcript_not_activity', 'blocked'],
    ['Patients should receive a higher dose.', 'claim_no_clinical_advice', 'blocked'],
  ])('claim: %s fails %s', (claim, id, status) => {
    const result = evaluateTrace(inputFor(claim));
    expect(result.checks.find((check) => check.id === id)?.status).toBe('failed');
    expect(result.status).toBe(status);
  });

  it('claim: numbers must appear in the cited records', () => {
    expect(failing(inputFor('acrB is 9.9× control, an association.'))).toEqual(['claim_quantities_match_sources']);
    expect(failing(inputFor('acrB is 3.1× control, an association.'))).toEqual([]);
    expect(failing(inputFor('E01 and E02 are consistent with involvement.'))).toEqual([]);
  });

  it('source: an uncited claim, an unknown citation, a dropped citation', () => {
    expect(failing(inputFor('consistent with involvement.', {}, []))).toEqual(expect.arrayContaining(['source_claims_cite', 'source_citations_retained']));
    expect(failing(inputFor('consistent with involvement.', {}, ['E01', 'E02', 'E03', 'E99']))).toEqual(['source_citations_resolve']);
    expect(failing(inputFor('consistent with involvement.', {}, ['E01']))).toEqual(['source_citations_retained']);
  });

  it('source: citing before reading, or reading the wrong version', () => {
    const before: TraceStep[] = [{ n: 1, title: 'Compare', sources: ['E01'], status: 'Grounded' }, { n: 2, title: 'Read', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' }, { n: 3, title: 'Draft', claim: 'consistent with involvement.', sources: ['E01'], status: 'Qualified' }];
    expect(failing(stepsInput(before))).toEqual(['source_read_before_citing']);
    const wrong: TraceStep[] = [{ ...READ, call: 'read_dataset(DS-BIO-07, v0.9)' }, COMPARE, { n: 3, title: 'Draft', claim: 'consistent with involvement.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' }];
    expect(failing(stepsInput(wrong))).toEqual(['source_dataset_pinned']);
  });

  it('source: nothing pinned', () => {
    const none = failing(inputFor('consistent with involvement.', { dataset: null, task: null }));
    expect(none).toEqual(expect.arrayContaining(['source_dataset_resolves', 'source_task_pinned', 'integrity_dataset_bytes', 'integrity_task_version_hash']));
  });

  it('source: repeated citations are advisory', () => {
    const result = evaluateTrace(inputFor('consistent with involvement.', {}, ['E01', 'E02', 'E03', 'E01']));
    expect(result.checks.find((check) => check.id === 'source_unique_citations')).toMatchObject({ status: 'failed', blocking: false });
    expect(result.status).toBe('passed');
  });

  it('private: external addresses, unlisted tools and personal data', () => {
    const external = (text: string): TraceStep[] => [READ, COMPARE, { n: 3, title: 'Draft', claim: 'consistent with involvement.', detail: text, sources: ['E01', 'E02', 'E03'], status: 'Qualified' }];
    expect(failing(stepsInput(external('Posted to https://example.com/x')))).toEqual(['private_no_external_urls']);
    expect(failing(stepsInput(external('Sent to maya@helixlab.example')))).toEqual(['private_no_email']);
    expect(failing(stepsInput(external('Call (415) 555-0100')))).toEqual(['private_no_phone']);
    expect(failing(stepsInput(external('SSN 123-45-6789')))).toEqual(['private_no_national_id']);
    expect(failing(stepsInput(external('MRN: 00123456')))).toEqual(['private_no_medical_record']);
    const tool: TraceStep[] = [READ, COMPARE, { n: 3, title: 'Search', call: 'web_search(efflux)', status: 'Allowed' }, { n: 4, title: 'Draft', claim: 'consistent with involvement.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' }];
    expect(failing(stepsInput(tool))).toEqual(['private_allowed_tools']);
  });

  it('private: reading another workspace’s private dataset', () => {
    expect(failing(inputFor('consistent with involvement.', { datasetsRead: [{ code: 'DS-BIO-07', found: true, allowed: false }] }))).toEqual(['private_dataset_boundary']);
    expect(failing(inputFor('consistent with involvement.', { datasetsRead: [{ code: 'DS-BIO-07', found: false, allowed: false }] }))).toEqual(['private_dataset_boundary']);
  });

  it('integrity: recomputes the trace hash', () => {
    const input = inputFor('consistent with involvement.');
    const tampered = { ...input, trace: { ...input.trace, computedSha256: 'different' } };
    expect(failing(tampered)).toEqual(['integrity_trace_hash']);
    expect(evaluateTrace(tampered).groups[3]).toMatchObject({ status: 'failed', detail: 'The stored trace no longer matches its hash' });
  });

  it('integrity: dataset bytes, task hash, step order and harness', () => {
    const input = inputFor('consistent with involvement.');
    expect(failing({ ...input, dataset: { ...input.dataset!, bytesVerified: false } })).toEqual(['integrity_dataset_bytes']);
    expect(failing({ ...input, task: { label: 'BIO-042 v1.0', hashVerified: false } })).toEqual(['integrity_task_version_hash']);
    expect(failing(stepsInput([READ, { ...COMPARE, n: 5 }, { n: 3, title: 'Draft', claim: 'consistent with involvement.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' }]))).toEqual(['integrity_steps_ordered']);
    expect(failing({ ...input, trace: { ...input.trace, harnessVersion: 'unknown' } })).toEqual(['integrity_harness_recorded']);
    expect(failing({ ...input, trace: { ...input.trace, candidate: null } })).toEqual(['integrity_harness_recorded']);
  });
});

describe('citationRange', () => {
  it('compresses consecutive IDs only', () => {
    expect(citationRange(['E01', 'E02', 'E03'])).toBe('E01–E03');
    expect(citationRange(['E03', 'E01', 'E02', 'E01'])).toBe('E01–E03');
    expect(citationRange(['E01', 'E03', 'E04'])).toBe('E01, E03, E04');
    expect(citationRange(['E01', 'E02'])).toBe('E01, E02');
    expect(citationRange([])).toBe('');
  });
});
