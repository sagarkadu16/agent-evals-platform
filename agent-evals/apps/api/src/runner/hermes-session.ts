import type { AgentConfig, Step } from '@evals/shared';

/** Pure helpers for HermesRunner: building the CLI args and parsing its output. No I/O here. */

export interface ParsedSession {
  sessionId: string | null;
  tokens: { input: number; output: number };
  costUsd: number | null;
  steps: Step[];
}

interface SessionLine {
  id?: string;
  /** Uncached input only; cached tokens are reported separately. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  estimated_cost_usd?: number | null;
  /** Real exports nest the messages here (one JSON object on one line). */
  messages?: unknown[];
}

interface MessageLine {
  role?: string;
  content?: unknown;
  /** An array in real exports; a JSON string in older/hand-made ones. */
  tool_calls?: unknown;
  tool_name?: string | null;
  finish_reason?: string | null;
  timestamp?: number | null;
}

interface ToolCall {
  function?: { name?: string; arguments?: string };
}

/** Args for `hermes chat`. An array, never a shell string, so prompts and paths can't inject commands. */
export function buildChatArgs(config: AgentConfig, promptPath: string, workDir: string): string[] {
  const args = [
    'chat',
    '--query-file', promptPath,
    '--oneshot',
    '-Q',
    '--provider', config.provider,
    '-m', config.model,
    '--max-turns', String(config.maxTurns),
    '--run-budget', String(config.runBudgetSec),
    '--source', 'evals',
    '--in', workDir,
    '-t', config.toolsets.join(','),
    '--ignore-user-config',
    '--yolo',
  ];
  if (config.skills.length > 0) args.push('-s', config.skills.join(','));
  return args;
}

/** Hermes prints "session_id: <id>" on stderr. */
export function parseSessionId(stderr: string): string | null {
  return /^\s*session_id:\s*(\S+)/m.exec(stderr)?.[1] ?? null;
}

/**
 * Parse `hermes sessions export` output. Two layouts are accepted:
 * - real exports: one JSON object (tokens, cost) with a `messages` array inside;
 * - line-based: line 1 = session object, every later line = one message.
 * Tolerant: a bad message is skipped instead of failing the whole run.
 */
export function parseSessionJsonl(text: string): ParsedSession {
  const lines = text.split('\n').filter((l) => l.trim());
  const first = tryJson(lines[0] ?? '');
  const session = (first && typeof first === 'object' ? first : {}) as SessionLine;
  const messages = Array.isArray(session.messages) ? session.messages : lines.slice(1).map(tryJson);
  const steps: Step[] = [];

  const push = (step: Omit<Step, 'index'>) => steps.push({ index: steps.length, ...step });

  for (const raw of messages) {
    const msg = raw as MessageLine | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const timestampMs = typeof msg.timestamp === 'number' ? Math.round(msg.timestamp * 1000) : undefined;

    const hasToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.length > 0 : Boolean(msg.tool_calls);
    if (msg.role === 'assistant' && hasToolCalls) {
      const calls = typeof msg.tool_calls === 'string' ? tryJson(msg.tool_calls) : msg.tool_calls;
      if (!Array.isArray(calls)) {
        push({ kind: 'tool', content: String(msg.tool_calls), timestampMs });
        continue;
      }
      for (const call of calls as ToolCall[]) {
        push({
          kind: 'tool',
          toolName: call.function?.name,
          content: prettyJson(call.function?.arguments ?? ''),
          timestampMs,
        });
      }
    } else if (msg.role === 'tool') {
      push({
        kind: 'result',
        toolName: msg.tool_name ?? undefined,
        content: prettyJson(msg.content ?? ''),
        timestampMs,
      });
    } else if (msg.role === 'assistant' && msg.finish_reason === 'stop') {
      push({ kind: 'model', content: typeof msg.content === 'string' ? msg.content : '', timestampMs });
    }
    // user messages (and anything else) are skipped.
  }

  return {
    sessionId: session.id ?? null,
    // Total prompt size = uncached + cache reads + cache writes, so models with and without caching compare fairly.
    tokens: {
      input: (session.input_tokens ?? 0) + (session.cache_read_tokens ?? 0) + (session.cache_write_tokens ?? 0),
      output: session.output_tokens ?? 0,
    },
    costUsd: session.estimated_cost_usd ?? null,
    steps,
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON (as a string or already parsed) becomes indented JSON for readability; plain text is kept as is. */
function prettyJson(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  const text = value;
  const parsed = tryJson(text);
  return parsed !== undefined && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : text;
}
