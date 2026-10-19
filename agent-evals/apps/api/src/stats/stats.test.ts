import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type StatRun, type SummaryInput } from './stats.js';

const A = { id: 'A', name: 'Config A' };
const B = { id: 'B', name: 'Config B' };
const taskIds = ['t1', 't2', 't3', 't4', 't5'];

function run(taskId: string, configId: string, passed: boolean | null, extra: Partial<StatRun> = {}): StatRun {
  return {
    taskId,
    configId,
    status: 'done',
    passed,
    durationMs: 1000,
    costUsd: 0.01,
    judgeCostUsd: 0.001,
    ...extra,
  };
}

function input(runs: StatRun[], extra: Partial<SummaryInput> = {}): SummaryInput {
  return {
    experimentId: 'e',
    status: 'done',
    configA: A,
    configB: B,
    tasks: taskIds.map((id) => ({ id, name: id })),
    runs,
    ...extra,
  };
}

/** 3 repeats per task per config; pass pattern chosen per (task, config). */
function runs(pass: (taskIndex: number, config: 'A' | 'B', repeat: number) => boolean): StatRun[] {
  return taskIds.flatMap((t, i) =>
    [0, 1, 2].flatMap((r) => [run(t, 'A', pass(i, 'A', r)), run(t, 'B', pass(i, 'B', r))]),
  );
}

test('identical results: difference 0, CI contains 0, and the reason is "no difference", not just inconclusive', () => {
  const s = summarize(input(runs((i, _c, r) => (i + r) % 2 === 0)));
  assert.equal(s.comparison.difference, 0);
  assert.ok(s.comparison.ci95!.low <= 0 && s.comparison.ci95!.high >= 0);
  assert.equal(s.comparison.verdict, 'inconclusive');
  assert.equal(s.comparison.reason, 'no-difference');
  assert.match(s.comparison.explanation, /exactly as often on every one of the 5 tasks/);
});

test('a real but unreliable difference: reason "ci-includes-zero"', () => {
  // B passes one more run on t1 and t2 only.
  const s = summarize(input(runs((i, c, r) => r === 0 || (c === 'B' && i < 2 && r === 1))));
  assert.equal(s.comparison.reason, 'ci-includes-zero');
  assert.match(s.comparison.explanation, /includes zero/);
});

test('B all pass, A all fail: B better', () => {
  const s = summarize(input(runs((_i, c) => c === 'B')));
  assert.equal(s.comparison.difference, 1);
  assert.ok(s.comparison.ci95!.low > 0);
  assert.equal(s.comparison.verdict, 'better');
  assert.match(s.comparison.explanation, /B passes 100\.0 points more often/);
});

test('A all pass, B all fail: B worse', () => {
  const s = summarize(input(runs((_i, c) => c === 'A')));
  assert.equal(s.comparison.verdict, 'worse');
});

test('same seed gives the same CI', () => {
  // Mixed results so the bootstrap distribution actually has spread.
  const data = runs((i, c, r) => (c === 'B' ? i !== 0 || r === 0 : i % 2 === 0));
  const one = summarize(input(data)).comparison.ci95;
  const two = summarize(input(data)).comparison.ci95;
  assert.deepEqual(one, two);
  assert.ok(one!.low < one!.high, 'expected a non-zero-width interval');
});

test('a task with only errors is skipped from the comparison but still listed', () => {
  const data = [
    ...runs((_i, c) => c === 'B').filter((r) => r.taskId !== 't5'),
    run('t5', 'A', null, { status: 'error', costUsd: null }),
    run('t5', 'B', null, { status: 'error', costUsd: null }),
  ];
  const s = summarize(input(data));
  assert.equal(s.comparison.tasksUsed, 4);
  assert.equal(s.comparison.difference, 1);
  const t5 = s.tasks.find((t) => t.taskId === 't5')!;
  assert.equal(t5.a.passRate, null);
  assert.equal(t5.b.scored, 0);
  assert.equal(s.configA.errors, 1);
});

