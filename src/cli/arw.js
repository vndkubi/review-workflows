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
  arw ticket <KEY> [--from-file ticket.md] [--extra notes.md ...] [--image screen.png ...] [--repo owner/name | --repo-dir <path>] [--redo intake|requirements|spec|analysis]

PR review (plan -> freeze -> waves -> validate -> report):
  arw review --local [<repo dir>] [--base main] [--mode branch|staged|worktree | --head <commit>]
                                               self-review before a PR (--head: one commit range)
  arw review --repo owner/name --pr <n> [--ticket KEY] [--workers 4] [--single-role]
             [--skip-seams] [--skip-rebuttals] [--skip-synthesis] [--refresh] [--no-repro]
             [--single-agent]   baseline: one reviewer over the whole diff, no planner/seams/red team/synthesis
  arw validate --repo owner/name --pr <n>      re-validate on disk, no model calls
  arw publish  --repo owner/name --pr <n> [--min-severity P3] [--dry-run]
                                               creates a PENDING GitHub review you submit yourself

What people did with the findings:
  arw reject   --repo owner/name --pr <n> --finding <id> --reason "..."   remember a rejected finding
  arw feedback --repo owner/name --pr <n>      read the submitted review back: kept / edited / dropped
  arw acceptance                               acceptance rate by severity, label and role
  arw memory [--repo owner/name] [--forget RJ-...]

Measuring the reviewer:
  arw eval cases | run | list | show | rescore | compare | label | add   (arw eval for details)
  arw retro [--since 30] [--save]              where calls go, what the validator rejects, suggestions
  arw checklist propose | accept <id> [--text "..."] [--category BZ]
                                               checklist items mined from kept and rejected findings

Human gates (the runtime never approves):
  arw gate approve|reject|status (--ticket KEY | --repo owner/name --pr <n>) --gate ${Object.keys(GATES).join('|')} [--note "..."]

Automation:
  arw watch [--once] [--interval 300]   review new PRs and new pushes of repos with "watch": true
  (notifications: ARW_SLACK_WEBHOOK / ARW_NOTIFY_WEBHOOK, sent when a review finishes)

Sandbox (PR code in containers):
  arw sandbox discover <owner/name | dir>... [--rev <rev>] [--json]
                    build system, Java version, coordinates, dependencies, proposed image;
                    read from git objects, nothing executed

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

// ARW_EXECUTOR_MODULE swaps codex for a module exporting the same executor
// function (evals of the harness itself, tests). Preflight is skipped then.
const customExecutor = process.env.ARW_EXECUTOR_MODULE ? require(path.resolve(process.env.ARW_EXECUTOR_MODULE)) : null;
const executor = customExecutor || ((opts) => runCodex({ ...opts, effort: opts.effort || executorConfig().effort }));

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
  const images = multi(argv, 'image').map((f) => path.resolve(f));
  for (const f of images) if (!fs.existsSync(f) || !/\.(png|jpe?g|gif|webp)$/i.test(f)) throw new Error(`--image ${f}: not a png, jpg, gif or webp file`);
  const res = await advanceTicket({ key, fromFile: args.fromFile, extras: multi(argv, 'extra'), images, repoDir, executor, models: models(), log, redo: args.redo });
  console.log(`${res.state}: ${res.message}\nrun: ${res.dir}`);
  return res.state === 'FAILED' ? 1 : 0;
}

async function cmdReview(argv) {
  const args = parseArgs(argv, ['singleRole', 'singleAgent', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'refresh', 'noRepro']);
  let local = null;
  if (args.local) {
    const { prepareLocal } = require('../lib/local-review');
    local = prepareLocal({ dir: args.local === true ? process.cwd() : args.local, base: args.base || 'main', mode: args.mode || 'branch', head: args.head || null });
    args.repo = local.repo;
    args.pr = local.pr;
    console.error(`local review of ${local.prepared.info.title}: run ${local.repo.replace('/', '__')}__${local.pr}`);
  }
  if (!args.repo || !args.pr) throw new Error('usage: arw review --repo owner/name --pr <n>  |  arw review --local [dir]');
  const pfDir = path.join(RUNS, '.preflight');
  const res = await reviewPr({
    repo: args.repo,
    pr: Number(args.pr),
    ticket: args.ticket,
    executor,
    preflight: customExecutor ? undefined : () => preflight({ cwd: ROOT, attemptDir: pfDir, model: executorConfig().model }),
    models: models(),
    workers: Number(args.workers) || envInt('ARW_WORKERS', 4),
    singleRole: args.singleRole,
    singleAgent: args.singleAgent,
    skipSeams: args.skipSeams,
    skipRebuttals: args.skipRebuttals,
    skipSynthesis: args.skipSynthesis,
    refresh: args.refresh,
    noRepro: args.noRepro,
    prepared: local ? local.prepared : undefined,
    log,
  });
  const v = res.validation;
  const identity = readJsonIfExists(path.join(res.runDir, 'run.json'), {}).identity || {};
  const base = (process.env.ARW_DASHBOARD_URL || '').replace(/\/+$/, '');
  await require('../lib/notify').notifyReview({ identity, validation: v, link: base ? `${base}/#/pr/${path.basename(res.runDir)}` : null, log });
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
  if (record.omitted.length) console.log(`\n${record.omitted.length} finding(s) left out: rejected before (${record.omitted.map((o) => `${o.finding_id} ~ ${o.entry_id}`).join(', ')}); see arw memory`);
  console.log(`\n${record.inline.length} inline + ${record.summary_only.length} summary finding(s)${record.html_url ? ` · pending review: ${record.html_url} — open it, edit, then submit with your verdict` : ''}`);
  return 0;
}

