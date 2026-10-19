import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const home = process.env.HERMES_HOME;
if (args[0] === 'sessions' && args[1] === 'list') {
  // Preparing a base home: real Hermes installs its dependencies into installs/.
  if (mode === 'base-fail') { process.stderr.write('no network'); process.exit(1); }
  fs.mkdirSync(path.join(home, 'installs'), { recursive: true });
  fs.appendFileSync(path.join(home, 'prepared.count'), 'x');
} else if (args[0] === 'chat') {
  fs.writeFileSync(path.join(process.cwd(), 'args.json'), JSON.stringify(args));
  const skillsDir = path.join(home, 'skills');
  fs.writeFileSync(path.join(process.cwd(), 'home.json'), JSON.stringify({
    home,
    skills: fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [],
    memory: fs.existsSync(path.join(home, 'memories', 'MEMORY.md'))
      ? fs.readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8')
      : null,
    installsIsLink: fs.lstatSync(path.join(home, 'installs')).isSymbolicLink(),
    soul: fs.existsSync(path.join(home, 'SOUL.md')) ? fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8') : null,
    writeSafeRoot: process.env.HERMES_WRITE_SAFE_ROOT,
  }));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'agent.log'), 'loaded skills; key=' + process.env.OPENROUTER_API_KEY + '\\n');
  if (mode === 'hang') { setTimeout(() => {}, 60000); return; }
  process.stderr.write('session_id: fixture-session-001\\n');
  if (mode === 'fail') { process.stderr.write('boom key=' + process.env.OPENROUTER_API_KEY + '\\n'); process.exit(2); }
  process.stdout.write('391\\n');
} else if (args[0] === 'sessions' && args[1] === 'export') {
  if (mode === 'escape') {
    // A session whose agent searched outside its folder and read a file there.
    const call = (name, a) => ({ function: { name, arguments: JSON.stringify(a) } });
    fs.writeFileSync(path.join(args[4], 'session.jsonl'), JSON.stringify({ input_tokens: 10, output_tokens: 5, messages: [
      { role: 'assistant', content: '', tool_calls: [call('search_files', { pattern: 'policy', path: '/Users/someone/project' })] },
      { role: 'tool', content: 'memory/sales-policy.md' },
      { role: 'assistant', content: '', tool_calls: [call('read_file', { path: '/Users/someone/project/memory/sales-policy.md' })] },
      { role: 'tool', content: 'Max discount 10%' },
      { role: 'assistant', content: '391' },
    ] }));
    return;
  }
  fs.copyFileSync(${JSON.stringify(fixturePath)}, path.join(args[4], 'session.jsonl'));
}
`;

const tmp = mkdtempSync(join(tmpdir(), 'evals-hermes-'));
const baseHome = join(tmp, 'base-home');
const assetsDir = join(tmp, 'assets');
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
  process.env.HERMES_BASE_HOME = baseHome;
  process.env.ASSETS_DIR = assetsDir;
  process.env.OPENROUTER_API_KEY = 'sk-test-secret';
  mkdirSync(join(assetsDir, 'skills', 'careful-data-check'), {
    recursive: true,
  });
  writeFileSync(
    join(assetsDir, 'skills', 'careful-data-check', 'SKILL.md'),
    '---\nname: careful-data-check\n---\nBe careful.\n',
  );
  mkdirSync(join(assetsDir, 'memory'));
  writeFileSync(join(assetsDir, 'memory', 'sales-policy.md'), 'Max discount 10%, annual billing only.\n');
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

test('each run gets its own temp HERMES_HOME, outside the work folder, deleted afterwards', async () => {
  const dirs = [workDir(), workDir()];
  for (const dir of dirs) await new HermesRunner().run({ runId: 'r', task, config, workDir: dir });
  const homes = dirs.map(
    (d) =>
      (
        JSON.parse(readFileSync(join(d, 'home.json'), 'utf8')) as {
          home: string;
        }
      ).home,
  );

  assert.notEqual(homes[0], homes[1], 'two runs must not share a home');
  for (const [i, home] of homes.entries()) {
    assert.ok(!home.startsWith(dirs[i]), 'home must not be inside the work folder the agent can read');
    assert.equal(existsSync(home), false, 'home is deleted after the run');
    assert.ok(home !== join(process.env.HOME ?? '', '.hermes'), 'never the real ~/.hermes');
  }
  // The shared dependency install survives: deleting a run home only removes the symlink.
  assert.ok(existsSync(join(baseHome, 'installs')));
});

test('the base home is prepared once, even for runs that start together', async () => {
  const before = readFileSync(join(baseHome, 'prepared.count'), 'utf8').length;
  const runner = new HermesRunner();
  await Promise.all(
    [workDir(), workDir(), workDir()].map((dir) => runner.run({ runId: 'r', task, config, workDir: dir })),
  );
  assert.equal(readFileSync(join(baseHome, 'prepared.count'), 'utf8').length - before, 1);
  const home = JSON.parse(readFileSync(join(tmp, `run-${n - 1}`, 'home.json'), 'utf8')) as { installsIsLink: boolean };
  assert.equal(home.installsIsLink, true, 'run homes link to the shared installs');
});

test('a config skill is copied into that run home only, and passed with -s', async () => {
  const withSkill = { ...config, skills: ['careful-data-check'] };
  const [a, b] = [workDir(), workDir()];
  await new HermesRunner().run({ runId: 'r', task, config: withSkill, workDir: a });
  await new HermesRunner().run({ runId: 'r', task, config, workDir: b });

  const seen = (d: string) =>
    JSON.parse(readFileSync(join(d, 'home.json'), 'utf8')) as {
      skills: string[];
    };
  assert.deepEqual(seen(a).skills, ['careful-data-check']);
  assert.deepEqual(seen(b).skills, [], 'a config without skills gets none');
  const args = JSON.parse(readFileSync(join(a, 'args.json'), 'utf8')) as string[];
  assert.equal(args[args.indexOf('-s') + 1], 'careful-data-check');
});

test("Hermes' log is kept in the run folder with the key masked", async () => {
  const dir = workDir();
  await new HermesRunner().run({ runId: 'r', task, config, workDir: dir });
  const log = readFileSync(join(dir, 'hermes-agent.log'), 'utf8');
  assert.match(log, /key=\*\*\*/);
  assert.ok(!log.includes('sk-test-secret'));
});

test('an unknown skill fails the run before Hermes is started', async () => {
  const dir = workDir();
  const r = await new HermesRunner().run({
    runId: 'r',
    task,
    config: { ...config, skills: ['no-such-skill'] },
    workDir: dir,
  });
  assert.match(r.error ?? '', /skill "no-such-skill" not found/);
  assert.equal(existsSync(join(dir, 'args.json')), false, 'hermes chat was never started');
});

test('a failed base-home setup becomes a run error, and the next run retries', async () => {
  const fresh = join(tmp, 'base-home-2');
  process.env.HERMES_BASE_HOME = fresh;
  try {
    const runner = new HermesRunner();
    process.env.FAKE_HERMES_MODE = 'base-fail';
    const r1 = await runner.run({
      runId: 'r',
      task,
      config,
      workDir: workDir(),
    });
    assert.match(r1.error ?? '', /could not prepare the Hermes base home/);
    delete process.env.FAKE_HERMES_MODE;
    const r2 = await runner.run({
      runId: 'r',
      task,
      config,
      workDir: workDir(),
    });
    assert.equal(r2.error, undefined);
    assert.ok(lstatSync(join(fresh, 'installs')).isDirectory());
    assert.ok(readdirSync(fresh).includes('prepared.count'));
  } finally {
    delete process.env.FAKE_HERMES_MODE;
    process.env.HERMES_BASE_HOME = baseHome;
  }
});

test('config memory is written fresh into that run home only', async () => {
  const withMemory = { ...config, memoryFiles: ['memory/sales-policy.md'] };
  const [a, b, c] = [workDir(), workDir(), workDir()];
  await new HermesRunner().run({ runId: 'r', task, config: withMemory, workDir: a });
  await new HermesRunner().run({ runId: 'r', task, config, workDir: b });
  await new HermesRunner().run({ runId: 'r', task, config: withMemory, workDir: c });

  const seen = (d: string) => JSON.parse(readFileSync(join(d, 'home.json'), 'utf8')) as { memory: string | null };
  assert.equal(seen(a).memory, 'Max discount 10%, annual billing only.');
  assert.equal(seen(b).memory, null, 'a config without memory files gets no memory');
  assert.equal(seen(c).memory, seen(a).memory, 'each run starts from the same memory, not from the last run');
});

test('a run whose agent reads outside its folder is an error, never a pass', async () => {
  process.env.FAKE_HERMES_MODE = 'escape';
  try {
    const r = await new HermesRunner().run({ runId: 'r', task, config, workDir: workDir() });
    assert.equal(r.finalAnswer, '391', 'the answer is kept for inspection');
    assert.match(r.error ?? '', /^sandbox violation: .*search_files \/Users\/someone\/project; read_file \/Users\/someone/);
  } finally {
    delete process.env.FAKE_HERMES_MODE;
  }
});

test('every run gets the harness rule in SOUL.md and a write sandbox on its own folder', async () => {
  writeFileSync(join(baseHome, 'SOUL.md'), 'You are Hermes.\n');
  const dir = workDir();
  await new HermesRunner().run({ runId: 'r', task, config, workDir: dir });
  const seen = JSON.parse(readFileSync(join(dir, 'home.json'), 'utf8')) as { soul: string; writeSafeRoot: string };
  assert.match(seen.soul, /^You are Hermes\.\n\n# Evaluation harness rule\n.*Work only with the files in your current working folder/s);
  assert.equal(seen.writeSafeRoot, dir);
});
