import type { RubricCriterion, ScoreEntry } from '../../shared/types/evaluation.ts';
import { recordRange, type SourceRecord } from './contract.ts';

/**
 * The deterministic demo scorer. It reads the text it is given and nothing else: which real record
 * IDs are cited, causal versus hedged language, alternatives, and proposed experiments. It knows
 * nothing about the model, and its scores are labelled `demo` everywhere.
 *
 * Each criterion starts at full points. Every deduction carries its own reason, so a rationale
 * accounts for every missing point.
 */

export const DEMO_SCORER_VERSION = 'demo-scorer-1';

type Dimension = 'attribution' | 'reasoning' | 'alternatives' | 'experiment' | 'calibration' | 'general';

interface Deduction {
  /** Share of the criterion's points, 0 to 1. */
  share: number;
  reason: string;
}

interface Assessment {
  deductions: Deduction[];
  /** Said when nothing is deducted. */
  credit: string;
}

const CAUSAL = /\b(caused by|causes|proves?|proven|driven by|is responsible for|definitely|certainly|confirms that|establishes that|demonstrates that)\b/gi;
const NEGATED_CAUSAL = /\b(?:do(?:es)? not|did not|cannot|can't|not|without|don't)\s+(?:\w+\s+){0,2}?(?:establish|prove|show|demonstrate|confirm)\w*|\bnot (?:proof|proven|causal)\b|\bassociation,? not caus\w+/gi;
const HEDGED = /\b(consistent with|suggests?|may|might|could|plausible|plausibly|appears?|supports? (?:this|the|an?)|hypothesis|likely|uncertain\w*|tentative\w*)\b/gi;
const SPECIFIC_ALTERNATIVE = /\b(permeab\w+|off-target|confound\w*|rival|competing|alternative explanations?|another explanation|other explanations?)\b/gi;
const GESTURED_ALTERNATIVE = /\b(other (?:mechanisms?|factors?|causes?)|alternatives?|something else)\b/gi;
const UNRESOLVED = /\b(not (?:been )?(?:excluded|ruled out)|cannot be (?:excluded|ruled out)|remains? (?:open|possible|unresolved)|would discriminate|has not been)\b/gi;
const SPECIFIC_EXPERIMENT = /\b(deletion|knockout|complementation|rescue|randomi[sz]ed|replicat\w+|titration|blinded|controlled|control group|matched control|one factor at a time|a\/b test|counterfactual)\b/gi;
const GENERIC_EXPERIMENT = /\b(experiments?|follow-up|further (?:work|study|studies|testing)|assay|test)\b/gi;
const DISCRIMINATING = /\b(discriminat\w+|separates?|distinguish\w*|tell apart)\b/gi;
const LIMITS = /\b(specificity|limits?|limitations?|caveat|off-target|sole cause|not establish|n = \d+|indirect|does not show|do not establish)\b/gi;

const found = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map((match) => match[0].toLowerCase());

export interface TextFeatures {
  citedReal: string[];
  citedUnknown: string[];
  uncited: string[];
  causal: string[];
  negatedCausal: boolean;
  hedged: string[];
  specificAlternatives: string[];
  gesturedAlternatives: string[];
  unresolved: boolean;
  specificExperiments: string[];
  genericExperiments: string[];
  discriminating: boolean;
  limits: string[];
}

