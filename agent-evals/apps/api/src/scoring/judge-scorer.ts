import type { RunResult, TaskDef } from '@evals/shared';
import type { Scorer, ScoreResult } from './scorer.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_JUDGE_MODEL = 'z-ai/glm-5.3-flashx';
const REQUEST_TIMEOUT_MS = 60_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

type Verdict = { pass: boolean; reason: string } | { error: string };

const SYSTEM_PROMPT =
  'You are a strict grader for an AI agent evaluation. Judge the agent answer only against the rubric. ' +
  'Reply with strict JSON only, no prose and no code fences: {"pass": true|false, "reason": "<one sentence>"}';

/** Builds the judge conversation: task prompt, rubric, reference answer (if any) and the agent's answer. */
export function buildJudgeMessages(task: TaskDef, rubric: string, answer: string): ChatMessage[] {
  const parts = [
    `## Task given to the agent\n${task.prompt}`,
    `## Rubric\n${rubric}`,
    task.referenceAnswer ? `## Reference answer (one example of a passing answer)\n${task.referenceAnswer}` : '',
    `## Agent's final answer\n${answer.trim() || '(empty answer)'}`,
    'Return {"pass": true|false, "reason": "..."} as JSON only.',
  ];
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}

/** Defensive parse of the judge's reply: strips code fences, tolerates text around the JSON object. */
export function parseJudgeReply(text: string): Verdict {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  // Fall back to the outermost {...} in case the model added words around it.
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { error: `reply was not JSON: ${text.slice(0, 100)}` };
  }
  const { pass, reason } = (parsed ?? {}) as { pass?: unknown; reason?: unknown };
  if (typeof pass !== 'boolean') return { error: `"pass" is not true/false: ${text.slice(0, 100)}` };
  return { pass, reason: typeof reason === 'string' ? reason : '' };
}

/**
 * LLM-as-judge via OpenRouter. Any problem (no key, HTTP error, bad JSON twice) gives passed = null
 * with "judge error: ...", so a judge problem never counts as an agent failure.
 */
export class JudgeScorer implements Scorer {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  async score(task: TaskDef, result: RunResult): Promise<ScoreResult> {
    const usage = { input: 0, output: 0, cost: null as number | null };
    const done = (passed: boolean | null, reason: string): ScoreResult => ({
      passed,
      reason,
      judgeTokens: { input: usage.input, output: usage.output },
      judgeCostUsd: usage.cost,
    });

    try {
      const rubric = task.scorerSpec.rubric;
      if (typeof rubric !== 'string') return done(null, 'judge error: scorer spec has no "rubric"');
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return done(null, 'judge error: OPENROUTER_API_KEY is not set');

      const messages = buildJudgeMessages(task, rubric, result.finalAnswer);
      let verdict: Verdict = { error: 'no attempt made' };

      // One retry, only for an unparseable reply. The bad reply is shown back so the model can fix it.
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await this.call(key, messages);
        usage.input += reply.inputTokens;
        usage.output += reply.outputTokens;
        if (reply.costUsd !== null) usage.cost = (usage.cost ?? 0) + reply.costUsd;

        verdict = parseJudgeReply(reply.content);
        if (!('error' in verdict)) return done(verdict.pass, verdict.reason);
        messages.push(
          { role: 'assistant', content: reply.content },
          { role: 'user', content: 'That was not valid JSON. Reply with only {"pass": true|false, "reason": "..."}.' },
        );
      }
      return done(null, `judge error: ${verdict.error}`);
    } catch (err) {
      return done(null, `judge error: ${(err as Error).message}`);
    }
  }

  private async call(key: string, messages: ChatMessage[]) {
    const res = await this.fetchFn(OPENROUTER_URL, {
      method: 'POST',
      // The key goes only in this header; it is never logged or put in an error message.
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
        messages,
        temperature: 0,
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as ChatResponse;
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
    };
  }
}
