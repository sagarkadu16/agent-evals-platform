# Agent Evals Platform

When you change an AI agent (a different model, a new skill, memory turned on), did it get **better, worse, or stay the same**? This platform answers that with evidence instead of impressions.

It runs a set of tasks through the [Hermes Agent](https://github.com/NousResearch/hermes-agent) CLI under two configurations, **A** and **B**, scores every run automatically, and reports the difference in **quality, speed and cost**, each with a 95% confidence interval. Every run can be opened to see exactly what the agent did and why it passed or failed.

**Stack:** NestJS (API) · Vue 3 + Vite (web) · TypeScript throughout · SQLite (`node:sqlite`) · npm workspaces

> The design document, with architecture, data model, statistics and design decisions, is in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Contents

1. [Quick start](#quick-start)
2. [How it works](#how-it-works)
3. [Using the app](#using-the-app)
4. [Tasks, configs, skills and memory](#tasks-configs-skills-and-memory)
5. [Results of real experiments](#results-of-real-experiments)
6. [Approximate costs](#approximate-costs)
7. [Configuration](#configuration)
8. [Testing](#testing)
9. [Assumptions](#assumptions)
10. [Known limits](#known-limits)
11. [Repository layout](#repository-layout)

---

## Quick start

**Requirements:** Node.js ≥ 22.13 (for the built-in `node:sqlite`). For real runs you also need the Hermes CLI (tested with v0.21.7) and an [OpenRouter](https://openrouter.ai) API key.

```bash
npm install
npm start
```

Open **http://localhost:5173**. That one command builds the shared package and starts the API (`:3000`) and the web app (`:5173`).

By default the platform uses the **mock runner and mock judge**: no Hermes, no key, **no money spent**. This is the mode to explore the UI in.

### Real runs with Hermes (paid)

1. Install Hermes Agent by following its README, then check that `hermes --version` works.
2. Create `apps/api/.env` (git-ignored) from the example and add your key:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```
3. Start the API with the real runner, and the web app in a second terminal:
   ```bash
   npm run build:shared
   cd apps/api && RUNNER=hermes npm run start:dev
   ```
   ```bash
   npm run dev -w apps/web
   ```

The first real run prepares a shared Hermes install in `apps/api/.hermes-base`. This takes about 25 s once. After that, each run takes a few seconds of setup.

The judge for free-text tasks switches to a real model automatically with `RUNNER=hermes`. Mock experiments never call it.

---

## How it works

```
Task  = what to do + how it's scored + input files     (never changes between configs)
Config = model, tools, skills, memory, max turns, time budget
Experiment = config A vs config B, on chosen tasks × N repeats, ideally with ONE thing different
```

```
 Vue 3 web ──/api──► NestJS API ──► queue (SQLite) ──► runner ──► Hermes CLI ──► OpenRouter
                         │                               │
                         │                               └──► scorer: regex | LLM judge
                         └──► statistics: paired bootstrap (quality), run bootstrap (speed, cost)
```

1. **Start an experiment.** Pick A and B, the tasks and the number of repeats. The API plans every task × config × repeat and interleaves A and B (A, B, A, B…), so drift over time hits both equally.
2. **Run.** A queue stored in the DB runs each one. Every Hermes run gets:
   - a **fresh run folder** holding only the task's input files;
   - its **own throwaway Hermes home** holding exactly that config's skills and memory, so your real `~/.hermes` is never read or changed;
   - a hard **timeout** that kills the process.
3. **Score.** Exact-answer tasks are checked with a strict regex. Free-text tasks are graded by an **LLM judge** against a concrete PASS/FAIL rubric and a reference answer. A run that crashed, timed out or broke the sandbox is an **error**, never a failure, so infrastructure problems don't look like agent mistakes.
4. **Compare.** The comparison page shows:
   - **What changed** between A and B, with a warning when more than one thing changed;
   - **Quality:** the pass-rate difference, with a **paired bootstrap 95% CI over tasks**;
   - **Speed:** the B/A ratio of median time per run, with a CI;
   - **Cost:** the B/A ratio of mean agent cost per run, with a CI, plus the cost per *passed* run;
   - a one-line **headline**, e.g. *"No reliable difference in pass rate (−6.0 points); B is about as fast and 48× more expensive."*
5. **Inspect.** Each run shows the prompt, the final answer, the scorer's reason, tokens, cost, time, and the full **step timeline** of model turns, tool calls and tool results.

---

## Using the app

| Page | What you do there |
|---|---|
| **Experiments** (`/`) | Start a new experiment. Pick configs A and B in side-by-side panels; fields that differ are highlighted, and a swap button switches them. Search and tag-filter the tasks, then "Select all shown". The form remembers its state while you navigate. The list below shows every experiment with a **live progress bar** (done / errors / running). |
| **Experiment** (`/experiments/:id`) | The headline and the Quality / Speed / Cost scorecards, the "What changed" box, per-config and per-task tables (rows where A and B differ are highlighted), **Retry errored runs**, and the runs list filtered by task and config. |
| **Run** (`/runs/:id`) | Why it passed or failed: the error banner (if any), the scorer reason (the judge's explanation or the regex result), the final answer, the prompt and reference answer, and the step-by-step timeline. |

Pages refresh every 3 s while an experiment is running.

A **suggested demo:**
1. Start **DeepSeek V4 Flash vs DeepSeek V4 Flash + sales-policy memory** on the `discount-reply` task with 3 repeats. Only one thing changes: memory.
2. Open a failing run without memory. The judge explains that it promised WhatsApp support and missed the booking link.
3. Open a passing run with memory. It applied the policy correctly.

---

## Tasks, configs, skills and memory

Everything is defined in reviewed files, not in a UI:

| What | Where |
|---|---|
| Tasks | `apps/api/seed/tasks.json` |
| Configs | `apps/api/seed/configs.json` |
| Skills | `skills/<name>/SKILL.md` |
| Memory | `memory/*.md` |

The API validates the seed files on every startup and loads them in one transaction. A broken file stops startup with a clear message.

### Tasks (16)

Each task has a prompt, optional input files, tags, a reference answer and a scorer. There are 8 **regex** tasks (exact answer, strict format) and 8 **LLM-judge** tasks (concrete PASS/FAIL rubric).

| Tag | Tasks |
|---|---|
| reasoning, format | `change-due`, `third-friday`, `sort-words`, `multi-part-format` |
| data | `extract-503`, `file-csv-sum`, `lead-triage`, `invoice-reconcile` |
| writing | `explain-retry`, `explain-idempotency`, `file-action-items` |
| code | `file-bug-review` |
| robustness | `missing-file-recovery` (the requested file is missing; the agent must find the value in the files that do exist), `prompt-injection` (a file contains instructions to ignore) |
| sales | `sales-followup`, `discount-reply` |
| memory | `discount-reply`: the answer depends on a sales policy that is **only** in the memory file, not in the prompt or the task files |

A task removed from `tasks.json` is **retired**, not deleted, so old results stay readable. A task whose meaning changes gets a new id.

### Configs (5)

| id | Model | What it tests |
|---|---|---|
| `config-a-cheap` | DeepSeek V4 Flash | baseline |
| `a-deepseek-skill` | DeepSeek V4 Flash + `careful-data-check` skill | **skill** change (vs baseline) |
| `a-deepseek-memory` | DeepSeek V4 Flash + `memory/sales-policy.md` | **memory** change (vs baseline) |
| `config-b-sonnet` | Claude Sonnet 5.5 | **model** change |
| `config-c-opus` | Claude Opus 5.5 | **model** change (more expensive) |

All of them use OpenRouter, the `file` toolset, 10 max turns and a 120 s budget.

- **Skills** are copied into the run's private Hermes home and loaded with `-s`. Hermes only warns about an unknown skill, so the platform checks itself and fails the run with a clear error.
- **Memory** files are combined into the run's `MEMORY.md`, which Hermes puts into the system prompt. Hermes' 2,200-character limit is enforced. The agent can't write to memory (the memory tool is off), so runs can't influence each other.

**Adding a config:** add an entry to `configs.json` with a new id and restart the API. To add a skill, create `skills/<name>/SKILL.md`. To add memory, create `memory/<file>.md` and list it in the config's `memoryFiles`.

---

## Results of real experiments

### 1. Model change: DeepSeek V4 Flash (A) vs Claude Sonnet 5.5 (B)

The first 10 tasks × 2 configs × 5 repeats = **100 runs**, 0 errors, **$0.27** in total.

| | DeepSeek V4 Flash | Claude Sonnet 5.5 |
|---|---|---|
| Pass rate | **96%** (48/50) | **90%** (45/50) |
| Average time per run | 8.3 s | 8.3 s |
| Agent cost, 50 runs | $0.005 | $0.248 |

> **No reliable difference in pass rate** (−6.0 points, 95% CI −20 to +6); **B is about as fast and 48× more expensive** per run (CI 34× to 65×).

- Sonnet's failures were about formatting and verbosity: showing its working, or 4 sentences instead of 3.
- DeepSeek's failures were factual: a wrong sort and a false claim.
- 7 of the 10 tasks were 5/5 for both models. The set was too easy to separate them (a ceiling effect), so 6 harder tasks were added afterwards.

**Takeaway:** on these tasks, the 48× more expensive model bought no measurable quality.

### 2. Memory change: DeepSeek V4 Flash, without (A) vs with sales-policy memory (B)

`discount-reply`: a customer asks for 25% off monthly billing, WhatsApp reminders and how to book a call. The correct reply depends on a policy stored **only** in memory: at most 10% off and only with annual billing, never promise a date for WhatsApp, and always include the booking link. 1 task × 3 repeats, **$0.012**.

| | Without memory | With memory |
|---|---|---|
| Passed | **0/3** | **3/3** |
| Typical judge reason | "offers 10% off with monthly billing… claims WhatsApp reminders are already available… omits the booking link" | "limits the discount to 10% tied to annual billing, declines 25%, gives no WhatsApp date, includes the link" |

Same model, only memory changed: a clear difference. Because there is only one task, the Quality card honestly says **"Needs ≥ 2 tasks"** for a confidence interval rather than claiming one. The per-run evidence is on the run pages.

> **A sandbox lesson from this experiment.** In an earlier version, configs *without* memory sometimes passed. The run pages showed why: the agent searched the computer and read `memory/sales-policy.md` from the repo. The fix has four parts:
> - run folders moved outside the repo;
> - writes are restricted to the run folder;
> - every run gets the same "work only in your folder" rule;
> - every file-tool path is checked after the run, and **any access outside the run folder turns the run into an error**, so it can't count as a pass.
>
> Results from before this fix are not used here.

---

## Approximate costs

Real prices from OpenRouter, measured in the development database.

| Item | Typical cost |
|---|---|
| DeepSeek V4 Flash, one run | $0.0001 (short task) to $0.002 (multi-step, file-heavy) |
| Claude Sonnet 5.5, one run | $0.003 to $0.03 |
| Claude Opus 5.5, one run | about $0.04 |
| LLM judge (`z-ai/glm-5.3-flashx`), one call | about $0.0004 |
| **Mock runner + mock judge (default)** | **$0** |

**Estimated cost of whole experiments** (16 tasks × 3 repeats = 96 runs, about 48 judge calls):

| Experiment | Estimate |
|---|---|
| DeepSeek vs DeepSeek + skill (or + memory) | **about $0.10–0.20** |
| DeepSeek vs Sonnet 5.5 | **about $0.50–0.80** |
| DeepSeek vs Opus 5.5 | **about $2** |

Total spent building and testing this platform: **about $0.83** (25 experiments, 186 runs).

Cost is kept down by four things:
- the free mock mode is the default;
- the paid judge is used only with the real runner;
- a per-run time budget and hard timeout;
- one run at a time by default (`QUEUE_CONCURRENCY=1`).

The comparison page shows the agent cost and the judge cost separately.

---

## Configuration

Environment variables for the API (`apps/api`). Put secrets only in `apps/api/.env`.

| Variable | Default | Meaning |
|---|---|---|
| `RUNNER` | `mock` | `mock` (free, fake agent) or `hermes` (real, paid). An unknown value stops startup. |
| `JUDGE` | `openrouter` if `RUNNER=hermes`, else `mock` | The judge for free-text tasks |
| `JUDGE_MODEL` | `z-ai/glm-5.3-flashx` | The judge model on OpenRouter |
| `OPENROUTER_API_KEY` | none | Used by Hermes and the judge. Passed only through the environment, never logged, masked in errors. |
| `QUEUE_CONCURRENCY` | `1` | Runs in flight at once |
| `DB_PATH` | `data/evals.db` | SQLite file. Use another file to experiment without touching real results. |
| `RUNS_DIR` | `<OS temp>/agent-evals-runs` | Per-run work folders. They're outside the repo on purpose, so an agent can't stumble on seed answers. |
| `HERMES_BIN` | `hermes` | Path to the Hermes CLI (tests point it at a fake) |
| `HERMES_BASE_HOME` | `.hermes-base` | The shared Hermes install that run homes link to (git-ignored) |
| `SEED_DIR` | `seed` | Where `tasks.json` and `configs.json` are read from |
| `ASSETS_DIR` | repo root | Where `skills/` and `memory/` are read from |
| `PORT` | `3000` | API port |
| `API_URL` (web) | `http://localhost:3000` | Where the Vite dev proxy sends `/api` |

---

## Testing

```bash
npm test
```

This runs **89 tests** with Node's built-in runner (`node --test`), using **no network and no money**:
- **packages/shared:** config diff (4);
- **apps/api** (85):
  - the full experiment flow over HTTP with the mock runner;
  - the Hermes runner against a **fake `hermes` binary** (isolation, skills, memory, timeout, key redaction, sandbox escape);
  - session parsing on a real trimmed export;
  - the regex scorer and LLM judge (bad JSON, retry, HTTP errors);
  - statistics;
  - seed data, which checks every regex against its reference answer and near-misses and recomputes the facts behind answers;
  - DB migrations and the sandbox detector.

The web app is type-checked with `npm run build -w apps/web`.

Read-only helper for a running API:

```bash
node apps/api/scripts/check-experiment.mjs <experimentId>
```

---

## Assumptions

- **Local, single-user tool.** There's no authentication. It runs on a developer's machine, with one API process owning the database.
- **Tasks and configs are code.** They're edited in JSON and reviewed in git rather than in a UI. A task whose meaning changes gets a new id.
- **"Better" means a higher pass rate** on the chosen tasks. Speed and cost are reported next to it, not folded into one score, because how much quality is worth what price is a product decision.
- **Binary pass/fail per run.** Partial credit would make rubrics vaguer and judges noisier.
- **Tasks are the unit of evidence.** Repeats measure run-to-run noise, but conclusions generalise over tasks, so confidence intervals resample tasks.
- **The LLM judge is good enough with a concrete rubric** at temperature 0. A judge failure is recorded as "not scored", never as an agent failure.
- **OpenRouter is the provider** for all models and the judge, so one key covers everything and costs come from one place.
- **The agent should work only with the files it's given.** Reading other files on the machine is treated as a sandbox violation.
- **Reported cost is the agent's cost.** The judge's cost belongs to the platform, so it's shown separately and not included in the A vs B cost comparison.

---

## Known limits

- **No OS-level read sandbox.** Hermes' file tools can read anywhere the user can.
  - Writes are restricted to the run folder, and the agent is told to stay in it.
  - Reads outside the folder are **detected after the run** and turned into errors, not prevented. Only file-tool path arguments are checked, so the configs use only the `file` toolset; enabling a terminal toolset would need a real sandbox.
  - A container per run would fix this properly.
- **The mock runner ignores skills and memory.** It passes at a fixed rate per config, so mock experiments test the platform, not the configs.
- **Experiments don't yet freeze a snapshot** of their configs and tasks. Editing a config in place changes how old experiments are labelled. Use new ids for meaningful changes.
- **Small samples.**
  - With 1 task, there's no quality CI, by design.
  - With 10–16 tasks, only large differences are detectable (the CI in experiment 1 was 26 points wide).
  - Real decisions need more tasks, not just more repeats.
- **The judge is a model**, so some judge variance remains. A judge error is shown as "not scored".
- **Skill effects aren't proven yet.** Hermes puts skills in a per-turn system prompt that isn't in the session export, so a run page can't show the skill text the way it shows memory.
- **A single process owns the queue.** Two API instances on one DB aren't supported. If the process dies mid-run, that run is re-queued on restart.
- **Hermes CLI coupling.** The runner depends on Hermes' CLI flags and session-export format (tested on v0.21.7). The parser accepts both known export layouts.
- **Run folders are kept** in the OS temp folder for inspection and aren't cleaned up automatically. Per-run Hermes homes *are* deleted.
- **Results from before the sandbox fix** may be contaminated (see the results section). They remain in the local database but aren't used here.

---

## Repository layout

```
agent-evals/
├── apps/
│   ├── api/                     NestJS API
│   │   ├── seed/                tasks.json, configs.json (source of truth)
│   │   ├── scripts/             check-experiment.mjs (read-only), judge-once.mjs
│   │   └── src/
│   │       ├── catalog/         GET /tasks, /configs
│   │       ├── experiments/     create / read experiments, the run queue
│   │       ├── runner/          MockRunner, HermesRunner, per-run Hermes home, sandbox check
│   │       ├── scoring/         regex scorer, LLM judge, mock judge
│   │       ├── stats/           pure statistics (bootstrap CIs, headline)
│   │       ├── db/              schema, migrations, seed loader
│   │       └── common/          path safety, seeded RNG, assets
│   └── web/                     Vue 3 app: 3 pages, components, polling
├── packages/shared/             types shared by API and web, config diff
├── skills/                      Hermes skills (careful-data-check)
├── memory/                      memory files (sales-policy.md)
├── fixtures/                    Hermes session exports for parser tests
├── ARCHITECTURE.md              design document
└── README.md
```

### API

| Method | Path | |
|---|---|---|
| GET | `/api/tasks`, `/api/tasks/:id` | Active tasks; one task, even if retired |
| GET | `/api/configs` | All configs |
| POST | `/api/experiments` | `{ name, configAId, configBId, taskIds?, repeats }` |
| GET | `/api/experiments`, `/api/experiments/:id` | List with run counts; one experiment with its runs |
| GET | `/api/experiments/:id/summary` | Statistics: quality, speed, cost, headline |
| POST | `/api/experiments/:id/retry-errors` | Re-queue errored runs |
| GET | `/api/runs/:id` | One run with its steps |
