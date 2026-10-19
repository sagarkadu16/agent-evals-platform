# Assignment status: what is done against each requirement

Checked on 2026-10-19 against the take-home brief. ✅ means done, 🟡 means partly done, ❌ means not started.

## The problem

> When we change the model, add a skill, or turn on memory, we need to know whether the agent got better, got worse or stayed the same. Answer this with evidence, built on Hermes Agent.

All three kinds of change can now be tested. Each one is an agent config, and an experiment compares two of them:

| Change | Config pair that tests it | Real evidence so far |
|---|---|---|
| Model | `config-a-cheap` (DeepSeek V4 Flash) vs `config-b-sonnet` / `config-c-opus` | `full-10x2x5`, 100 runs (below) |
| Skill | `config-a-cheap` vs `a-deepseek-skill` (`skills/careful-data-check`) | Smoke test still to do (Step 7) |
| Memory | `config-a-cheap` vs `a-deepseek-memory` (`memory/sales-policy.md`) | `deepseek check with memory`: **3/3 vs 0/3** (below) |

## "What it should do"

| # | Requirement | Status | How |
|---|---|---|---|
| 1 | Define a set of tasks and how each is scored | ✅ | `apps/api/seed/tasks.json` holds 16 tasks, each with a prompt, optional input files, tags, a reference answer and a scorer. There are 8 regex (exact-match) tasks and 8 LLM-judge tasks with concrete PASS/FAIL rubrics. Every task is validated on startup and tested in `seed-tasks.test.ts` (the regex is checked against the reference and near-misses, and facts in the files are recomputed). |
| 2 | Define configs to compare (model, skills, memory, tools) | ✅ | `apps/api/seed/configs.json` sets the model, provider, toolsets, skills, memory files, max turns and time budget. There are 5 configs: DeepSeek, DeepSeek + skill, DeepSeek + memory, Sonnet 5.5 and Opus 5.5. Skills live in `skills/<name>/SKILL.md` and memory in `memory/*.md`. |
| 3 | Run the tasks under each config | ✅ | `ExecutorService` is an in-process queue. It runs each task × config × repeat, alternating A and B. `HermesRunner` gives each run its own `HERMES_HOME` holding exactly that config's skills and memory, so `~/.hermes` is never touched. `MockRunner` runs everything free for development. |
| 4 | Show whether one config is better, and how confident we can be | ✅ | The comparison page has a "What changed" box, a one-line headline and three scorecards. **Quality** is the pass-rate difference with a paired bootstrap 95% CI over tasks. **Speed** is the median duration ratio and **cost** is the mean cost ratio, each with a bootstrap CI. Each verdict says *why*: "needs ≥ 2 tasks", "no difference", "unclear: CI includes 0", "B better" or "B worse". |
| 5 | Inspect a single run to see why it passed or failed | 🟡 | The run page shows the prompt, the final answer, every model and tool step, the score reason (the judge's explanation or the regex result), tokens, cost, duration and the error. **Missing (Step 4):** the frozen config snapshot and "Skills loaded / Memory loaded" badges. |

## Requirements

| Requirement | Status | Notes |
|---|---|---|
| NestJS backend, Vue 3 frontend, TypeScript throughout | ✅ | npm workspaces: `apps/api` (NestJS, `node:sqlite`, native ESM), `apps/web` (Vue 3 + Vite) and `packages/shared` (shared types plus `diffConfigs`). |
| Runs locally with a single command | ✅ | `npm start` builds shared and starts the API and web together with `concurrently`. The default is the mock runner and mock judge, so it's free. Use `RUNNER=hermes` for real runs. |
| Sample task set that demonstrates the platform | ✅ | 16 tasks over 9 tags (reasoning, format, data, writing, code, sales, multi-step, robustness, memory). They include harder tasks (lead-triage, invoice-reconcile, prompt-injection, missing-file-recovery) and a memory-only task (discount-reply). |
| Document assumptions | ✅ | README → Assumptions (9 items). The design decisions are in `ARCHITECTURE.md` §9. |

## Deliverables

| # | Deliverable | Status | What exists / what is left |
|---|---|---|---|
| 1 | Production-grade code in Git, with a README | 🟡 | `README.md` written. `npm test` runs all **89 tests** (85 API + 4 shared). The web app is type-checked with `vue-tsc`. `apps/api/.env.example` added. **Left:** work since `6549ebe` isn't committed. |
| 2 | Design doc: architecture and key decisions | ✅ | `ARCHITECTURE.md` is updated: 16 tasks and 5 configs, the per-run Hermes home (skills and memory), the sandbox, speed and cost stats, and the new UI and design decisions. |
| 3 | Known limits | ✅ | README → Known limits, and `ARCHITECTURE.md` §13. |
| 4 | Approximate costs | ✅ | README → Approximate costs (per run, per experiment, total spent). |
| 5 | Results of one real experiment comparing two configs | ✅ | README → Results (a model change and a memory change). |
| 6 | Video of the working system | ✅ | [Demo video](https://drive.google.com/file/d/1S9hPa6WlyR_Rf6IpYgl2mCYvGUxBLrRi/view?usp=sharing), linked from both READMEs. |

## Real results so far

**1. Model change: `full-10x2x5`** (10 tasks × 2 configs × 5 repeats = 100 runs, 0 errors, about $0.27 total)

| | DeepSeek V4 Flash (A) | Claude Sonnet 5.5 (B) |
|---|---|---|
| Pass rate | 96% (48/50) | 90% (45/50) |
| Median time per run | about the same | about the same |
| Agent cost | $0.25 total for both configs | about **48× A** (CI 34×–65×) |

Headline: *"No reliable difference in pass rate (−6.0 points, 95% CI −20 to +6); B is about as fast and 48× more expensive."* 7 of the 10 tasks were 5/5 for both models (a ceiling effect), which is why the harder tasks were added.

**2. Memory change: `deepseek check with memory`** (discount-reply × 3 repeats, run after the sandbox fix, $0.012 total)

| | DeepSeek + sales-policy memory | DeepSeek, no memory |
|---|---|---|
| Passed | **3/3** | **0/3** |
| Why | 10% only with annual billing, no WhatsApp date, includes the booking link | Offered a monthly or 3-month discount, claimed WhatsApp works today, no booking link |

This is the "turn on memory" question answered with evidence: same model, one thing changed, a clear difference. It's one task, so the quality card honestly says "Needs ≥ 2 tasks" for a CI. Step 7 adds a second memory task for that.

**Invalid results (don't present them):** the earlier `discount reply…` and `tewrtwrt` experiments, run before the sandbox fix. In those, configs without memory passed by reading `memory/sales-policy.md` from the repo. The sandbox fix stops this from happening again: runs now live outside the repo, writes are sandboxed, every run gets a "stay in your folder" rule, and any file access outside the run folder turns the run into an error.

## Approximate costs (OpenRouter, from the dev DB)

| What | Cost |
|---|---|
| One DeepSeek V4 Flash run | about $0.001–0.003 |
| One Sonnet 5.5 run | about $0.01–0.03 |
| One Opus 5.5 run | about $0.04 |
| One judge call (GLM flash) | about $0.0002–0.0005 |
| Full 10 tasks × 5 repeats, DeepSeek vs Sonnet | about $0.27 |
| Everything spent in development so far (25 experiments, 186 runs) | **about $0.83** |
| Mock runner + mock judge (default) | $0 |

## Built beyond the brief

- **Sandbox and leak detection.** We found a real leak (an agent read the answer from the repo), fixed it, and added tests that replay the leak.
- **Config diff ("What changed").** It warns when an experiment changes more than one thing, so a result can't be pinned on one cause.
- **Speed and cost statistics.** A median-based speed ratio and cost per passed run, with CIs. This showed that a 30.8 s vs 18.8 s average gap came from outliers (medians 19.4 s vs 18.0 s).
- **UI:**
  - a live progress bar on every experiment in the list;
  - the new-experiment form keeps its state while you navigate;
  - task search with tag filters and "select all shown";
  - side-by-side config panels that highlight the fields that differ;
  - A/B swap.
- **Operational details:**
  - retry errored runs;
  - a restart re-queues interrupted runs;
  - retired tasks stay in old results;
  - additive DB migrations;
  - the API key is never logged and is masked in errors (tested).

## What's left, in order

1. **Step 3:** freeze a config snapshot (with skill and memory hashes) on each experiment; record what each run actually loaded; fail fast in the seed check on a missing skill or memory file; note in the UI that MockRunner ignores skills and memory.
2. **Step 4:** run page shows the config snapshot and "Skills loaded / Memory loaded" badges.
3. **Step 5:** tests for the above; root `npm test` runs the shared and API tests.
4. ~~**Step 6:** README and design doc.~~ Done.
5. **Step 7 (paid, you run it):** skill smoke test (lead-triage + invoice-reconcile, A vs `a-deepseek-skill`) and a memory re-run.
6. ~~Commit, then record the video.~~ Done.
