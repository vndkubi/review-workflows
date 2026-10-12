#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, loadEnv, parseArgs, log, envInt, readJsonIfExists } = require('../lib/util');

loadEnv();
const { runCodex, preflight, executorConfig, resolveCodex } = require('../lib/codex');
const { advanceTicket } = require('../lib/ticket-pipeline');
const { reviewPr, revalidate } = require('../lib/pr-review');
const { recordGate, gateState, ticketDir, prDir, RUNS, GATES } = require('../lib/runs');
const { publish } = require('../lib/publish');
const github = require('../lib/github');

const USAGE = `arw — evidence-first ticket analysis and PR review (codex CLI workers)

Ticket pipeline (understand the requirement; stops at each human gate):
  arw ticket <KEY> [--from-file ticket.md] [--extra notes.md ...] [--repo owner/name | --repo-dir <path>] [--redo intake|requirements|spec|analysis]

PR review (plan -> freeze -> waves -> validate -> report):
  arw review --repo owner/name --pr <n> [--ticket KEY] [--workers 4] [--single-role]
             [--skip-seams] [--skip-rebuttals] [--skip-synthesis] [--refresh] [--no-repro]
  arw validate --repo owner/name --pr <n>      re-validate on disk, no model calls
  arw publish  --repo owner/name --pr <n> [--min-severity P3] [--dry-run]
                                               creates a PENDING GitHub review you submit yourself

Human gates (the runtime never approves):
  arw gate approve|reject|status (--ticket KEY | --repo owner/name --pr <n>) --gate ${Object.keys(GATES).join('|')} [--note "..."]

Other:
  arw ui [--port 8787] [--no-open]   local dashboard (loopback only)
  arw clean [--older-than 14] [--runs] [--no-worktrees] [--no-attempts] [--apply]
                    disk usage and cleanup of old runs (preview unless --apply)
  arw status        list runs
  arw doctor        check git, gh, codex, config`;

function models() {
  const cfg = executorConfig();
  return {
    plan: cfg.model,
    review: cfg.model,
    judge: cfg.judgeModel,
    requirements: process.env.CODEX_REQUIREMENTS_MODEL || cfg.model,
    audit: process.env.CODEX_AUDIT_MODEL || cfg.judgeModel,
    analysis: cfg.model,
    effort: cfg.effort,
  };
}

const executor = (opts) => runCodex({ ...opts, effort: opts.effort || executorConfig().effort });

function runDirFrom(args) {
  if (args.ticket) return ticketDir(args.ticket);
  if (args.repo && args.pr) return prDir(args.repo, Number(args.pr));
  if (args.run) return path.resolve(args.run);
  throw new Error('need --ticket KEY, or --repo owner/name --pr <n>');
}

