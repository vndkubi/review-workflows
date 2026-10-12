# agent-review-workflows

Evidence-first **ticket analysis** and **PR review** for Java/Maven and Python repositories,
driven by `codex exec` workers. Models propose; trusted Node scripts decide; people own the gates.

```
ticket:  intake → requirements (deterministic | model + audit) → [GATE REQUIREMENTS]
                → analysis (read-only investigation) → [GATE ANALYSIS] → READY
review:  PR + worktree → ticket inputs → plan (model, repaired until valid)
                → freeze (hash-bound context, no model)
                → W1 first-pass packets ∥ → W2 seams → W3 blind red-team per duplicate cluster → W4 synthesis
                → validate (no model) → report.md → publish as a PENDING GitHub review → [person submits]
```

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
4. Optional Jira: `JIRA_URL` + `JIRA_PAT` (Server/DC) or `JIRA_EMAIL` + `JIRA_API_TOKEN` (Cloud).

No npm dependencies.

## Use

```bash
# 1. Understand the requirement (stops at each gate)
node src/cli/arw.js ticket ACME-7 --repo your-org/payment-api        # from Jira
node src/cli/arw.js ticket ACME-7 --from-file ACME-7.md --repo-dir D:/src/payment-api
#    review runs/tickets/ACME-7/requirements.md, edit requirements.json if needed, then:
node src/cli/arw.js gate approve --ticket ACME-7 --gate REQUIREMENTS
node src/cli/arw.js ticket ACME-7 --repo your-org/payment-api        # runs the analysis
node src/cli/arw.js gate approve --ticket ACME-7 --gate ANALYSIS

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

- Repro tests (RED/GREEN on the reviewed head) to promote findings to `CONFIRMED`.
- Acceptance tracking: reading back which published findings were kept (`<!-- arw:finding=... -->` markers are already in each comment).
- An eval harness that replays frozen contexts against labelled findings.
- Multi-user access (the dashboard is single-user, loopback only).
