import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Experiment, RunRecord } from '@evals/shared';
import { AppModule } from '../app.module.js';

// End-to-end through the HTTP API with the MockRunner and a throwaway DB.
const tmp = mkdtempSync(join(tmpdir(), 'evals-flow-'));
process.env.DB_PATH = join(tmp, 'test.db');
process.env.RUNS_DIR = join(tmp, 'runs');
process.env.RUNNER = 'mock';
// Never call the paid judge from tests, even if the key is in the shell.
process.env.JUDGE = 'mock';
delete process.env.OPENROUTER_API_KEY;

let app: INestApplication;
let base: string;

async function start() {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  base = `${await app.getUrl()}/api`.replace('[::1]', 'localhost');
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function waitDone(id: string): Promise<Experiment & { runs: RunRecord[] }> {
  for (let i = 0; i < 100; i++) {
    const { data } = await api<Experiment & { runs: RunRecord[] }>('GET', `/experiments/${id}`);
    if (data.status === 'done') return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('experiment did not finish in time');
}

before(start);
after(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

let experimentId: string;

test('create -> all runs finish -> experiment done', async () => {
  const created = await api<Experiment & { runs: RunRecord[] }>('POST', '/experiments', {
    name: 'flow',
    configAId: 'config-a-cheap',
    configBId: 'config-b-sonnet',
    taskIds: ['change-due', 'file-csv-sum'],
    repeats: 2,
  });
  assert.equal(created.status, 201);
  experimentId = created.data.id;
  assert.equal(created.data.runs.length, 2 * 2 * 2); // tasks x configs x repeats
  assert.deepEqual(
    created.data.runs.map((r) => r.configId).slice(0, 4),
    ['config-a-cheap', 'config-b-sonnet', 'config-a-cheap', 'config-b-sonnet'],
  );

  const done = await waitDone(experimentId);
  assert.deepEqual(done.counts, { queued: 0, running: 0, done: 8, error: 0 });
  assert.ok(done.finishedAt);

  const regexRunId = done.runs.find((r) => r.taskId === 'change-due')!.id;
  const run = await api<RunRecord>('GET', `/runs/${regexRunId}`);
  assert.equal(run.data.status, 'done');
  assert.equal(typeof run.data.passed, 'boolean'); // regex task is scored
  assert.match(run.data.scoreReason ?? '', /^(matched|no match for) \//);
  assert.ok(run.data.steps && run.data.steps.length >= 2);
  assert.ok((run.data.durationMs ?? 0) >= 100);

  // Task files are written into the run's own folder before the agent starts.
  const fileRunId = done.runs.find((r) => r.taskId === 'file-csv-sum')!.id;
  assert.match(readFileSync(join(process.env.RUNS_DIR!, fileRunId, 'orders.csv'), 'utf8'), /^id,customer,amount,status/);
});

test('GET /tasks/:id returns one task, 404 for an unknown id', async () => {
  const ok = await api<{ id: string; prompt: string }>('GET', '/tasks/change-due');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.id, 'change-due');
  assert.equal((await api('GET', '/tasks/no-such-task')).status, 404);
});

test('bad input is rejected with 400', async () => {
  const bad = await api('POST', '/experiments', {
    name: 'x',
    configAId: 'config-a-cheap',
    configBId: 'config-a-cheap',
    repeats: 1,
  });
  assert.equal(bad.status, 400);
});

test('restart re-queues stuck "running" runs; retry-errors re-queues errored runs', async () => {
  await app.close();
  // Simulate a crash mid-run and a run that errored.
  const db = new DatabaseSync(process.env.DB_PATH!);
  const [stuck, failed] = db
    .prepare('SELECT id FROM runs WHERE experiment_id = ? ORDER BY seq LIMIT 2')
    .all(experimentId) as { id: string }[];
  db.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(stuck.id);
  db.prepare(`UPDATE runs SET status = 'error', error = 'boom' WHERE id = ?`).run(failed.id);
  db.prepare(`UPDATE experiments SET status = 'running', finished_at = NULL WHERE id = ?`).run(experimentId);
  db.close();

  await start();
  let exp = await waitDone(experimentId);
  assert.deepEqual(exp.counts, { queued: 0, running: 0, done: 7, error: 1 });

  const retry = await api<{ requeued: number }>('POST', `/experiments/${experimentId}/retry-errors`);
  assert.deepEqual(retry.data, { requeued: 1 });
  exp = await waitDone(experimentId);
  assert.deepEqual(exp.counts, { queued: 0, running: 0, done: 8, error: 0 });
});
