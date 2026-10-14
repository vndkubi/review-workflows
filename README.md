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

**Ticket evidence** is the ticket (Jira REST, an MCP server, or a file), the Confluence pages it links to or
that mention it, its **linked tickets and parent** in brief (summary, status, description; `ARW_LINKED_ISSUES`,
default 5; each is its own quotable evidence block), and **images**: Jira image attachments (REST, or MCP with a
mapped download tool), or screenshots you pass with `arw ticket KEY --from-file t.md --image screen.png`.
Images are stored with their sha256 under `runs/tickets/<KEY>/attachments/` and sent to the requirement,
audit, spec and analysis jobs with `codex --image`; a changed image re-runs the later stages and a tampered one
is not sent. Text that only an image shows cannot be quoted, so it becomes an INFERRED item a person confirms
at the SPEC gate.

## Reproduction: from SUSPECTED to CONFIRMED

A failing test is not yet proof: it may fail for a reason that has nothing to do with the defect. The labels:

| Label | Evidence level | What the harness saw |
|---|---|---|
| SUSPECTED | L1 | quotes and evidence validated, no execution |
| REPRODUCED | L2 | a new test calling the cited code failed twice on the reviewed head |
| CONFIRMED | L3 | that, **and a control**: the finding's own fix makes the test pass, or (when the fix does not) the base commit passes it — a regression |

Tests that always fail (`assert False`, `fail()`) or do not call the code the finding cites are rejected.
Every run keeps raw evidence, hash-bound: the log ends with the process outcome (exit code, timeout) and the
JUnit XML is stored as written. `arw validate` recomputes each run's status, the verdict, `fix.verified` and
the control from those artifacts and rejects a record that disagrees with them. GREEN needs a zero exit code
as well as passing tests. (A person with write access to the run directory could still rewrite artifacts and
record together; the hashes protect against accidents and partial edits, not against that.)

**Isolation.** By default tests run on this machine in a separate worktree with secrets removed from the
environment — a build can still read what you can read and reach the network. `ARW_SANDBOX=docker` runs repro
and impacted tests in a throwaway container instead: only the worktree is mounted, no network
(`ARW_SANDBOX_NETWORK`), memory/CPU/process limits, killed on timeout. Images per toolchain
(`ARW_SANDBOX_IMAGE_MAVEN` / `_GRADLE` / `_PYTEST`); `ARW_SANDBOX_M2` mounts a local Maven repository read-only
so builds work offline. Checked with `maven:3.9-eclipse-temurin-17`: a test passing on base and failing on head,
no network, about 20 s per run. Built-in commands (Maven, Gradle, pytest) start in the container as a program with
arguments, no shell; a configured `test_command` runs through `sh -c`. If docker or its daemon is unavailable
(`ARW_DOCKER` names another CLI), the run is ENVIRONMENT_BLOCKED; it never falls back to the host. Impacted-test
results record where they ran. `ARW_DOCKER_TESTS=1 npm test` also runs the isolation tests in real containers
(network, host environment, links made inside the container, a rewritten `.git` file, timeout). The sandbox settings are part of the frozen context: switching between host and
docker, or changing image, network, limits or mounts, is drift. Image tags can move; pin `name@sha256:<digest>`
to make the image exact.

What the container cannot protect is the harness's own file access on the host. The worktree is PR code, so
any path in it may be a symlink (tracked, or made by a build). Writing the model's test, applying the fix, and
reading or deleting JUnit reports all refuse paths that go through a link (`src/lib/confine.js`). A test path or
PR test file name with anything other than letters, digits and `_ . - /` never reaches a shell command.
The check and the write are separate calls, so a process left running in the background (a build daemon)
could still swap a directory in between. Git in such a worktree never reads its `.git` file (PR code can point
it at a repository whose config runs commands, or delete it so git finds a parent repository): the git dir
comes from the main repository's records, with hooks and fsmonitor off.

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
   pass marks the fix as verified. If it does not pass, the same test runs on the base commit.

`RED_PROVEN` with a control (the fix makes the test pass, or the base commit passes it) turns a finding (and
its duplicates) into **CONFIRMED (L3)**; without one it is only REPRODUCED. Each run's log and the test file
are stored with SHA-256 hashes, and validation re-checks them: an edited log turns the finding back into
SUSPECTED and makes the review incomplete.

## Sandbox discovery: what a repository needs to build

```
arw sandbox discover <owner/name | dir>... [--rev <rev>] [--json]
```

