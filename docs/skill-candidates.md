# Skill candidates

Mined from all 94 commits on `main` (the history is shorter than 200), the two PRs and their review
comments (PR #2: 17 inline comments from sourcery-ai; PR #1: 3 from the arw smoke run). A candidate
is a task that recurs, takes several steps, and goes wrong in a known way. Rules that apply to every
change go to `AGENTS.md` instead.

Every command below was run on 2026-10-28 from the repository root (Git Bash) and printed what is
quoted next to it.

## 1. incident-to-regression: a failure seen on a real run becomes a failing test, then a fix

Trigger: "this run on owner/repo#N went wrong", a bad finding, a lost packet, a wrong status.

Evidence: 19 commits name an incident (`Incident:`, `Seen on`, `Found on/by/in`), and all 19
touch `test/`. Examples: 40875b4 (a merged PR had "no reviewable files"), 4a57196 / 202ca5f (garbled
non-ASCII quotes on trading#1), b27551f (two P2s chained into one cluster on the smoke PR), 6bd0d94
(vnstock#1: the reviewer used a `python` without the library).

```bash
git log --format=%h -E -i --grep='Seen on|Incident|Found on|Found by|Found in|Found while' | wc -l
# 19
for h in $(git log --format=%h -E -i --grep='Seen on|Incident|Found on|Found by|Found in|Found while'); do git show --name-only --format= $h | grep -q '^test/' && echo $h; done | wc -l
# 19
```

What the skill holds: find the run (`node src/cli/arw.js status`, `runs/prs/<owner>__<name>__<n>/`),
read `run.json`, the driver log and the rejected attempts; rebuild the case with `makeRepo()` and
`scriptedExecutor` from `test/helpers.js`; watch the new test fail; fix; re-check on the stored run
(`arw validate` makes no model calls); write the body as `Incident: ... / Verified: ...`.

## 2. real-repo-repro-fix: reproduction stuck at build_error or ENVIRONMENT_BLOCKED

Trigger: a repro record says `build_error`, `ENVIRONMENT_BLOCKED` or "report not found" on a real
Java/Python repository.

Evidence: 10 commits fix how the harness builds or reads real projects: 672579e (Maven module
outside the reactor), da1f5e3 (pom under `backend/`, `*.gradle` module markers), 47f1f3c (jacoco not
cached offline), ca71abb (Gradle shortens the JUnit report name), ae21078 (scope to the test module),
1dfb472 (no host fallback for impacted tests), 341fd2a (repro test does not compile), 1314d1e (14 of
14 runs at build_error: dependencies never resolved), 1a4ee0e (wrong Python), f04896e (JUnit report
of a module test). `src/lib/repro.js` changed in 16 commits, 10 of them with a `test/repro*` file.

```bash
git log --format='%h %s' -E -i --grep='maven|gradle|pytest|junit' | wc -l
# 25  (the 10 above plus sandbox, setup and indexer work that mentions the tools)
n=0; for h in $(git log --format=%h -- src/lib/repro.js); do git show --name-only --format= $h | grep -q '^test/repro' && n=$((n+1)); done; echo $n
# 10
```

What the skill holds: read the record and its logs under the run's repro directory; classify (PR
does not build / test does not compile / dependencies not resolved / report not where looked /
no build tool found); check the module layout the commits above met; re-run with
`node src/cli/arw.js repro --repo <o/n> --pr <n>` (only for a review frozen by the current tool);
add the case to `test/repro-*.test.js` or `test/host-env.test.js`.

## 3. packet-contract-change: add or change a field models answer with

Trigger: a new verdict kind, evidence form or finding field (`config/schemas/review.schema.json`).

Evidence: all 6 commits that changed the review schema also changed `src/lib/validate.js` and
`src/lib/prompts.js`; 4 of 6 changed the scripted answers (`test/fixtures/fake-review-executor.js`,
`test/helpers.js`). 963d013, 1ec309e and f04896e say older contexts need a refresh. Missing one of the
files shows up as repair calls (e92d8b7: a third of all calls were repairs).

```bash
for h in $(git log --format=%h -- config/schemas/review.schema.json); do git show --name-only --format= $h | grep -cE '^src/lib/(validate|prompts)\.js$'; done | sort | uniq -c
#       6 2
```

What the skill holds: the file list (schema, validator, prompt, canonicalization in `anchors.js`,
fake executor, helpers, report, dashboard), the strict-schema rules codex enforces
(`CODEX_OUTPUT_SCHEMA=1`), the frozen-hash note for the commit body, and a stored packet re-validated
with `arw validate`.

## 4. repair-forensics: cut repair calls by mining what the validator rejects

Trigger: many repair calls, incomplete reviews, "quote not found" in attempts.

Evidence: 8 commits turn a counted rejection into a runtime rule: 25af968 (3 of 3 repairs were
multi-line quotes), e92d8b7 (85% of validator errors were "quote not found"), 31cb073 (~40 repair
calls from anchor and gap verdicts), 0164cbb (duplicate rule ids), c8f2502 (a packet lost to one
quote), 4a57196 and 202ca5f (re-checked 50 and 173 failed quotes), b285862 (`arw retro` itself).

```bash
git log --format='%h %s' -E -i --grep='repair' | wc -l
# 12
node src/cli/arw.js retro --since 30 | head -3
# - 11 run(s) · 464 model calls (151 repairs) · ...
```

Repairs are still a third of the calls in the last 30 days, so the task is not done.

What the skill holds: run `arw retro`, group rejections by message, decide per group whether the
runtime can settle it (canonicalize) or the prompt must change, re-check the rule against the stored
attempts without a model call, then count again.

## 5. luna-measure: prove a prompt or runtime change on real PRs

Trigger: a change meant to find more (or cost less), judged by re-running real PRs.

Evidence: 22f9d62 (A/B, 10 runs plus confirmation; a variant that lost a finding 2/2 -> 0/2 was
dropped), 6261753 and 6bd0d94 (vnstock#1 re-runs at `CODEX_EFFORT=max`), bffb27f (3 labelled cases and
5 open PRs, 8/13 known defects), 9cb2e9e (copilot measured), and the measuring tools 14bc7ae and
f657023 (`--repeat`, McNemar, bootstrap CIs, budgeted matrix).

```bash
git log --format=%h -E -i --grep='A/B|Measured with|Re-checked|re-run' | wc -l
# 14
node src/cli/arw.js eval 2>&1 | head -3
```

What the skill holds: freeze the tool first (no edits to `src/lib`, `src/cli` or policies while it
runs), separate `ARW_RUNS_DIR`, the fixed PR set (vnstock#1, trading#1, ecommerce-jhipter#1,
Mindustry#12707), `--repeat` and `eval compare` instead of single runs, the codex usage limit, and a
report that separates the effect from run-to-run noise.

## 6. external-review-triage: verify each claim of an outside review before fixing

Trigger: a pasted deep review, a bot review on a PR, a codex discussion with a list of holes.

Evidence: a102981 (F1-F6, B: "each finding was checked against the code and reproduced by a failing
test"), ed227ff (N1-N5), f04896e (six trust holes, "each one has a test that failed first"),
5573d35, ad0637e, 56aa082 and 061ed03 ("From the external review's ..."), and PR #2's 17 sourcery
comments, four of them closed in b1709a6 on `scenarios-k1-k2`. Tests: `test/audit-regression.test.js`,
`test/audit2-regression.test.js`.

```bash
git log --format=%h -E -i --grep="external review|deep review|trust holes" | wc -l
# 7
gh api repos/vndkubi/review-workflows/pulls/2/comments --jq length
# 17
```

What the skill holds: one row per claim (confirmed / not reproduced / out of scope), a failing test
per confirmed claim, "Still open:" in the commit body for the rest, and the rule that a claim is
never fixed on the reviewer's word alone.

## 7. dashboard-change-verify: change the dashboard and check it in a browser

Trigger: any change under `src/web/`.

Evidence: `src/web/public/app.js` is the most changed code file (35 commits, 17 with a
`test/web*` file); 7 commits record a browser check (6bab966, 1a0a74a, 5b37059, e69a488, ac57be5,
f097a66, 2a07c8e); two bugs only a running server showed: bf1ec5a (server died on a gh exit code)
and f097a66 (`pattern` attributes invalid under the `v` flag).

```bash
git log --format=%h -E -i --grep='Checked in the (browser|dashboard)|browser pass' | wc -l
# 7
```

What the skill holds: start the server against a scratch `ARW_RUNS_DIR` (never the real `runs/`),
the guards to keep (Host/Origin, per-start token, CSP, text nodes only), `node scripts/test.js
test/web.test.js`, and a browser pass on real run data.

## Not proposed as skills

- Adding a setting: `src/lib/settings.js` changed in 21 commits, 13 with `app.js` and 10 with README,
  but the steps are short. A recipe in `AGENTS.md` covers it.
- Commit message style: 92 of 94 subjects already follow it. `AGENTS.md` covers it.
- Sandbox bootstrap (ffd34f0, 23a0c15, 31078b5, 85a2065): built once in October 2026, not a recurring
  task yet.
