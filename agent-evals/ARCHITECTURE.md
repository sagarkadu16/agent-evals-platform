# Architecture: Agent Evals Platform

This platform runs AI agent tasks through the **Hermes Agent CLI** under two configurations (A and B), scores every run, and reports whether B is better than A in **quality, speed and cost**, each with a **bootstrap confidence interval**.

It answers one question with evidence instead of impressions: *did changing the model, adding a skill or turning on memory make the agent better, worse, or no different on these tasks, and by how much, given the noise?*

Setup, results and costs are in the [README](README.md). This document covers how the system is built and why.

---

## 1. System overview

```
 Browser (Vue 3, :5173)
   │  fetch('/api/...')            Vite dev proxy forwards /api → :3000 (no CORS needed)
   ▼
 NestJS API (:3000, prefix /api)
   ├─ CatalogController ─────────── GET /tasks, /tasks/:id, /configs
   ├─ ExperimentsController ─────── POST/GET /experiments, GET /experiments/:id(/summary),
   │                                POST /experiments/:id/retry-errors, GET /runs/:id
   │
   ├─ ExperimentsService ── validates input, builds the run plan, reads results, calls stats
   ├─ ExecutorService ───── in-process queue: claim → run → score → save
   │     ├─ AgentRunner  (AGENT_RUNNER token)  MockRunner | HermesRunner ──► hermes CLI ──► OpenRouter
   │     │                                                   ├─ per-run HERMES_HOME (skills, memory, SOUL.md)
   │     │                                                   └─ sandbox check on the trace
   │     └─ ScoringService                     RegexScorer | JudgeScorer ──► OpenRouter
   │                                                         | MockJudgeScorer
   ├─ stats.ts (pure) ───── quality (paired task bootstrap), speed & cost (run bootstrap), headline
   └─ DatabaseService ───── node:sqlite (DatabaseSync), file data/evals.db
         SeedService ────── seed/tasks.json + seed/configs.json (+ skills/, memory/) → DB on every startup
```

### Repository layout

| Path | What lives there |
|---|---|
| `packages/shared` | Types shared by API and web (`TaskDef`, `AgentConfig`, `RunResult`, `ExperimentSummary`, `MetricComparison`, …) and one pure runtime helper, `diffConfigs` (used by the web "What changed" box), with its tests. |
| `apps/api/src/db` | Schema, `DatabaseService` (opens the DB, adds missing columns), `SeedService` (validates and upserts seeds). |
| `apps/api/src/catalog` | Read-only access to tasks and configs. |
| `apps/api/src/experiments` | Experiment creation and reads (`ExperimentsService`), the queue (`ExecutorService`), and pure run-plan and timeout helpers. |
| `apps/api/src/runner` | The `AgentRunner` contract, `MockRunner`, `HermesRunner`, the per-run Hermes home (`hermes-home.ts`), the sandbox check (`sandbox.ts`), and pure Hermes arg and export parsing. |
| `apps/api/src/scoring` | The `Scorer` contract, regex scorer, LLM judge, mock judge, and the `ScoringService` dispatcher. |
| `apps/api/src/stats` | Pure statistics (no Nest, no DB). |
| `apps/api/src/common` | Seeded RNG, path-safety helpers, asset locations (`skills/`, `memory/`). |
| `apps/api/seed` | `tasks.json` (16 tasks) and `configs.json` (5 configs): the source of truth for both. |
| `skills/`, `memory/` (repo root) | Hermes skills (`<name>/SKILL.md`) and memory files referenced by configs. |
| `apps/api/scripts` | `check-experiment.mjs` (read-only report) and `judge-once.mjs` (one real judge call). |
| `fixtures` | Hermes session exports used by parser tests (hand-made, plus a trimmed real export). |
| `apps/web/src` | Router, API client, polling and draft composables, formatters, 3 pages, 7 components. |

### Stack and conventions

- **npm workspaces** monorepo: `apps/api`, `apps/web`, `packages/shared`.
- **Native ESM everywhere**: `"type": "module"`, `moduleResolution: nodenext`, and relative imports end in `.js`.
- **No ORM, no migration tool**: Node's built-in `node:sqlite` (`DatabaseSync`), with hand-written SQL.
- **Tests**: Node's built-in runner (`node --test`) on compiled output. `npm test` at the root runs the shared tests (4) and the API tests (85).
- **Frontend**: Vue 3 + TypeScript + Vite, `vue-router`, plain CSS with design tokens and dark mode, no UI library.

---

## 2. Data model

All tables live in one SQLite file (`DB_PATH`, default `apps/api/data/evals.db`). JSON values (lists, specs, files) are stored as `TEXT`.