Reads the build metadata of a revision from git objects (never the working tree, nothing executed) and
reports, each with `path:line` evidence that matches the revision:

- **Build system**: Maven (the module tree from the root POM, parents inside the repository, properties,
  `pluginManagement`) and Gradle (literal values only: build scripts are code, anything computed is not seen).
- **Java**: the version it compiles for (`release`/`target`/`source`, compiler properties, Spring Boot's
  `java.version`) and the JDK it builds with: an explicit toolchain, then CI (`setup-java`, CI images,
  Jenkins `jdk`), then `.java-version`/`.sdkmanrc`/`.tool-versions`, otherwise the declared target. A
  Dockerfile or a framework default counts only when nothing else does. Labelled DECLARED, INFERRED or
  UNKNOWN; contradictions (a JDK older than the target, a JDK that can no longer compile for it, an enforcer
  minimum) are listed.
- **Coordinates**: what the repository produces (parent POMs included) and what it depends on, with versions
  resolved through properties and `dependencyManagement` where they are in the repository.
- **A proposed sandbox**: image and commands, marked not verified (a bootstrap run has to prove it).

Checked on three public repositories (jhipster sample, hadoop, elasticsearch): 0.4–0.8 s each, every one of
8,581 evidence lines matches `git show`.

```
arw sandbox graph [<owner/name | dir>...] [--json]      (default: every configured repository)
```

Which repository produces an artifact another one depends on (by `groupId:artifactId`), the build order, and
which repositories can build side by side (a payment-lib on Java 8 before a payment-server on Java 11). A
dependency is a reason to build the other repository first only when it wants the version that source
produces: on the real clones elasticsearch depends on hadoop `2.8.5` releases while the hadoop source
produces `3.6.0-SNAPSHOT`, so hadoop is not built first; that is a note. Two repositories producing the same
coordinate, a cycle, or a library compiled for a newer Java than its consumer builds with are reported as
problems (exit code 2), never resolved by guessing.

```
arw sandbox bootstrap <owner/name | dir>[@rev]... [--force] [--keep] [--allow-test-failures] [--image <image>]
arw sandbox records [<repo>...]
```

Builds and tests the repositories in graph order, each in its own containers (Maven only so far), and keeps
what was verified under `runs/sandbox/` (`ARW_SANDBOX_HOME`):

1. a **source snapshot** of the exact revision from `git archive`: no `.git`, symlinks skipped, entries that
   would land outside refused; the checkout is never touched;
2. **resolve, with network**: Maven fills this repository's dependency cache (one test class per module runs
   so the test provider is fetched; nothing is installed). It runs the revision's build plugins with network,
   so bootstrap is for revisions you trust. Skipped when the same build files (and staged POMs) were
   resolved before;
3. **build and test, without network**: `mvn -o install` into a task-private local repository; the cache and
   the artifacts of the repositories it depends on are read-only (`maven.repo.local.tail`);
4. the produced jars and POMs are copied out, hashed, and stored with a **verification record**: status
   (`TESTS_PASSED`, `TESTS_FAILED` — built, tests failed —, `ARTIFACT_BUILT`, `BUILD_FAILED`,
   `RESOLVE_FAILED`, `RESOLUTION_INCOMPLETE`, `ENVIRONMENT_BLOCKED`), JUnit reports and logs as hashed evidence.

A record is keyed by a fingerprint of the source tree, the recipe (image id, commands), the digests of the
artifacts it consumed and the execution policy. Same fingerprint and intact files: reused, nothing runs.
An environment failure is never reused. A repository whose dependencies have no usable record is BLOCKED and
does not run; a library whose tests failed is not used unless `--allow-test-failures`.

Measured with real containers (`ARW_DOCKER_TESTS=1`, test/bootstrap-docker.test.js): payment-lib on
`maven:3.9-eclipse-temurin-8`, payment-server on `-11` using it.

| Run | payment-lib | payment-server | Time |
|---|---|---|---|
| 1. cold | resolve + build + test | resolve + build + test | 134 s |
| 2. server changed | reused | build + test | 19 s |
| 3. library changed | build + test | build + test | 36 s |
| 4. library broken | BUILD_FAILED | BLOCKED, not run | 12 s |

**In a review** (`ARW_SANDBOX=bootstrap`), the impacted tests and the reproduction tests run in an environment
prepared once per review (`<run>/sandbox-env.json`):

- the image discovered for the PR head;
- the configured repositories this one needs built from source (by the build graph), bootstrapped or reused,
  their artifacts staged read-only;
