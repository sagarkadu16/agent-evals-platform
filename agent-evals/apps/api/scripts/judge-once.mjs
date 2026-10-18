// Calls the REAL judge once (costs a fraction of a cent) on the "explain-retry" seed task.
// Usage, from apps/api after `npm run build`:
//   node --env-file=.env scripts/judge-once.mjs "your hand-made answer"
import { readFileSync } from 'node:fs';
import { JudgeScorer } from '../dist/scoring/judge-scorer.js';

const answer = process.argv[2];
if (!answer) {
  console.error('Usage: node --env-file=.env scripts/judge-once.mjs "<answer>"');
  process.exit(1);
}
const seed = JSON.parse(readFileSync(new URL('../seed/tasks.json', import.meta.url), 'utf8'));
const t = seed.find((x) => x.id === 'explain-retry');
const { type, ...scorerSpec } = t.scorer;
const task = { ...t, scorerType: type, scorerSpec };

const result = await new JudgeScorer().score(task, {
  finalAnswer: answer,
  steps: [],
  tokens: { input: 0, output: 0 },
  costUsd: null,
});
console.log(JSON.stringify(result, null, 2));
