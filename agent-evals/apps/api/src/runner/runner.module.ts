import { Module } from '@nestjs/common';
import { AGENT_RUNNER, type AgentRunner } from './agent-runner.js';
import { HermesRunner } from './hermes-runner.js';
import { MockRunner } from './mock-runner.js';

/** Picks the runner once at startup from env RUNNER (default "mock"). */
export function createRunner(kind = process.env.RUNNER ?? 'mock'): AgentRunner {
  switch (kind) {
    case 'mock':
      return new MockRunner();
    case 'hermes':
      return new HermesRunner();
    default:
      throw new Error(`Unknown RUNNER "${kind}" (expected "mock" or "hermes")`);
  }
}

@Module({
  providers: [{ provide: AGENT_RUNNER, useFactory: () => createRunner() }],
  exports: [AGENT_RUNNER],
})
export class RunnerModule {}
