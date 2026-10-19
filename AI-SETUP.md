# Set up ARW with an AI assistant

Give this file to a coding assistant (Claude Code, Codex, Copilot agent) opened in a fresh clone of this
repository, with a message such as:

> Read AI-SETUP.md and set up this tool on my machine.

Everything below the line is the instruction for the assistant.

---

You are setting up **ARW** (agent-review-workflows) on the user's machine. ARW reviews pull requests with
`codex exec` workers; trusted Node scripts in `src/lib/` decide what is valid. Your job is to get it to a
state where `npm test` passes, `npm run doctor` is clean (or every warning is explained), and one review
can run. Reply in the user's language.

## Rules

- **Check before you change.** Run the check commands first and show the user what is missing. Do not
  install anything the check does not report as missing.
- **Ask before every install** (winget, brew, apt, Docker Desktop, a JDK). Name the package and why it is
  needed. Optional items stay optional: offer them, do not push them.
- **Never type passwords, tokens or API keys.** The user signs in themselves: `codex login`,
  `gh auth login`, and any Jira/Confluence token goes into `.env` by the user. You may open `.env` and
  point at the line to fill.
- **Do not edit** `src/`, `agents/`, `config/schemas/`, `config/policies/`: they are the trusted runtime,
  and changing them changes the frozen hashes of every review.
- **Do not commit or push.** `config/repos.json`, `.env`, `runs/`, `wt/` and `evals/` are local and
  gitignored; keep them that way.
- `npm run doctor` makes one tiny model call; `arw doctor --provider` makes a few. Say so before running
  them. A full review makes many calls: run one only when the user asks, on a PR they name.
- Report what you ran and what it printed. Never claim a check passed unless you ran it.

## Step 1: what the machine has

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -CheckOnly
```

macOS / Linux:

```bash
scripts/setup.sh --check-only
```

If Node 20+ is already there, `node src/cli/arw.js setup --check` gives the same report. Show the user a
short table: item, found or missing, needed for what.

| Item | Needed for |
|---|---|
| Node ≥ 20, git | everything |
| codex CLI, signed in | every model call |
| GitHub CLI, signed in | reviews of GitHub PRs (not local reviews or tickets from a file) |
| JDK 11+ (17+ is safer) | Java impact analysis; running proof tests of Java PRs on the host |
| Maven or Gradle, or the repository's `mvnw` / `gradlew` | proof tests on the host |
| Docker (optional) | proof tests in containers instead of on the host |

## Step 2: install what is missing

With the user's consent, run the setup script without the check flag. It installs only what is missing,
asks before each install, and then runs `arw setup` and `arw doctor`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -WithJava
```

```bash
scripts/setup.sh --with-java
```

Add `-WithDocker` / `--with-docker` only if the user wants proof tests in containers. Without Docker,
proof tests run on the host: a JDK is picked from those installed, dependencies are resolved once at the
PR's base commit, and the PR's test runs offline.

When the script reaches sign-in, stop and ask the user to run `codex login` and `gh auth login`
themselves, then continue.

## Step 3: settings

`arw setup` creates `.env` from `.env.example` when it is missing. Go through these with the user:

- `CODEX_MODEL`: default `gpt-6-luna`. It must be available to the user's codex login.
- `CODEX_EFFORT`: `max` gives the most findings; `high` costs less. If the company's provider fixes the
  effort (self-hosted or BYOK models), set `CODEX_EFFORT=managed` and run `node src/cli/arw.js doctor
  --provider` to see what the provider supports.
- `ARW_OUTPUT_LANGUAGE`: language of finding titles and explanations (quotes stay verbatim).
- Jira / Confluence: only if the user reviews against tickets; the user fills the tokens.

Settings that found the most defects when measured on 17 open PRs:

```
CODEX_EFFORT=max
ARW_SMALL_PR=off
ARW_PLAIN_REVIEW=on
```

`ARW_PLAIN_REVIEW=on` is the default: a plain senior-engineer review of the whole PR runs inside the
pipeline, and its findings are quote-checked, red-teamed and proven by tests like the rest.

A preset sets the cost-related settings in one step:

```bash
node src/cli/arw.js setup --preset thorough     # or fast, java-docker
```

All settings are also on the dashboard (`npm start`, then Settings).

## Step 4: repositories

A GitHub PR review needs a local clone of the repository, mapped in `config/repos.json`. Ask the user
which repositories they want to review and where the clones are (or should go). Then either:

- clone it (`git clone <url> <folder>`) if the user agrees, and add it in the dashboard (Settings >
  Repositories), or
- write `config/repos.json` following `config/repos.example.json`:

```json
{ "repos": { "owner/name": { "checkout": "D:/src/name", "remote": "origin" } } }
```

Use forward slashes in paths on Windows. For containers, `node src/cli/arw.js sandbox setup <folder>
--register` detects the build, prepares the sandbox and registers the folder in one step (it needs Docker).

## Step 5: verify

Run, in order, and show the result of each:

```bash
npm test                         # no network, no model calls; expect 0 failures
npm run doctor                   # one tiny codex call; fix every "fix:" line or explain it
```

If the user agrees, one small review end to end, on a PR they choose:

```bash
node src/cli/arw.js review --repo owner/name --pr 123
```

It prints where the report is (`runs/prs/<owner>__<name>__<pr>/.../report.md`). `npm start` opens the
dashboard to browse it. Publishing to GitHub is a separate, explicit step (`arw publish ... --dry-run`
first); do not publish without the user asking.

## Step 6: report to the user

Finish with:

- a table of what is installed, what was installed now, and what stays optional and missing;
- the settings chosen (model, effort, preset, where PR code runs: Docker or host);
- the commands run and their results (`npm test` counts, `doctor` lines);
- what is not verified yet (for example: no review run yet, Docker not running, no JDK 17 for a
  Java 17 project).

Common problems:

| Symptom | Cause and fix |
|---|---|
| `doctor`: model not available | the codex login does not offer `CODEX_MODEL`; pick a model it offers |
| proof tests `ENVIRONMENT_BLOCKED: needs Java 17` | install a JDK 17+, or set `ARW_JAVA_HOME` to one |
| `no local checkout for owner/name` | add the repository to `config/repos.json` |
| Docker installed but `daemon not running` | start Docker Desktop, or leave it: proof tests fall back to the host |
| a provider rejects structured output | set `CODEX_OUTPUT_SCHEMA=0` |
