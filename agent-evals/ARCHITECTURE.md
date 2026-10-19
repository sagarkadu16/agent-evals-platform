# Architecture: Agent Evals Platform

This platform runs AI agent tasks through the **Hermes Agent CLI** under two configurations (A and B), scores every run, and reports whether B is better than A, with a **bootstrap confidence interval** for the difference.

It answers one question with evidence instead of impressions: *is config B really better than config A on these tasks, and by how much, given the noise?*

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
   │     └─ ScoringService                     RegexScorer | JudgeScorer ──► OpenRouter
   │                                                         | MockJudgeScorer
   ├─ stats.ts (pure) ───── per-config/per-task numbers, paired cluster bootstrap, verdict
   └─ DatabaseService ───── node:sqlite (DatabaseSync), file data/evals.db
         SeedService ────── seed/tasks.json + seed/configs.json → DB on every startup
```

### Repository layout

| Path | What lives there |
|---|---|
| `packages/shared` | TypeScript types shared by API and web (`TaskDef`, `AgentConfig`, `RunResult`, `RunRecord`, `Experiment`, `ExperimentSummary`, …). Types only, no runtime code. |
| `apps/api/src/db` | Schema, `DatabaseService` (open DB, add missing columns), `SeedService` (validate + upsert seeds). |
| `apps/api/src/catalog` | Read-only access to tasks and configs. |
| `apps/api/src/experiments` | Experiment creation/reads (`ExperimentsService`), the queue (`ExecutorService`), pure run-plan and timeout helpers. |
| `apps/api/src/runner` | `AgentRunner` contract, `MockRunner`, `HermesRunner`, pure Hermes arg/export parsing. |
| `apps/api/src/scoring` | `Scorer` contract, regex scorer, LLM judge, mock judge, `ScoringService` dispatcher. |
| `apps/api/src/stats` | Pure statistics (no Nest, no DB). |
| `apps/api/src/common` | Seeded RNG, path-safety helpers. |
| `apps/api/seed` | `tasks.json` (10 tasks) and `configs.json` (2 configs): the source of truth for both. |
| `apps/api/scripts` | `check-experiment.mjs` (read-only report), `judge-once.mjs` (one real judge call). |
| `fixtures` | Hermes session exports used by parser tests (hand-made + trimmed real export). |
| `apps/web/src` | Router, API client, polling composable, formatters, 3 pages, 2 components. |

### Stack and conventions

- **npm workspaces** monorepo: `apps/api`, `apps/web`, `packages/shared`.
- **Native ESM everywhere**: `"type": "module"`, `moduleResolution: nodenext`, relative imports end in `.js`.
- **No ORM, no migration tool**: Node's built-in `node:sqlite` (`DatabaseSync`), SQL written by hand.
- **Tests**: Node's built-in runner (`node --test`) on the compiled output (`npm run test:unit` = `nest build && node --test "dist/**/*.test.js"`). 55 tests.
- **Frontend**: Vue 3 + TypeScript + Vite, `vue-router`, plain CSS, no UI library.

---

## 2. Data model

All tables live in one SQLite file (`DB_PATH`, default `apps/api/data/evals.db`). JSON values (lists, specs, files) are stored as `TEXT`.

| Table | Purpose | Key columns |
|---|---|---|
| `tasks` | What the agent must do and how it is graded | `prompt`, `scorer_type` (`regex`/`judge`), `scorer_spec` (JSON: `pattern`+`flags` or `rubric`), `reference_answer`, `files` (JSON path → content), `active` |
| `configs` | One way of running the agent | `model`, `provider`, `toolsets`, `skills`, `max_turns`, `run_budget_sec`, `mock_pass_rate` |
| `experiments` | A comparison of config A vs config B | `config_a_id`, `config_b_id`, `task_ids` (JSON), `repeats`, `status` (`queued`/`running`/`done`), `created_at`, `finished_at` |
| `runs` | One task × one config × one repeat | `seq` (queue order), `status` (`queued`/`running`/`done`/`error`), `passed` (NULL/0/1), `score_reason`, `final_answer`, agent `input_tokens`/`output_tokens`/`cost_usd`, `judge_input_tokens`/`judge_output_tokens`/`judge_cost_usd`, `duration_ms`, `error`, `session_id`, `started_at`, `finished_at` |
| `steps` | The agent's trace for a run | `idx`, `kind` (`tool`/`result`/`model`), `tool_name`, `content`, `timestamp_ms` |

Indexes: `runs(experiment_id)`, `runs(status, seq)` (queue claims), `steps(run_id)`.

**`passed` has three states on purpose**: `1` pass, `0` fail, `NULL` *not scored* (runner error, broken scorer spec, or judge error). Only `0`/`1` count toward pass rates.

---

## 3. Lifecycle of an experiment

### 3.1 Creating it: `POST /api/experiments`

Body: `{ name, configAId, configBId, taskIds?, repeats }`.

1. **Validation** (`ExperimentsService.validate`): non-empty name; both configs exist and differ; `repeats` an integer 1–50; `taskIds` (optional) non-empty, known, and **active**. If omitted, all active tasks are used.
2. **Run plan** (`buildRunPlan`, pure): for each repeat → for each task → `[A, B]`. Runs alternate A, B, A, B, and every task finishes repeat 0 before any task starts repeat 1.
3. **One transaction** inserts the experiment and all runs with a globally increasing `seq`, so experiments are served first come, first served.
4. The executor is kicked.

### 3.2 Executing runs: `ExecutorService`

```
queued ──claim──► running ──runner + scorer──► done   (passed = 1 / 0 / NULL)
                     │                     └─► error  (runner failed or timed out; passed = NULL)
                     └── process dies ──► reset to queued on next startup
