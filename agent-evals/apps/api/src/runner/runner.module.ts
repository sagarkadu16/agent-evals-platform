import { Module } from '@nestjs/common';
import { AGENT_RUNNER, type AgentRunner } from './agent-runner.js';
import { MockRunner } from './mock-runner.js';

/** Picks the runner once at startup from env RUNNER (default "mock"). */
export function createRunner(kind = process.env.RUNNER ?? 'mock'): AgentRunner {
  switch (kind) {
    case 'mock':
      return new MockRunner();
    case 'hermes':
      // HermesRunner is added in Task 7.
      throw new Error('RUNNER=hermes is not implemented yet');
    default:
      throw new Error(`Unknown RUNNER "${kind}" (expected "mock" or "hermes")`);
  }
}

@Module({
  providers: [{ provide: AGENT_RUNNER, useFactory: () => createRunner() }],
  exports: [AGENT_RUNNER],
})
export class RunnerModule {}
