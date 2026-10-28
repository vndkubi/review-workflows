# src/web: the local dashboard

Read the root `AGENTS.md` first. This file holds what is specific to editing `src/web/`.

## Shape
- `src/web/` is not in the tool digest: editing it leaves frozen contexts valid. What it requires from
  `src/lib/` is.
- `server.js` serves a route table of `[method, regex, handler]`. Quick reads call `src/lib` in process;
  anything long (reviews, validate, doctor) is a job: `jobs.js` spawns `node src/cli/arw.js ...` and the
  page follows its log. A new long action becomes a job, not an in-process call.
- `public/app.js` is plain browser JS, no build, no framework.

## Guards to keep (each one answers a past bug or attack)
- Untrusted text (findings, quotes, tickets, PR text) is rendered only through text nodes (`h()` in
  `public/app.js`), never `innerHTML`.
- Loopback only. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); a
  write with an `Origin` from elsewhere is refused; every write carries the per-start token
  (`x-arw-token`, injected into `index.html`). The CSP allows `'self'` only.
- An HTTP status comes only from `httpError` (`data.js`). Never pass a child process exit code through
  as a status: a `gh` exit code once killed the server (bf1ec5a).
- Browsers compile `pattern=""` with the `v` flag: escape `/` and `-` inside character classes.
  `test/web.test.js` compiles every pattern.
- Gate buttons write through `recordGate` like `arw gate` does; they never approve on their own.

## Checking a change
- `node scripts/test.js test/web.test.js` (plus `test/web-*.test.js` when one matches the area).
- A browser pass on real run data, against a scratch copy: `ARW_RUNS_DIR=<copy> node src/cli/arw.js ui
  --port 8787 --no-open`. Never point a dev server at the real `runs/` while testing writes.