- this repository's dependency cache resolved at the **base** revision: the only step with network, so the
  PR's own code never runs with network;
- every Maven run offline in it (`MAVEN_ARGS=-o`, local repository and read-only tails through `MAVEN_OPTS`,
  so a configured `test_command` gets it too).

Results carry the environment's digest; the reproduction re-checks the image and the staged artifacts before
it runs. A dependency the PR adds is not in the environment: that run is ENVIRONMENT_BLOCKED ("does the PR add
one?"), not a test failure. A blocked environment blocks the runs; nothing falls back to the host, and the
static review goes on. The dashboard's **Sandbox** page shows the mode and docker status, discovery per
repository, the build graph, and the verification records with their logs and JUnit reports; bootstrap and
"Verify again" (`--force` for that repository only) run as jobs with a live log. Bootstrapping one repository
brings the configured repositories it needs. **Set up from a source folder** does it in one step: give a
path to a git checkout, Detect shows what it needs (build, JDK and its evidence, image), Set up pulls a
missing image, optionally adds the folder to the repositories, and bootstraps it with what it depends on
(`arw sandbox setup <dir> --register [--name owner/name]` on the command line). Detect also lists the
libraries it depends on: built from source by a configured repository, from a Maven repository, or in-house
but without source (same group, or a SNAPSHOT) — give that library's source folder there (Add library: it
must produce that artifact) and the setup builds it first. Measured with real containers: a PR that breaks payment-server's `BillingTest` is
reported as "FAILS ON HEAD, passed on base" (`expected:<100> but was:<101>`), 154 s cold (payment-lib built,
both resolved), 23 s for the next review.

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