function cmdReject(argv) {
  const args = parseArgs(argv);
  if (!args.finding || !args.reason) throw new Error('usage: arw reject --repo owner/name --pr <n> --finding <id> --reason "why"');
  const entry = require('../lib/feedback').rejectFinding(runDirFrom(args), String(args.finding), { reason: args.reason, source: 'cli' });
  console.log(`remembered ${entry.id} (${entry.scope}${entry.path ? `, ${entry.path}` : ''}): similar findings will be marked, and minor ones left out of published drafts`);
  return 0;
}

function cmdFeedback(argv) {
  const args = parseArgs(argv);
  const { record, remembered } = require('../lib/feedback').readBack(runDirFrom(args), { api: github.apiGet, graphql: github.graphql });
  console.log(`review ${record.review_id}: ${record.state}${record.submitted_at ? ` at ${record.submitted_at}` : ''}`);
  for (const f of record.findings) {
    console.log(`  ${f.verdict.padEnd(9)} ${f.id}  [${f.severity}] ${f.title}`);
    const t = f.thread;
    if (t && (t.replies || t.resolved)) console.log(`            thread: ${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}${t.signal ? ` (${t.signal})` : ''}${t.resolved ? ' · resolved' : ''}${t.last_reply ? ` · last by ${t.last_reply.user}: ${t.last_reply.text.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`);
  }
  const c = record.counts;
  console.log(`kept ${c.kept} · edited ${c.edited} · dropped ${c.dropped}${c.pending ? ` · pending ${c.pending} (submit the review on GitHub first)` : ''}${remembered.length ? ` · ${remembered.length} dropped finding(s) remembered` : ''}`);
  return 0;
}

function cmdMemory(argv) {
  const args = parseArgs(argv);
  const memory = require('../lib/memory');
  if (args.forget) {
    if (!memory.forget(String(args.forget))) throw new Error(`no memory entry ${args.forget}`);
    console.log(`forgot ${args.forget}`);
    return 0;
  }
  const entries = memory.loadMemory().entries.filter((e) => !args.repo || e.scope === args.repo);
  for (const e of entries) console.log(`${e.id}  ${e.scope.padEnd(28)} [${e.severity}] ${e.title}${e.path ? `  (${e.path})` : ''}\n${' '.repeat(15)}${e.source} ${e.at.slice(0, 10)}: ${e.reason}`);
  console.log(`${entries.length} rejected finding(s) remembered${args.repo ? ` for ${args.repo}` : ''}`);
  return 0;
}

function cmdAcceptance() {
  const s = require('../lib/feedback').acceptanceStats();
  const line = (name, c) => `${name.padEnd(12)} kept ${c.kept} · edited ${c.edited} · dropped ${c.dropped} · acceptance ${c.rate == null ? '-' : `${c.rate}%`}`;
  console.log(line('all', s.total));
  for (const [group, buckets] of Object.entries(s.groups)) {
    console.log(`\nby ${group}`);
    for (const [k, c] of Object.entries(buckets).sort()) console.log(`  ${line(k, c)}`);
  }
  console.log(`\n${s.runs.length} run(s) with feedback (arw feedback --repo ... --pr ... after submitting a review)`);
  return 0;
}

// Polls watched repositories and reviews new PRs and new pushes, one at a
// time, each in its own process (like a dashboard job).
async function cmdWatch(argv) {
  const args = parseArgs(argv, ['once']);
  const { pollOnce, watchedRepos } = require('../lib/watch');
  const { spawnSync } = require('node:child_process');
  const intervalMs = Math.max(60, Number(args.interval) || envInt('ARW_WATCH_INTERVAL', 300)) * 1000;
  const repos = watchedRepos();
  if (!repos.length) throw new Error('no watched repositories: set "watch": true on entries in config/repos.json (or tick Watch in Settings)');
  console.error(`watching ${repos.map((r) => r.name).join(', ')} every ${intervalMs / 1000}s`);
  for (;;) {
    const queued = [];
    const res = pollOnce({ enqueue: (j) => queued.push(j), log });
    for (const e of res.errors) log(`watch: ${e}`);
    for (const j of queued) {
      log(`review ${j.repo}#${j.pr}`);
      spawnSync(process.execPath, [__filename, 'review', '--repo', j.repo, '--pr', String(j.pr)], { stdio: 'inherit', env: process.env });
    }
    if (args.once) return 0;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function cmdChecklist(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  const mining = require('../lib/checklist-mining');
  if (sub === 'propose' || !sub) {
    const { proposals, decided } = mining.mineChecklist({ minRuns: Number(args.minRuns) || 2 });
    for (const p of proposals) {
      console.log(`${p.id}  [${p.kind}]${p.ck ? ` ${p.ck}` : ''} ${p.text}\n    ${p.evidence}`);
      for (const e of p.examples) console.log(`    - ${e.run} ${e.finding} [${e.severity}] ${e.title}`);
    }
    console.log(`${proposals.length} proposal(s) from ${decided} finding(s) people decided on. Accept: arw checklist accept <id> [--text "..."] [--category BZ]`);
    return 0;
  }
  if (sub === 'accept') {
    const res = mining.acceptProposal(String(args._[0] || ''), { text: args.text, category: args.category });
    console.log(`added ${res.line}\nto ${res.file}. Reviews frozen from now on cite it; older contexts are refreshed on their next run.`);
    return 0;
  }
  throw new Error('usage: arw checklist propose [--min-runs 2] | accept <id> [--text "..."] [--category BZ]');
}

function cmdRetro(argv) {
  const args = parseArgs(argv, ['save']);
  const { retrospective, renderRetro } = require('../lib/retro');
  const r = retrospective({ sinceDays: args.since ? Number(args.since) : undefined });
  const text = renderRetro(r);
  console.log(text);
  if (args.save) {
    const file = path.join(RUNS, 'retro', `${r.at.slice(0, 10)}${r.since_days ? `-last${r.since_days}d` : ''}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`saved ${file}`);
  }
  return 0;
}

async function cmdEval(argv) {
  const evals = require('../lib/eval');
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, ['force']);
  const pct = (x) => (x == null ? '-' : `${Math.round(x * 1000) / 10}%`);
  if (sub === 'cases') {
    const cases = evals.loadCases();
    for (const c of cases) console.log(`${c.errors.length ? 'INVALID' : 'ok     '} ${c.id.padEnd(30)} ${(c.expected || []).length} expected · ${(c.not_expected || []).length} not expected${c.errors.length ? `\n        ${c.errors.join('\n        ')}` : ''}`);
    console.log(`${cases.length} case(s) in ${path.join(evals.evalDir(), 'cases')}`);
    return cases.some((c) => c.errors.length) ? 1 : 0;
  }
  if (sub === 'run') {
    const { outDir, card } = await evals.runEval({ only: args.case ? String(args.case).split(',') : undefined, label: args.label || args.config, config: args.config, log });
    const t = card.totals;
    console.log(`recall ${pct(t.recall)} (${t.found}/${t.expected}) · precision ${pct(t.precision)} (${t.tp} TP, ${t.fp} FP) · ${t.unlabelled} unlabelled · ${t.calls} calls\nscorecard: ${path.join(outDir, 'scorecard.md')}`);
    return t.completed === t.cases ? 0 : 1;
  }
  if (sub === 'list') {
    for (const r of evals.listRuns()) console.log(`${r.id.padEnd(40)} recall ${pct(r.totals.recall).padStart(6)} · precision ${pct(r.totals.precision).padStart(6)} · ${r.totals.unlabelled} unlabelled · ${r.totals.calls} calls · ${r.model || 'default'}`);
    return 0;
  }
  if (sub === 'show') {
    evals.loadRun(String(args._[0] || ''));
    console.log(fs.readFileSync(path.join(evals.evalDir(), 'runs', args._[0], 'scorecard.md'), 'utf8'));
    return 0;
  }
  if (sub === 'rescore') {
    const card = evals.rescore(String(args._[0] || ''));
    console.log(`recall ${pct(card.totals.recall)} · precision ${pct(card.totals.precision)} · ${card.totals.unlabelled} unlabelled`);
    return 0;
  }
  if (sub === 'compare') {
    const c = evals.compare(String(args._[0] || ''), String(args._[1] || ''));
    console.log(`${c.a.id} -> ${c.b.id}\nrecall ${pct(c.a.totals.recall)} -> ${pct(c.b.totals.recall)} · precision ${pct(c.a.totals.precision)} -> ${pct(c.b.totals.precision)} · calls ${c.a.totals.calls} -> ${c.b.totals.calls}`);
    for (const r of c.rows) console.log(`  ${r.id.padEnd(30)} recall ${pct(r.recall[0])} -> ${pct(r.recall[1])} · FP ${r.fp[0]} -> ${r.fp[1]}${r.newly_missed.length ? ` · NEWLY MISSED ${r.newly_missed.join(', ')}` : ''}${r.newly_found.length ? ` · newly found ${r.newly_found.join(', ')}` : ''}`);
    return c.rows.some((r) => r.newly_missed.length) ? 1 : 0;
  }
  if (sub === 'label') {
    if (!args.run || !args.case || !args.finding || !args.as) throw new Error('usage: arw eval label --run <eval run> --case <id> --finding <id> --as tp|fp [--severity P2]');
    const label = evals.labelFinding({ runId: String(args.run), caseId: String(args.case), findingId: String(args.finding), as: String(args.as), severity: args.severity });
    console.log(`added ${label.id}: ${label.path}:${label.lines.join('-')} keywords ${label.keywords.join(', ')} — re-score with: arw eval rescore ${args.run}`);
    return 0;
  }
  if (sub === 'add') {
    const { file, case: c } = evals.caseFromRun(runDirFrom(args), { id: args.id, force: args.force });
    console.log(`wrote ${file}: ${c.expected.length} expected, ${c.not_expected.length} not expected`);
    return 0;
  }
  console.log(`usage:
  arw eval cases                                  list and check the labelled cases
  arw eval run [--case a,b] [--label name] [--config single-agent|multi-agent|multi-agent+repro]
                                                  review every case (one process and runs dir each), then score
  arw eval list | show <run> | rescore <run> | compare <run A> <run B>
  arw eval label --run <run> --case <id> --finding <id> --as tp|fp [--severity P2]
  arw eval add (--repo owner/name --pr <n> | --run <run dir>) [--id name] [--force]
                                                  a case from a reviewed PR: kept findings expected, dropped/rejected not`);
  return sub ? 1 : 0;
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
  // The JDK behind Java impact analysis: present, 11+, a real JDK, and at
  // least as new as the Java the configured repositories build with.
  const javaAst = require('../lib/java-ast');
  const ji = javaAst.javaInfo();
  const jdkName = 'JDK for Java impact (javac)';
  if (process.env.ARW_JAVA_AST === 'off') checks.push([jdkName, 'ok', 'off (ARW_JAVA_AST=off): structural index only']);
  else if (javaAst.javaVersion()) {
    const levels = Object.entries(repos).map(([n, r]) => [n, r && r.checkout ? javaAst.projectJavaLevel(r.checkout) : null]).filter(([, l]) => l);
    const low = levels.filter(([, l]) => l > ji.version);
    checks.push([jdkName, low.length ? 'WARN' : 'ok', `JDK ${ji.version} (${ji.bin})${low.length ? `; older than ${low.map(([n, l]) => `${n} (Java ${l})`).join(', ')}: set ARW_JAVA_HOME to a newer JDK` : levels.length ? `; reads ${levels.map(([n, l]) => `${n} (Java ${l})`).join(', ')}` : ''}`]);
  } else {
    checks.push([jdkName, 'WARN', ji.error ? `${ji.error}: Java impact uses the structural index (install a JDK 11+ or set ARW_JAVA_HOME)` : ji.version && ji.version < 11 ? `${ji.bin} is Java ${ji.version}; a JDK 11+ is needed (ARW_JAVA_HOME)` : `${ji.bin} (Java ${ji.version}) has no javac — a JRE? A JDK is needed`]);
  }
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

function cmdSandbox(argv) {
  const args = parseArgs(argv, ['json']);
  const [action, ...targets] = args._;
  if (action !== 'discover' || !targets.length) throw new Error('usage: arw sandbox discover <owner/name | dir>... [--rev <rev>] [--json]');
  const { discoverRepo, renderDiscovery, checkoutOf } = require('../lib/discovery');
  const results = targets.map((t) => discoverRepo({ ...checkoutOf(t), rev: args.rev || 'HEAD' }));
  console.log(args.json ? JSON.stringify(results.length === 1 ? results[0] : results, null, 2) : results.map(renderDiscovery).join('\n\n'));
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
    case 'reject':
      return cmdReject(rest);
    case 'feedback':
      return cmdFeedback(rest);
    case 'memory':
      return cmdMemory(rest);
    case 'acceptance':
      return cmdAcceptance();
    case 'eval':
      return cmdEval(rest);
    case 'retro':
      return cmdRetro(rest);
    case 'checklist':
      return cmdChecklist(rest);
    case 'watch':
      return cmdWatch(rest);
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
    case 'ui':
      return cmdUi(rest);
    case 'sandbox':
      return cmdSandbox(rest);
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
