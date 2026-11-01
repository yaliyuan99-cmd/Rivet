// Offline search for the 23 authored fixtures whose real bootstrap reproduces the frame's numbers; paste the printed table into server/db/seed/published.ts.
import { drawTaskResamples, mulberry32, pairedBootstrap, percentileIndices, round1, type ScoreRow } from '../server/lib/statistics.ts';

const TASKS = 24;
const RESAMPLES = 10_000;
const LABELS = ['BIO-042 v1.0', ...Array.from({ length: 23 }, (_, index) => `BIO-F${String(index + 1).padStart(2, '0')} v1.0`)].sort();

// BIO-042 v1.0 is fixed by the seeded report and sorts first.
const TARGETS = [
  { model: 'aster-3.2', fixed: 86, mean: 87.4, low: 83.1, high: 91.2, spread: 10, floor: 60 },
  { model: 'meridian-2.1', fixed: 81, mean: 83.1, low: 78.5, high: 87.6, spread: 11, floor: 55 },
  { model: 'lumen-4-mini', fixed: 74, mean: 77.8, low: 72.0, high: 83.4, spread: 14, floor: 45 },
];

const draws = drawTaskResamples(TASKS, RESAMPLES);
const counts = new Uint8Array(TASKS * RESAMPLES);
for (let r = 0; r < RESAMPLES; r += 1) {
  for (let d = 0; d < TASKS; d += 1) counts[r * TASKS + (draws[r * TASKS + d] as number)] += 1;
}

// Tasks share a difficulty, so models rise and fall together as paired observations do.
const shared = mulberry32(2026);
const difficulty = Array.from({ length: TASKS }, () => shared() * 2 - 1);

function search(target: (typeof TARGETS)[number]): number[] {
  const { low: lowIndex, high: highIndex } = percentileIndices(RESAMPLES);
  const random = mulberry32(target.fixed * 1009);
  const means = new Float64Array(RESAMPLES);
  const sorted = new Float64Array(RESAMPLES);
  const miss = (value: number, wanted: number) => Math.max(0, Math.abs(value - wanted) - 0.04);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const scores = difficulty.map((value) => Math.min(100, Math.max(target.floor, Math.round(target.mean + target.spread * (0.7 * value + 0.6 * (random() * 2 - 1))))));
    scores[0] = target.fixed;
    for (let r = 0; r < RESAMPLES; r += 1) {
      let sum = 0;
      for (let t = 0; t < TASKS; t += 1) sum += (counts[r * TASKS + t] as number) * (scores[t] as number);
      means[r] = sum / TASKS;
    }
    const loss = () => {
      sorted.set(means);
      sorted.sort();
      const mean = scores.reduce((sum, value) => sum + value, 0) / TASKS;
      return miss(mean, target.mean) * 3 + miss(sorted[lowIndex] as number, target.low) + miss(sorted[highIndex] as number, target.high);
    };
    const apply = (task: number, delta: number) => {
      scores[task] = (scores[task] as number) + delta;
      for (let r = 0; r < RESAMPLES; r += 1) means[r] = (means[r] as number) + ((counts[r * TASKS + task] as number) * delta) / TASKS;
    };
    const legal = (task: number, delta: number) => {
      const next = (scores[task] as number) + delta;
      return next <= 100 && next >= target.floor;
    };

    // Annealing: single moves shift the mean; paired moves change the spread and skew around it.
    let current = loss();
    const steps = 12_000;
    for (let step = 0; step < steps && current > 0; step += 1) {
      const temperature = 0.06 * (1 - step / steps) ** 2 + 0.0005;
      const a = 1 + Math.floor(random() * (TASKS - 1));
      const b = 1 + Math.floor(random() * (TASKS - 1));
      const delta = (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 3));
      const pair = random() < 0.7 && a !== b;
      if (!legal(a, delta) || (pair && !legal(b, -delta))) continue;
      apply(a, delta);
      if (pair) apply(b, -delta);
      const next = loss();
      if (next <= current || random() < Math.exp((current - next) / temperature)) {
        current = next;
      } else {
        apply(a, -delta);
        if (pair) apply(b, delta);
      }
    }
    console.log(`${target.model} attempt ${attempt + 1}: loss ${current.toFixed(4)}`);
    if (current === 0) return scores;
  }
  throw new Error(`No solution for ${target.model}`);
}

const solved = TARGETS.map(search);
const rows: ScoreRow[] = TARGETS.flatMap((target, column) => LABELS.map((taskLabel, t) => ({ taskLabel, modelId: target.model, score: solved[column]?.[t] as number })));
const result = pairedBootstrap(rows);
for (const model of result.models) console.log(`${model.modelId}: ${round1(model.mean)} [${round1(model.low as number)}, ${round1(model.high as number)}] n=${model.n}`);

console.log('\nexport const AUTHORED_SCORES: [string, number, number, number][] = [');
LABELS.forEach((label, t) => console.log(`  ['${label}', ${solved[0]?.[t]}, ${solved[1]?.[t]}, ${solved[2]?.[t]}],`));
console.log('];');

// How the same resamples read as paired differences, recorded in docs/assumptions/expert.md.
for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
  const diffs = new Float64Array(RESAMPLES);
  for (let r = 0; r < RESAMPLES; r += 1) {
    let sum = 0;
    for (let t = 0; t < TASKS; t += 1) sum += (counts[r * TASKS + t] as number) * ((solved[a]?.[t] as number) - (solved[b]?.[t] as number));
    diffs[r] = sum / TASKS;
  }
  diffs.sort();
  console.log(`${TARGETS[a]?.model} - ${TARGETS[b]?.model}: [${round1(diffs[249] as number)}, ${round1(diffs[9749] as number)}]`);
}
