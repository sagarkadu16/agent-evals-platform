import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunResult } from '@evals/shared';
import { assetsRoot } from '../common/assets.js';
import type { AgentRunner, RunInput } from './agent-runner.js';
import { createRunHome, removeRunHome } from './hermes-home.js';
import { buildChatArgs, parseSessionId, parseSessionJsonl } from './hermes-session.js';
import { describeViolations, findSandboxViolations } from './sandbox.js';

const EXPORT_TIMEOUT_MS = 30_000;
/** The one-time dependency install for the base home takes ~25 s; allow for a slow network. */
const BASE_HOME_TIMEOUT_MS = 10 * 60_000;

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

/**
 * Runs one task through the Hermes CLI, then exports the session for steps, tokens and cost.
 * Every run gets its own throwaway HERMES_HOME holding only that config's skills and memory (see hermes-home.ts).
 */
export class HermesRunner implements AgentRunner {
  readonly name = 'hermes';
  private readonly bin = process.env.HERMES_BIN ?? 'hermes';
  /** Only Hermes' installed dependencies live here, so it can stay next to the API (git-ignored). */
  private readonly baseHome = resolve(process.env.HERMES_BASE_HOME ?? '.hermes-base');
  private readonly assetsDir = assetsRoot();
  /** Shared by concurrent runs so the base home is prepared once; cleared on failure so the next run retries. */
  private baseReady?: Promise<void>;

  async run({ task, config, workDir, signal }: RunInput): Promise<RunResult> {
    let home: string | undefined;
    try {
      if (config.provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
        return failed('OPENROUTER_API_KEY is not set');
      }

      await this.ensureBaseHome();
      home = createRunHome({
        baseHome: this.baseHome,
        assetsDir: this.assetsDir,
        skills: config.skills,
        memoryFiles: config.memoryFiles,
      });

      // Never `-q "<prompt>"` (it hangs): the prompt goes in a file.
      const promptPath = join(workDir, 'prompt.txt');
      writeFileSync(promptPath, task.prompt, 'utf8');

      const chat = await this.exec(buildChatArgs(config, promptPath, workDir), workDir, home, signal);
      if (chat.aborted) return failed('hermes was stopped (timeout)');

      const sessionId = parseSessionId(chat.stderr);
      const finalAnswer = chat.stdout.trim();
      const error =
        chat.code !== 0 ? `hermes exited with code ${chat.code}: ${tail(chat.stderr)}` : undefined;

      // Export even after a failed chat: tokens were still spent and should be recorded.
      const session = sessionId ? await this.exportSession(sessionId, workDir, home) : undefined;
      const steps = session?.steps ?? [];

      // A run that read or wrote outside its folder may have found answers there: never score it.
      const violations = findSandboxViolations(steps, workDir);
      const sandboxError = violations.length ? describeViolations(violations) : undefined;

      return {
        // stdout is the final answer; fall back to the last model step if stdout was empty.
        finalAnswer: finalAnswer || (steps.filter((s) => s.kind === 'model').at(-1)?.content ?? ''),
        steps,
        tokens: session?.tokens ?? { input: 0, output: 0 },
        costUsd: session?.costUsd ?? null,
        sessionId: sessionId ?? undefined,
        error: sandboxError ?? error ?? (sessionId ? undefined : `no session_id on stderr: ${tail(chat.stderr)}`),
      };
    } catch (err) {
      return failed(`HermesRunner failed: ${redact((err as Error).message)}`);
    } finally {
      if (home) {
        keepAgentLog(home, workDir);
        removeRunHome(home);
      }
    }
  }

  /**
   * Prepares the shared base home once: any Hermes command in a new home installs its dependencies.
   * `sessions list` is offline and free, so no model is called and nothing is spent.
   */
  private ensureBaseHome(): Promise<void> {
    this.baseReady ??= (async () => {
      mkdirSync(this.baseHome, { recursive: true });
      const res = await this.exec(
        ['sessions', 'list', '--source', 'evals'],
        this.baseHome,
        this.baseHome,
        AbortSignal.timeout(BASE_HOME_TIMEOUT_MS),
      );
      if (res.code !== 0 || !existsSync(join(this.baseHome, 'installs'))) {
        throw new Error(`could not prepare the Hermes base home at ${this.baseHome}: ${tail(res.stderr)}`);
      }
    })().catch((err: unknown) => {
      this.baseReady = undefined;
      throw err;
    });
    return this.baseReady;
  }

  /** Returns undefined if the export fails; the run keeps its answer but has no steps or cost. */
  private async exportSession(sessionId: string, workDir: string, home: string) {
    const exportDir = join(workDir, 'session-export');
    mkdirSync(exportDir, { recursive: true });
    const signal = AbortSignal.timeout(EXPORT_TIMEOUT_MS);
    // Same HERMES_HOME as the chat: the session only exists in that home's state.db.
    const res = await this.exec(['sessions', 'export', '--session-id', sessionId, exportDir], workDir, home, signal);
    if (res.code !== 0) return undefined;
    const file = readdirSync(exportDir).find((f) => f.endsWith('.jsonl'));
    return file ? parseSessionJsonl(readFileSync(join(exportDir, file), 'utf8')) : undefined;
  }

  private exec(args: string[], cwd: string, home: string, signal?: AbortSignal): Promise<ProcessResult> {
    return new Promise((resolve) => {
      // The key reaches Hermes only through the inherited environment, never through args.
      // HERMES_WRITE_SAFE_ROOT: Hermes' own write sandbox, so file writes can't leave the folder.
      const env = { ...process.env, HERMES_HOME: home, HERMES_WRITE_SAFE_ROOT: cwd };
      const child = spawn(this.bin, args, {
        cwd,
        env,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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

/**
 * Copies Hermes' own log into the run folder before the home is deleted. It is the only record of
 * which skills Hermes accepted (it logs and skips unknown ones instead of failing).
 */
function keepAgentLog(home: string, workDir: string): void {
  try {
    const log = join(home, 'logs', 'agent.log');
    if (existsSync(log)) writeFileSync(join(workDir, 'hermes-agent.log'), redact(readFileSync(log, 'utf8')));
  } catch {
    // Best effort: a missing log must not fail the run.
  }
}

function redact(text: string): string {
  const key = process.env.OPENROUTER_API_KEY;
  return key ? text.split(key).join('***') : text;
}