# Self-review before opening a PR (no GitHub needed)
node src/cli/arw.js review --local D:/src/payment-api --base main --mode branch    # commits since leaving main
node src/cli/arw.js review --local D:/src/payment-api --mode staged                # what `git add` has staged
node src/cli/arw.js review --local D:/src/payment-api --mode worktree              # all tracked edits
```

A local review needs an immutable commit like any other: staged and working-tree modes write a dangling
snapshot commit (`git write-tree` / `git stash create` + `commit-tree`), so your branch, index, stash and files
are not touched. Untracked files are not included. The run lives at `runs/prs/local__<dir name>__<n>/`, with
one run per (repository, branch, mode) so re-running refreshes it. Repro uses the `test_command` of the
configured repository whose `checkout` is that directory. It can be previewed but not published.

### Dashboard (personal, local)

```bash
npm start            # = node src/cli/arw.js ui  → http://127.0.0.1:8787/
```

The dashboard lists runs, starts reviews and ticket runs as queued jobs (one at a time) that run the same `arw`
commands and stream their logs. It shows findings with diffs, rebuttals and the cited source lines at the frozen
commit, lets you edit requirement items, record gate decisions, and preview or create the pending GitHub review.
**Settings** (top bar) edits everything that used to need a text editor: executor, review and repro options
(written to `.env`, comments kept, applied to new jobs without a restart), the ticket source (an MCP server
with a connection test, or Jira/Confluence REST), and the repository list. Secrets are write-only: the page
only shows whether they are set, and MCP headers must reference them as `${NAME}`. Diagnostics runs
`doctor` with streamed output.

It binds to 127.0.0.1 only, rejects unexpected `Host`/`Origin` headers, requires a per-start token for every
write, and sends a strict CSP. There is no login, so do not expose it beyond your machine.

**Impact analysis.** The evidence pack carries the call sites of every changed method or function, up to three
levels of callers, from a structural index of the repository's Java and Python files (no parser dependency):
comments and string literals are blanked first, declarations are indexed with their line ranges, and a
changed declaration is one whose lines hold an added line at head or a removed line at base. Each call site
names the method that contains it and how sure the match is: **resolved** (the caller imports or shares the
package of the declaring type, or imports the module; or a call within the same class/file) or **name-only**
(another method of that name is possible; not followed further, and dropped for common names such as `get`).
`Other.name(...)` with a type-like receiver other than the owner is not counted. Tests reached through the
callers are added to test impact as `call`. Measured on a synthetic 3,000-file Java repository: about 5 s.

Receivers are typed where the code says so: fields, parameters and locals (`OrderService orders`,
`var x = new T()`, Python `svc = FeeService()`, `o: Other`), `new T().m()` and `T().m()`. A call on a receiver
declared as the changed type is **typed**; declared as one of its supertypes (an interface or base class, as
with Spring-injected interfaces) it is **interface** dispatch; declared as an unrelated type it is dropped.
Beyond calls, the analysis lists references **by name**: configuration files naming the type
(`applicationContext.xml`, MyBatis mappers, YAML/properties, with the method id when present), reflection
(`getMethod("x")`, `getattr(o, "x")`), and **HTTP clients** of changed endpoints (Spring `@…Mapping`,
Flask/FastAPI decorators) found by path in non-handler files. Other repositories are searched when a
repository lists them under `"related"` in `config/repos.json` (configured names or absolute paths): callers
that import the changed type or module, and clients of changed endpoints, read-only at their checkout's HEAD.
**With a JDK (11+) on PATH, Java calls are resolved by javac itself.** `src/lib/JavaIndex.java` runs through
the JDK's source launcher (no build step) and uses the Compiler Tree API to parse and attribute the
repository's Java files: annotation processing is off and nothing is executed. Every call it resolves to a
type of the repository decides that call site: **ast** (the changed method itself — same owner and parameter
count, so another overload is not counted) or **ast-dispatch** (a supertype's method the changed one overrides:
interface calls, injected beans, base classes). This covers what text cannot: the type behind `var`, chained
and multi-line calls, method references, any expression as receiver. Calls javac cannot resolve (a library
missing from `ARW_JAVA_CLASSPATH`) keep the structural result; if javac fails or the repository has more than
`ARW_JAVA_AST_MAX_FILES` (8,000) Java files, the structural index is used and the pack says so. Measured on
the synthetic 3,000-file repository: about 26 s with javac against 5 s structural, same 20 callers.
`ARW_JAVA_AST=off` turns it off.

Setup on the machine that runs `arw` (nothing on the reviewed project's side, no build): a **JDK 11+** with
javac — `java` on PATH, or `ARW_JAVA_HOME` pointing at one — **at least as new as the Java the projects build
with** (javac reads older source, not newer: JDK 11 cannot read records or sealed classes). `arw doctor` checks
it against the Java level of every configured repository (pom.xml / Gradle). The pack says when javac could
not parse a file (that file's calls fall back to the structural match), when the project's Java level is newer
than the JDK, and when a class name is declared in more than one file (separate modules, or Java 8 and 11
variants of one API): javac kept only one of them, so its answers for that name are not used.
`ARW_JAVA_CLASSPATH` (library jars, e.g. from `mvn dependency:build-classpath`) lets more calls resolve; calls
between the repository's own classes need nothing.

Still unknown: generated code, reflection beyond the patterns above, and repositories that are not
configured. `ARW_IMPACT=off` skips the analysis.

**Machine evidence.** Before planning, the runtime collects cheap facts and freezes them in the evidence pack
(also `runs/prs/<id>/static.json`, and the Overview tab): GitHub check runs, commit statuses and failing-check
annotations on changed files for the head commit; linter hits on the changed files, marked when they fall on an
added line; and test impact (for each changed Java/Python source, the tests found by naming convention or by a
reference to it, and whether the PR changed them). Reviewers are told these are leads to verify, not findings.
Built-in linters are tools that read source without executing it — `ruff`, `semgrep` (only with a local
`.semgrep.yml` or `ARW_SEMGREP_CONFIG`), `pmd` (rulesets from `ARW_PMD_RULESETS`) — and run when they are on
`PATH`. Anything else, such as `mypy` (whose plugins execute code) or SpotBugs (needs a build), is opt-in per
repository via `static_commands` in `config/repos.json` (see the example; output lines `path:line: message`,
file paths appended where `{files}` appears). Commands run without a shell, with secrets removed from the
environment, and file names are passed as `./path` so a PR cannot turn one into an option. `ARW_STATIC=off`
disables linters.

**Impacted tests (opt-in).** With `ARW_RUN_IMPACTED_TESTS=on` (or `"run_impacted_tests": true` on a repository)
the existing tests found by test impact (up to `ARW_IMPACTED_TESTS_MAX`, 10) run at the base and at the head in
their own worktree, grouped per toolchain and module (Maven `-Dtest=A,B`, Gradle `--tests`, pytest paths). Each
test file gets a verdict — **newly failing** (passes on base, fails on head: broken by this change), still
failing, fixed, passing, new test passing/failing — with the failing cases' messages. The result is frozen
into the evidence pack and shown in the report and the Overview tab. This executes PR code like repro does,
with secrets removed from the environment; leave it off for repositories you do not trust. pytest runs with
`ARW_PYTHON`, or the first of `python`, `python3`, `py` that can import pytest (on some machines `python` is
another tool's virtualenv).

**Large PRs.** The whole-diff viewpoints (V0 technical, V1 business) answer one coverage row per file, so on
more than `ARW_VIEWPOINT_FILES` (25) files they are split into parts of neighbouring files (`V0_1`, `V0_2`, …).
Every unit gets a deterministic risk score (changed lines, boundary signals, money/auth/data paths up,
docs/tests down) and units run riskiest first inside each wave, so a budget stop (`ARW_MAX_CALLS`,
`ARW_MAX_INPUT_TOKENS`) leaves the least risky part undone and reported as a gap. Above `ARW_LARGE_PR_FILES`
(60) files or `ARW_LARGE_PR_LINES` (2000) changed lines the report and the dashboard say the PR is too large to
review well and propose a split along the planned units (units sharing files stay together).

**New pushes are reviewed incrementally.** When the PR head moves, the previous plan is kept if the PR still
changes the same files, and a packet from the previous context is carried over when the tool, review items,
spec and policies are byte-identical, the unit is the same, none of its files changed on either side of the
diff, and no file it cites changed. Carried packets (and the rebuttals of their unchanged findings) are
validated against the new frozen sources like any model output; whatever fails runs again. Synthesis and
reproductions always run again. `--refresh` forces a full re-plan and re-review.

Useful flags: `--workers N`, `--single-role` (business units get only the business pass),
`--skip-seams`, `--skip-rebuttals`, `--skip-synthesis` (opt-outs are recorded in `validation.json`),
`--refresh` (re-plan and re-freeze). `arw validate` re-checks everything on disk with no model calls.

### Automation: watch PRs, notify when a review finishes

Tick **Watch** for a repository in Settings (or set `"watch": true` in `config/repos.json`) and turn
`ARW_WATCH` on: the dashboard polls GitHub every `ARW_WATCH_INTERVAL` seconds (default 300) and queues a
review for every new PR and every new push (reviews of new pushes are incremental). Drafts (unless
`"watch_drafts": true`) and PRs labelled `arw:skip` are left alone; `runs/watch/state.json` remembers what was
queued. Without the dashboard, `arw watch [--once]` does the same in a terminal or from a scheduler (cron,
Task Scheduler). Nothing is published automatically: a person still opens and submits the review.

When a review finishes, `ARW_SLACK_WEBHOOK` (Slack incoming webhook) and/or `ARW_NOTIFY_WEBHOOK` (JSON POST)
receive a summary: recommendation, counts and the top findings' titles, with a link if `ARW_DASHBOARD_URL` is
set. `ARW_NOTIFY_ON` = `findings` (default), `blocking` (P1/P2 or a failed review) or `all`. Webhooks must be
https (http only for localhost); a failed notification is logged and never fails the review. Finding titles
leave this machine, so point them at a channel where the reviewed code may be discussed.

### Feedback: acceptance rate and rejected findings

```bash
node src/cli/arw.js feedback --repo your-org/payment-api --pr 123     # after you submitted the review on GitHub
node src/cli/arw.js acceptance                                        # kept / edited / dropped, by severity, label, role
node src/cli/arw.js reject --repo your-org/payment-api --pr 123 --finding B1-business-F1 --reason "inclusive by design"
node src/cli/arw.js memory [--forget RJ-...]
```

`feedback` reads the submitted review back and finds each published comment by its
`<!-- arw:finding=... -->` marker: **kept** (unchanged), **edited** (reworded, or rewritten at the same line
without the marker) or **dropped** (deleted before submitting). Dropped findings, and findings rejected in the
dashboard or with `arw reject`, go to `runs/memory/rejected.json`. Later findings in the same repository and
file that look alike are marked in the report and the dashboard; P3/P4
look-alikes are left out of the published draft and P1/P2 ones are published with a note. The exact finding a
person rejected is never published. Validation never reads this memory, so verdicts stay a function of the
frozen context. Local reviews share memory with the configured repository whose `checkout` is that directory.

"Look alike" is judged by meaning, offline and deterministically: the best of word overlap, **concept** overlap
(stems folded into review vocabulary — threshold/limit/edge → boundary, float/rounding/decimal → precision,
None/null/missing → missing, …) and the **code anchor**: same file, same enclosing method (from the structural
index), and either the same code to change (`fix.asis` identifiers) or the same checklist item/requirement.
The same method alone is not enough, since two different defects often share one. Each match says why
(`same code`, `same concern`, `same words`).

The conversation after submission is read too: replies in each comment's thread (with a hint when a reply
disputes the finding — "by design", "won't fix" — or reports it fixed) and, through GraphQL, whether the thread
was resolved or became outdated. A dispute is shown and counted, not remembered as a rejection: only the
reviewer's own decision suppresses a finding.

### Retrospective and checklist mining

```bash
node src/cli/arw.js retro --since 30 [--save]       # where calls and tokens go, what the validator rejects, who finds what
node src/cli/arw.js checklist propose               # checklist changes mined from kept and rejected findings
node src/cli/arw.js checklist accept add-1a2b3c4d --text "Money is rounded to the currency unit before it is stored."
```

`retro` reads run directories only: calls, repairs and first-try acceptance per job kind, the most common
validator rejections (receipts keep a sample of the errors), findings per reviewer with how many people kept or
dropped, budget stops and executor failures, plus rule-based suggestions that name the evidence they rest on.
It has already paid off: on real runs the most repeated repair was a shortened input id (`"evidence"` for
`"evidence-pack"`), which the runtime now completes itself.

`checklist propose` suggests three kinds of change: **add** (the same kind of defect kept in two or more reviews
with no checklist item behind it), **avoid** (look-alike findings rejected in two or more reviews become a
"Do not report" line) and **revise** (an item whose findings are mostly rejected). Accepting writes the line
under "## Learned from reviews" with the next free `CK-<CAT>-<n>` id; the new policy hash refreshes later
reviews. The dashboard's **Insights** page shows both, with one-click accept.

### Evals: measure before you trust a change

A case (`evals/cases/<id>.json`, git-ignored because it points at your clones) is a commit range plus labels:

```json
{
  "id": "discount-boundary",
  "repo": "D:/src/payment-api",
  "base": "3f2a91c", "head": "8be04d7",
  "flags": { "noRepro": true },
  "expected": [
    { "id": "E1", "path": "src/main/java/com/acme/OrderService.java", "lines": [8, 12],
      "keywords": ["1000000", "boundary"], "severity_at_least": "P2" }
  ],
  "not_expected": [
    { "id": "N1", "path": "billing/fees.py", "keywords": ["float"], "why": "rates are display-only" }
  ]
}
```

```bash
node src/cli/arw.js eval add --repo your-org/payment-api --pr 123   # a case from a reviewed PR (after arw feedback / rejections)
node src/cli/arw.js eval run --label baseline                       # each case: arw review --local <repo> --base --head, own runs dir
node src/cli/arw.js eval label --run <run> --case <id> --finding T1-technical-F2 --as fp
node src/cli/arw.js eval rescore <run>
node src/cli/arw.js eval compare <baseline run> <new run>           # exits 1 when an expected defect is newly missed
```

**Is the multi-agent harness worth its calls?** Run the same cases under named configurations and compare:
`arw eval run --config single-agent` (one reviewer over the whole diff: no planner, seams, red team or
synthesis — the baseline), `--config multi-agent`, and `--config multi-agent+repro`. Same model, same inputs,
same labels; `arw eval compare` shows recall, precision and calls side by side. Until such runs exist on PRs
with known defects, any claim that one configuration is better is an opinion.

A finding matches a label when it cites code in that file, within ±3 lines of `lines` (if given), and its
title/ASIS/TOBE contains one of the `keywords` (if given). **Recall** = expected defects found; **precision** =
true / (true + known false) among the findings a reader would see (not withdrawn by the red team, not folded as
duplicates); everything else is listed as unlabelled for you to label. The scorecard also records a defect the
red team wrongly withdrew, the cost of every case, the tool hash, the arw commit and the model. Comparisons
re-score both runs on the current labels. The dashboard's **Evals** page runs cases as a job, labels findings
with one click and compares runs. `ARW_EXECUTOR_MODULE` replaces codex with a module (tests use
`test/fixtures/fake-review-executor.js`).

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
Java + Python fixture repo, with a scripted executor standing in for codex. Tests never touch your `.env`,
`config/*.json`, `runs/` or `wt/`: they point `ARW_ENV_FILE`, `ARW_REPOS_FILE`, `ARW_MCP_CONFIG`,
`ARW_RUNS_DIR` and `ARW_WT_DIR` at temporary directories.

## Not built yet

- Multi-user access (the dashboard is single-user, loopback only).
