import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunResult, TaskDef } from '@evals/shared';
import { buildJudgeMessages, JudgeScorer, parseJudgeReply } from './judge-scorer.js';

// No real API calls: every test uses a fake fetch that returns canned judge replies.
const task: TaskDef = {
  id: 'explain-retry',
  name: 'Explain retry',
  prompt: 'Explain exponential backoff.',
  scorerType: 'judge',
  scorerSpec: { rubric: 'PASS only if it says waits grow longer.' },
  referenceAnswer: 'Waits grow longer after each failure.',
};
const answer: RunResult = { finalAnswer: 'Wait longer each time.', steps: [], tokens: { input: 0, output: 0 }, costUsd: 0 };

function fakeFetch(replies: (string | { status: number; body: string })[]) {
  const calls: { headers: Record<string, string>; body: { model: string; temperature: number; messages: unknown[] } }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = replies[calls.length - 1];
    if (typeof r !== 'string') return new Response(r.body, { status: r.status });
    return Response.json({
      choices: [{ message: { content: r } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let savedKey: string | undefined;
before(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-test-secret';
});
after(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

test('parse: plain JSON, code fences, and text around the object', () => {
  assert.deepEqual(parseJudgeReply('{"pass": true, "reason": "ok"}'), { pass: true, reason: 'ok' });
  assert.deepEqual(parseJudgeReply('```json\n{"pass": false, "reason": "missing"}\n```'), {
    pass: false,
    reason: 'missing',
  });
  assert.deepEqual(parseJudgeReply('Sure! {"pass": true, "reason": "fine"} Hope that helps.'), {
    pass: true,
    reason: 'fine',
  });
});

test('parse: non-JSON or non-boolean pass is an error', () => {
  assert.ok('error' in parseJudgeReply('PASS'));
  assert.ok('error' in parseJudgeReply('{"pass": "yes", "reason": "x"}'));
});

test('prompt contains task, rubric, reference answer and agent answer', () => {
  const user = buildJudgeMessages(task, 'RUBRIC-TEXT', 'AGENT-ANSWER')[1].content;
  for (const part of [task.prompt, 'RUBRIC-TEXT', task.referenceAnswer!, 'AGENT-ANSWER']) {
    assert.ok(user.includes(part), `missing: ${part}`);
  }
});

test('good reply: pass + reason, temperature 0, key only in the auth header, tokens and cost saved', async () => {
  const { fn, calls } = fakeFetch(['{"pass": true, "reason": "says waits grow"}']);
  const r = await new JudgeScorer(fn).score(task, answer);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'says waits grow');
  assert.deepEqual(r.judgeTokens, { input: 100, output: 10 });
  assert.equal(r.judgeCostUsd, 0.0001);
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test-secret');
  assert.ok(!JSON.stringify(calls[0].body).includes('sk-test-secret'));
});

test('bad JSON once, then good: retried once, usage summed over both calls', async () => {
  const { fn, calls } = fakeFetch(['I think it passes.', '{"pass": false, "reason": "no growth mentioned"}']);
  const r = await new JudgeScorer(fn).score(task, answer);
  assert.equal(calls.length, 2);
  assert.equal(r.passed, false);
  assert.deepEqual(r.judgeTokens, { input: 200, output: 20 });
  assert.equal(r.judgeCostUsd, 0.0002);
});

test('bad JSON twice: passed = null (not a failure), "judge error: ..."', async () => {
  const { fn, calls } = fakeFetch(['nope', 'still nope']);
  const r = await new JudgeScorer(fn).score(task, answer);
  assert.equal(calls.length, 2);
  assert.equal(r.passed, null);
  assert.match(r.reason, /^judge error: /);
});

test('HTTP error: passed = null, key not in the reason', async () => {
  const { fn } = fakeFetch([{ status: 401, body: '{"error":"bad key"}' }]);
  const r = await new JudgeScorer(fn).score(task, answer);
  assert.equal(r.passed, null);
  assert.match(r.reason, /^judge error: OpenRouter HTTP 401/);
  assert.ok(!r.reason.includes('sk-test-secret'));
});

test('missing key: passed = null without calling the API', async () => {
  delete process.env.OPENROUTER_API_KEY;
  const { fn, calls } = fakeFetch([]);
  const r = await new JudgeScorer(fn).score(task, answer);
  process.env.OPENROUTER_API_KEY = 'sk-test-secret';
  assert.equal(r.passed, null);
  assert.equal(r.reason, 'judge error: OPENROUTER_API_KEY is not set');
  assert.equal(calls.length, 0);
});
