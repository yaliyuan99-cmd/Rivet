import type { PinnedModel, RubricCriterion, ScoreEntry } from '../../shared/types/evaluation.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { STARTER_PROMPT, STARTER_RUBRIC } from '../lib/demoFixtures.ts';
import type { GenerateInput, GenerateResult, ModelAdapter, ScoreInput, ScoreResult } from './adapters.ts';
import type { SourceRecord } from './contract.ts';
import { AUTHORED_OUTPUTS } from './demoStory.ts';
import { DEMO_SCORER_VERSION, scoreText } from './scorer.ts';

/**
 * "Rivet Demo / Synthetic response adapter". No model is called. For the starter prompt it returns
 * the authored story; for anything else it writes a clearly synthetic answer whose quality depends
 * on the model's profile, so the comparison pages have something real to compare.
 */

type Profile = 'careful' | 'competent' | 'overconfident' | 'cursory';

const PROFILE_BY_LETTER: Record<string, Profile> = { A: 'careful', M: 'competent', L: 'overconfident' };
const PROFILES: Profile[] = ['careful', 'competent', 'overconfident', 'cursory'];

const hashNumber = (text: string) => Number.parseInt(sha256Hex(text).slice(0, 8), 16);

export function profileFor(model: PinnedModel): Profile {
  return PROFILE_BY_LETTER[model.letter] ?? (PROFILES[hashNumber(model.id) % PROFILES.length] as Profile);
}

const pick = <T,>(options: readonly T[], key: string): T => options[hashNumber(key) % options.length] as T;

function shortObservation(record: SourceRecord): string {
  const text = record.observation || record.label || 'an unlabelled observation';
  const trimmed = text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
  return trimmed.replace(/[.;:]+$/, '');
}

function citeClause(record: SourceRecord): string {
  return `${record.id === record.label ? 'the record' : record.label || 'the record'} reports ${shortObservation(record)} [${record.id}]`;
}

function syntheticAnswer(input: GenerateInput, profile: Profile): string {
  const { model, records, task } = input;
  const seedKey = `${task.settings.seed}:${model.id}:${task.prompt}`;
  const lead = `Synthetic demo response from ${model.displayName}; not a real model output. Task: “${task.title}”.`;
  const clauses = records.slice(0, 5).map(citeClause);
  const noRecords = 'No source records were attached, so this synthetic response cites none.';

  switch (profile) {
    case 'careful': {
      const evidence = clauses.length ? `${clauses.join('; ')}.` : noRecords;
      const opener = pick(['Taken together, these observations are consistent with the proposed explanation', 'These observations support the proposed explanation as a hypothesis'], seedKey);
      // Careful, not perfect: each answer leaves one thing short, so a demo score is never a clean sweep.
      const shortOnAlternatives = hashNumber(`${seedKey}:weakness`) % 2 === 0;
      const alternative = shortOnAlternatives ? 'An alternative explanation is possible.' : 'An alternative explanation has not been excluded.';
      const experiment = shortOnAlternatives
        ? 'A controlled experiment that changes one factor at a time against a matched control would discriminate between the explanations.'
        : 'A controlled experiment against a matched control would be a useful next step.';
      return `${lead} ${evidence} ${opener}, but they do not establish it as the sole cause, and the limits of each record still apply. ${alternative} ${experiment}`;
    }
    case 'competent': {
      const evidence = clauses.length ? `${clauses.slice(0, Math.max(1, clauses.length - 1)).join('; ')}.` : noRecords;
      return `${lead} ${evidence} Together this suggests the proposed explanation may contribute. Another explanation could also contribute and has not been excluded. A follow-up experiment would help confirm the result.`;
    }
    case 'overconfident': {
      const evidence = clauses.length ? `${clauses[0]}.` : noRecords;
      const claim = pick(['The result is driven by the proposed mechanism', 'The proposed mechanism is responsible for the result'], seedKey);
      return `${lead} ${claim}. ${evidence} Other factors may play a role. Further work is recommended.`;
    }
    case 'cursory':
      return `${lead} The proposed explanation is correct and the records support it.`;
  }
}

function usesAuthoredStory(input: { task: { prompt: string }; model: PinnedModel }): boolean {
  return input.task.prompt === STARTER_PROMPT && input.model.id in AUTHORED_OUTPUTS;
}

/** Authored scores only apply to the rubric and records they were written against. */
function authoredScoresApply(rubric: RubricCriterion[], records: SourceRecord[]): boolean {
  const ids = records.map((record) => record.id);
  const sameRubric = rubric.length === STARTER_RUBRIC.length && rubric.every((criterion, index) => criterion.name === STARTER_RUBRIC[index]?.name && criterion.points === STARTER_RUBRIC[index]?.points);
  return sameRubric && ['E01', 'E02', 'E03'].every((id) => ids.includes(id));
}

export const demoAdapter: ModelAdapter = {
  paced: true,

  async generate(input): Promise<GenerateResult> {
    if (usesAuthoredStory(input)) {
      return {
        text: (AUTHORED_OUTPUTS[input.model.id] as (typeof AUTHORED_OUTPUTS)[string]).output,
        meta: { adapter: 'demo', synthetic: true, authored: true, seed: input.task.settings.seed },
      };
    }
    const profile = profileFor(input.model);
    return {
      text: syntheticAnswer(input, profile),
      meta: { adapter: 'demo', synthetic: true, label: 'Synthetic response adapter', profile, seed: input.task.settings.seed },
    };
  },

  async score(input: ScoreInput): Promise<ScoreResult> {
    const authored = AUTHORED_OUTPUTS[input.model.id];
    if (authored && input.output === authored.output && authoredScoresApply(input.task.rubric, input.records)) {
      const scores = input.task.rubric.map(
        (criterion, index): ScoreEntry => ({
          name: criterion.name,
          short: criterion.short,
          points: criterion.points,
          score: authored.scores[index] as number,
          rationale: authored.notes[index] as string,
        }),
      );
      return { scores, total: scores.reduce((sum, entry) => sum + entry.score, 0), label: 'demo', meta: { scorer: 'authored', authored: true } };
    }
    const { scores, total } = scoreText(input.task.rubric, input.records, input.output);
    return { scores, total, label: 'demo', meta: { scorer: DEMO_SCORER_VERSION } };
  },
};