```

1. **Claim**: one SQL statement moves the next `queued` run (lowest `seq`) to `running` (`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING …`). `node:sqlite` is synchronous, so two claims can never interleave. The experiment moves `queued → running`.
2. **Concurrency**: up to `QUEUE_CONCURRENCY` runs in flight (default 1). When one finishes, the next is claimed.
3. **Fresh folder**: `RUNS_DIR/<runId>` is deleted and re-created on every attempt. The task's `files` are written into it (paths checked by `resolveInside`).
4. **Hard timeout**: `config.runBudgetSec + 30 s`. `withTimeout` races the run against a timer and **aborts an `AbortSignal`**. The HermesRunner kills its child process on that signal. A timeout becomes a run `error`.
5. **Scoring hook**: only runs *without* a runner error are scored. Errored runs keep `passed = NULL`, so they count as errors, not failures.
6. **Save**: in one transaction, the run row is updated and its steps are replaced (a retried run overwrites its old steps).
7. **Finish**: when no run of the experiment is `queued` or `running`, the experiment becomes `done` with `finished_at`.

**Restart recovery**: on startup (`onApplicationBootstrap`), any run still `running` is reset to `queued`. Its result was lost with the process, so it simply runs again. **Retry**: `POST /experiments/:id/retry-errors` resets `error` runs (and their score and judge fields) to `queued` and re-opens the experiment.

### 3.3 Reading results

- `GET /experiments`: all experiments with run counts per status.
- `GET /experiments/:id`: one experiment, counts, and a light list of its runs (needed to find run IDs).
- `GET /experiments/:id/summary`: statistics (section 6).
- `GET /runs/:id`: one run with its steps.

---

## 4. Runners

### 4.1 The contract

```ts
interface AgentRunner { readonly name: string; run(input: RunInput): Promise<RunResult> }
RunInput = { runId, task, config, workDir, signal? }
```

**`run()` never throws.** On failure it returns a `RunResult` with `error` set, so one bad run is recorded instead of crashing the queue. The executor still wraps the call in `try/catch` as a second line of defence.

`RunnerModule` provides the `AGENT_RUNNER` injection token through a factory that reads `RUNNER` (`mock` default, or `hermes`) **once at startup**. An unknown value fails startup with a clear error.

### 4.2 MockRunner

A free, fake agent for building and demoing the platform.
- **Deterministic**: an RNG (`mulberry32`) seeded with an FNV-1a hash of `runId`. The same run always gives the same result; different runs vary.
- Passes with probability `config.mockPassRate` (default 0.7). Pass returns `task.referenceAnswer`; fail returns a plausible wrong answer (a nearby number for numeric answers).
- Returns 2–4 fake steps, fake token counts, `costUsd: 0`, after a 100–400 ms delay.

### 4.3 HermesRunner

```
hermes chat --query-file WORKDIR/prompt.txt --oneshot -Q --provider P -m MODEL
            --max-turns N --run-budget SECONDS --source evals --in WORKDIR -t TOOLSETS
            --ignore-user-config --yolo [-s SKILLS]
