import type { ConfigStats, ExperimentSummary, RunStatus, TaskStats, Verdict } from '@evals/shared';
import { mulberry32 } from '../common/random.js';

/**
 * Pure statistics for an A/B experiment. No Nest, no DB: plain data in, plain data out.
 */

export const BOOTSTRAP_ITERATIONS = 5000;
export const BOOTSTRAP_SEED = 42;
/** With fewer tasks, the bootstrap has too little to resample and its interval is meaningless. */
export const MIN_TASKS_FOR_CI = 2;

export interface StatRun {
  taskId: string;
  configId: string;
  status: RunStatus;
  passed: boolean | null;
  durationMs: number | null;
  costUsd: number | null;
  judgeCostUsd: number | null;
}

export interface SummaryInput {
  experimentId: string;
  status: ExperimentSummary['status'];
  configA: { id: string; name: string };
  configB: { id: string; name: string };
  tasks: { id: string; name: string }[];
  runs: StatRun[];
  iterations?: number;
  seed?: number;
}

/** Scored-run counts for one task, per config. The unit the bootstrap resamples. */
interface TaskCluster {
  aPassed: number;
  aScored: number;
  bPassed: number;
  bScored: number;
}

export function summarize(input: SummaryInput): ExperimentSummary {
  const { configA, configB, runs } = input;
  const iterations = input.iterations ?? BOOTSTRAP_ITERATIONS;
  const seed = input.seed ?? BOOTSTRAP_SEED;

  const tasks: TaskStats[] = input.tasks.map((t) => {
    const forTask = runs.filter((r) => r.taskId === t.id);
    return {
      taskId: t.id,
      taskName: t.name,
      a: passCounts(forTask.filter((r) => r.configId === configA.id)),
      b: passCounts(forTask.filter((r) => r.configId === configB.id)),
    };
  });

  // Only tasks with scored runs on BOTH sides are compared, so the comparison stays paired.
  const clusters: TaskCluster[] = tasks
    .filter((t) => t.a.scored > 0 && t.b.scored > 0)
    .map((t) => ({ aPassed: t.a.passed, aScored: t.a.scored, bPassed: t.b.passed, bScored: t.b.scored }));

  const difference = clusters.length > 0 ? diff(clusters) : null;
  const ci95 = clusters.length >= MIN_TASKS_FOR_CI ? bootstrapCi(clusters, iterations, seed) : null;
  const verdict = decide(ci95);

  return {
    experimentId: input.experimentId,
    status: input.status,
    configA: configStats(configA, runs),
    configB: configStats(configB, runs),
    tasks,
    comparison: {
      tasksUsed: clusters.length,
      difference,
      ci95,
      iterations,
      seed,
      verdict,
      explanation: explain(verdict, difference, ci95, clusters.length),
    },
  };
}

/**
 * Paired cluster bootstrap over tasks: each iteration draws tasks with replacement,
 * keeps all of each drawn task's runs for both configs, and recomputes passRate(B) - passRate(A).
 */
export function bootstrapCi(
  clusters: TaskCluster[],
  iterations: number,
  seed: number,
): { low: number; high: number } {
  const rand = mulberry32(seed);
  const n = clusters.length;
  const diffs = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let aPassed = 0, aScored = 0, bPassed = 0, bScored = 0;
    for (let j = 0; j < n; j++) {
      const c = clusters[Math.floor(rand() * n)];
      aPassed += c.aPassed;
      aScored += c.aScored;
      bPassed += c.bPassed;
      bScored += c.bScored;
    }
    diffs[i] = bPassed / bScored - aPassed / aScored;
  }
  diffs.sort();
  return { low: percentile(diffs, 0.025), high: percentile(diffs, 0.975) };
}

/** Pooled difference: all scored runs of the given tasks, B rate minus A rate. */
function diff(clusters: TaskCluster[]): number {
  const sum = (k: keyof TaskCluster) => clusters.reduce((s, c) => s + c[k], 0);
  return sum('bPassed') / sum('bScored') - sum('aPassed') / sum('aScored');
}

/** Linear interpolation between the two nearest ranks. `sorted` must be ascending. */
function percentile(sorted: Float64Array, p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function decide(ci: { low: number; high: number } | null): Verdict {
  if (!ci) return 'inconclusive';
  if (ci.low > 0) return 'better';
  if (ci.high < 0) return 'worse';
  return 'inconclusive';
}

function explain(
  verdict: Verdict,
  difference: number | null,
  ci: { low: number; high: number } | null,
  tasksUsed: number,
): string {
  if (difference === null || !ci) {
    return tasksUsed === 0
      ? 'No task has scored runs for both configs yet, so there is nothing to compare.'
      : `Only ${tasksUsed} task has scored runs for both configs; at least ${MIN_TASKS_FOR_CI} are needed for a confidence interval.`;
  }
  const range = `95% CI ${points(ci.low)} to ${points(ci.high)} points`;
  if (verdict === 'better') {
    return `B passes ${points(difference)} points more often than A (${range}); the whole interval is above zero, so B is better on these tasks.`;
  }
  if (verdict === 'worse') {
    return `B passes ${points(-difference)} points less often than A (${range}); the whole interval is below zero, so B is worse on these tasks.`;
  }
  return `B differs from A by ${points(difference, true)} points, but the ${range} includes zero, so we cannot tell which is better; add tasks or repeats to narrow it.`;
}

/** 0.123 -> "12.3"; signed adds "+" for positive values. */
function points(fraction: number, signed = false): string {
  const v = Math.round(fraction * 1000) / 10;
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function passCounts(runs: StatRun[]) {
  const scored = runs.filter((r) => r.passed !== null);
  const passed = scored.filter((r) => r.passed).length;
  return { scored: scored.length, passed, passRate: scored.length ? passed / scored.length : null };
}

function configStats(config: { id: string; name: string }, allRuns: StatRun[]): ConfigStats {
  const runs = allRuns.filter((r) => r.configId === config.id);
  const { scored, passed, passRate } = passCounts(runs);
  const timed = runs.filter((r) => r.durationMs !== null);
  const agentCostUsd = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const judgeCostUsd = runs.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0);
  return {
    configId: config.id,
    configName: config.name,
    runs: runs.length,
    scored,
    passed,
    errors: runs.filter((r) => r.status === 'error').length,
    pending: runs.filter((r) => r.status === 'queued' || r.status === 'running').length,
    passRate,
    avgDurationMs: timed.length ? timed.reduce((s, r) => s + (r.durationMs ?? 0), 0) / timed.length : null,
    agentCostUsd,
    judgeCostUsd,
    totalCostUsd: agentCostUsd + judgeCostUsd,
  };
}
