import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentConfig } from '@evals/shared';
import { buildChatArgs, parseSessionId, parseSessionJsonl } from './hermes-session.js';

// Compiled to apps/api/dist/runner/, so the repo root is four levels up.
const fixture = readFileSync(new URL('../../../../fixtures/sample-session.jsonl', import.meta.url), 'utf8');

test('fixture: session totals come from line 1', () => {
  const s = parseSessionJsonl(fixture);
  assert.equal(s.sessionId, 'fixture-session-001');
  assert.deepEqual(s.tokens, { input: 7447, output: 79 });
  assert.equal(s.costUsd, 0.00018);
});

test('fixture: messages map to tool / result / model steps, user skipped', () => {
  const { steps } = parseSessionJsonl(fixture);
  assert.deepEqual(
    steps.map((s) => [s.index, s.kind, s.toolName]),
    [
      [0, 'tool', 'write_file'],
      [1, 'result', 'write_file'],
      [2, 'tool', 'read_file'],
      [3, 'result', 'read_file'],
      [4, 'model', undefined],
    ],
  );
  // tool_calls arguments and tool content are JSON strings: parsed, then shown indented.
  assert.deepEqual(JSON.parse(steps[0].content), { path: 'answer.txt', content: '391' });
  assert.deepEqual(JSON.parse(steps[3].content), { ok: true, content: '391' });
  assert.equal(steps[4].content, '391');
  // Seconds -> milliseconds.
  assert.equal(steps[0].timestampMs, 1792250001200);
});

// A trimmed real export (one JSON object with a messages array; local paths replaced by /work/run).
const realFixture = readFileSync(new URL('../../../../fixtures/sample-session-real.jsonl', import.meta.url), 'utf8');

test('real export: messages nested in one object, tool_calls as an array', () => {
  const s = parseSessionJsonl(realFixture);
  assert.ok(s.sessionId);
  assert.deepEqual(
    s.steps.map((x) => [x.index, x.kind, x.toolName]),
    [
      [0, 'tool', 'search_files'],
      [1, 'result', 'search_files'],
      [2, 'tool', 'read_file'],
      [3, 'result', 'read_file'],
      [4, 'model', undefined],
    ],
  );
  assert.equal(s.steps[4].content, '1287.45');
  assert.ok(JSON.parse(s.steps[2].content).path.endsWith('orders.csv'));
  assert.ok(s.steps.every((x) => typeof x.timestampMs === 'number' && x.timestampMs > 1e12));
});

test('real export: input tokens include cache reads and writes', () => {
  const s = parseSessionJsonl(realFixture);
  assert.deepEqual(s.tokens, { input: 3214 + 10752 + 0, output: 239 });
  assert.equal(s.costUsd, 0.0001759834);
});

test('bad lines are skipped, bad tool_calls kept as raw text', () => {
  const text = [
    '{"id":"s1","input_tokens":5,"output_tokens":2,"estimated_cost_usd":null}',
    'not json at all',
    '{"role":"assistant","tool_calls":"[broken","timestamp":1}',
    '{"role":"tool","tool_name":"read_file","content":"plain text, not JSON","timestamp":2}',
    '{"role":"assistant","content":"done","finish_reason":"stop","timestamp":3}',
    '',
  ].join('\n');
  const s = parseSessionJsonl(text);
  assert.equal(s.costUsd, null);
  assert.deepEqual(
    s.steps.map((x) => [x.kind, x.content]),
    [
      ['tool', '[broken'],
      ['result', 'plain text, not JSON'],
      ['model', 'done'],
    ],
  );
});

test('empty export gives zero tokens and no steps', () => {
  assert.deepEqual(parseSessionJsonl(''), {
    sessionId: null,
    tokens: { input: 0, output: 0 },
    costUsd: null,
    steps: [],
  });
});

test('session_id is read from stderr', () => {
  assert.equal(parseSessionId('loading...\nsession_id: abc-123\nbye'), 'abc-123');
  assert.equal(parseSessionId('no id here'), null);
});

test('chat args: -s only when skills are set, never -q', () => {
  const config: AgentConfig = {
    id: 'c',
    name: 'c',
    model: 'm/x',
    provider: 'openrouter',
    toolsets: ['file', 'web'],
    skills: [],
    maxTurns: 10,
    runBudgetSec: 120,
  };
  const args = buildChatArgs(config, '/w/prompt.txt', '/w');
  assert.ok(!args.includes('-s') && !args.includes('-q'));
  assert.deepEqual(args.slice(0, 3), ['chat', '--query-file', '/w/prompt.txt']);
  assert.equal(args[args.indexOf('-t') + 1], 'file,web');
  assert.equal(args[args.indexOf('--run-budget') + 1], '120');

  const withSkills = buildChatArgs({ ...config, skills: ['a', 'b'] }, '/w/prompt.txt', '/w');
  assert.deepEqual(withSkills.slice(-2), ['-s', 'a,b']);
});
