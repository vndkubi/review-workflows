# src/lib: the trusted runtime

Read the root `AGENTS.md` first. This file holds what is specific to editing `src/lib/`.

## Every edit here is a tool change
- Every `.js` and `.java` file under `src/lib/` and `src/cli/` is hashed into the tool digest
  (`toolDigest` in `freeze.js`). Any edit makes every frozen context stale: say so in the commit body.
  `.md` files are not hashed, so this note is safe to edit.
- Do not edit here while a review, eval or repro of this checkout is running (`scripts/hooks/guard-frozen-edit.js`
  blocks it once the Claude hooks are enabled).

## Load order
- `prompts -> repro -> bootstrap -> driver -> prompts` (plus `impacted-tests`) is a require cycle. It works
  only because some requires are inside functions: `prompts.js` (`require('./repro')`), `repro.js`
  (`require('./bootstrap')`), `bootstrap.js` (`require('./driver')`, twice), `impacted-tests.js`
  (`require('./bootstrap')`). Keep them there; moving one to the top of the file gives a half-built module.
- `runs.js` reads `ARW_RUNS_DIR` once, when it is first required. A test sets
  `process.env.ARW_RUNS_DIR` before it requires anything from `src/lib` (see `test/audit-regression.test.js`).

## Workers never take instructions from the checkout or the user's setup
- codex (`codex.js`): `project_doc_max_bytes=0`, `skills.include_instructions=false`, `--ignore-user-config`
  unless `CODEX_USE_USER_CONFIG=1`, and a private `CODEX_HOME` (`runs/.codex-home`) that holds only
  `auth.json` (plus `*.toml` with the user config). Since codex 0.163, `--ignore-user-config` alone still
  loaded `~/.codex/AGENTS.md` and skills from the reviewed checkout.
- copilot (`copilot.js`): `--no-custom-instructions`, a private `COPILOT_HOME` with `disableAllHooks`, and
  an allow-list of tools: `skill`, `task` and the agent tools stay off.
- A new executor flag or CLI upgrade keeps this. Check with `codex debug prompt-input` (no model call) or
  `copilot skill list` / `copilot instruction list` run in a checkout that holds marker files.
  Tests: `test/codex-isolation.test.js`, `test/copilot.test.js`.

## Gates
- `recordGate` (`runs.js`) binds a decision to artifact hashes. It is called by `arw gate`, by the
  dashboard's gate buttons (`src/web/server.js`, REVIEW and SPEC), and by one policy:
  `ARW_AUTO_APPROVE_SPEC=1` approves a clean SPEC that did not come from a PR's own description
  (`ticket-pipeline.js`). Nothing approves REVIEW automatically. Add no other caller.

## Tests for runtime code
- Model answers come from `scriptedExecutor` (`test/helpers.js`) or `ARW_EXECUTOR_MODULE`, never a real
  model. A real CLI is replaced by a stand-in script through `CODEX_BIN` (see `test/codex-isolation.test.js`).
