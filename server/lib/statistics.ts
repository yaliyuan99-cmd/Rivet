/**
 * The leaderboard statistic: a paired, task-level percentile bootstrap.
 *
 * - Tasks are the unit of resampling. Each resample draws n tasks with replacement.
 * - The same draw applies to every model, so a hard task stays hard for all of them.
 * - The generator is mulberry32 seeded with 42, and tasks are taken in sorted label order, so the
 *   same sample always gives the same interval. A new task changes the numbers, which is correct.
 * - The 95% interval is the percentile pair at sorted[249] and sorted[9749] of 10,000 means.
 */

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 42;

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Task indices for every resample, flattened: resample r, draw d is at r * taskCount + d. */
export function drawTaskResamples(taskCount: number, resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED): Uint32Array {
  const random = mulberry32(seed);
  const draws = new Uint32Array(taskCount * resamples);
  for (let index = 0; index < draws.length; index += 1) draws[index] = Math.floor(random() * taskCount);
  return draws;
}

/** Positions in a sorted list of `count` means: 249 and 9749 for 10,000. */
export function percentileIndices(count: number): { low: number; high: number } {
  return { low: Math.ceil((count * 25) / 1000) - 1, high: Math.ceil((count * 975) / 1000) - 1 };
}

export interface ScoreRow {
  taskLabel: string;
  modelId: string;
  score: number;
}

export interface ModelEstimate {
  modelId: string;
  /** Tasks this model has a score on. */
  n: number;
  mean: number;
  /** Null below two tasks: a single task has no interval. */
  low: number | null;
  high: number | null;
}

export interface BootstrapResult {
  /** Sorted task labels: the order the resamples index into. */
  tasks: string[];
  /** Highest mean first. */
  models: ModelEstimate[];
  /** task × model cells with no score. */
  missing: number;
  resamples: number;
  seed: number;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function pairedBootstrap(rows: ScoreRow[], options: { resamples?: number; seed?: number } = {}): BootstrapResult {
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const tasks = [...new Set(rows.map((row) => row.taskLabel))].sort(compareText);
  const modelIds = [...new Set(rows.map((row) => row.modelId))].sort(compareText);
  const taskIndex = new Map(tasks.map((label, index) => [label, index]));
  const taskCount = tasks.length;

  const scores = new Map<string, Float64Array>();
  for (const modelId of modelIds) scores.set(modelId, new Float64Array(taskCount).fill(Number.NaN));
  for (const row of rows) (scores.get(row.modelId) as Float64Array)[taskIndex.get(row.taskLabel) as number] = row.score;

  const draws = taskCount > 0 ? drawTaskResamples(taskCount, resamples, seed) : new Uint32Array();
  const models: ModelEstimate[] = modelIds.map((modelId) => {
    const column = scores.get(modelId) as Float64Array;
    const present = column.filter((value) => !Number.isNaN(value));
    const n = present.length;
    const mean = n ? present.reduce((sum, value) => sum + value, 0) / n : 0;
    if (n < 2) return { modelId, n, mean, low: null, high: null };

    // With missing runs a resample averages the tasks this model has among those drawn.
    const means = new Float64Array(resamples);
    let filled = 0;
    for (let r = 0; r < resamples; r += 1) {
      let sum = 0;
      let count = 0;
      for (let d = 0; d < taskCount; d += 1) {
        const value = column[draws[r * taskCount + d] as number] as number;
        if (!Number.isNaN(value)) {
          sum += value;
          count += 1;
        }
      }
      if (count > 0) {
        means[filled] = sum / count;
        filled += 1;
      }
    }
    const sorted = means.subarray(0, filled).sort();
    const { low, high } = percentileIndices(filled);
    return { modelId, n, mean, low: sorted[low] as number, high: sorted[high] as number };
  });

  models.sort((a, b) => b.mean - a.mean || compareText(a.modelId, b.modelId));
  return { tasks, models, missing: taskCount * modelIds.length - rows.length, resamples, seed };
}

/** One decimal, the precision the leaderboard prints. */
export const round1 = (value: number) => Math.round(value * 10) / 10;

export interface LabelledInterval {
  label: string;
  low: number | null;
  high: number | null;
}

export type OverlapState = 'all' | 'some' | 'none' | 'not_applicable';

export interface OverlapReading {
  state: OverlapState;
  separated: [string, string][];
  overlapping: [string, string][];
}

/** Compares every pair of intervals; the leaderboard may only say "overlap" when this says so. */
export function readOverlap(intervals: LabelledInterval[]): OverlapReading {
  const usable = intervals.filter((item) => item.low !== null && item.high !== null);
  const separated: [string, string][] = [];
  const overlapping: [string, string][] = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i] as LabelledInterval;
      const b = usable[j] as LabelledInterval;
      const overlap = (a.low as number) <= (b.high as number) && (b.low as number) <= (a.high as number);
      (overlap ? overlapping : separated).push([a.label, b.label]);
    }
  }
  if (usable.length < 2) return { state: 'not_applicable', separated, overlapping };
  if (separated.length === 0) return { state: 'all', separated, overlapping };
  return { state: overlapping.length === 0 ? 'none' : 'some', separated, overlapping };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const joinPairs = (pairs: [string, string][]) => pairs.map(([a, b]) => `${a} and ${b}`).join('; ');

/** The "Read the uncertainty" paragraph. Every clause follows from the computed result. */
export function describeUncertainty(input: { intervals: LabelledInterval[]; modelCount: number; synthetic: boolean; missing: number; resamples?: number; seed?: number }): string {
  const { intervals, modelCount, synthetic, missing } = input;
  const adjective = synthetic ? 'synthetic ' : '';
  const reading = readOverlap(intervals);
  let claim: string;
  if (reading.state === 'all') {
    claim = `Intervals overlap: these ${adjective}observations do not establish a statistically decisive ordering.`;
  } else if (reading.state === 'some') {
    claim = `Some intervals overlap: these ${adjective}observations separate only ${joinPairs(reading.separated)}. Every other ordering stays undecided.`;
  } else if (reading.state === 'none') {
    claim = `Intervals do not overlap: these ${adjective}observations separate every model in this sample, and say nothing beyond these tasks.`;
  } else if (modelCount < 2) {
    claim = `Only one model has scores here, so these ${adjective}observations contain no ordering to read.`;
  } else {
    claim = `An interval needs at least two tasks per model, so these ${adjective}observations do not establish an ordering.`;
  }
  const resamples = (input.resamples ?? BOOTSTRAP_RESAMPLES).toLocaleString('en-US');
  const method = `Paired, task-level bootstrap; ${resamples} resamples; seed ${input.seed ?? BOOTSTRAP_SEED}.`;
  const gaps = missing === 0 ? 'No missing runs.' : `${plural(missing, 'missing run')}: each mean uses only the tasks that model has.`;
  return `${claim} ${method} ${gaps}`;
}
