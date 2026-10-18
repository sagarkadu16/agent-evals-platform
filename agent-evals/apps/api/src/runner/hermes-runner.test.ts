import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, TaskDef } from '@evals/shared';
import { HermesRunner } from './hermes-runner.js';

// A fake `hermes` executable: no network, no money. Behaviour is chosen by FAKE_HERMES_MODE.
const fixturePath = fileURLToPath(new URL('../../../../fixtures/sample-session.jsonl', import.meta.url));
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_HERMES_MODE;
if (args[0] === 'chat') {
  fs.writeFileSync(path.join(process.cwd(), 'args.json'), JSON.stringify(args));
  if (mode === 'hang') { setTimeout(() => {}, 60000); return; }
  process.stderr.write('session_id: fixture-session-001\\n');
  if (mode === 'fail') { process.stderr.write('boom key=' + process.env.OPENROUTER_API_KEY + '\\n'); process.exit(2); }
  process.stdout.write('391\\n');
} else if (args[0] === 'sessions' && args[1] === 'export') {
  fs.copyFileSync(${JSON.stringify(fixturePath)}, path.join(args[4], 'session.jsonl'));
}
`;

const tmp = mkdtempSync(join(tmpdir(), 'evals-hermes-'));
const task: TaskDef = {
  id: 't',
  name: 't',
  prompt: 'What is 17 * 23?',
  scorerType: 'regex',
  scorerSpec: {},
};
const config: AgentConfig = {
  id: 'c',
  name: 'c',
  model: 'm/x',
  provider: 'openrouter',
  toolsets: ['file'],
  skills: [],
  maxTurns: 5,
  runBudgetSec: 60,
};

let n = 0;
function workDir() {
  const dir = join(tmp, `run-${n++}`);
  mkdirSync(dir);
  return dir;
}

before(() => {
  const bin = join(tmp, 'hermes');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  process.env.HERMES_BIN = bin;
  process.env.OPENROUTER_API_KEY = 'sk-test-secret';
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('happy path: answer from stdout, steps/tokens/cost from export, prompt in a file', async () => {
  const dir = workDir();
  const r = await new HermesRunner().run({ runId: 'r', task, config, workDir: dir });
  assert.equal(r.error, undefined);
  assert.equal(r.finalAnswer, '391');
  assert.equal(r.sessionId, 'fixture-session-001');
  assert.equal(r.steps.length, 5);
  assert.deepEqual(r.tokens, { input: 7447, output: 79 });
  assert.equal(r.costUsd, 0.00018);
  assert.equal(readFileSync(join(dir, 'prompt.txt'), 'utf8'), task.prompt);
  const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
  assert.ok(!args.join(' ').includes('sk-test-secret'), 'key must not be in args');
});

test('non-zero exit becomes an error, key is masked, tokens still recorded', async () => {
  process.env.FAKE_HERMES_MODE = 'fail';
  try {
    const r = await new HermesRunner().run({ runId: 'r', task, config, workDir: workDir() });
    assert.match(r.error ?? '', /exited with code 2/);
    assert.ok(!r.error?.includes('sk-test-secret'));
    assert.deepEqual(r.tokens, { input: 7447, output: 79 });
  } finally {
    delete process.env.FAKE_HERMES_MODE;
  }
});

test('abort signal kills a hanging hermes and returns an error', async () => {
  process.env.FAKE_HERMES_MODE = 'hang';
  try {
    const signal = AbortSignal.timeout(300);
    const started = Date.now();
    const r = await new HermesRunner().run({ runId: 'r', task, config, workDir: workDir(), signal });
    assert.match(r.error ?? '', /stopped/);
    assert.ok(Date.now() - started < 5000);
  } finally {
    delete process.env.FAKE_HERMES_MODE;
  }
});

test('missing key fails fast without spawning hermes', async () => {
  const key = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const r = await new HermesRunner().run({ runId: 'r', task, config, workDir: workDir() });
    assert.equal(r.error, 'OPENROUTER_API_KEY is not set');
  } finally {
    process.env.OPENROUTER_API_KEY = key;
  }
});
