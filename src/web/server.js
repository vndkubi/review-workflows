'use strict';
// Personal dashboard. Loopback only; every request must carry the expected
// Host (DNS-rebinding guard) and every write a per-start token that only the
// served page knows. Model work is delegated to the `arw` CLI via JobQueue.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ROOT, writeFileAtomic, ensureDir } = require('../lib/util');
const { recordGate } = require('../lib/runs');
const { buildReview } = require('../lib/publish');
const { executorConfig } = require('../lib/codex');
const github = require('../lib/github');
const { reposConfig } = github;
const feedback = require('../lib/feedback');
const memory = require('../lib/memory');
const data = require('./data');
const insights = require('./insights');
const { atlassianConfig, checkMcp } = require('../lib/ticket-mcp');
const settings = require('../lib/settings');
const { RUNS } = require('../lib/runs');

// Non-secret configuration, for the System page.
function systemInfo() {
  const cfg = executorConfig();
  const mcp = atlassianConfig();
  const flag = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
  return {
    executor: {
      model: cfg.model,
      judge_model: cfg.judgeModel,
      effort: cfg.effort || 'default',
      output_schema: flag('CODEX_OUTPUT_SCHEMA', '1') !== '0',
      user_config: flag('CODEX_USE_USER_CONFIG', '0') === '1',
      windows_sandbox: process.platform === 'win32' ? flag('CODEX_WINDOWS_SANDBOX', 'unelevated') : 'n/a',
      timeout_ms: Number(flag('CODEX_TIMEOUT_MS', 1800000)),
    },
    review: {
      workers: Number(flag('ARW_WORKERS', 4)),
      repair_attempts: Number(flag('ARW_REPAIR_ATTEMPTS', 2)),
      language: flag('ARW_OUTPUT_LANGUAGE', 'English'),
      auto_approve_spec: flag('ARW_AUTO_APPROVE_SPEC', '0') === '1',
    },
    repro: { timeout_ms: Number(flag('REPRO_TIMEOUT_MS', 900000)), maven_offline: flag('REPRO_MAVEN_OFFLINE', '0') === '1' },
    ticket_source: mcp ? { kind: 'mcp', transport: mcp.server.url ? 'http' : 'stdio', target: mcp.server.url || mcp.server.command, tools: Object.fromEntries(Object.entries(mcp.tools).map(([k, v]) => [k, v ? v.name : null])) } : process.env.JIRA_URL ? { kind: 'rest', url: process.env.JIRA_URL, confluence: process.env.CONFLUENCE_URL || null } : { kind: 'file' },
    repos: reposConfig().repos,
    runs_dir: RUNS,
    node: process.version,
    platform: process.platform,
  };
}
const { JobQueue } = require('./jobs');

