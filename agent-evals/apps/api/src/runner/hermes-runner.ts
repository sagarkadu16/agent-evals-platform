import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '@evals/shared';
import type { AgentRunner, RunInput } from './agent-runner.js';
import { buildChatArgs, parseSessionId, parseSessionJsonl } from './hermes-session.js';

const EXPORT_TIMEOUT_MS = 30_000;

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

/** Runs one task through the Hermes CLI, then exports the session for steps, tokens and cost. */
export class HermesRunner implements AgentRunner {
  readonly name = 'hermes';
  private readonly bin = process.env.HERMES_BIN ?? 'hermes';

  async run({ task, config, workDir, signal }: RunInput): Promise<RunResult> {
    try {
      if (config.provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
        return failed('OPENROUTER_API_KEY is not set');
      }

      // Never `-q "<prompt>"` (it hangs): the prompt goes in a file.
      const promptPath = join(workDir, 'prompt.txt');
      writeFileSync(promptPath, task.prompt, 'utf8');

      const chat = await this.exec(buildChatArgs(config, promptPath, workDir), workDir, signal);
      if (chat.aborted) return failed('hermes was stopped (timeout)');

      const sessionId = parseSessionId(chat.stderr);
      const finalAnswer = chat.stdout.trim();
      const error =
        chat.code !== 0 ? `hermes exited with code ${chat.code}: ${tail(chat.stderr)}` : undefined;

      // Export even after a failed chat: tokens were still spent and should be recorded.
      const session = sessionId ? await this.exportSession(sessionId, workDir) : undefined;
      const steps = session?.steps ?? [];

      return {
        // stdout is the final answer; fall back to the last model step if stdout was empty.
        finalAnswer: finalAnswer || (steps.filter((s) => s.kind === 'model').at(-1)?.content ?? ''),
        steps,
        tokens: session?.tokens ?? { input: 0, output: 0 },
        costUsd: session?.costUsd ?? null,
        sessionId: sessionId ?? undefined,
        error: error ?? (sessionId ? undefined : `no session_id on stderr: ${tail(chat.stderr)}`),
      };
    } catch (err) {
      return failed(`HermesRunner failed: ${redact((err as Error).message)}`);
    }
  }

  /** Returns undefined if the export fails; the run keeps its answer but has no steps or cost. */
  private async exportSession(sessionId: string, workDir: string) {
    const exportDir = join(workDir, 'session-export');
    mkdirSync(exportDir, { recursive: true });
    const signal = AbortSignal.timeout(EXPORT_TIMEOUT_MS);
    const res = await this.exec(['sessions', 'export', '--session-id', sessionId, exportDir], workDir, signal);
    if (res.code !== 0) return undefined;
    const file = readdirSync(exportDir).find((f) => f.endsWith('.jsonl'));
    return file ? parseSessionJsonl(readFileSync(join(exportDir, file), 'utf8')) : undefined;
  }

  private exec(args: string[], cwd: string, signal?: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve) => {
      // The key reaches Hermes only through the inherited environment, never through args.
      const child = spawn(this.bin, args, { cwd, env: process.env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        // ENOENT (hermes not installed) or AbortError (timeout).
        resolve({ code: null, stdout, stderr: stderr + err.message, aborted: signal?.aborted ?? false });
      });
      child.on('close', (code) => resolve({ code, stdout, stderr, aborted: signal?.aborted ?? false }));
    });
  }
}

function failed(error: string): RunResult {
  return { finalAnswer: '', steps: [], tokens: { input: 0, output: 0 }, costUsd: null, error };
}

/** Last part of stderr, with the API key masked, for an error message. */
function tail(text: string, max = 500): string {
  const t = redact(text.trim());
  return t.length > max ? `...${t.slice(-max)}` : t;
}

function redact(text: string): string {
  const key = process.env.OPENROUTER_API_KEY;
  return key ? text.split(key).join('***') : text;
}
