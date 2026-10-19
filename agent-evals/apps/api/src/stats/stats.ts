import type {
  ConfigStats,
  ExperimentSummary,
  MetricComparison,
  QualityReason,
  RunStatus,
  TaskStats,
  Verdict,
} from '@evals/shared';
import { mulberry32 } from '../common/random.js';

/**
 * Pure statistics for an A/B experiment. No Nest, no DB: plain data in, plain data out.
 */

export const BOOTSTRAP_ITERATIONS = 5000;
export const BOOTSTRAP_SEED = 42;
/** With fewer tasks, the bootstrap has too little to resample and its interval is meaningless. */
export const MIN_TASKS_FOR_CI = 2;
/** Speed and cost CIs resample runs, so they need at least this many finished runs per config. */
export const MIN_RUNS_FOR_METRIC_CI = 2;

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
  const reason = qualityReason(clusters, ci95);

  // Speed and cost: finished runs only (an errored run's time and cost say nothing about the config).
  const taskIds = input.tasks.map((t) => t.id);
  const durations = metricGroups(taskIds, input, (r) => r.durationMs);
  const costs = metricGroups(taskIds, input, (r) => r.costUsd);
  const speed = compareMetric(durations, 'median', iterations, seed);
  const cost = compareMetric(costs, 'mean', iterations, seed);
  const statsA = configStats(configA, runs);
  const statsB = configStats(configB, runs);
  const perPass = (s: ConfigStats) => (s.passed > 0 ? s.agentCostUsd / s.passed : null);

  return {
    experimentId: input.experimentId,
    status: input.status,
    configA: statsA,
    configB: statsB,
    tasks,
    comparison: {
      tasksUsed: clusters.length,
      difference,
      ci95,
      iterations,
      seed,
      verdict,
      reason,
      explanation: explain(reason, difference, ci95, clusters.length),
    },
    speed,
    cost: { ...cost, perPassA: perPass(statsA), perPassB: perPass(statsB) },
    headline: headline(reason, difference, speed, cost),
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

/** Per-run values of one metric, grouped by task: only tasks with values on both sides, so it stays paired. */
interface MetricGroup {
  a: number[];
  b: number[];
}

function metricGroups(taskIds: string[], input: SummaryInput, pick: (r: StatRun) => number | null): MetricGroup[] {
  const values = (taskId: string, configId: string) =>
    input.runs
      .filter((r) => r.taskId === taskId && r.configId === configId && r.status === 'done')
      .map(pick)
      .filter((v): v is number => v !== null);
  return taskIds
    .map((t) => ({ a: values(t, input.configA.id), b: values(t, input.configB.id) }))
    .filter((g) => g.a.length > 0 && g.b.length > 0);
}

/**
 * B / A for a per-run metric, with a stratified bootstrap CI: each iteration resamples runs with
 * replacement *within each task and config*, so the task mix stays fixed and only run-to-run noise
 * (the main source of variation in time and cost) is measured. Works even for a single task.
 */
export function compareMetric(
  groups: MetricGroup[],
  statistic: 'median' | 'mean',
  iterations: number,
  seed: number,
): MetricComparison {
  const stat = statistic === 'median' ? median : mean;
  const allA = groups.flatMap((g) => g.a);
  const allB = groups.flatMap((g) => g.b);
  const a = allA.length ? stat(allA) : null;
  const b = allB.length ? stat(allB) : null;
  const ratio = a !== null && b !== null && a > 0 ? b / a : null;

  let ci95: { low: number; high: number } | null = null;
  if (ratio !== null && allA.length >= MIN_RUNS_FOR_METRIC_CI && allB.length >= MIN_RUNS_FOR_METRIC_CI) {
    const rand = mulberry32(seed);
    const draw = (xs: number[]) => xs[Math.floor(rand() * xs.length)];
    const ratios: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ra = groups.flatMap((g) => g.a.map(() => draw(g.a)));
      const rb = groups.flatMap((g) => g.b.map(() => draw(g.b)));
      const sa = stat(ra);
      if (sa > 0) ratios.push(stat(rb) / sa);
    }
    const sorted = Float64Array.from(ratios).sort();
    if (sorted.length) ci95 = { low: percentile(sorted, 0.025), high: percentile(sorted, 0.975) };
  }

  const verdict = !ci95 ? null : ci95.high < 1 ? 'lower' : ci95.low > 1 ? 'higher' : 'similar';
  return { statistic, a, b, ratio, ci95, verdict, runsA: allA.length, runsB: allB.length };
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

function qualityReason(clusters: TaskCluster[], ci: { low: number; high: number } | null): QualityReason {
  if (clusters.length === 0) return 'no-data';
  const sameEverywhere = clusters.every((c) => c.aPassed / c.aScored === c.bPassed / c.bScored);
  if (sameEverywhere) return clusters.length < MIN_TASKS_FOR_CI ? 'too-few-tasks' : 'no-difference';
  if (!ci) return 'too-few-tasks';
  if (ci.low > 0) return 'ci-above-zero';
  if (ci.high < 0) return 'ci-below-zero';
  return 'ci-includes-zero';
}

function decide(ci: { low: number; high: number } | null): Verdict {
  if (!ci) return 'inconclusive';
  if (ci.low > 0) return 'better';
  if (ci.high < 0) return 'worse';
  return 'inconclusive';
}

function explain(
  reason: QualityReason,
  difference: number | null,
  ci: { low: number; high: number } | null,
  tasksUsed: number,
): string {
  if (reason === 'no-data' || difference === null) {
    return 'No task has scored runs for both configs yet, so there is nothing to compare.';
  }
  const gap =
    difference === 0
      ? 'A and B pass equally often'
      : `B passes ${points(Math.abs(difference))} points ${difference > 0 ? 'more' : 'less'} often than A`;
  if (reason === 'too-few-tasks') {
    return `${gap} on ${tasksUsed} task. A confidence interval needs at least ${MIN_TASKS_FOR_CI} tasks, so this cannot be generalised beyond it; add tasks to get a verdict.`;
  }
  if (reason === 'no-difference') {
    return `A and B pass exactly as often on every one of the ${tasksUsed} tasks, so there is no difference in quality.`;
  }
  const range = `95% CI ${points(ci!.low)} to ${points(ci!.high)} points`;
  if (reason === 'ci-above-zero') {
    return `${gap} (${range}); the whole interval is above zero, so B is better on these tasks.`;
  }
  if (reason === 'ci-below-zero') {
    return `${gap} (${range}); the whole interval is below zero, so B is worse on these tasks.`;
  }
  return `B differs from A by ${points(difference, true)} points, but the ${range} includes zero, so we cannot tell which is better; add tasks or repeats to narrow it.`;
}

/** e.g. "Same pass rate; B is 1.6× faster and 17× more expensive." */
function headline(
  reason: QualityReason,
  difference: number | null,
  speed: MetricComparison,
  cost: MetricComparison,
): string {
  if (reason === 'no-data' || difference === null) return 'Nothing to compare yet.';
  const quality =
    reason === 'ci-above-zero'
      ? `B passes ${points(difference)} points more often`
      : reason === 'ci-below-zero'
        ? `B passes ${points(-difference)} points less often`
        : difference === 0
          ? 'Same pass rate'
          : `No reliable difference in pass rate (${points(difference, true)} points)`;
  const speedPart = describeRatio(speed, ['faster', 'slower', 'about as fast']);
  const costPart = describeRatio(cost, ['cheaper', 'more expensive', 'about as expensive']);
  const parts = [speedPart, costPart].filter(Boolean);
  return parts.length ? `${quality}; B is ${parts.join(' and ')}.` : `${quality}.`;
}

/** "1.6× faster" / "17× more expensive" / "about as fast"; empty when there is no CI. */
export function describeRatio(m: MetricComparison, [lower, higher, similar]: [string, string, string]): string {
  if (m.verdict === null || m.ratio === null) return '';
  if (m.verdict === 'similar') return similar;
  return `${factor(m.verdict === 'lower' ? 1 / m.ratio : m.ratio)} ${m.verdict === 'lower' ? lower : higher}`;
}

/** 1.63 -> "1.6×", 17.4 -> "17×". */
export function factor(x: number): string {
  return `${x < 10 ? x.toFixed(1) : Math.round(x)}×`;
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
