# agent-review-workflows

Evidence-first **ticket analysis** and **PR review** for Java/Maven and Python repositories,
driven by `codex exec` workers. Models propose; trusted Node scripts decide; people own the gates.

```
ticket:  intake (Jira + linked Confluence, or a file) → requirement items (deterministic | model + audit)
                → spec model (model declares variables, classes, rules)
                → tables built by code: input matrix, decision table, scenarios, boundaries,
                  gaps, contradictions → review items
                → [GATE SPEC: approve | reject with a note that rebuilds the spec]
                → analysis: current behaviour per review item → READY
review:  PR + worktree → ticket inputs → plan (model, repaired until valid)
                → freeze (hash-bound context, no model)
                → W1 first-pass packets ∥ → W2 seams → W3 blind red-team per duplicate cluster → W4 synthesis
                → validate (no model) → report.md → publish as a PENDING GitHub review → [person submits]
```

## From spec text to review items

A model only *declares* the spec: decision areas, input variables, value classes (ranges for numbers and dates,
values for enums, plus invalid and missing classes), rules with results, and verbatim quotes. Everything that
must be counted is done by `src/lib/spec.js`:

- the classes of a numeric or date variable must partition the whole line with no gap or overlap;
- **every** value combination is checked: none of the rules covers it → open question (gap); two rules give
  different results → contradiction. Gaps are compressed into patterns such as `member=*, total=negative`;
- boundary values are computed where crossing a class boundary changes the result (999,999 | 1,000,000);
- scenario rows list every combination up to 64. Above that they are pairwise, plus one row per rule and every
  business boundary, so business coverage is kept;
- a rule labelled CONFIRMED must quote the ticket verbatim, or it is downgraded to INFERRED;
- review items are generated from all this: one per rule, per business boundary, per gap and per contradiction.

A PR review is graded per review item. A business reviewer gives pass, fail, not_applicable or cannot_determine
for every item, and one finding can cover several failed items. Risky rule and boundary items must be decided
before the review counts as complete. Set `ARW_AUTO_APPROVE_SPEC=1` to let a deterministic policy approve
clean specs (no gaps, contradictions or inferred rules).

## Reproduction: from SUSPECTED to CONFIRMED

After the review, every blocking (P1/P2) finding that was not withdrawn gets one reproduction attempt per
duplicate cluster:

1. A model writes **one new test file** (JUnit or pytest, in the style of the repository's own tests) that
   asserts the *expected* result for the finding's trigger values. It returns the file as JSON and does not
   run anything.
2. The harness checks the file: it must be new, use the right package/class/selector, and assert something.
   It writes the file into a **separate repro worktree** at the reviewed head, so the frozen checkout is never
   touched.
3. The harness runs the test twice with the repository's build (Maven, Gradle, pytest, or `test_command`
   from `config/repos.json`), with tokens and keys removed from the environment, and reads the result from
   JUnit XML:
   - assertion failure both times → `RED_PROVEN`
   - passes → `GREEN_NOT_PROVEN`
   - one failure and one pass → `FLAKY`
   - does not compile, or errors → `INCONCLUSIVE`
   - no build tool → `ENVIRONMENT_BLOCKED`
4. On `RED_PROVEN` the finding's own fix (`fix.asis → fix.tobe`) is applied and the test runs again. A
   pass marks the fix as verified.

Only `RED_PROVEN` turns a finding (and its duplicates) into **CONFIRMED (L3)**. Each run's log and the test
file are stored with SHA-256 hashes, and validation re-checks them: an edited log turns the finding back into
SUSPECTED and makes the review incomplete.

## Why it is built this way

| Rule | Where it is enforced |
|---|---|
| A model never writes `valid`/`approved`/status | schemas use `additionalProperties: false`; statuses come from `src/lib/driver.js` |
| Every claim quotes real bytes | `quoteMatchesAt` in `src/lib/validate.js` checks each quote against `git show <sha>:<path>` or a frozen input |
| Nothing changes under a running review | `freezeContext`/`verifyContext` hash the source, plan, inputs and the tool itself; checked before and after every model call |
| Invalid output is repaired, not retried blindly | validator errors + the previous candidate go back to the model (2 repairs, then 1 fresh run) |
| "Didn't see a problem" ≠ "pass" | `cannot_determine`, `unverified`, `UNRESOLVED`, `needs_investigation` are first-class |
| Two models agreeing is not proof | findings are labelled `SUSPECTED` (L1). `CONFIRMED` is reserved for executed reproductions |
| Humans approve | `arw gate` binds a decision to the artifact hash; editing the artifact voids it |
| Cost is visible | per-call receipts with input/cached/output tokens from codex JSONL events, including planning |

