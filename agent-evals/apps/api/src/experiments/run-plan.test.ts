import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunPlan, TimeoutError, withTimeout } from './run-plan.js';

test('plan has one run per task x config x repeat, alternating A and B', () => {
  const plan = buildRunPlan(['t1', 't2'], 'A', 'B', 3);
  assert.equal(plan.length, 2 * 2 * 3);
  assert.deepEqual(
    plan.map((p) => p.configId),
    ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
  );
  // Every task finishes repeat 0 before repeat 1 starts.
  assert.deepEqual(
    plan.map((p) => p.repeatIndex),
    [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2],
  );
});

test('withTimeout returns the result when work is fast', async () => {
  assert.equal(await withTimeout(async () => 'ok', 1000), 'ok');
});

test('withTimeout rejects with TimeoutError and aborts the signal when work is slow', async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => (aborted = true));
          setTimeout(resolve, 500);
        }),
      50,
    ),
    TimeoutError,
  );
  assert.equal(aborted, true);
});