hermes sessions export --session-id ID WORKDIR/session-export
```

- **Prompt goes in a file**; `-q` is never used (it hangs).
- **`spawn` with an argument array**, never a shell string, so prompts and paths cannot inject commands.
- **stdout = final answer**; the `session_id: <id>` line is read from **stderr**.
- **The API key reaches Hermes only through the environment.** It never appears in args. Any error text is passed through `redact()`, which masks the key.
- **Export even after a failed chat**: tokens were spent and must be recorded.
- **An export failure does not fail the run**: the answer is kept (and scored), with no steps and `costUsd = null`.
- Missing `OPENROUTER_API_KEY` (for provider `openrouter`) fails fast without spawning.

**Session export parsing** (`parseSessionJsonl`, pure). The real export turned out to be **one JSON object with a `messages` array**, not one message per line. The parser accepts both layouts:

| Message | Becomes |
|---|---|
| `assistant` with `tool_calls` (array, or JSON string) | one `tool` step per call (tool name + pretty-printed arguments) |
| `tool` | `result` step (`tool_name` + content, pretty-printed if JSON) |
| `assistant` without tool calls, `finish_reason: "stop"` | `model` step |
| `user` and anything else | skipped |

Timestamps are converted from seconds to ms. **Input tokens = `input_tokens + cache_read_tokens + cache_write_tokens`**: Hermes reports cached tokens separately (Sonnet showed `input_tokens: 6` with 9k cached). Cost = `estimated_cost_usd`. A malformed message is skipped instead of failing the run.

---

## 5. Scoring

```ts
interface Scorer { score(task, result): Promise<{ passed: boolean | null; reason: string; judgeTokens?; judgeCostUsd? }> }
```

Same rule as runners: **never throws**. `ScoringService` picks the scorer by `task.scorerType` and has a final `catch` that turns any surprise into `passed = null`.

### 5.1 RegexScorer
- Tests `scorerSpec.pattern` (with optional `scorerSpec.flags`) against the **trimmed** final answer.
- Reasons: `matched /pattern/` or `no match for /pattern/; got: <first 100 chars>` (`(empty answer)` if empty).
- A missing or invalid pattern → `passed = null` ("scorer spec error"): it's our bug, not the agent's failure.
- Patterns are anchored (`^…$`), so "reply with only X" is enforced: showing working before the answer fails.

### 5.2 JudgeScorer (LLM-as-judge)
- `fetch` to OpenRouter chat completions; model from `JUDGE_MODEL` (default `z-ai/glm-5.3-flashx`); `temperature: 0`; 60 s timeout; `usage: { include: true }` to get cost.
- Prompt: task prompt, rubric, reference answer (if any), and the agent's answer. It asks for strict JSON only: `{"pass": true|false, "reason": "..."}`.
- **Defensive parsing**: strip code fences, take the outermost `{…}`, `JSON.parse` in `try/catch`, and require `pass` to be a real boolean.
- **One retry on bad JSON**, showing the model its bad reply plus a correction message (at temperature 0, resending the same request would repeat the same mistake).
- Still bad, HTTP error, or no key → `passed = null`, `reason = "judge error: …"`. **A judge problem never counts as an agent failure.**
- Judge tokens and cost are **summed across both attempts** and saved, even when the judge fails.

### 5.3 Which judge runs
`JUDGE` = `openrouter` | `mock`. Default: `openrouter` only when `RUNNER=hermes`, otherwise `mock`. The **MockJudgeScorer** passes when the answer equals the reference answer and costs nothing. This guarantees mock experiments never spend money, even with a key in `.env`.

---

## 6. Statistics (`stats/stats.ts`, pure)

**Per config**: runs, scored, passed, errors (`status = error`), pending, pass rate (`passed / scored`), average duration, agent cost, judge cost, total cost.
**Per task**: A and B scored / passed / pass rate.

**Difference** = passRate(B) − passRate(A), computed on scored runs, **only over tasks that have scored runs for both configs** (keeps the comparison paired).

**95% confidence interval: paired cluster bootstrap over tasks**
1. Each task is a cluster: `{aPassed, aScored, bPassed, bScored}`.
2. 5000 iterations: draw tasks **with replacement**, sum the clusters, recompute the pooled difference.
3. Sort, and take the 2.5th and 97.5th percentiles (linear interpolation).
4. RNG seeded (seed 42), so the same data always gives the same interval.

**Why resample tasks, not runs**: runs of the same task are correlated (an easy task passes all its repeats). Resampling single runs would treat 100 runs as 100 independent pieces of evidence and give a falsely narrow interval. Resampling whole tasks asks the honest question: *if we had picked different tasks, how much could the result move?* Keeping A and B of the same task together ("paired") cancels task difficulty.

**Verdict** (always from B's point of view): `low > 0` → `better`; `high < 0` → `worse`; else `inconclusive`. With fewer than 2 comparable tasks there is no CI and the verdict is `inconclusive` (a 1-task bootstrap has zero width and would produce false certainty). A one-sentence plain-English explanation is generated with the numbers.

---

## 7. Tasks and configs (seed data)

- **Source of truth is `seed/tasks.json` and `seed/configs.json`**, read on every startup, validated, and upserted in **one transaction** (all or nothing).
- Validation: required fields; regex tasks need `pattern`, judge tasks need `rubric`; `referenceAnswer` must be a string; `mockPassRate` in 0..1; `files` must be an object of **safe relative paths** → string content.
- **Task lifecycle**: a task removed from `tasks.json` becomes `active = 0`. It is **retired, not deleted**: its old runs still reference it, `GET /tasks/:id` still returns it, but `GET /tasks` and new experiments exclude it. Adding it back reactivates it.
- **Rule for editing tasks**: if a task's prompt or scorer changes meaningfully, give it a **new id** (e.g. `change-due-v2`) and remove the old one. Experiments don't snapshot task content, so reusing an id would mix old and new results.
- **Task files**: up to 3 tasks carry files (`orders.csv`, `utils.js`, `meeting-notes.md`) that the executor writes into each fresh run folder before the agent starts.

Current set: **10 tasks: 5 regex, 5 judge, 3 needing file tools.**

| id | type | tests |
|---|---|---|
| `change-due` | regex | arithmetic with steps, strict number format |
| `third-friday` | regex | date reasoning, ISO format |
| `sort-words` | regex | case-insensitive sort, strict output format |
| `extract-503` | regex | value extraction from a log, with decoys |
| `file-csv-sum` | regex, files | read a CSV (with a quoted comma), filter, sum |
| `explain-retry` | judge | short explanation (control task) |
| `explain-idempotency` | judge | explanation with a sentence limit |
| `multi-part-format` | judge | four formatting rules at once |
| `file-bug-review` | judge, files | find an off-by-one bug, give the fix |
| `file-action-items` | judge, files | extract exactly the committed action items |

A test (`seed-tasks.test.ts`) checks every regex against its own reference answer and against plausible near-misses, and recomputes the facts behind the answers (the date, the CSV total, the single 503) before any money is spent.

---

## 8. Frontend (`apps/web`)

| Route | Page | Shows |
|---|---|---|
| `/` | `ExperimentsPage` | Start form (name, config A/B, repeats, **task checkboxes** with all/none, live run count, client-side checks) and the experiments table (configs, status, runs done/total, errors). |
| `/experiments/:id` | `ExperimentPage` | Progress bar; **verdict** label + explanation; **`CiBar`**; per-config table (pass rate, scored, errors, avg duration, total = agent + judge cost); per-task table (A vs B, differing rows highlighted); **Retry errored runs**; runs list filtered by `?task=…&config=…#runs`. |
| `/runs/:id` | `RunPage` | Error banner first (if errored); task, config, result badge; duration, tokens, cost cards; scorer reason; final answer; prompt (+ reference answer); **step timeline** (`StepCard`). |