function multi(argv, flag) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${flag}` && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

async function cmdTicket(argv) {
  const args = parseArgs(argv);
  const key = args._[0];
  if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('usage: arw ticket <KEY>');
  let repoDir = args.repoDir ? path.resolve(args.repoDir) : null;
  if (!repoDir && args.repo) repoDir = github.sourceCheckoutFor(args.repo).checkout;
  const res = await advanceTicket({ key, fromFile: args.fromFile, extras: multi(argv, 'extra'), repoDir, executor, models: models(), log, redo: args.redo });
  console.log(`${res.state}: ${res.message}\nrun: ${res.dir}`);
  return res.state === 'FAILED' ? 1 : 0;
}

async function cmdReview(argv) {
  const args = parseArgs(argv, ['singleRole', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'refresh', 'noRepro']);
  if (!args.repo || !args.pr) throw new Error('usage: arw review --repo owner/name --pr <n>');
  const pfDir = path.join(RUNS, '.preflight');
  const res = await reviewPr({
    repo: args.repo,
    pr: Number(args.pr),
    ticket: args.ticket,
    executor,
    preflight: () => preflight({ cwd: ROOT, attemptDir: pfDir, model: executorConfig().model }),
    models: models(),
    workers: Number(args.workers) || envInt('ARW_WORKERS', 4),
    singleRole: args.singleRole,
    skipSeams: args.skipSeams,
    skipRebuttals: args.skipRebuttals,
    skipSynthesis: args.skipSynthesis,
    refresh: args.refresh,
    noRepro: args.noRepro,
    log,
  });
  const v = res.validation;
  console.log(`${v.status} · recommendation ${v.recommendation}${v.complete ? '' : ' (incomplete)'} · ${v.findings.length} finding(s) · ${v.usage.calls} model calls`);
  console.log(`report: ${res.report}`);
  return v.status === 'EXECUTED_PASS' ? 0 : 1;
}

function cmdValidate(argv) {
  const args = parseArgs(argv);
  const res = revalidate(runDirFrom(args));
  console.log(`${res.validation.status} · ${res.validation.recommendation}\nreport: ${res.report}`);
  if (res.validation.drift.length) console.log(`drift: ${res.validation.drift.join('; ')}`);
  return res.validation.status === 'EXECUTED_PASS' ? 0 : 1;
}

function cmdPublish(argv) {
  const args = parseArgs(argv, ['dryRun']);
  const runDir = runDirFrom(args);
  const { record, review } = publish(runDir, { minSeverity: args.minSeverity || 'P3', dryRun: args.dryRun, createPendingReview: github.createPendingReview });
  if (args.dryRun) {
    console.log(review.body);
    for (const c of review.comments) console.log(`\n--- ${c.path}:${c.line}\n${c.body}`);
  }
  console.log(`\n${record.inline.length} inline + ${record.summary_only.length} summary finding(s)${record.html_url ? ` · pending review: ${record.html_url} — open it, edit, then submit with your verdict` : ''}`);
  return 0;
}

function cmdGate(argv) {
  const args = parseArgs(argv);
  const action = args._[0];
  const runDir = runDirFrom(args);
  const gate = String(args.gate || '').toUpperCase();
  if (action === 'status') {
    for (const g of gate ? [gate] : Object.keys(GATES)) {
      try {
        const s = gateState(runDir, g);
        console.log(`${g}: ${s.decision}${s.decision !== 'NOT_RECORDED' ? (s.valid ? ' (bound to current artifact)' : ' (STALE: artifact changed)') : ''}`);
      } catch (err) {
        console.log(`${g}: ${err.message}`);
      }
    }
    return 0;
  }
  if (!['approve', 'reject'].includes(action) || !gate) throw new Error('usage: arw gate approve|reject ... --gate NAME');
  if (!process.stdin.isTTY && !args.yes) throw new Error('gates are for people: run this in an interactive terminal (or pass --yes if you are scripting your own decision)');
  if (action === 'reject' && gate === 'SPEC' && !args.note) throw new Error('a SPEC rejection needs --note "what is wrong": it is fed back to the next spec attempt');
  const record = recordGate(runDir, gate, action === 'approve' ? 'approved' : 'rejected', { note: args.note || '' });
  console.log(`${gate} ${record.decision} by ${record.by} at ${record.at}; bound to ${JSON.stringify(record.bound)}`);
  return 0;
}

function cmdStatus() {
  for (const kind of ['tickets', 'prs']) {
    const dir = path.join(RUNS, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const run = readJsonIfExists(path.join(dir, name, 'run.json'));
      if (!run) continue;
      const stages = run.stages || run.phases || {};
      const last = Object.entries(stages).pop();
      console.log(`${kind.slice(0, -1).padEnd(6)} ${name.padEnd(40)} ${last ? `${last[0]}=${last[1].status}` : '-'}`);
    }
  }
  return 0;
}

async function cmdDoctor() {
  const checks = [];
  const tryRun = (name, fn) => {
    try {
      checks.push([name, 'ok', fn()]);
    } catch (err) {
      checks.push([name, 'FAIL', err.message.split('\n')[0]]);
    }
  };
  tryRun('node >= 20', () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(process.version);
    return process.version;
  });
  tryRun('git', () => execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
  tryRun('gh auth', () => `logged in as ${github.currentLogin()}`);
  tryRun('codex', () => {
    const { cmd, pre } = resolveCodex();
    return execFileSync(cmd, [...pre, '--version'], { encoding: 'utf8' }).trim();
  });
  const repos = github.reposConfig().repos;
  checks.push(['config/repos.json', Object.keys(repos).length ? 'ok' : 'WARN', Object.keys(repos).length ? Object.keys(repos).join(', ') : 'no repos mapped; copy config/repos.example.json']);
  const { checkMcp } = require('../lib/ticket-mcp');
  const mcp = await checkMcp();
  if (mcp.configured) {
    const detail = mcp.ok ? `${(mcp.server && mcp.server.name) || 'server'} ok, ${mcp.tools} tools` : mcp.error || `mapped tools missing on the server: ${mcp.missing.join(', ')}`;
    checks.push(['Jira/Confluence via MCP', mcp.ok ? 'ok' : 'FAIL', detail]);
  } else {
    checks.push(['Jira (REST)', process.env.JIRA_URL ? 'ok' : 'WARN', process.env.JIRA_URL ? process.env.JIRA_URL : 'not configured; set up config/mcp.json or use arw ticket --from-file']);
  }
  const pf = await preflight({ cwd: ROOT, attemptDir: path.join(RUNS, '.preflight'), model: executorConfig().model });
  checks.push([`codex preflight (model ${executorConfig().model || 'default'})`, pf.ok ? 'ok' : 'FAIL', pf.ok ? `${pf.elapsed_ms} ms, ${pf.usage.input_tokens} input tokens` : `${pf.error_class}: ${pf.error_message}`]);
  for (const [name, status, detail] of checks) console.log(`${status.padEnd(4)} ${name.padEnd(36)} ${detail}`);
  return checks.some((c) => c[1] === 'FAIL') ? 1 : 0;
}

function cmdClean(argv) {
  const args = parseArgs(argv, ['runs', 'noWorktrees', 'noAttempts', 'apply']);
  const { clean } = require('../lib/cleanup');
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
  const days = args.olderThan === undefined ? 14 : Number(args.olderThan);
  const res = clean({ olderThanDays: Number.isFinite(days) ? days : 14, runs: Boolean(args.runs), worktrees: !args.noWorktrees, attempts: !args.noAttempts, apply: Boolean(args.apply) });
  for (const a of res.actions) console.log(`${res.applied ? 'removed' : 'would remove'}  ${mb(a.bytes).padStart(9)}  ${a.action}: ${a.target}`);
  console.log(`${res.actions.length} item(s), ${mb(res.bytes)}${res.applied ? ' freed' : ' (preview; add --apply to remove)'} — runs untouched since ${res.cutoff.slice(0, 10)}`);
  return 0;
}

async function cmdUi(argv) {
  const args = parseArgs(argv, ['noOpen']);
  const { startDashboard } = require('../web/server');
  await startDashboard({ port: Number(args.port) || 8787, open: !args.noOpen });
  return new Promise(() => {}); // serve until interrupted
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'ticket':
      return cmdTicket(rest);
    case 'review':
      return cmdReview(rest);
    case 'validate':
      return cmdValidate(rest);
    case 'publish':
      return cmdPublish(rest);
    case 'gate':
      return cmdGate(rest);
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
    case 'ui':
      return cmdUi(rest);
    case 'clean':
      return cmdClean(rest);
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code || 0),
  (err) => {
    console.error(`error: ${err.message}`);
    if (process.env.ARW_DEBUG) console.error(err.stack);
    process.exit(2);
  },
);
