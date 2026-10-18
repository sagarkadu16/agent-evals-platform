import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult, TaskDef } from '@evals/shared';
import { RegexScorer } from './regex-scorer.js';

const task = (scorerSpec: Record<string, unknown>): TaskDef => ({
  id: 't',
  name: 't',
  prompt: 'p',
  scorerType: 'regex',
  scorerSpec,
});
const answer = (finalAnswer: string): RunResult => ({
  finalAnswer,
  steps: [],
  tokens: { input: 0, output: 0 },
  costUsd: 0,
});
const scorer = new RegexScorer();

test('match: answer is trimmed before testing', async () => {
  assert.deepEqual(await scorer.score(task({ pattern: '^391$' }), answer('  391\n')), {
    passed: true,
    reason: 'matched /^391$/',
  });
});

test('flags from the spec are applied', async () => {
  const r = await scorer.score(task({ pattern: '^yes$', flags: 'i' }), answer('YES'));
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'matched /^yes$/i');
});

test('no match: reason shows the first 100 chars of the answer', async () => {
  const long = 'x'.repeat(150);
  const r = await scorer.score(task({ pattern: '^391$' }), answer(long));
  assert.equal(r.passed, false);
  assert.equal(r.reason, `no match for /^391$/; got: ${'x'.repeat(100)}`);
});

test('empty answer fails with a clear reason', async () => {
  const r = await scorer.score(task({ pattern: '^391$' }), answer('   '));
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'no match for /^391$/; got: (empty answer)');
});

test('invalid regex in the spec: unscored (null), not failed, and no throw', async () => {
  const r = await scorer.score(task({ pattern: '([' }), answer('391'));
  assert.equal(r.passed, null);
  assert.match(r.reason, /^scorer spec error: /);
});

test('missing pattern: unscored (null)', async () => {
  const r = await scorer.score(task({}), answer('391'));
  assert.equal(r.passed, null);
});