- **API client** (`api.ts`): one typed `fetch` wrapper; non-2xx replies throw with the server's message.
- **Polling** (`usePolling`): calls the loader now and every **3 s**; the loader returns whether to continue (stop when `done`); the interval is **cleared on unmount**; `start()` restarts after a retry.
- **`<RouterView :key="$route.path">`**: switching experiments remounts the page, while changing the run filter (query/hash) does not.
- **`CiBar`**: a symmetric scale around 0 (at least ±20 points), interval colored by verdict, marker at the point estimate, line at 0.
- **`StepCard`**: kind (tool / result / model), tool name, `+x.x s` since run start (falls back to the first step), content collapsed past 400 chars or 8 lines with "show more (N chars)".
- **Vite proxy**: the page calls `/api` on its own origin and Vite forwards it to `API_URL` (default `http://localhost:3000`), so no CORS setup is needed.
- Types come from `@evals/shared` (`import type` only).

---

## 9. Design decisions

Format: **decision | alternative | why**.

### Backend core
| Decision | Alternative | Why |
|---|---|---|
| The DB is the queue (`status` + `seq`), with an atomic claim | In-memory array of run IDs | A crash loses nothing; restart recovery and retry are one `UPDATE` each. |
| Explicit `seq` column for queue order | `rowid` or `created_at` | `rowid` can change after `VACUUM`; many runs share a millisecond. `seq` keeps A/B alternation exact. |
| Interleave A/B, and all tasks per repeat before the next repeat | All A runs, then all B runs | Drift over time (latency, rate limits, provider changes) hits both configs equally. |
| Timeout fires an `AbortSignal` as well as marking `error` | Only race a timer | Without killing the child process, a "timed out" Hermes run keeps running and spending money. |
| Runner errors leave `passed = NULL` | Count them as failures | Infrastructure problems would otherwise look like agent mistakes and skew A vs B. |
| Score in the executor before saving, in the same transaction | A separate scoring pass | A run is never visible as `done` without its score. |
| Runner chosen once at startup by `RUNNER`, fail fast on unknown values | Choose per run / silently fall back | A typo would otherwise produce a whole experiment of mock data that looks real. |
| `node:sqlite` with hand-written SQL, no ORM | Prisma / TypeORM | Zero dependencies, synchronous (makes atomic claims trivial), small schema. |
| Add missing columns on startup (`addMissingColumns`) | "Delete the DB after schema changes" | The dev DB holds a paid experiment; additive-only changes are safe and keep results. |

