---
name: dashboard-change-verify
description: Change the ARW dashboard (src/web/, the arw ui server and its browser page) and prove it works in a real browser on real run data. Use for any edit under src/web/ or any new API route, page, filter or button.
---

# Dashboard change, verified in the browser

Read `src/web/AGENTS.md` first: it lists the guards every change keeps (text nodes only, Host and
Origin checks, the per-start token, CSP, `httpError`, `v`-flag patterns).

## 1. Make the change
- A route is one `[method, regex, handler]` row in `src/web/server.js`. Anything slow becomes a job
  (`src/web/jobs.js` spawns the CLI); quick reads call `src/lib` directly.
- The page is `src/web/public/app.js`: build elements with `h()`, never `innerHTML`.
- A write route checks its input and throws `httpError(status, message)` from `src/web/data.js`.

## 2. Tests
- `node scripts/test.js test/web.test.js`, plus the `test/web-*.test.js` file of the area
  (`web-progress`, `web-sandbox`, `web-viewpoints`, `web-preliminary`).
- A new input with `pattern` is covered by the `v`-flag test in `test/web.test.js` automatically.

## 3. Browser pass on real data, never on the real runs
Copy one or two real run directories to a scratch folder and point the server at it:

```bash
mkdir -p "$TMPDIR/arw-ui/prs" && cp -r runs/prs/<owner>__<name>__<pr> "$TMPDIR/arw-ui/prs/"
ARW_RUNS_DIR="$TMPDIR/arw-ui" node src/cli/arw.js ui --port 8787 --no-open
```

Then, in a browser at `http://127.0.0.1:8787/`:
- the changed view renders with real findings, quotes and statuses;
- the console has no errors and the network tab no failed request;
- a write (gate, reject, settings) works and shows up in the scratch copy, not in `runs/`;
- the page works at a narrow width if the layout changed.

Stop the server when done.

## 4. Report
In the commit body: `Checked in the dashboard:` and what was looked at, with the run used.
