// Prints an experiment's progress, every run (status, score, tokens, cost, steps) and the cost totals.
// Read-only: it only calls GET endpoints, so it never spends money.
// Usage: node scripts/check-experiment.mjs <experimentId> [baseUrl]
const [id, base = 'http://localhost:3000/api'] = process.argv.slice(2);
if (!id) {
  console.error('Usage: node scripts/check-experiment.mjs <experimentId> [baseUrl]');
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
};

const exp = await get(`/experiments/${id}`);
const c = exp.counts;
console.log(`${exp.name}: ${exp.status}  (done ${c.done}, error ${c.error}, running ${c.running}, queued ${c.queued})\n`);

for (const r of exp.runs) {
  const run = await get(`/runs/${r.id}`);
  const score = run.passed === null ? 'UNSCORED' : run.passed ? 'PASS' : 'FAIL';
  const usd = (v) => (v === null ? 'null' : `$${v.toFixed(5)}`);
  console.log(
    `${run.taskId} | ${run.configId} | ${run.status} | ${score} | ` +
      `tokens ${run.inputTokens ?? 0}/${run.outputTokens ?? 0} | agent ${usd(run.costUsd)} | ` +
      `judge ${usd(run.judgeCostUsd)} | ${run.steps.length} steps | ${run.durationMs ?? '-'} ms`,
  );
  console.log(`    answer: ${JSON.stringify((run.finalAnswer ?? '').slice(0, 120))}`);
  console.log(`    reason: ${run.scoreReason ?? '-'}`);
  if (run.error) console.log(`    ERROR:  ${run.error}`);
}

const s = await get(`/experiments/${id}/summary`);
console.log('');
for (const k of ['configA', 'configB']) {
  const x = s[k];
  console.log(
    `${x.configName}: ${x.passed}/${x.scored} passed, ${x.errors} errors, ` +
      `agent $${x.agentCostUsd.toFixed(5)} + judge $${x.judgeCostUsd.toFixed(5)} = $${x.totalCostUsd.toFixed(5)}`,
  );
}
console.log(`\nVerdict: ${s.comparison.verdict} - ${s.comparison.explanation}`);