### Hermes integration
| Decision | Alternative | Why |
|---|---|---|
| Parse both export layouts (nested `messages` and line-per-message) | Only the documented layout | The real export differed from the hand-made fixture; tolerating both keeps tests and reality aligned. |
| Input tokens include cache reads/writes | Use `input_tokens` as is | Cached tokens are still processed; without them Sonnet looked like 6 input tokens, which makes token comparisons meaningless. |
| Export failure keeps the answer, with no steps or cost | Mark the run as an error | It's a logging problem, not an agent failure; the answer can still be scored. |
| Pure parsing in `hermes-session.ts`, runner tested with a fake `hermes` binary | Mock `child_process` / only real Hermes | Tests the real spawn, abort, export and redaction paths for free and in CI. |

### Scoring
| Decision | Alternative | Why |
|---|---|---|
| Three-state `passed` (true / false / null) | Boolean | "Couldn't score" (bad spec, judge down) must not be counted as a failure. |
| Retry the judge once, showing it its bad reply | Resend the same request | At temperature 0 the same request tends to repeat the same bad output. |
| Paid judge only with `RUNNER=hermes` (or explicit `JUDGE=openrouter`) | Always use the real judge | Mock experiments stay free even with a key present. |
| Strict anchored regexes ("reply with only X") | Lenient, e.g. last-line match | Instruction-following is part of the task; this is a deliberate, documented choice. |