## Setup

```bash
npm run doctor
```

1. Node ≥ 20, git, `gh auth login`, `codex` CLI logged in.
2. `cp .env.example .env`. `CODEX_MODEL` defaults to `gpt-6-luna`; set another model if your codex login does not offer it.
3. `cp config/repos.example.json config/repos.json` and map `owner/name` → local clone.
4. Ticket source, first match wins:
   - **MCP** (when Jira/Confluence are not reachable from this machine): copy `config/mcp.example.json` to
     `config/mcp.json` and point it at a stdio command (for example `docker run ... mcp-atlassian`) or an HTTP
     MCP URL with headers. Tool names and arguments are configurable; the defaults match `mcp-atlassian`
     (`jira_get_issue`, `confluence_get_page`, `confluence_search`). `npm run doctor` checks the connection
     and the mapped tools.
   - **REST**: `JIRA_URL` + `JIRA_PAT` (Server/DC) or `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud), plus
     `CONFLUENCE_URL`.
   - **File**: `arw ticket KEY --from-file ticket.md --extra page.md`.

No npm dependencies.

## Use

```bash
# 1. Understand the requirement (stops at the SPEC gate)
node src/cli/arw.js ticket ACME-7 --repo your-org/payment-api        # from Jira (+ Confluence)
node src/cli/arw.js ticket ACME-7 --from-file ACME-7.md --repo-dir D:/src/payment-api
#    read runs/tickets/ACME-7/spec.md (tables, open questions, review items), then either:
node src/cli/arw.js gate approve --ticket ACME-7 --gate SPEC
node src/cli/arw.js gate reject  --ticket ACME-7 --gate SPEC --note "rule for refunds is missing"
node src/cli/arw.js ticket ACME-7 --repo your-org/payment-api        # rebuild (after reject) or analyse (after approve)

# 2. Review a PR (ticket key is taken from the title/branch, or --ticket)
node src/cli/arw.js review --repo your-org/payment-api --pr 123
#    read runs/prs/your-org__payment-api__123/report.md

# 3. Publish as a pending review, then open it on GitHub, edit, and submit yourself
node src/cli/arw.js publish --repo your-org/payment-api --pr 123 --dry-run
node src/cli/arw.js publish --repo your-org/payment-api --pr 123
```

### Dashboard (personal, local)

```bash
npm start            # = node src/cli/arw.js ui  → http://127.0.0.1:8787/
```

The dashboard lists runs, starts reviews and ticket runs as queued jobs (one at a time) that run the same `arw`
commands and stream their logs. It shows findings with diffs, rebuttals and the cited source lines at the frozen
commit, lets you edit requirement items, record gate decisions, and preview or create the pending GitHub review.
It binds to 127.0.0.1 only, rejects unexpected `Host`/`Origin` headers, requires a per-start token for every
write, and sends a strict CSP. There is no login, so do not expose it beyond your machine.

Useful flags: `--workers N`, `--single-role` (business units get only the business pass),
`--skip-seams`, `--skip-rebuttals`, `--skip-synthesis` (opt-outs are recorded in `validation.json`),
`--refresh` (re-plan and re-freeze). `arw validate` re-checks everything on disk with no model calls.

## Run layout

```
runs/tickets/<KEY>/      ticket-evidence.md, requirements.{json,md}, analysis.{json,md}, gates/, work/
runs/prs/<owner>__<repo>__<n>/
  run.json               identity, phases, units (statuses written by the driver only)
  pr-review-plan.md, plan.json, report.md, published.json, gates/
  review/revisions/<context_id>/
    context.json         frozen source + input hashes (+ tool hash)
    inputs/*.txt         evidence pack, requirements, scenarios, policies, agent charters
    packets/<role>/<unit>.json, rebuttals/<finding>.json, synthesis.json
    receipts.json        one entry per model call: mode, tokens, time, errors
    attempts/<job>-<n>/  prompt.txt, events.jsonl, raw-candidate.txt
    validation.json      the model-free verdict
```

## Customise

- `config/policies/checklist.md`: your team's viewpoints. Findings cite ids such as `CK-TX-1`.
- `agents/*.md`: role charters. They are frozen per review, so editing them invalidates older contexts.
- `config/schemas/*.json`: the output contracts.

## Tests

```bash
npm test
```

There are unit tests and an end-to-end test (ticket → review → publish draft → resume → tamper → drift) on a
Java + Python fixture repo, with a scripted executor standing in for codex.

## Not built yet

- Acceptance tracking: reading back which published findings were kept (`<!-- arw:finding=... -->` markers are already in each comment).
- An eval harness that replays frozen contexts against labelled findings.
- Multi-user access (the dashboard is single-user, loopback only).
