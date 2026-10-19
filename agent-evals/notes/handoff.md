# Handoff: Agent Evals Platform (state on 2026-10-19)

Paste this into a new session to continue the work.

## The project
- **What:** a take-home for HighLevel. It measures with evidence whether changing an AI agent (its model, a skill, or memory) makes it better, worse or no different. Runs go through the Hermes Agent CLI under config A vs config B, every run is scored, and A and B are compared with bootstrap confidence intervals.
- **Repo:** https://github.com/sagarkadu16/agent-evals-platform (public, personal account). The project is in `agent-evals/`, and a root `README.md` points there.
- **Stack:** npm workspaces.
  - `apps/api`: NestJS, `node:sqlite`, native ESM.
  - `apps/web`: Vue 3 + Vite.
  - `packages/shared`: ESM types plus `diffConfigs`.
- **Run it:** `cd agent-evals && npm install && npm start` uses the mock runner, which is free. `npm test` runs 89 tests (4 shared + 85 API, `node --test`) and all pass.
- **Docs:** `agent-evals/README.md` (setup, results, costs, assumptions, known limits) and `agent-evals/ARCHITECTURE.md` (the design doc). `notes/assignment-status.md` tracks the brief against each deliverable.

## Mental model
- **Task:** what to do, how it's scored (regex or LLM judge), and input files. A task never changes between configs.
- **Config:** model, toolsets, skills, memoryFiles, maxTurns, runBudgetSec.
- **Experiment:** A vs B on chosen tasks × repeats, ideally with ONE thing different.

## What's done
- **Seed data:** 16 tasks with tags, in `apps/api/seed/tasks.json`. 5 configs in `apps/api/seed/configs.json`:
  - `config-a-cheap`: DeepSeek V4 Flash, the baseline;
  - `a-deepseek-skill`: baseline + `skills/careful-data-check`;
  - `a-deepseek-memory`: baseline + `memory/sales-policy.md`;
  - `config-b-sonnet`: Sonnet 5.5;
  - `config-c-opus`: Opus 5.5.
- **Per-run Hermes home** (`runner/hermes-home.ts`):
  - a throwaway `HERMES_HOME` holding the config's skills and memory (`MEMORY.md`, joined with §, 2200-char limit);
  - `SOUL.md` = Hermes' default persona + the harness rule;
  - `installs/` is symlinked from `apps/api/.hermes-base`;
  - skills and memory are validated before spawning (fail fast).
- **Sandbox** (`runner/sandbox.ts`):
  - run folders live in the OS temp dir;
  - `HERMES_WRITE_SAFE_ROOT` restricts writes to the run folder;
  - every run gets the harness rule;
  - any file-tool path outside the run folder makes the run an error.
  - Why: a no-memory config once passed by reading `memory/sales-policy.md` from the repo.
- **Stats** (`stats/stats.ts`):
  - quality: paired cluster bootstrap over tasks, with reason labels (no-data, too-few-tasks, no-difference, ci-includes-zero, ci-above-zero, ci-below-zero);
  - speed: median-duration ratio; cost: mean-cost ratio. Both use a stratified run bootstrap CI;
  - a one-line headline.
- **Web:**
  - ConfigPanel (A/B side by side, differing fields highlighted, swap button);
  - TaskPicker (search, tag chips, "select all shown");
  - a localStorage form draft;
  - a live progress bar per experiment in the list;
  - the comparison page: ConfigDiff "What changed" box + ComparisonSummary (headline + Quality/Speed/Cost cards).
- **Real results** (written up in the README):
  - Model: DeepSeek 96% vs Sonnet 90% over 100 runs, no reliable difference (CI −20 to +6). Sonnet is about as fast and 48× more expensive.
  - Memory: discount-reply × 3, with memory 3/3 vs without 0/3.
- **Total API spend so far:** about $0.83.

## What's left (in order)
1. **Small fix:** the headline can say "B is 1.0× slower" when the ratio rounds to 1.0×. Say "about as fast" or "about the same cost" in that case: `describeRatio`/`headline` in `apps/api/src/stats/stats.ts` and `metricView` in `apps/web/src/components/ComparisonSummary.vue`. Add a test.
2. **Step 3: hardening.**
   - Freeze a config snapshot on each experiment, with content hashes of skill and memory files. Editing `configs.json` later must not change an old experiment's displayed config.
   - Record per run which skills and memory were loaded (with hashes).
   - Fail-fast seed validation when a config references a missing skill folder or memory file.
   - Show in the UI that MockRunner ignores skills and memory.
3. **Step 4:** the run page shows the config snapshot plus "Skills loaded" / "Memory loaded" badges.
4. **Step 5:** tests for steps 3 and 4, including an integration test: an experiment stores its snapshot, and a later `configs.json` edit doesn't change it.
5. **Step 6:** update the README and ARCHITECTURE for steps 3–5. Remove "experiments don't snapshot configs" from the known limits.
6. **Step 7** (paid; the user runs it, with RUNNER=hermes):
   - skill test: lead-triage + invoice-reconcile, `config-a-cheap` vs `a-deepseek-skill`, 3 repeats, about $0.03;
   - optional second memory task.
7. **Optional cleanup:** NestJS scaffold leftovers in `apps/api` (`vitest.config*.ts`, `test/app.e2e-spec.ts`, and the `test:watch`/`test:cov`/`test:e2e`/`test:debug` scripts).
8. ~~Video~~ Done: https://drive.google.com/file/d/1S9hPa6WlyR_Rf6IpYgl2mCYvGUxBLrRi/view?usp=sharing (linked in both READMEs).

## Working rules
- Work one step at a time and STOP after each step. Report after each step in this format:
  - (0) a plain summary;
  - (1) files changed, one line each;
  - (2) top 3 decisions as "decision | alternative | why";
  - (3) test commands + expected output;
  - (4) one question.
- Start a message with "YOUR TURN:" whenever the user must act.
- Never spend API money without a YOUR TURN pause. Never read or print `.env` or keys. Pass the key only through the environment.
- Commit or push only when asked. Commits go to the personal identity (`Sagar Kadu <49630944+sagarkadu16@users.noreply.github.com>`), never the work account.
- Never use `hermes -q` (it hangs). Use `spawn` with an args array, never a shell string.
- Tests use `node --test`, not Jest or vitest. Use `npm test` at the root.
- Prettier: format with `--print-width 120`, and don't reformat untouched lines.
- Give zsh commands without inline `#` comments.
- The user will share this repo with recruiters, so everything must be review quality.

## Not in the repo (local machine only)
- `apps/api/data/evals.db`: the dev DB with the paid experiments (git-ignored). It also holds the contaminated pre-sandbox experiments ("discount reply…", "tewrtwrt"); don't present those.
- `apps/api/.env` (the OpenRouter key) and `apps/api/.hermes-base` (the Hermes install).
- A cloud session therefore has no Hermes, no key and no real results DB. Mock mode and `npm test` work everywhere. Do paid runs on the local machine.
- The old private copy `SagarK-CURATELYAI/agent-evals-platform` may still exist. The user is deleting it.