test('per-config counts: errors and judge errors are not scored; cost = agent + judge', () => {
  const data = [
    run('t1', 'A', true),
    run('t1', 'A', false),
    run('t1', 'A', null, { status: 'error', costUsd: 0.02, judgeCostUsd: null }), // runner error
    run('t1', 'A', null), // judge error: done but unscored
    run('t1', 'A', null, { status: 'queued', durationMs: null, costUsd: null, judgeCostUsd: null }),
  ];
  const a = summarize(input(data)).configA;
  assert.equal(a.runs, 5);
  assert.equal(a.scored, 2);
  assert.equal(a.passed, 1);
  assert.equal(a.passRate, 0.5);
  assert.equal(a.errors, 1);
  assert.equal(a.pending, 1);
  assert.equal(a.avgDurationMs, 1000);
  assert.ok(Math.abs(a.totalCostUsd - (0.01 * 3 + 0.02 + 0.001 * 3)) < 1e-12);
});

test('fewer than 2 comparable tasks: no CI, inconclusive, and it says why', () => {
  const s = summarize(input([run('t1', 'A', false), run('t1', 'B', true)]));
  assert.equal(s.comparison.difference, 1);
  assert.equal(s.comparison.ci95, null);
  assert.equal(s.comparison.verdict, 'inconclusive');
  assert.equal(s.comparison.reason, 'too-few-tasks');
  assert.match(s.comparison.explanation, /B passes 100\.0 points more often than A on 1 task\. .*at least 2 tasks/);
});

// --- Speed and cost: B / A ratios with a CI from resampling runs within each task ---

/** One task, 5 runs per side, with given durations (ms) and agent costs (USD). */
function oneTask(aMs: number[], bMs: number[], aCost = 0.002, bCost = 0.02): SummaryInput {
  const make = (configId: string, ms: number[], costUsd: number) =>
    ms.map((durationMs) => run('t1', configId, true, { durationMs, costUsd }));
  return input([...make('A', aMs, aCost), ...make('B', bMs, bCost)], { tasks: [{ id: 't1', name: 't1' }] });
}

test('one task is enough for speed and cost: B clearly faster and pricier gets a CI and a verdict', () => {
  const s = summarize(oneTask([30_000, 31_000, 29_000, 32_000, 30_500], [15_000, 16_000, 14_500, 15_500, 15_200]));
  assert.equal(s.comparison.reason, 'too-few-tasks', 'quality still needs 2 tasks');
  assert.equal(s.speed.statistic, 'median');
  assert.equal(s.speed.a, 30_500);
  assert.equal(s.speed.b, 15_200);
  assert.equal(s.speed.verdict, 'lower');
  assert.ok(s.speed.ci95!.high < 1);
  assert.equal(s.cost.ratio, 10);
  assert.equal(s.cost.verdict, 'higher');
  assert.equal(s.headline, 'Same pass rate; B is 2.0× faster and 10× more expensive.');
});

test('overlapping run times: "about as fast", not a false speed claim', () => {
  const s = summarize(oneTask([10_000, 30_000, 12_000, 28_000, 20_000], [11_000, 29_000, 13_000, 27_000, 19_000]));
  assert.equal(s.speed.verdict, 'similar');
  assert.ok(s.speed.ci95!.low < 1 && s.speed.ci95!.high > 1);
  assert.match(s.headline, /B is about as fast/);
});

test('speed uses the median, so one very slow run does not swing it', () => {
  const s = summarize(oneTask([20_000, 20_000, 20_000, 20_000, 200_000], [20_000, 20_000, 20_000, 20_000, 20_000]));
  assert.equal(s.speed.a, 20_000);
  assert.equal(s.speed.ratio, 1);
});

test('errored runs are left out of speed and cost', () => {
  const base = oneTask([1000, 1000], [1000, 1000]);
  base.runs.push(run('t1', 'B', null, { status: 'error', durationMs: 150_000, costUsd: 1 }));
  const s = summarize(base);
  assert.equal(s.speed.runsB, 2);
  assert.equal(s.speed.b, 1000);
});

test('free runs (mock, cost 0): no cost ratio, and the headline leaves cost out', () => {
  const s = summarize(oneTask([1000, 1100, 900], [2000, 2100, 1900], 0, 0));
  assert.equal(s.cost.ratio, null);
  assert.equal(s.cost.verdict, null);
  assert.equal(s.headline, 'Same pass rate; B is 2.0× slower.');
});

test('cost per passed run divides agent cost by passes', () => {
  const s = summarize(input([run('t1', 'A', true), run('t1', 'A', false), run('t1', 'B', true), run('t1', 'B', true)]));
  assert.equal(s.cost.perPassA, 0.02);
  assert.equal(s.cost.perPassB, 0.01);
});
