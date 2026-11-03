# Hook proposals

Four hooks, each answering a failure this repository has had or can have. The scripts exist and were
run on 2026-10-28 (Windows, Git Bash, Node 22); nothing is enabled yet. Enabling them is the user's call.

| Hook | Kind | Stops | Cost |
| --- | --- | --- | --- |
| `.githooks/pre-commit` | git | private files in a public repo; staged JS that does not parse | < 1 s |
| `.githooks/pre-push` | git | pushing a red suite to `main` | ~2-3 min |
| `scripts/hooks/guard-frozen-edit.js` | Claude Code PreToolUse | editing frozen tool/policy files during a run; hand edits in `runs/` | ~1 s |
| `scripts/hooks/test-touched.js` | Claude Code PostToolUse | a break found only at push time | 1-20 s per edit |

## Git hooks

Enable once per clone (tried in a scratch clone):

```bash
git config core.hooksPath .githooks
```

Commit the hook files with the executable bit so other clones get it:
`git add --chmod=+x .githooks/pre-commit .githooks/pre-push`.

### pre-commit: nothing private reaches the public repository

Why: `origin` is public. `Sổ tay làm việc với AI.md` and `.claude/` are untracked but not ignored,
so `git add -A` would publish them. `runs/`, `evals/`, `wt/` hold reviewed-project code and only
`.gitignore` keeps them out; `git add -f` gets past it.

It refuses staged additions or changes to the handbook, `.claude/`, `runs/`, `wt/`, `evals/`,
`_study/`, `.env`, `config/repos.json`, `config/mcp.json`, `config/projects/`, and any staged `.js`
whose staged content does not parse (as a CommonJS module; a leading `#!` line is allowed).
Deletions pass.

Tested in a scratch clone with `core.hooksPath` set:

| Case | Result |
| --- | --- |
| handbook, `.claude/launch.json`, `runs/`, `config/repos.json`, `config/projects/`, broken JS staged with `-f` | refused, exit 1, all six listed |
| a clean change to `src/cli/arw.js` (has a `#!` line) | committed |
| broken JS staged, then fixed on disk only | refused: the staged content is checked |
| `git rm` of a tracked file | committed |

The 128 tracked `.js` files all pass the parse check (no false positives).

A lighter, local-only alternative for the two untracked paths (keeps the handbook's name out of the
public `.gitignore`; tried in the scratch clone, `git check-ignore` then matches both):

```bash
printf '%s\n' '/Sổ tay làm việc với AI.md' '/.claude/' >> .git/info/exclude
```

### pre-push: the suite CI runs, before it reaches main

Why: commits go straight to `main`, and CI runs only after the push (ubuntu and windows, Node 20 and
22). 79d8ee2 and c82e904 were CI failures fixed after the push.

Tested: pushing a commit that deleted `src/lib/anchors.js` to a scratch bare repository was refused
(45 failing tests); pushing the commit before it went through (317 passing, 0 failing; the scratch
clone has no uncommitted work, so it has fewer tests than the working tree).

Not proposed: a `commit-msg` hook. 92 of 94 subjects already follow the style, and style is not a
safety problem.

## Claude Code hooks

Proposed for `.claude/settings.local.json` (personal, never committed; the pre-commit refuses
`.claude/` anyway):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/guard-frozen-edit.js\"", "timeout": 20 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hooks/test-touched.js\"", "timeout": 300 }]
      }
    ]
  }
}
```

Both command strings were run through `bash -c` with `CLAUDE_PROJECT_DIR` set, with tool-call JSON
on stdin. Worktrees under `.claude/worktrees/` get the scripts only once they are committed; until
then the hook fails there with a non-blocking error.

### guard-frozen-edit (PreToolUse): no drift in a run that is going on

Why: `verifyContext` checks the tool digest (`src/lib`, `src/cli`) and the frozen policy files
(`agents`, `config/policies`, `config/schemas`, `config/projects`) before and after every model call.
An edit in the middle of a review or eval aborts it, and an eval matrix can run for hours. `runs/`
holds hash-bound evidence: an edit there breaks validation.

It blocks (exit 2, reason to the model):
- any edit under `runs/`;
- an edit of a frozen path while `node ... arw.js review|raw-review|repro|validate|ticket|watch|eval run|eval matrix`
  of this checkout is running (read from the process list; a relative `arw.js` path counts as this
  checkout).

Tested with stand-in processes (`node -e "setTimeout(...)" <path>/src/cli/arw.js <subcommand>`):

| Case | Exit |
| --- | --- |
| nothing running: `src/lib/driver.js`, `README.md`, `agents/planner.md` | 0 |
| `runs/...` (relative, absolute with backslashes, lower-case drive) | 2 |
| review of this checkout running: `src/lib`, `src/cli`, `config/schemas`, `agents`, `config/policies` (notebook_path) | 2 |
| same run: `config/repos.json`, `test/x.test.js`, `README.md` | 0 |
| `eval run` with a relative `arw.js` | 2 |
| `eval list`, `arw ui`, a review of another checkout | 0 |
| empty or malformed stdin | 0 |

Limit: a run started outside this checkout's `src/cli/arw.js` (another clone) is not this
checkout's run and is ignored, which is right: it hashes its own files.

### test-touched (PostToolUse): the edited file's tests, right after the edit

Why: the full suite takes ~2-3 minutes, so it runs late. 80 of 94 commits change `src/lib` and `test/`
together.

It runs `test/<name>.test.js` for `src/**/<name>.js`, else the test files that `require` the module
(at most 3), and a test file itself when one is edited. Other files are skipped. On failure it exits
2 with the failing test names and the last 40 lines.

Tested: `anchors.js` -> `test/anchors.test.js` (5 s); `driver.js` -> 3 requiring tests (20 s);
`cluster.js` (2 s); a test file (1 s); `README.md` (skipped). In the scratch clone, `anchors.js` with
`resolveAnchor` stubbed out gave exit 2 with the three failing tests named.

Caveat: in a change spread over several files, a test can fail between edits. The hook only reports;
it does not undo the edit.

## Considered, not proposed

- A Stop hook running `npm test`: 2-3 minutes at every stop. pre-push covers it.
- A Bash PreToolUse hook refusing `git add -A`: pre-commit catches the result whatever the command.