### Statistics
| Decision | Alternative | Why |
|---|---|---|
| Paired cluster bootstrap over tasks | Bootstrap over individual runs / normal approximation | Runs within a task are correlated; resampling tasks gives an honest interval. |
| Compare only tasks scored on both sides | Use every scored run per config | Prevents a config from looking better because its hard-task runs errored out. |
| Pooled difference (total passes / total scored) | Mean of per-task differences | Matches the per-config pass rates shown; trade-off: tasks with more scored runs weigh slightly more. |
| No CI below 2 comparable tasks | Report it anyway | A 1-task bootstrap has zero width and implies false certainty. |
| Seeded RNG for the bootstrap | Unseeded | Reproducible numbers: the same data always gives the same CI. |

### Tasks
| Decision | Alternative | Why |
|---|---|---|
| Seed JSON is the source of truth; no task editor UI | CRUD endpoints + editor | Changes are reviewed in git; avoids versioning problems; matches the "no extra features" scope. |
| Retire (`active = 0`) instead of delete | `DELETE` | Old runs reference tasks; history stays readable. |
| Task files inline in `tasks.json` | A separate files folder | One file per task definition; small files; one transaction. |
| Path checks at seed time **and** at write time | Trust the seed | A path like `../../.env` must never be written outside the run folder. |

### Frontend
| Decision | Alternative | Why |
|---|---|---|
| Per-task cells link to `?task&config#runs` on the same page | A separate runs route | Keeps 3 routes; the filter is shareable and works with back/forward. |
| `usePolling` composable with loader-controlled stop | `setInterval` in each page | Cleanup on unmount is written once; no leaked timers; restartable after retry. |
| Symmetric CI scale around 0 | Fixed −100…+100 | Narrow intervals stay visible; "does it cross 0?" is obvious. |
| Vite proxy for `/api` | Enable CORS on the API | No server change; same-origin requests in dev. |
| Plain CSS with tokens and dark mode, no UI library | Vuetify / Tailwind | Small, fast, matches the scope. |

---

## 10. Security and cost controls

- **The API key** lives only in `apps/api/.env` (git-ignored), loaded with `process.loadEnvFile`. It is passed to Hermes via the environment and to OpenRouter in the `Authorization` header only. It is never logged, never in args, and masked in error text (`redact`). Tests assert this.
- **No shell**: every process is started with `spawn(bin, args[])`.
- **Filesystem**: task files go through `isSafeRelativePath` + `resolveInside`; each run gets its own folder.
- **Cost**: mock runner + mock judge by default; the paid judge only with the real runner; `check-experiment.mjs` is read-only; the start form warns that Hermes runs are paid.
- **Not in scope**: authentication and authorization (local tool by design).

---

## 11. Configuration

