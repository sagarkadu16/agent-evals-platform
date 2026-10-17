import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig, TaskDef } from '@evals/shared';
import { MockRunner } from './mock-runner.js';

const task: TaskDef = {
  id: 'math-mult',
  name: 'Simple multiplication',
  prompt: 'What is 17 * 23?',
  scorerType: 'regex',
  scorerSpec: { pattern: '^391$' },
  referenceAnswer: '391',
};

const config = (mockPassRate?: number): AgentConfig => ({
  id: 'c',
  name: 'c',
  model: 'm',
  provider: 'p',
  toolsets: [],
  skills: [],
  maxTurns: 1,
  runBudgetSec: 10,
  mockPassRate,
});

const runner = new MockRunner();
const run = (runId: string, rate?: number) =>
  runner.run({ runId, task, config: config(rate), workDir: '/tmp/unused' });

test('same runId gives the same result', async () => {
  const a = await run('run-123');
  const b = await run('run-123');
  assert.equal(a.finalAnswer, b.finalAnswer);
  assert.deepEqual(a.tokens, b.tokens);
  assert.deepEqual(
    a.steps.map((s) => [s.kind, s.content]),
    b.steps.map((s) => [s.kind, s.content]),
  );
});

test('result shape: 2-4 steps ending in a model step, cost 0, no error', async () => {
  const r = await run('run-shape');
  assert.ok(r.steps.length >= 2 && r.steps.length <= 4);
  assert.equal(r.steps.at(-1)?.kind, 'model');
  assert.equal(r.steps.at(-1)?.content, r.finalAnswer);
  assert.equal(r.costUsd, 0);
  assert.ok(r.tokens.input > 0 && r.tokens.output > 0);
  assert.equal(r.error, undefined);
});

test('mockPassRate 1 always passes, 0 never passes', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await run(`p-${i}`, 1)).finalAnswer, '391');
    assert.notEqual((await run(`f-${i}`, 0)).finalAnswer, '391');
  }
});

test('default pass rate is roughly 0.7', async () => {
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => run(`r-${i}`)));
  const rate = results.filter((r) => r.finalAnswer === '391').length / results.length;
  assert.ok(rate > 0.6 && rate < 0.8, `pass rate was ${rate}`);
});