export function analyse(text: string, records: SourceRecord[]): TextFeatures {
  const ids = records.map((record) => record.id);
  const citedReal = ids.filter((id) => new RegExp(`(^|[^\\p{L}\\p{N}])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text));
  // Bracketed citations in the [E01] style that name no pinned record.
  const bracketed = [...text.matchAll(/\[([^\]\n]{1,60})\]/g)].flatMap((match) => (match[1] as string).split(/[,;]/).map((part) => part.trim())).filter((part) => /^[A-Za-z]{1,4}-?\d{1,4}$/.test(part));
  const citedUnknown = [...new Set(bracketed.filter((part) => !ids.includes(part)))];
  const withoutNegated = text.replace(NEGATED_CAUSAL, ' ');
  return {
    citedReal,
    citedUnknown,
    uncited: ids.filter((id) => !citedReal.includes(id)),
    causal: found(CAUSAL, withoutNegated),
    negatedCausal: found(NEGATED_CAUSAL, text).length > 0,
    hedged: found(HEDGED, text),
    specificAlternatives: found(SPECIFIC_ALTERNATIVE, text),
    gesturedAlternatives: found(GESTURED_ALTERNATIVE, text),
    unresolved: found(UNRESOLVED, text).length > 0,
    specificExperiments: found(SPECIFIC_EXPERIMENT, text),
    genericExperiments: found(GENERIC_EXPERIMENT, text),
    discriminating: found(DISCRIMINATING, text).length > 0,
    limits: found(LIMITS, text),
  };
}

function dimensionOf(criterion: RubricCriterion): Dimension {
  const classify = (text: string): Dimension | null => {
    if (/alternativ|off-target|confound|permeab|rival/i.test(text)) return 'alternatives';
    if (/evidence|attribut|citation|\bcit(e|es|ing)\b|source/i.test(text)) return 'attribution';
    if (/calibrat|uncertain|conclusion|confidence|overclaim/i.test(text)) return 'calibration';
    if (/experiment|control|design|follow-up|discriminat/i.test(text)) return 'experiment';
    if (/mechanis|causal|reason|interpret|logic|argument/i.test(text)) return 'reasoning';
    return null;
  };
  return classify(criterion.name) ?? classify(criterion.guidance) ?? 'general';
}

const quote = (values: string[]) => [...new Set(values)].slice(0, 2).map((value) => `“${value}”`).join(' and ');

function assessAttribution(features: TextFeatures, records: SourceRecord[]): Assessment {
  const deductions: Deduction[] = [];
  if (records.length === 0) {
    if (features.citedUnknown.length > 0) deductions.push({ share: 0.7, reason: `Cites ${recordRange(features.citedUnknown)}, but no source records are pinned to this version` });
    else deductions.push({ share: 0.6, reason: 'No source records are pinned, so nothing here can be attributed' });
    return { deductions, credit: '' };
  }
  const required = Math.min(records.length, 3);
  if (features.citedReal.length === 0) deductions.push({ share: 0.7, reason: `Cites none of the pinned records (${recordRange(records.map((record) => record.id))})` });
  else if (features.citedReal.length < required) {
    deductions.push({ share: (0.45 * (required - features.citedReal.length)) / required, reason: `Cites ${recordRange(features.citedReal)} but leaves ${recordRange(features.uncited)} uncited` });
  }
  if (features.citedUnknown.length > 0) deductions.push({ share: 0.2, reason: `Cites ${recordRange(features.citedUnknown)}, which ${features.citedUnknown.length === 1 ? 'is' : 'are'} not in the pinned pack` });
  if (features.limits.length === 0) deductions.push({ share: 0.15, reason: 'Does not state the limits of the cited records' });
  return { deductions, credit: `Cites ${recordRange(features.citedReal)} and states their limits` };
}

function assessReasoning(features: TextFeatures): Assessment {
  const deductions: Deduction[] = [];
  if (features.causal.length > 0) deductions.push({ share: features.hedged.length > 0 ? 0.25 : 0.5, reason: `Uses causal language the records do not support (${quote(features.causal)})` });
  else if (features.hedged.length === 0 && !features.negatedCausal) deductions.push({ share: 0.3, reason: 'Does not say how strongly the observations support the claim' });
  if (!features.negatedCausal && features.causal.length === 0 && features.hedged.length > 0) deductions.push({ share: 0.1, reason: 'Hedges without saying what remains unestablished' });
  return { deductions, credit: 'Treats the observations as support, not proof, and says what remains unestablished' };
}

function assessAlternatives(features: TextFeatures): Assessment {
  if (features.specificAlternatives.length === 0 && features.gesturedAlternatives.length === 0) return { deductions: [{ share: 0.8, reason: 'Does not mention any alternative explanation' }], credit: '' };
  if (features.specificAlternatives.length === 0) return { deductions: [{ share: 0.45, reason: `Only gestures at alternatives (${quote(features.gesturedAlternatives)}) without naming one` }], credit: '' };
  if (!features.unresolved) return { deductions: [{ share: 0.2, reason: `Names ${quote(features.specificAlternatives)} but does not say whether it was excluded` }], credit: '' };
  return { deductions: [], credit: `Names ${quote(features.specificAlternatives)} and says it remains open` };
}

function assessExperiment(features: TextFeatures): Assessment {
  if (features.specificExperiments.length === 0 && features.genericExperiments.length === 0) return { deductions: [{ share: 0.85, reason: 'Proposes no experiment' }], credit: '' };
  if (features.specificExperiments.length === 0) return { deductions: [{ share: 0.55, reason: 'Calls for further work without naming a controlled experiment' }], credit: '' };
  if (!features.discriminating) return { deductions: [{ share: 0.2, reason: `Names ${quote(features.specificExperiments)} but does not say what it would separate` }], credit: '' };
  return { deductions: [], credit: `Proposes ${quote(features.specificExperiments)} and says what it would discriminate` };
}

function assessCalibration(features: TextFeatures): Assessment {
  const deductions: Deduction[] = [];
  if (features.causal.length > 0) deductions.push({ share: features.hedged.length > 0 ? 0.2 : 0.4, reason: `Concludes more than the evidence allows (${quote(features.causal)})` });
  if (features.hedged.length === 0 && !features.negatedCausal) deductions.push({ share: 0.25, reason: 'States no uncertainty' });
  if (features.specificExperiments.length === 0) deductions.push({ share: 0.2, reason: 'Names no specific next experiment' });
  return { deductions, credit: 'States uncertainty and names a specific next experiment' };
}

function assess(dimension: Dimension, features: TextFeatures, records: SourceRecord[]): Assessment {
  switch (dimension) {
    case 'attribution':
      return assessAttribution(features, records);
    case 'reasoning':
      return assessReasoning(features);
    case 'alternatives':
      return assessAlternatives(features);
    case 'experiment':
      return assessExperiment(features);
    case 'calibration':
      return assessCalibration(features);
    case 'general': {
      // A criterion this scorer cannot place gets an even weight of the four signals it can read.
      const parts = [assessAttribution(features, records), assessReasoning(features), assessAlternatives(features), assessExperiment(features)];
      return { deductions: parts.flatMap((part) => part.deductions.map((item) => ({ share: item.share / parts.length, reason: item.reason }))), credit: 'Cites its sources, stays calibrated, names alternatives and proposes an experiment' };
    }
  }
}

export function scoreText(rubric: RubricCriterion[], records: SourceRecord[], output: string): { scores: ScoreEntry[]; total: number } {
  const features = analyse(output, records);
  const scores = rubric.map((criterion): ScoreEntry => {
    const { deductions, credit } = assess(dimensionOf(criterion), features, records);
    let remaining = criterion.points;
    const notes: string[] = [];
    for (const deduction of deductions) {
      const points = Math.min(remaining, Math.round(criterion.points * deduction.share));
      if (points <= 0) continue;
      remaining -= points;
      notes.push(`−${points}: ${deduction.reason}`);
    }
    return {
      name: criterion.name,
      short: criterion.short || criterion.name,
      points: criterion.points,
      score: remaining,
      rationale: notes.length > 0 ? `${notes.join('. ')}.` : `No deduction: ${credit || 'nothing here loses points'}.`,
    };
  });
  return { scores, total: scores.reduce((sum, entry) => sum + entry.score, 0) };
}
