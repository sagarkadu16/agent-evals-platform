# Agent Evals Platform

When you change an AI agent (a different model, a new skill, memory turned on), did it get **better, worse, or stay the same**? This platform answers that with evidence.

It runs tasks through the [Hermes Agent](https://github.com/NousResearch/hermes-agent) CLI under two configurations, A and B. It scores every run and reports the difference in **quality, speed and cost**, each with a 95% confidence interval. You can open any run to see why it passed or failed.

**Stack:** NestJS · Vue 3 · TypeScript · SQLite (`node:sqlite`) · npm workspaces

## 👉 The project lives in [`agent-evals/`](agent-evals/)

| Start here | |
|---|---|
| **[README](agent-evals/README.md)** | Setup, how it works, results, costs, assumptions, known limits |
| **[Design document](agent-evals/ARCHITECTURE.md)** | Architecture, data model, statistics and key design decisions |

## Quick start

```bash
cd agent-evals
npm install
npm start
```

Then open http://localhost:5173. By default it uses a free mock agent and mock judge, so nothing is spent. See the [README](agent-evals/README.md#real-runs-with-hermes-paid) for real Hermes runs.

## Results at a glance

| Change tested | Result |
|---|---|
| **Model:** DeepSeek V4 Flash vs Claude Sonnet 5.5 (10 tasks × 5 repeats, 100 runs) | 96% vs 90%, **no reliable difference** in pass rate (95% CI −20 to +6 points). Sonnet is about as fast and **48× more expensive**. |
| **Memory:** DeepSeek V4 Flash with vs without a sales-policy memory | **3/3 vs 0/3** passed. Only memory changed. |

Details and the method are in the [README](agent-evals/README.md#results-of-real-experiments).
