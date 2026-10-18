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

test('identical results: difference 0, CI contains 0, inconclusive', () => {
  const s = summarize(input(runs((i, _c, r) => (i + r) % 2 === 0)));
  assert.equal(s.comparison.difference, 0);
  assert.ok(s.comparison.ci95!.low <= 0 && s.comparison.ci95!.high >= 0);
  assert.equal(s.comparison.verdict, 'inconclusive');
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

test('fewer than 2 comparable tasks: no CI, inconclusive', () => {
  const s = summarize(input([run('t1', 'A', false), run('t1', 'B', true)]));
  assert.equal(s.comparison.difference, 1);
  assert.equal(s.comparison.ci95, null);
  assert.equal(s.comparison.verdict, 'inconclusive');
});