const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const STATIC = { '/app.js': 'application/javascript', '/style.css': 'text/css' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(data.httpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(data.httpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Eval helpers throw plain errors for bad ids or labels: those are 400s.
function evalCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw data.httpError(/^no eval run|^bad eval run/.test(err.message) ? 404 : 400, err.message);
  }
}

function knownRepo(repo) {
  if (!Object.prototype.hasOwnProperty.call(reposConfig().repos, repo)) throw data.httpError(400, `${repo} is not in config/repos.json`);
  return repo;
}

function prNumber(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw data.httpError(400, 'bad PR number');
  return n;
}

function createServer({ port, token = crypto.randomBytes(24).toString('hex'), queue = new JobQueue(), githubApi = github.apiGet } = {}) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const who = `${os.userInfo().username} (dashboard)`;

  const routes = [
    ['GET', /^\/api\/config$/, () => {
      const cfg = executorConfig();
      return {
        repos: Object.keys(reposConfig().repos),
        checkouts: Object.values(reposConfig().repos).map((r) => r && r.checkout).filter(Boolean),
        model: cfg.model,
        judge_model: cfg.judgeModel,
        effort: cfg.effort,
        language: process.env.ARW_OUTPUT_LANGUAGE || 'English',
        jira: Boolean(process.env.JIRA_URL),
        workers: Number(process.env.ARW_WORKERS) || 4,
      };
    }],
    ['GET', /^\/api\/runs$/, () => data.listRuns()],
    ['GET', /^\/api\/system$/, () => systemInfo()],
    ['GET', /^\/api\/settings$/, () => settings.readAll()],
    ['GET', /^\/api\/disk$/, () => require('../lib/cleanup').diskUsage().map(({ worktrees, ...r }) => ({ ...r, worktrees: worktrees.length, worktree_bytes: worktrees.reduce((n, w) => n + w.size, 0) }))],
    ['POST', /^\/api\/clean$/, (m, q, body) => {
      const days = Number.isInteger(Number(body.olderThan)) && Number(body.olderThan) >= 0 ? Number(body.olderThan) : 14;
      const args = ['clean', '--older-than', String(days)];
      if (body.runs) args.push('--runs');
      if (body.apply) args.push('--apply');
      return queue.enqueue({ kind: 'clean', title: body.apply ? 'disk cleanup' : 'cleanup preview', args, target: { type: 'system' } });
    }],
    ['PUT', /^\/api\/settings\/env$/, (m, q, body) => settings.writeEnvSettings(body.changes)],
    ['PUT', /^\/api\/settings\/repos$/, (m, q, body) => settings.writeRepos(body.repos)],
    ['PUT', /^\/api\/settings\/mcp$/, (m, q, body) => settings.writeMcp(body.server === undefined ? null : body.server)],
    // Test a configuration before (or after) saving it.
    ['POST', /^\/api\/settings\/mcp\/test$/, (m, q, body) => {
      if (!body.server) return checkMcp();
      const { DEFAULT_TOOLS } = require('../lib/ticket-mcp');
      const tools = { ...DEFAULT_TOOLS };
      for (const [k, v] of Object.entries(body.server.tools || {})) tools[k] = v === null ? null : { ...DEFAULT_TOOLS[k], ...v };
      return checkMcp({ server: { name: 'atlassian', ...body.server }, tools });
    }],
    ['POST', /^\/api\/doctor$/, () => queue.enqueue({ kind: 'doctor', title: 'system check', args: ['doctor'], target: { type: 'system' } })],
    ['GET', /^\/api\/prs\/([^/]+)\/progress$/, (m) => insights.prProgress(m[1])],
    ['GET', /^\/api\/prs\/([^/]+)\/calls$/, (m) => insights.prCalls(m[1])],
    ['GET', /^\/api\/prs\/([^/]+)\/repro$/, (m) => insights.prRepro(m[1])],
    ['GET', /^\/api\/prs\/([^/]+)\/file$/, (m, q) => insights.prFile(m[1], q.get('path'))],
    ['GET', /^\/api\/tickets\/([^/]+)\/calls$/, (m) => insights.ticketCalls(m[1])],
    ['GET', /^\/api\/tickets\/([^/]+)\/intake$/, (m) => insights.ticketIntake(m[1])],
    ['GET', /^\/api\/tickets\/([^/]+)\/file$/, (m, q) => insights.ticketFile(m[1], q.get('path'))],
    ['GET', /^\/api\/jobs$/, () => queue.list()],
    ['GET', /^\/api\/jobs\/([\w-]+)\/log$/, (m, q) => queue.readLog(m[1], q.get('from'))],
    ['POST', /^\/api\/jobs\/([\w-]+)\/cancel$/, (m) => queue.cancel(m[1]) || Promise.reject(data.httpError(404, 'no such job'))],

    ['GET', /^\/api\/github\/prs$/, (m, q) => {
      const repo = knownRepo(q.get('repo') || '');
      const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '40', '--json', 'number,title,author,headRefName,updatedAt,isDraft'], { encoding: 'utf8', windowsHide: true });
      return JSON.parse(out);
    }],

    ['POST', /^\/api\/reviews$/, async (m, q, body) => {
      const repo = knownRepo(String(body.repo || ''));
      const pr = prNumber(body.pr);
      const args = ['review', '--repo', repo, '--pr', String(pr)];
      if (body.ticket) args.push('--ticket', checkKey(body.ticket));
      if (body.workers) args.push('--workers', String(Math.max(1, Math.min(8, Number(body.workers) || 4))));
      for (const flag of ['singleRole', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'noRepro', 'refresh']) {
        if (body[flag]) args.push(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      }
      return queue.enqueue({ kind: 'review', title: `${repo}#${pr}`, args, target: { type: 'pr', id: `${repo.replace('/', '__')}__${pr}` } });
    }],
    ['POST', /^\/api\/reviews\/local$/, async (m, q, body) => {
      const { localRunId, MODES } = require('../lib/local-review');
      const dir = String(body.dir || '').trim();
      const base = String(body.base || 'main').trim();
      const mode = String(body.mode || 'branch');
      if (!dir || !path.isAbsolute(dir)) throw data.httpError(400, 'dir must be an absolute path to a git repository');
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(base)) throw data.httpError(400, 'base must be a branch name');
      if (!MODES.includes(mode)) throw data.httpError(400, `mode must be one of ${MODES.join(', ')}`);
      let id;
      try {
        id = localRunId({ dir, mode });
      } catch {
        throw data.httpError(400, `${dir} is not a git repository`);
      }
      const args = ['review', '--local', dir, '--base', base, '--mode', mode];
      if (body.workers) args.push('--workers', String(Math.max(1, Math.min(8, Number(body.workers) || 4))));
      for (const flag of ['singleRole', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'noRepro']) {
        if (body[flag]) args.push(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
      }
      return queue.enqueue({ kind: 'review', title: `local ${path.basename(dir)} (${mode})`, args, target: { type: 'pr', id } });
    }],
    ['GET', /^\/api\/prs\/([^/]+)$/, (m) => data.prDetail(m[1])],
    ['GET', /^\/api\/prs\/([^/]+)\/source$/, (m, q) =>
      data.sourceSnippet(m[1], q.get('path') || '', { revision: q.get('revision') === 'base' ? 'base' : 'reviewed', start: Number(q.get('start')) || 1, end: Number(q.get('end')) || Number(q.get('start')) || 1 })],
    ['POST', /^\/api\/prs\/([^/]+)\/gate$/, (m, q, body) => {
      const { dir } = data.prDirFromId(m[1]);
      return recordGate(dir, 'REVIEW', decisionOf(body), { by: who, note: String(body.note || '') });
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/validate$/, (m) => {
      const { repo, pr } = data.prDirFromId(m[1]);
      return queue.enqueue({ kind: 'validate', title: `${repo}#${pr}`, args: ['validate', '--repo', repo, '--pr', String(pr)], target: { type: 'pr', id: m[1] } });
    }],
    ['GET', /^\/api\/prs\/([^/]+)\/publish-preview$/, (m, q) => {
      const { dir } = data.prDirFromId(m[1]);
      const review = buildReview(dir, { minSeverity: severity(q.get('min')) });
      return { body: review.body, comments: review.comments, summary_only: review.summaryOnly, omitted: review.omitted };
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/findings\/([A-Za-z0-9._-]+)\/reject$/, (m, q, body) => {
      const { dir } = data.prDirFromId(m[1]);
      const reason = String(body.reason || '').trim();
      if (!reason) throw data.httpError(400, 'a reason is needed: it is shown when a similar finding comes back');
      try {
        return feedback.rejectFinding(dir, m[2], { reason: reason.slice(0, 500), source: who });
      } catch (err) {
        throw data.httpError(400, err.message);
      }
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/feedback$/, (m) => {
      const { dir } = data.prDirFromId(m[1]);
      try {
        return feedback.readBack(dir, { api: githubApi });
      } catch (err) {
        throw data.httpError(400, err.message);
      }
    }],
    ['GET', /^\/api\/acceptance$/, () => feedback.acceptanceStats()],
    ['GET', /^\/api\/evals$/, () => {
      const evals = require('../lib/eval');
      return { dir: evals.evalDir(), cases: evals.loadCases().map((c) => ({ id: c.id, repo: c.repo, expected: (c.expected || []).length, not_expected: (c.not_expected || []).length, errors: c.errors })), runs: evals.listRuns() };
    }],
    ['GET', /^\/api\/evals\/compare$/, (m, q) => evalCall(() => require('../lib/eval').compare(String(q.get('a') || ''), String(q.get('b') || '')))],
    ['GET', /^\/api\/evals\/([A-Za-z0-9._-]+)$/, (m) => evalCall(() => require('../lib/eval').loadRun(m[1]))],
    ['POST', /^\/api\/evals\/run$/, (m, q, body) => {
      const args = ['eval', 'run'];
      const ids = Array.isArray(body.cases) ? body.cases.map(String).filter((c) => /^[A-Za-z0-9._-]+$/.test(c)) : [];
      if (ids.length) args.push('--case', ids.join(','));
      if (body.label && /^[A-Za-z0-9._-]{1,40}$/.test(String(body.label))) args.push('--label', String(body.label));
      return queue.enqueue({ kind: 'eval', title: `eval${body.label ? ` ${body.label}` : ''}`, args, target: { type: 'eval' } });
    }],
    ['POST', /^\/api\/evals\/([A-Za-z0-9._-]+)\/rescore$/, (m) => evalCall(() => require('../lib/eval').rescore(m[1]))],
    ['POST', /^\/api\/evals\/([A-Za-z0-9._-]+)\/label$/, (m, q, body) => evalCall(() => require('../lib/eval').labelFinding({ runId: m[1], caseId: String(body.case || ''), findingId: String(body.finding || ''), as: String(body.as || '') }))],
    ['GET', /^\/api\/memory$/, () => memory.loadMemory().entries.slice().reverse()],
    ['POST', /^\/api\/memory\/(RJ-[0-9a-f]+)\/forget$/, (m) => {
      if (!memory.forget(m[1])) throw data.httpError(404, 'no such memory entry');
      return { forgotten: m[1] };
    }],
    ['POST', /^\/api\/prs\/([^/]+)\/publish$/, (m, q, body) => {
      const { repo, pr } = data.prDirFromId(m[1]);
      return queue.enqueue({ kind: 'publish', title: `${repo}#${pr}`, args: ['publish', '--repo', repo, '--pr', String(pr), '--min-severity', severity(body.minSeverity)], target: { type: 'pr', id: m[1] } });
    }],

    ['GET', /^\/api\/tickets\/([^/]+)$/, (m) => data.ticketDetail(m[1])],
    ['POST', /^\/api\/tickets$/, (m, q, body) => {
      const key = checkKey(String(body.key || ''));
      const args = ['ticket', key];
      if (body.text && String(body.text).trim()) {
        const file = path.join(ensureDir(data.ticketDirFromKey(key)), 'input-ticket.md');
        writeFileAtomic(file, String(body.text));
        args.push('--from-file', file);
      }
      if (body.repo) args.push('--repo', knownRepo(String(body.repo)));
      return queue.enqueue({ kind: 'ticket', title: key, args, target: { type: 'ticket', key } });
    }],
    ['POST', /^\/api\/tickets\/([^/]+)\/advance$/, (m, q, body) => {
      const key = checkKey(m[1]);
      const args = ['ticket', key];
      if (body.repo) args.push('--repo', knownRepo(String(body.repo)));
      if (body.redo) args.push('--redo', ['intake', 'requirements', 'spec', 'analysis'].includes(body.redo) ? body.redo : 'spec');
      return queue.enqueue({ kind: 'ticket', title: key, args, target: { type: 'ticket', key } });
    }],
    ['POST', /^\/api\/tickets\/([^/]+)\/gate$/, (m, q, body) => {
      const dir = data.ticketDirFromKey(m[1]);
      if (String(body.gate || 'SPEC') !== 'SPEC') throw data.httpError(400, 'the ticket gate is SPEC');
      const decision = decisionOf(body);
      // A rejection note is the feedback the next spec attempt is built from.
      if (decision === 'rejected' && !String(body.note || '').trim()) throw data.httpError(400, 'say what is wrong: the note is fed back to the next spec attempt');
      return recordGate(dir, 'SPEC', decision, { by: who, note: String(body.note || '') });
    }],
  ];

  function checkKey(key) {
    if (!data.TICKET_KEY.test(key)) throw data.httpError(400, 'ticket key must look like ABC-123');
    return key;
  }

  function decisionOf(body) {
    if (body.decision === 'approved' || body.decision === 'rejected') return body.decision;
    throw data.httpError(400, 'decision must be approved or rejected');
  }

  function severity(v) {
    return ['P1', 'P2', 'P3', 'P4'].includes(v) ? v : 'P3';
  }

  // Server-Sent Events: the job's log as it is written, its status changes,
  // and an "end" event once it finished and the whole log was sent.
  function streamJob(req, res, id, from) {
    if (!queue.get(id)) return send(res, 404, { error: 'no such job' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
    let offset = from;
    let lastStatus = null;
    let closed = false;
    const emit = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    const stop = () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
    };
    const tick = () => {
      if (closed) return;
      const job = queue.get(id);
      const chunk = queue.readLog(id, offset);
      if (chunk.text) emit('log', { text: chunk.text, offset: chunk.next });
      offset = chunk.next;
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        emit('status', job);
      }
      if (!['queued', 'running'].includes(job.status) && (!chunk.size || offset >= chunk.size)) {
        emit('end', { status: job.status, exit_code: job.exit_code });
        stop();
        res.end();
      }
    };
    const timer = setInterval(tick, 400);
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15000);
    req.on('close', stop);
    tick();
    return undefined;
  }

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host || '')) return send(res, 421, { error: 'unexpected Host header' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__ARW_TOKEN__', token);
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, url.pathname.slice(1)), 'utf8'), `${STATIC[url.pathname]}; charset=utf-8`);
      }
      const stream = req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/([\w-]+)\/stream$/);
      if (stream) return streamJob(req, res, stream[1], Number(url.searchParams.get('from')) || 0);
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'cross-origin write rejected' });
        const given = String(req.headers['x-arw-token'] || '');
        if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return send(res, 403, { error: 'missing or wrong token' });
      }
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' ? {} : await readBody(req);
        const result = await handler(m, url.searchParams, body);
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 500;
      return send(res, status, { error: status === 500 ? `internal error: ${err.message}` : err.message });
    }
  });
}

function startDashboard({ port = 8787, open = true } = {}) {
  const server = createServer({ port });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`;
      process.stderr.write(`dashboard: ${url} (loopback only; Ctrl+C to stop)\n`);
      if (open) {
        try {
          if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
          else if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
          else execFileSync('xdg-open', [url], { stdio: 'ignore' });
        } catch {
          /* no browser available; the URL is printed */
        }
      }
      resolve(server);
    });
  });
}

module.exports = { createServer, startDashboard, ROOT };
