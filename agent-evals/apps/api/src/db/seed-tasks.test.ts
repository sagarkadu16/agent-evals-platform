import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TaskDef } from '@evals/shared';
import { RegexScorer } from '../scoring/regex-scorer.js';
import { isSafeRelativePath } from '../common/safe-path.js';

// Checks the real seed file, so a typo in a pattern or reference answer is caught before any money is spent.
interface SeedTask {
  id: string;
  prompt: string;
  referenceAnswer?: string;
  files?: Record<string, string>;
  scorer: { type: 'regex' | 'judge'; pattern?: string; rubric?: string };
}
const tasks = JSON.parse(
  readFileSync(new URL('../../seed/tasks.json', import.meta.url), 'utf8'),
) as SeedTask[];
const byId = (id: string) => tasks.find((t) => t.id === id)!;

function asTaskDef(t: SeedTask): TaskDef {
  const { type, ...spec } = t.scorer;
  return { id: t.id, name: t.id, prompt: t.prompt, scorerType: type, scorerSpec: spec };
}
const regexPasses = async (t: SeedTask, answer: string) =>
  (await new RegexScorer().score(asTaskDef(t), { finalAnswer: answer, steps: [], tokens: { input: 0, output: 0 }, costUsd: 0 }))
    .passed;

test('10 tasks with unique ids: 5 regex, 5 judge, 3 with files', () => {
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 10);
  assert.equal(tasks.filter((t) => t.scorer.type === 'regex').length, 5);
  assert.equal(tasks.filter((t) => t.scorer.type === 'judge').length, 5);
  assert.equal(tasks.filter((t) => t.files).length, 3);
});

test('every task has a referenceAnswer; every rubric lists concrete PASS conditions', () => {
  for (const t of tasks) {
    assert.ok(t.referenceAnswer?.trim(), `${t.id} has no referenceAnswer`);
    if (t.scorer.type === 'judge') assert.match(t.scorer.rubric ?? '', /^PASS only if/, t.id);
  }
});

test('every regex task passes its own reference answer', async () => {
  for (const t of tasks.filter((x) => x.scorer.type === 'regex')) {
    assert.equal(await regexPasses(t, t.referenceAnswer!), true, t.id);
  }
});

test('regex tasks reject plausible near-misses', async () => {
  const misses: [string, string][] = [
    ['change-due', '$42.20'],
    ['change-due', '42.2'],
    ['third-friday', '2027-03-18'],
    ['third-friday', 'March 19, 2027'],
    ['sort-words', 'apple, Banana, cherry, Date, elderberry, fig'],
    ['sort-words', 'apple,banana,cherry,date,elderberry,fig'],
    ['extract-503', 'req-503abc'],
    ['file-csv-sum', '1287.4'],
  ];
  for (const [id, answer] of misses) assert.equal(await regexPasses(byId(id), answer), false, `${id}: ${answer}`);
});

test('facts behind the answers are right', () => {
  // Third Friday of March 2027.
  assert.equal(new Date(Date.UTC(2027, 2, 19)).getUTCDay(), 5);
  const fridays = [...Array(31).keys()].map((d) => new Date(Date.UTC(2027, 2, d + 1))).filter((d) => d.getUTCDay() === 5);
  assert.equal(fridays[2].getUTCDate(), 19);

  // Shipped total in orders.csv, parsed with quoted fields respected.
  const csv = byId('file-csv-sum').files!['orders.csv'];
  const rows = csv.trim().split('\n').slice(1).map((l) => l.match(/("[^"]*"|[^,]+)/g)!);
  const total = rows.filter((r) => r[3] === 'shipped').reduce((s, r) => s + Number(r[2]), 0);
  assert.equal(total.toFixed(2), '1287.45');

  // Exactly one 503 status in the log.
  const statuses = byId('extract-503').prompt.split('\n').filter((l) => / 503 req-/.test(l));
  assert.equal(statuses.length, 1);

  // The multi-part reference answer obeys its own rules.
  const lines = byId('multi-part-format').referenceAnswer!.split('\n');
  assert.equal(lines.at(-1), 'DONE');
  for (const b of lines.slice(0, 3)) assert.ok(b.startsWith('- ') && b.slice(2).split(/\s+/).length < 15, b);
});

test('task file paths are safe relative paths', () => {
  for (const t of tasks) for (const p of Object.keys(t.files ?? {})) assert.ok(isSafeRelativePath(p), `${t.id}: ${p}`);
});