| Table | Purpose | Key columns |
|---|---|---|
| `tasks` | What the agent must do and how it's graded | `prompt`, `scorer_type` (`regex`/`judge`), `scorer_spec` (JSON: `pattern`+`flags`, or `rubric`), `reference_answer`, `files` (JSON path → content), `tags` (JSON), `active` |
| `configs` | One way of running the agent | `model`, `provider`, `toolsets`, `skills`, `memory_files`, `max_turns`, `run_budget_sec`, `mock_pass_rate` |
| `experiments` | A comparison of config A vs config B | `config_a_id`, `config_b_id`, `task_ids` (JSON), `repeats`, `status` (`queued`/`running`/`done`), `created_at`, `finished_at` |
| `runs` | One task × one config × one repeat | `seq` (queue order), `status` (`queued`/`running`/`done`/`error`), `passed` (NULL/0/1), `score_reason`, `final_answer`, agent `input_tokens`/`output_tokens`/`cost_usd`, judge `judge_input_tokens`/`judge_output_tokens`/`judge_cost_usd`, `duration_ms`, `error`, `session_id`, `started_at`, `finished_at` |
| `steps` | The agent's trace for a run | `idx`, `kind` (`tool`/`result`/`model`), `tool_name`, `content`, `timestamp_ms` |

Indexes: `runs(experiment_id)`, `runs(status, seq)` (for queue claims), `steps(run_id)`.

**`passed` has three states on purpose**: `1` pass, `0` fail, `NULL` *not scored*. A run isn't scored after a runner error, a sandbox violation, a broken scorer spec or a judge error. Only `0`/`1` count toward pass rates.

**Migrations are additive.** On startup, `DatabaseService.addMissingColumns` adds columns introduced after a DB was created (`tasks.active`, `tasks.tags`, `configs.memory_files`) with safe defaults. Existing results are never dropped.

---

## 3. Lifecycle of an experiment

### 3.1 Creating it: `POST /api/experiments`

Body: `{ name, configAId, configBId, taskIds?, repeats }`.

1. **Validation** (`ExperimentsService.validate`):
   - the name isn't empty;
   - both configs exist and differ;
   - `repeats` is an integer from 1 to 50;
   - `taskIds`, if given, isn't empty and every id is known and **active**. If it's omitted, all active tasks are used.
2. **Run plan** (`buildRunPlan`, pure): for each repeat → for each task → `[A, B]`. Runs alternate A, B, A, B, and every task finishes repeat 0 before any task starts repeat 1.
3. **One transaction** inserts the experiment and all its runs with a globally increasing `seq`, so experiments are served first come, first served.
4. The executor is kicked.

### 3.2 Executing runs: `ExecutorService`

```
queued ──claim──► running ──runner + scorer──► done   (passed = 1 / 0 / NULL)
                     │                     └─► error  (runner failed, timed out or left its folder; passed = NULL)
                     └── process dies ──► reset to queued on next startup
```

1. **Claim**: one SQL statement moves the next `queued` run (lowest `seq`) to `running` (`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING …`). `node:sqlite` is synchronous, so two claims can never interleave. The experiment moves from `queued` to `running`.
2. **Concurrency**: up to `QUEUE_CONCURRENCY` runs are in flight (default 1). When one finishes, the next is claimed.
3. **Fresh folder**: `RUNS_DIR/<runId>` is deleted and re-created on every attempt, and the task's `files` are written into it (paths checked by `resolveInside`). `RUNS_DIR` defaults to the **OS temp folder**, outside the repo, so an agent that looks around can't find seed answers or memory files next to its folder.
4. **Hard timeout**: `config.runBudgetSec + 30 s`. `withTimeout` races the run against a timer and **aborts an `AbortSignal`**; the HermesRunner kills its child process on that signal. A timeout becomes a run `error`.
5. **Scoring**: only runs *without* a runner error are scored. Errored runs keep `passed = NULL`, so they count as errors, not failures.
6. **Save**: one transaction updates the run row and replaces its steps (a retried run overwrites its old steps).
7. **Finish**: when no run of the experiment is `queued` or `running`, the experiment becomes `done` with `finished_at` set.

**Restart recovery**: on startup (`onApplicationBootstrap`), any run still `running` is reset to `queued`. Its result was lost with the process, so it simply runs again.

**Retry**: `POST /experiments/:id/retry-errors` resets `error` runs (and their score and judge fields) to `queued` and re-opens the experiment.

### 3.3 Reading results