| Variable | Default | Used by |
|---|---|---|
| `RUNNER` | `mock` | `mock` or `hermes` |
| `JUDGE` | `openrouter` if `RUNNER=hermes`, else `mock` | which judge scorer is used |
| `JUDGE_MODEL` | `z-ai/glm-5.3-flashx` | judge model on OpenRouter |
| `OPENROUTER_API_KEY` | (none) | Hermes + judge (from `apps/api/.env`) |
| `QUEUE_CONCURRENCY` | `1` | runs in flight |
| `DB_PATH` | `data/evals.db` | SQLite file (use another file for mock testing) |
| `RUNS_DIR` | `runs` | per-run work folders |
| `SEED_DIR` | `seed` | where `tasks.json` / `configs.json` are read from |
| `HERMES_BIN` | `hermes` | path to the Hermes CLI (tests point it at a fake) |
| `PORT` | `3000` | API port |
| `API_URL` (web) | `http://localhost:3000` | Vite proxy target |

---

## 12. Testing strategy

All with `node --test` on compiled output (`npm run test:unit -w apps/api`): **55 tests, no network, no money.**

| Area | What is covered |
|---|---|
| MockRunner | determinism, shape, pass-rate extremes, default rate ≈ 0.7 |
| Run plan / timeout | A/B alternation and repeat order; `withTimeout` resolves, rejects and aborts |
| Executor flow (end to end over HTTP, mock runner, temp DB) | create → all done; regex runs scored; task files written; 400 on bad input; restart re-queues `running`; retry-errors; `GET /tasks/:id` |
| Hermes parsing | hand-made fixture and **trimmed real export**; bad lines; empty export; `session_id` on stderr; args (`-s` only with skills, never `-q`) |
| HermesRunner (fake binary) | happy path; non-zero exit with masked key and tokens still recorded; hang killed by abort; missing key |
| Scorers | regex match / no match / empty / invalid / flags; judge parsing, prompt contents, retry, double failure, HTTP error, missing key; key only in the header |
| Statistics | identical → inconclusive; all-pass B → better; reverse → worse; same seed → same CI; error-only task skipped; counts and costs; < 2 tasks → no CI |
| Seed data | 10 tasks, mix, references, rubric format, regex vs reference and near-misses, recomputed facts, safe paths |
| Task lifecycle | retire / reactivate; old DB gets the new column and keeps data |

The web app is type-checked with `vue-tsc` (`npm run build -w apps/web`).

---

## 13. Results so far and known limitations

**First full experiment** (`full-10x2x5`: 10 tasks × 2 configs × 5 repeats = 100 runs, about $0.27, 0 errors):
A DeepSeek V4 Flash **96%** (48/50), B Claude Sonnet 5.5 **90%** (45/50). Difference **−6.0 points**, 95% CI **−20.0 to +6.0** → **inconclusive**. Sonnet cost about 17× more in total.
Sonnet's failures were formatting and verbosity (showing working, 4 sentences instead of 3); DeepSeek's were factual (a wrong sort, a false claim). **7 of 10 tasks were 5/5 for both models**: the task set is too easy to separate them (ceiling effect). The next step is a harder task set and one re-run.

**Known limitations**
- **Single process**: the queue lives in the API process; running two API instances on one DB is not supported.
- **The timeout doesn't stop the MockRunner** (it ignores the signal); it only matters for Hermes, which is killed.
- **If saving a run fails**, the run stays `running` until the next restart re-queues it.
- **Experiments don't snapshot task content**; the "new id for changed content" rule must be followed.
- **The judge is itself a model**: temperature 0 and concrete rubrics reduce, but don't remove, judge variance.
- **Run folders are never cleaned up** (`runs/` grows; it is git-ignored).
- `packages/shared/tsconfig.json` compiles as CommonJS while the package is ESM; harmless while it exports only types.
- `apps/api/tsconfig.build.tsbuildinfo` is tracked in git and changes on every build.
