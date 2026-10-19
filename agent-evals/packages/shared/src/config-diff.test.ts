import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from './index.js';
import { diffConfigs, formatConfigValue } from './config-diff.js';

const base: AgentConfig = {
  id: 'a',
  name: 'A',
  model: 'deepseek/deepseek-v4-flash-0731',
  provider: 'openrouter',
  toolsets: ['file'],
  skills: [],
  maxTurns: 10,
  runBudgetSec: 120,
};

test('identical configs (apart from id, name and mockPassRate) have no differences', () => {
  assert.deepEqual(diffConfigs(base, { ...base, id: 'b', name: 'B', mockPassRate: 0.9 }), []);
});

test('one changed field is reported with readable before/after values', () => {
  assert.deepEqual(diffConfigs(base, { ...base, skills: ['careful-data-check'] }), [
    { field: 'skills', label: 'Skills', a: 'none', b: 'careful-data-check' },
  ]);
  assert.deepEqual(diffConfigs(base, { ...base, memoryFiles: ['memory/sales-policy.md'] }), [
    { field: 'memoryFiles', label: 'Memory', a: 'none', b: 'memory/sales-policy.md' },
  ]);
});

test('several changes are all reported, in display order', () => {
  const other = { ...base, model: 'anthropic/claude-sonnet-5.5', runBudgetSec: 60, skills: ['x'] };
  assert.deepEqual(
    diffConfigs(base, other).map((d) => d.field),
    ['model', 'skills', 'runBudgetSec'],
  );
});

test('a missing memoryFiles is the same as an empty one, and list order does not matter', () => {
  assert.deepEqual(diffConfigs(base, { ...base, memoryFiles: [] }), []);
  assert.deepEqual(diffConfigs({ ...base, skills: ['a', 'b'] }, { ...base, skills: ['b', 'a'] }), []);
  assert.equal(formatConfigValue({ ...base, toolsets: ['web', 'file'] }, 'toolsets'), 'file, web');
  assert.equal(formatConfigValue(base, 'runBudgetSec'), '120 s');
});