| Endpoint | Returns |
|---|---|
| `GET /experiments` | All experiments, with run counts per status (drives the list's progress bars). |
| `GET /experiments/:id` | One experiment, its counts, and a light list of its runs. |
| `GET /experiments/:id/summary` | Statistics (section 6). |
| `GET /runs/:id` | One run with its steps. |

---

## 4. Runners

### 4.1 The contract

```ts
interface AgentRunner { readonly name: string; run(input: RunInput): Promise<RunResult> }
RunInput = { runId, task, config, workDir, signal? }
```

**`run()` never throws.** On failure it returns a `RunResult` with `error` set, so one bad run is recorded instead of crashing the queue. The executor still wraps the call in `try/catch` as a second line of defence.

`RunnerModule` provides the `AGENT_RUNNER` injection token through a factory that reads `RUNNER` (`mock`, the default, or `hermes`) **once at startup**. An unknown value fails startup with a clear error.

### 4.2 MockRunner

A free, fake agent for building and demoing the platform.
- **Deterministic**: an RNG (`mulberry32`) is seeded with an FNV-1a hash of `runId`. The same run always gives the same result; different runs vary.
- It passes with probability `config.mockPassRate` (default 0.7). A pass returns `task.referenceAnswer`; a fail returns a plausible wrong answer (a nearby number for numeric answers).
- It returns 2–4 fake steps and fake token counts, with `costUsd: 0`, after a 100–400 ms delay.
- It **ignores skills and memory**. Mock experiments exercise the platform, not the configs.

### 4.3 HermesRunner

```
hermes chat --query-file WORKDIR/prompt.txt --oneshot -Q --provider P -m MODEL
            --max-turns N --run-budget SECONDS --source evals --in WORKDIR -t TOOLSETS
            --ignore-user-config --yolo [-s SKILL,...]
hermes sessions export --session-id ID WORKDIR/session-export
```

Both commands run with `HERMES_HOME=<per-run home>` and `HERMES_WRITE_SAFE_ROOT=WORKDIR`.

- **The prompt goes in a file.** `-q` is never used because it hangs.
- **`spawn` with an argument array**, never a shell string, so prompts and paths can't inject commands.
- **stdout is the final answer.** The `session_id: <id>` line is read from **stderr**.
- **The API key reaches Hermes only through the environment.** It never appears in args. Any error text is passed through `redact()`, which masks the key. Hermes' own `agent.log` is copied into the run folder for debugging, also redacted.
- **The session is exported even after a failed chat**, because tokens were spent and must be recorded.
- **An export failure doesn't fail the run.** The answer is kept and scored, with no steps and `costUsd = null`.
- If `OPENROUTER_API_KEY` is missing (for provider `openrouter`), the run fails fast without spawning.

#### Per-run Hermes home: how skills and memory are applied (`hermes-home.ts`)

`HERMES_HOME` moves *everything* Hermes reads: config, `.env`, memories, skills, SOUL.md and the session DB. Without isolation, every run would pick up the developer's own `~/.hermes` (their persona, skills and memory), and A and B could not differ only in what the config says. So each run gets a **throwaway home** in the OS temp folder:

| In the run home | Comes from |
|---|---|
| `skills/<name>/SKILL.md` | Copied from `skills/<name>/` for each skill in `config.skills`; loaded with `-s`. |
| `memories/MEMORY.md` | The config's `memoryFiles` joined with Hermes' entry delimiter (`\n§\n`), checked against Hermes' 2,200-character limit. Hermes injects it into the system prompt. |
| `SOUL.md` | Hermes' default persona plus the **harness rule** (below). It's identical for A and B, so it's never the difference between them. |
| `installs/` | A **symlink** to a shared base home (`apps/api/.hermes-base`), which is prepared once with `hermes sessions list`. |
| `logs/`, session DB | Written by Hermes during the run. |

The home is **deleted in `finally`**; the run folder is kept for inspection.

- **Fail fast.** Hermes only *warns* about an unknown skill and carries on. The runner checks the skill folders and memory files itself, before spawning anything, and returns a clear error.
- **Memory is read-only for the agent.** With `-t file`, Hermes' memory tool is off, so a run can't write notes that would leak into later runs.
- **Why the symlinked base home.** Each fresh home triggers a ~25 s, ~350 MB dependency install. Preparing one base home and linking its `installs/` makes per-run setup take seconds and ~5 MB. Setting `HERMES_DISABLE_LAZY_INSTALLS=1` instead breaks Hermes startup.

#### Sandbox (`sandbox.ts`)

Hermes' file tools can **read** anywhere the user can. This was found in practice: on the memory task, a config *without* memory searched the disk, read `memory/sales-policy.md` from the repo, and passed. There are four layers of defence:

1. **Location.** Run folders live in the OS temp folder, not in the repo.
2. **Writes.** `HERMES_WRITE_SAFE_ROOT` restricts writes to the run folder.
3. **Instruction.** The harness rule in SOUL.md tells the agent to work only with the files in its folder, and to say so if something is missing instead of looking elsewhere.
4. **Detection, the actual guarantee.** After the run, `findSandboxViolations` parses the arguments of every tool call in the trace (`path`, `file_path`, `dir`, …). It resolves each one against the run folder, handling `~`, relative paths and macOS `/var` ↔ `/private/var` aliases. Any path outside the folder makes the run an **error**: *"sandbox violation: the agent accessed files outside its run folder: read_file …"*. A violation is never scored, so it can't become a pass.

#### Session export parsing (`parseSessionJsonl`, pure)

The real export turned out to be **one JSON object with a `messages` array**, not one message per line. The parser accepts both layouts:

| Message | Becomes |
|---|---|
| `assistant` with `tool_calls` (an array, or a JSON string) | one `tool` step per call (tool name + pretty-printed arguments) |
| `tool` | a `result` step (`tool_name` + content, pretty-printed if JSON) |
| `assistant` without tool calls, `finish_reason: "stop"` | a `model` step |
| `user` and anything else | skipped |

- Timestamps are converted from seconds to ms.
- **Input tokens = `input_tokens + cache_read_tokens + cache_write_tokens`.** Hermes reports cached tokens separately; Sonnet showed `input_tokens: 6` with 9k cached.
- Cost is `estimated_cost_usd`.
- A malformed message is skipped instead of failing the run.

---

## 5. Scoring

```ts
interface Scorer { score(task, result): Promise<{ passed: boolean | null; reason: string; judgeTokens?; judgeCostUsd? }> }
```

Scorers follow the same rule as runners: they **never throw**. `ScoringService` picks the scorer by `task.scorerType` and has a final `catch` that turns any surprise into `passed = null`.

### 5.1 RegexScorer
- Tests `scorerSpec.pattern` (with optional `scorerSpec.flags`) against the **trimmed** final answer.
- The reason is `matched /pattern/`, or `no match for /pattern/; got: <first 100 chars>` (`(empty answer)` if empty).
- A missing or invalid pattern gives `passed = null` ("scorer spec error"): it's our bug, not the agent's failure.
- Patterns are anchored (`^…$`), so "reply with only X" is enforced: showing working before the answer fails.

### 5.2 JudgeScorer (LLM-as-judge)
- It calls OpenRouter chat completions with `fetch`:
  - the model comes from `JUDGE_MODEL` (default `z-ai/glm-5.3-flashx`);
  - `temperature: 0`;
  - a 60 s timeout;
  - `usage: { include: true }` to get the cost.
- **Prompt:** the task prompt, the rubric, the reference answer (if any) and the agent's answer. It asks for strict JSON only: `{"pass": true|false, "reason": "..."}`.
- **Rubrics are concrete PASS/FAIL checklists** ("PASS only if … FAIL if …"), not vague quality scales.
- **Defensive parsing:**
  - strip code fences;
  - take the outermost `{…}`;
  - `JSON.parse` inside `try/catch`;
  - require `pass` to be a real boolean.
- **One retry on bad JSON**, showing the model its bad reply plus a correction message. At temperature 0, resending the same request would repeat the same mistake.
- **Failure:** still-bad JSON, an HTTP error or no key gives `passed = null` with `reason = "judge error: …"`. **A judge problem never counts as an agent failure.**
- Judge tokens and cost are **summed across both attempts** and saved, even when the judge fails.

### 5.3 Which judge runs
`JUDGE` is `openrouter` or `mock`. The default is `openrouter` only when `RUNNER=hermes`, otherwise `mock`. The **MockJudgeScorer** passes when the answer equals the reference answer and costs nothing. This guarantees mock experiments never spend money, even with a key in `.env`.

---

## 6. Statistics (`stats/stats.ts`, pure)

The summary answers three separate questions (is B better, faster, cheaper?) and does **not** merge them into one score. Trading quality against cost is a product decision, so the numbers are put side by side.

**Per config**: runs, scored, passed, errors, pending, pass rate (`passed / scored`), average duration, agent cost, judge cost, total cost.
**Per task**: scored, passed and pass rate for A and B.

### 6.1 Quality: paired cluster bootstrap over tasks

**Difference** = passRate(B) − passRate(A), on scored runs, **only over tasks with scored runs for both configs**. This keeps the comparison paired.

1. Each task is a cluster: `{aPassed, aScored, bPassed, bScored}`.
2. For 5000 iterations, draw tasks **with replacement**, sum the clusters, and recompute the pooled difference.
3. Sort, and take the 2.5th and 97.5th percentiles (with linear interpolation).
4. The RNG is seeded (seed 42), so the same data always gives the same interval.

**Why resample tasks, not runs.** Runs of the same task are correlated: an easy task passes all its repeats. Resampling single runs would treat 100 runs as 100 independent pieces of evidence and give a falsely narrow interval. Resampling whole tasks asks the honest question: *if we had picked different tasks, how much could the result move?* Keeping A and B of the same task together ("paired") cancels out task difficulty.

**Quality reasons.** Instead of a bare "inconclusive", the result carries the specific reason, which the UI shows as a label plus a sentence:

| Reason | Label | When |
|---|---|---|
| `no-data` | No data yet | No task has scored runs on both sides |
| `too-few-tasks` | Needs ≥ 2 tasks | Fewer than 2 comparable tasks. A 1-task bootstrap has zero width and would imply false certainty. |
| `no-difference` | No difference | A and B have the same pass rate on every task |
| `ci-includes-zero` | Unclear | There is a difference, but the 95% CI includes 0 |
| `ci-above-zero` / `ci-below-zero` | B better / B worse | The whole CI is above or below 0 |

### 6.2 Speed and cost: stratified bootstrap over runs

- **Speed** is the **median** duration per run. The median is used because one slow run (a provider hiccup) would otherwise dominate. In a real experiment the averages were 30.8 s vs 18.8 s, but the medians were 19.4 s vs 18.0 s.
- **Cost** is the **mean** agent cost per run, because the total bill is what matters, so outliers count. The **cost per passed run** is shown next to it.
- Only `done` runs count, from tasks that have values on both sides. Errored runs are left out.
- **The ratio is B / A.** For the CI, each iteration resamples runs *within each task and config*. This keeps the task mix fixed and measures run-to-run noise, the main source of variation in time and cost, so it works even with one task. It needs at least 2 runs per config.
- **Verdict:** if the whole CI is below 1×, B is *faster* or *cheaper*. If the whole CI is above 1×, B is *slower* or *more expensive*. Otherwise they're *about the same*.
- Judge cost is **not** included in the config's cost. It's the platform's cost, and it's shown separately.

### 6.3 Headline

A one-line answer built from the three verdicts, for example *"No reliable difference in pass rate (−6.0 points); B is about as fast and 48× more expensive."*

---

## 7. Tasks, configs, skills and memory (seed data)

- **The source of truth is `seed/tasks.json` and `seed/configs.json`.** They're read on every startup, validated, and upserted in **one transaction** (all or nothing).
- **Validation:**
  - required fields are present;
  - regex tasks need a `pattern` and judge tasks need a `rubric`;
  - `referenceAnswer` is a string;
  - `mockPassRate` is between 0 and 1;
  - `files` is an object mapping **safe relative paths** to string content;
  - `tags` are short lowercase words;
  - skill names match `^[a-z0-9][a-z0-9_-]*$`;
  - `memoryFiles` are safe paths under `memory/`.
- **Task lifecycle.** A task removed from `tasks.json` becomes `active = 0`. It's **retired, not deleted**: its old runs still reference it and `GET /tasks/:id` still returns it, but `GET /tasks` and new experiments exclude it. Adding it back reactivates it.
- **Rule for editing tasks.** If a task's prompt or scorer changes meaningfully, give it a **new id** (e.g. `change-due-v2`) and remove the old one. Experiments don't snapshot task content, so reusing an id would mix old and new results.

### Tasks (16: 8 regex, 8 judge)

| id | Scorer | Tags | Tests |
|---|---|---|---|
| `change-due` | regex | reasoning | arithmetic with steps, strict number format |
| `third-friday` | regex | reasoning, format | date reasoning, ISO format |
| `sort-words` | regex | format | case-insensitive sort, strict output format |
| `extract-503` | regex | data | value extraction from a log, with decoys |
| `file-csv-sum` | regex, files | data | read a CSV (with a quoted comma), filter, sum |
| `lead-triage` | regex, files | sales, data, multi-step | apply several qualification rules to every row of a lead list |
| `invoice-reconcile` | regex, files | data, multi-step | match invoices to payments with messy IDs and amounts |
| `missing-file-recovery` | regex, files | robustness | the requested `config.json` is missing; the agent must find the value in the files that do exist |
| `explain-retry` | judge | writing | short explanation (control task) |
| `explain-idempotency` | judge | writing | explanation with a sentence limit |
| `multi-part-format` | judge | writing, format | four formatting rules at once |
| `file-bug-review` | judge, files | code | find an off-by-one bug and give the fix |
| `file-action-items` | judge, files | writing | extract exactly the committed action items |
| `prompt-injection` | judge, files | robustness, writing | a file contains instructions the agent must ignore |
| `sales-followup` | judge, files | sales, writing | write a follow-up grounded in call notes |
| `discount-reply` | judge, files | sales, writing, memory | reply to a customer under a policy that exists **only in memory** |

`seed-tasks.test.ts` checks every task before any money is spent:
- every regex is tested against its own reference answer and against plausible near-misses;
- the facts behind the answers are recomputed (the date, the CSV totals, the lead and invoice results);
- for `discount-reply`, the policy facts (the 10% cap, annual billing, the booking link) must appear in the reference answer and must **not** appear in the prompt or task files. Otherwise the task wouldn't test memory.

### Configs (5)

| id | Model | Skills | Memory | Compared with the baseline, it tests |
|---|---|---|---|---|
| `config-a-cheap` | DeepSeek V4 Flash | none | none | (baseline) |
| `a-deepseek-skill` | DeepSeek V4 Flash | `careful-data-check` | none | a **skill** |
| `a-deepseek-memory` | DeepSeek V4 Flash | none | `memory/sales-policy.md` | **memory** |
| `config-b-sonnet` | Claude Sonnet 5.5 | none | none | a **model** |
| `config-c-opus` | Claude Opus 5.5 | none | none | a **model** (more expensive) |

All of them use OpenRouter, the `file` toolset, 10 max turns and a 120 s budget. Each variant changes **one** field from the baseline, so a difference in results can be attributed to it.

- **Skill**: `skills/careful-data-check/SKILL.md` is a checklist for data tasks (read every file fully, handle quoted CSV fields, normalise IDs, check every row against every rule, mind the boundaries, output the exact format).
- **Memory**: `memory/sales-policy.md` holds three rules (at most 10% off and only with annual billing; WhatsApp isn't available and no date may be promised; always include the booking link).

---

## 8. Frontend (`apps/web`)

| Route | Page | Shows |
|---|---|---|
| `/` | `ExperimentsPage` | The start form and the experiments list (configs, live progress bar, start time). |
| `/experiments/:id` | `ExperimentPage` | "What changed", the headline, Quality / Speed / Cost scorecards, the per-config and per-task tables, **Retry errored runs**, and the runs list filtered by `?task=…&config=…#runs`. |
| `/runs/:id` | `RunPage` | The error banner first (if errored); task, config and result badge; duration, tokens and cost; the scorer's reason; the final answer; the prompt and reference answer; the **step timeline** (`StepCard`). |

**The start form:**
- `ConfigPanel` ×2 show each config's full spec side by side (model, provider, tools, skills, memory, max turns, budget). **Fields that differ are highlighted.**
- A swap button switches A and B.
- A banner warns when more than one thing differs.
- The default pair is a plain config as A and a config one field away from it as B.
- `TaskPicker` has search, tag filter chips with counts, a filter-aware "Select all N shown", and task cards showing the scorer type, file count and tags.
- `useLocalDraft` keeps the whole form in `localStorage`, so it survives navigating to a run and back.

**The comparison page:**
- `ConfigDiff` is the "What changed (A → B)" box. It's green for a clean single-variable test and amber when several things changed.
- `ComparisonSummary` shows the headline and three cards:
  - each card has a verdict pill, the A → B values and its CI;
  - the Quality card also has a `CiBar`;
  - each card states its method in one line.
- CI text is written in the direction of the claim, e.g. "1.2× to 2.1× faster".

**Infrastructure:**
- **API client** (`api.ts`): one typed `fetch` wrapper. Non-2xx replies throw with the server's message.
- **Polling** (`usePolling`):
  - calls the loader now and then every **3 s**;
  - the loader returns whether to continue (polling stops when `done`);
  - the interval is **cleared on unmount**;
  - `start()` restarts it after a retry.
- **`ExperimentProgress`**: a segmented bar (done / error / running) with a status line ("Waiting for N earlier experiments", "Running · N in progress", "Finished").
- **`<RouterView :key="$route.path">`**: switching experiments remounts the page, while changing the run filter (query or hash) doesn't.
- **Vite proxy**: the page calls `/api` on its own origin and Vite forwards it to `API_URL`, so no CORS setup is needed.

---

## 9. Design decisions

Format: **decision | alternative | why**.

### Backend core
| Decision | Alternative | Why |
|---|---|---|
| The DB is the queue (`status` + `seq`), with an atomic claim | An in-memory array of run IDs | A crash loses nothing; restart recovery and retry are one `UPDATE` each. |
| An explicit `seq` column for queue order | `rowid` or `created_at` | `rowid` can change after `VACUUM`, and many runs share a millisecond. `seq` keeps the A/B alternation exact. |
| Interleave A and B, and run all tasks per repeat before the next repeat | All A runs, then all B runs | Drift over time (latency, rate limits, provider changes) hits both configs equally. |
| The timeout fires an `AbortSignal` as well as marking `error` | Only race a timer | Without killing the child process, a "timed out" Hermes run keeps running and spending money. |
| Runner errors leave `passed = NULL` | Count them as failures | Infrastructure problems would otherwise look like agent mistakes and skew A vs B. |
| Score in the executor before saving, in the same transaction | A separate scoring pass | A run is never visible as `done` without its score. |
| The runner is chosen once at startup by `RUNNER`; unknown values fail fast | Choose per run, or silently fall back | A typo would otherwise produce a whole experiment of mock data that looks real. |
| `node:sqlite` with hand-written SQL, no ORM | Prisma or TypeORM | Zero dependencies, synchronous (which makes atomic claims trivial), and a small schema. |
| Add missing columns on startup | "Delete the DB after schema changes" | The dev DB holds paid experiments; additive-only changes are safe and keep results. |

### Hermes integration
| Decision | Alternative | Why |
|---|---|---|
| A throwaway `HERMES_HOME` per run | Use `~/.hermes`, or one shared eval home | It's the only way to make *the config* (and nothing else) decide which skills and memory load. No state leaks between runs or from the developer's own setup. |
| Symlink `installs/` from one base home | A full fresh home per run | Avoids a ~25 s, ~350 MB install per run, while keeping each run's skills and memory separate. |
| Validate skills and memory before spawning | Trust Hermes | Hermes only warns about an unknown skill, so a typo would silently run the config without its skill. |
| Detect out-of-folder file access and mark the run as an error | Trust the prompt; or a container per run | It was a real leak that produced false passes. Detection is cheap, deterministic and tested. A container is the stronger fix, but heavy for a local tool (see Known limits). |
| The same harness rule in SOUL.md for every config | No rule | It reduces violations and is identical for A and B, so it can't bias the comparison. |
| Run folders in the OS temp folder | `apps/api/runs` | Next to the repo, an agent that looks around finds seed answers and memory files. |
| Parse both export layouts (nested `messages` and line-per-message) | Only the documented layout | The real export differed from the hand-made fixture; tolerating both keeps tests and reality aligned. |
| Input tokens include cache reads and writes | Use `input_tokens` as is | Cached tokens are still processed. Without them Sonnet looked like 6 input tokens, which makes token comparisons meaningless. |
| An export failure keeps the answer, with no steps or cost | Mark the run as an error | It's a logging problem, not an agent failure; the answer can still be scored. |
| Pure parsing in `hermes-session.ts`; the runner tested with a fake `hermes` binary | Mock `child_process`, or only test with real Hermes | Tests the real spawn, abort, export, isolation and redaction paths for free and in CI. |

### Scoring
| Decision | Alternative | Why |
|---|---|---|
| Three-state `passed` (true / false / null) | A boolean | "Couldn't score" (a bad spec, the judge down) must not be counted as a failure. |
| Retry the judge once, showing it its bad reply | Resend the same request | At temperature 0 the same request tends to repeat the same bad output. |
| The paid judge only with `RUNNER=hermes` (or an explicit `JUDGE=openrouter`) | Always use the real judge | Mock experiments stay free even with a key present. |
| Strict anchored regexes ("reply with only X") | Lenient matching, e.g. on the last line | Instruction-following is part of the task; this is a deliberate, documented choice. |
| Concrete PASS/FAIL rubrics | A 1–10 quality score | Binary checklists give far less judge variance, and pass rates are easy to compare. |

### Statistics
| Decision | Alternative | Why |
|---|---|---|
| Paired cluster bootstrap over tasks for quality | A bootstrap over individual runs, or a normal approximation | Runs within a task are correlated; resampling tasks gives an honest interval. |
| Compare only tasks scored on both sides | Use every scored run per config | Prevents a config from looking better because its hard-task runs errored out. |
| A pooled difference (total passes / total scored) | The mean of per-task differences | Matches the per-config pass rates shown. Trade-off: tasks with more scored runs weigh slightly more. |
| No quality CI below 2 comparable tasks, with an explicit "Needs ≥ 2 tasks" label | Report it anyway, or a bare "inconclusive" | A 1-task bootstrap has zero width and implies false certainty; the label says what's missing. |
| Quality, speed and cost reported separately | One combined score | Weighing quality against price is the user's decision; a merged score would hide it. |
| The median for speed, the mean for cost | Means for both | Latency has outliers that don't reflect the config; the bill is a sum, so the mean is the right summary. |
| A stratified run bootstrap for speed and cost | A task bootstrap like quality | Variation in time and cost is mostly run-to-run, and this works even for a single task. |
| A seeded RNG for every bootstrap | Unseeded | Reproducible numbers: the same data always gives the same CI. |

### Tasks and configs
| Decision | Alternative | Why |
|---|---|---|
| Seed JSON is the source of truth; no editor UI | CRUD endpoints and an editor | Changes are reviewed in git; it avoids versioning problems and keeps the scope small. |
| Retire (`active = 0`) instead of deleting | `DELETE` | Old runs reference tasks, so history stays readable. |
| Task files inline in `tasks.json` | A separate files folder | One file per task definition; the files are small; one transaction. |
| Path checks at seed time **and** at write time | Trust the seed | A path like `../../.env` must never be written outside the run folder. |
| Memory belongs to the config, not the task | Memory per task | Memory is part of the agent ("what it knows"). Tasks must stay identical between A and B; that's what makes the comparison fair. |
| Each config variant differs from the baseline in one field | Arbitrary combinations | A difference in results can be attributed to one cause; the UI warns when an experiment changes more. |

### Frontend
| Decision | Alternative | Why |
|---|---|---|
| Side-by-side config panels with differing fields highlighted | Two plain dropdowns | The most important fact about an experiment is *what differs*, so it's visible before starting. |
| Tag filters and search in the task picker | A flat checkbox list | With 16+ tasks, users pick by area ("sales", "data"); "select all shown" respects the filter. |
| The form draft in `localStorage` | Component state only | Users go to a run and come back; losing the form is frustrating. |
| Per-task cells link to `?task&config#runs` on the same page | A separate runs route | Keeps 3 routes; the filter is shareable and works with back and forward. |
| A `usePolling` composable with loader-controlled stop | `setInterval` in each page | Cleanup on unmount is written once; no leaked timers; restartable after a retry. |
| A symmetric CI scale around 0 | A fixed −100…+100 scale | Narrow intervals stay visible, and "does it cross 0?" is obvious. |
| A Vite proxy for `/api` | Enable CORS on the API | No server change; same-origin requests in dev. |
| Plain CSS with tokens and dark mode, no UI library | Vuetify or Tailwind | Small, fast, and matches the scope. |

---

## 10. Security and cost controls

- **The API key** lives only in `apps/api/.env` (git-ignored) and is loaded with `process.loadEnvFile`.
  - It's passed to Hermes through the environment and to OpenRouter in the `Authorization` header only.
  - It's never logged and never in args, and it's masked in error text and in the copied Hermes log (`redact`). Tests assert this.
  - Hermes' file tools refuse to read `.env` files.
- **No shell**: every process is started with `spawn(bin, args[])`.
- **Filesystem:**
  - task files go through `isSafeRelativePath` + `resolveInside`, and memory paths must stay under `memory/`;
  - each run gets its own folder outside the repo, writes are restricted to it, and reads outside it are detected (section 4.3);
  - the developer's `~/.hermes` is never read or written.
- **Cost:**
  - the mock runner and mock judge are the default;
  - the paid judge runs only with the real runner;
  - each run has a time budget and a hard kill;
  - concurrency is 1 by default;
  - `check-experiment.mjs` is read-only;
  - the start form warns that Hermes runs are paid.
- **Out of scope**: authentication and authorization (it's a local tool by design).

---

## 11. Configuration

| Variable | Default | Used by |
|---|---|---|
| `RUNNER` | `mock` | `mock` or `hermes` |
| `JUDGE` | `openrouter` if `RUNNER=hermes`, else `mock` | Which judge scorer is used |
| `JUDGE_MODEL` | `z-ai/glm-5.3-flashx` | The judge model on OpenRouter |
| `OPENROUTER_API_KEY` | (none) | Hermes and the judge (from `apps/api/.env`) |
| `QUEUE_CONCURRENCY` | `1` | Runs in flight |
| `DB_PATH` | `data/evals.db` | The SQLite file (use another file for mock testing) |
| `RUNS_DIR` | `<OS temp>/agent-evals-runs` | Per-run work folders |
| `HERMES_BIN` | `hermes` | Path to the Hermes CLI (tests point it at a fake) |
| `HERMES_BASE_HOME` | `.hermes-base` | The shared Hermes install that run homes link to |
| `SEED_DIR` | `seed` | Where `tasks.json` and `configs.json` are read from |
| `ASSETS_DIR` | `../..` (the repo root, relative to `apps/api`) | Where `skills/` and `memory/` are read from |
| `PORT` | `3000` | API port |
| `API_URL` (web) | `http://localhost:3000` | The Vite proxy target |

---

## 12. Testing strategy

All tests use `node --test` on compiled output (`npm test` at the root): **89 tests, no network, no money.**

| Area | What is covered |
|---|---|
| Config diff (shared) | identical configs; one field; list order ignored; several fields |
| MockRunner | determinism, shape, pass-rate extremes, default rate ≈ 0.7 |
| Run plan / timeout | A/B alternation and repeat order; `withTimeout` resolves, rejects and aborts |
| Executor flow (end to end over HTTP, mock runner, temp DB) | create → all done; regex runs scored; task files written; 400 on bad input; a restart re-queues `running`; retry-errors; `GET /tasks/:id` |
| Hermes parsing | the hand-made fixture and a **trimmed real export**; bad lines; an empty export; `session_id` on stderr; args (`-s` only with skills, never `-q`) |
| HermesRunner (fake binary) | happy path; non-zero exit with the key masked and tokens still recorded; a hang killed by abort; a missing key; **a separate home per run**; the base home prepared once and retried after failure; skills and memory copied in; an unknown skill fails fast; the agent log is redacted; SOUL.md has the rule; the write root is set; **an escape in the trace becomes an error** |
| Hermes home | memory joining and the limit; paths outside `memory/`; a missing file; a bad file creates no home; removing a home keeps the shared installs |
| Sandbox | inside paths (relative, `./`, absolute, `/private` alias); repo, parent, sibling-run and home paths flagged; prefix look-alikes; non-path arguments ignored; message formatting |
| Scorers | regex match, no match, empty, invalid and flags; judge parsing, prompt contents, retry, double failure, HTTP error, missing key; the key only in the header |
| Statistics | every quality reason; same seed gives the same CI; an error-only task is skipped; speed faster / similar; the median ignores an outlier; errors are excluded from speed; mock cost is 0; cost per passed run; the headline |
| Seed data | 16 tasks with tags; scorer mix; regex vs reference and near-misses; recomputed facts; memory-only facts kept out of the prompt; safe paths |
| Task lifecycle and migrations | retire and reactivate; an old DB gets the new columns and keeps its data; memory-file round-trip; bad memory paths rejected |

The web app is type-checked with `vue-tsc` (`npm run build -w apps/web`).

**Verified against real Hermes with a fake key (no spend):** skill lookup, memory present in the system prompt, the SOUL.md rule present with the persona kept, nothing written to `~/.hermes`, and temp homes deleted.

---

## 13. Results, assumptions and known limitations

The results of real experiments, approximate costs and the full list of assumptions are in the [README](README.md#results-of-real-experiments). In short:

- **Model change** (DeepSeek V4 Flash vs Claude Sonnet 5.5, 100 runs, $0.27): 96% vs 90%, with **no reliable difference** (CI −20 to +6 points). Sonnet was about as fast and **48× more expensive**. 7 of the 10 tasks were 5/5 for both models (a ceiling effect), which led to the 6 harder tasks.
- **Memory change** (DeepSeek with vs without the sales-policy memory, `discount-reply` × 3): **3/3 vs 0/3**.

**Known limitations**
- **No OS-level read sandbox.** Reads outside the run folder are detected afterwards (and the run voided), not prevented. Detection covers file-tool path arguments only; enabling a terminal toolset would need a container per run.
- **The mock runner ignores skills and memory.**
- **Experiments don't snapshot configs or task content.** Editing a config or task in place changes how old experiments are described; the "new id for changed content" rule must be followed. (Planned next: a frozen config snapshot with content hashes of skill and memory files, and a per-run record of what was loaded.)
- **Skill text isn't visible in the run trace.** In `--oneshot`, Hermes sends skills as an ephemeral system prompt that isn't in the session export. Memory is visible.
- **Small samples.** With 10–16 tasks only large differences are detectable, and one task gives no quality CI.
- **The judge is itself a model.** Temperature 0 and concrete rubrics reduce judge variance, but don't remove it.
- **Single process.** The queue lives in the API process; running two API instances on one DB isn't supported.
- **The timeout doesn't stop the MockRunner** (it ignores the signal); this only matters for Hermes, which is killed.
- **If saving a run fails**, the run stays `running` until the next restart re-queues it.
- **Run folders aren't cleaned up** (they're in the OS temp folder); per-run Hermes homes are.
- **Coupled to the Hermes CLI** (flags and export format, tested on v0.21.7).
- **Results recorded before the sandbox fix** may include runs that read files outside their folder. They remain in the local DB and aren't used in the reported results.
- `apps/api/tsconfig.build.tsbuildinfo` is tracked in git and changes on every build.
