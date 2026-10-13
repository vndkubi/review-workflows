'use strict';
// Cheap machine evidence collected before planning and frozen with the
// evidence pack: CI check results for the head commit, linter hits on the
// changed files, and which tests cover the changed sources. These are leads
// for the reviewers, never findings by themselves.
//
// Linters run on the PR checkout with secrets removed from the environment,
// without a shell (file names come from the PR), and only tools that read
// source without executing it are built in: ruff, semgrep (with a local
// config), PMD. Anything else is opt-in per repository ("static_commands").
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nowIso, envInt } = require('./util');
const git = require('./git');
const { scrubbedEnv } = require('./repro');

const MAX_HITS = 80;
const MAX_ANNOTATIONS = 30;

function run(cmd, args, cwd, timeoutMs) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, env: scrubbedEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true };
    // Linters exit non-zero when they find something; their stdout is the result.
    if (err.stdout) return { ok: true, out: String(err.stdout) };
    return { ok: false, error: (err.stderr ? String(err.stderr) : err.message).trim().split('\n')[0].slice(0, 200) };
  }
}

// ARW_RUFF_BIN, ARW_SEMGREP_BIN, ARW_PMD_BIN: a tool that is not on PATH.
function binOf(name) {
  return process.env[`ARW_${name.toUpperCase()}_BIN`] || name;
}

function available(cmd) {
  return !run(cmd, ['--version'], process.cwd(), 15000).missing;
}

// A path that cannot be read as an option, whatever the PR named the file.
const arg = (f) => `./${f}`;

function rel(checkout, file) {
  const p = path.isAbsolute(file) ? path.relative(checkout, file) : file;
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

const LINTERS = [
  {
    name: 'ruff',
    applies: (f) => f.endsWith('.py'),
    enabled: () => available(binOf('ruff')),
    args: (files) => ['check', '--output-format=json', '--no-cache', '--exit-zero', ...files.map(arg)],
    parse: (out, checkout) => JSON.parse(out || '[]').map((h) => ({ path: rel(checkout, h.filename), line: h.location && h.location.row, rule: h.code, message: h.message })),
  },
  {
    name: 'semgrep',
    applies: () => true,
    config: (checkout) => process.env.ARW_SEMGREP_CONFIG || ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].map((c) => path.join(checkout, c)).find((c) => require('node:fs').existsSync(c)),
    enabled() {
      return available(binOf('semgrep'));
    },
    args(files, checkout) {
      return ['scan', '--json', '--quiet', '--metrics=off', '--disable-version-check', '--config', this.config(checkout), ...files.map(arg)];
    },
    parse: (out, checkout) => (JSON.parse(out || '{}').results || []).map((h) => ({ path: rel(checkout, h.path), line: h.start && h.start.line, rule: h.check_id, message: (h.extra && h.extra.message) || '' })),
  },
  {
    name: 'pmd',
    applies: (f) => f.endsWith('.java'),
    enabled: () => available(binOf('pmd')),
    args: (files) => ['check', '--no-progress', '--no-cache', '-f', 'json', '-R', process.env.ARW_PMD_RULESETS || 'rulesets/java/quickstart.xml', '-d', files.map(arg).join(',')],
    parse: (out, checkout) => (JSON.parse(out || '{}').files || []).flatMap((f) => (f.violations || []).map((v) => ({ path: rel(checkout, f.filename), line: v.beginline, rule: v.rule, message: v.description }))),
  },
];

// `path:line[:col]: message` lines from an opt-in command.
function parseLines(out, checkout) {
  const hits = [];
  for (const line of String(out).split('\n')) {
    const m = /^(.+?):(\d+)(?::\d+)?:?\s+(.*)$/.exec(line.trim());
    if (m) hits.push({ path: rel(checkout, m[1]), line: Number(m[2]), rule: '', message: m[3] });
  }
  return hits;
}

function addedLineSet(parsed) {
  const out = new Map();
  for (const f of parsed) {
    const set = new Set();
    for (const hunk of f.hunks || []) for (const l of hunk.lines || []) if (l.type === '+') set.add(l.new_line);
    out.set(f.path, set);
  }
  return out;
}

function runLinters({ checkout, files, repoCfg, parsed, log }) {
  const timeout = envInt('ARW_STATIC_TIMEOUT_MS', 120000);
  const added = addedLineSet(parsed);
  const results = [];
  const tools = [...LINTERS];
  for (const c of (repoCfg && repoCfg.static_commands) || []) {
    if (!c || !c.name || !Array.isArray(c.command) || !c.command.length) continue;
    tools.push({ name: c.name, applies: (f) => !c.extensions || c.extensions.some((e) => f.endsWith(e)), enabled: () => true, args: (files) => c.command.slice(1).flatMap((a) => (a === '{files}' ? files.map(arg) : [a])), cmd: c.command[0], parse: parseLines });
  }
  for (const tool of tools) {
    const mine = files.filter((f) => tool.applies(f));
    if (!mine.length) continue;
    if (tool.config && !tool.config(checkout)) continue;
    if (!tool.enabled()) continue;
    const res = run(tool.cmd || binOf(tool.name), tool.args(mine, checkout), checkout, timeout);
    if (!res.ok) {
      results.push({ tool: tool.name, error: res.error || 'not runnable', hits: [] });
      continue;
    }
    let hits;
    try {
      hits = tool.parse(res.out, checkout);
    } catch (err) {
      results.push({ tool: tool.name, error: `unreadable output: ${err.message.slice(0, 120)}`, hits: [] });
      continue;
    }
    const inPr = new Set(mine);
    hits = hits.filter((h) => inPr.has(h.path) && h.line).map((h) => ({ ...h, on_added_line: Boolean(added.get(h.path) && added.get(h.path).has(h.line)) }));
    hits.sort((a, b) => b.on_added_line - a.on_added_line || a.path.localeCompare(b.path) || a.line - b.line);
    log(`static: ${tool.name} ${hits.length} hit(s) on changed files (${hits.filter((h) => h.on_added_line).length} on added lines)`);
    results.push({ tool: tool.name, hits: hits.slice(0, MAX_HITS), total: hits.length });
  }
  return results;
}

function ciChecks({ repo, head, files, api, log }) {
  if (!api) return null;
  const out = { checks: [], statuses: [], annotations: [], error: null };
  try {
    const runs = api(`repos/${repo}/commits/${head}/check-runs?per_page=100`).check_runs || [];
    out.checks = runs.map((r) => ({ id: r.id, name: r.name, app: r.app && r.app.name, status: r.status, conclusion: r.conclusion, title: r.output && r.output.title, summary: ((r.output && r.output.summary) || '').slice(0, 300), url: r.html_url }));
    const inPr = new Set(files);
    for (const r of out.checks.filter((c) => ['failure', 'timed_out', 'action_required'].includes(c.conclusion))) {
      if (out.annotations.length >= MAX_ANNOTATIONS) break;
      const anns = api(`repos/${repo}/check-runs/${r.id}/annotations?per_page=50`) || [];
      for (const a of anns) {
        if (inPr.has(a.path) && out.annotations.length < MAX_ANNOTATIONS) out.annotations.push({ check: r.name, path: a.path, line: a.start_line, level: a.annotation_level, message: String(a.message || '').slice(0, 300) });
      }
    }
    const status = api(`repos/${repo}/commits/${head}/status`);
    out.statuses = (status.statuses || []).map((s) => ({ context: s.context, state: s.state, description: s.description }));
    log(`static: ${out.checks.length} check run(s), ${out.statuses.length} status(es), ${out.annotations.length} annotation(s) on changed files`);
  } catch (err) {
    out.error = err.message.split('\n')[0].slice(0, 200);
    log(`static: CI checks unavailable: ${out.error}`);
  }
  return out;
}

// Which tests cover each changed source file, by naming convention or by a
// reference to the class/module name in test code.
function isTest(f) {
  return /(^|\/)src\/test\//.test(f) || /(^|\/)tests?\//.test(f) || /(^|\/)test_[^/]*\.py$/.test(f) || /_test\.py$/.test(f) || /(Test|Tests|IT)\.java$/.test(f);
}

// impact: the call-site analysis of the evidence pack, when available. A test
// that (transitively) calls a changed declaration is the strongest link.
function testImpact({ checkout, head, changed, impact = null }) {
  const all = String(git.git(checkout, ['ls-files'], { allowFail: true }) || '').split('\n').filter(Boolean);
  const tests = all.filter(isTest);
  const changedSet = new Set(changed);
  const sources = changed.filter((f) => !isTest(f) && /\.(java|py)$/.test(f) && !/__init__\.py$/.test(f));
  const out = [];
  for (const src of sources) {
    const name = path.basename(src).replace(/\.(java|py)$/, '');
    const byName = src.endsWith('.java')
      ? tests.filter((t) => [`${name}Test.java`, `${name}Tests.java`, `${name}IT.java`, `Test${name}.java`].includes(path.basename(t)))
      : tests.filter((t) => [`test_${name}.py`, `${name}_test.py`].includes(path.basename(t)));
    const ext = src.endsWith('.java') ? '*.java' : '*.py';
    const grep = String(git.git(checkout, ['grep', '-l', '-w', '-F', name, head, '--', ext], { allowFail: true }) || '')
      .split('\n').filter(Boolean).map((l) => l.slice(head.length + 1)).filter((t) => isTest(t) && !byName.includes(t)).slice(0, 10);
    // Tests that call a changed declaration of this file, directly or through up to two callers.
    const reached = new Set([src]);
    const calls = [];
    for (const level of [1, 2, 3]) {
      for (const e of ((impact && impact.edges) || []).filter((x) => x.level === level && ['ast', 'ast-dispatch', 'typed', 'resolved', 'interface'].includes(x.confidence) && !x.repo && reached.has(x.to.path))) {
        if (isTest(e.from.path)) calls.push(e.from.path);
        else reached.add(e.from.path);
      }
    }
    const callers = [...new Set(calls)].filter((t) => !byName.includes(t));
    const found = [
      ...byName.map((t) => ({ path: t, how: callers.includes(t) ? 'name+call' : 'name' })),
      ...callers.map((t) => ({ path: t, how: 'call' })),
      ...grep.filter((t) => !callers.includes(t)).map((t) => ({ path: t, how: 'reference' })),
    ].map((t) => ({ ...t, changed_in_pr: changedSet.has(t.path) }));
    out.push({ source: src, tests: found });
  }
  return { sources: out, tests_changed: changed.filter(isTest) };
}

function renderMarkdown(s) {
  const lines = [`## Machine evidence (collected ${s.collected_at}; leads to verify, not findings)`];
  if (s.ci) {
    lines.push('', `### CI at ${s.head.slice(0, 12)}`);
    if (s.ci.error) lines.push(`- unavailable: ${s.ci.error}`);
    else if (!s.ci.checks.length && !s.ci.statuses.length) lines.push('- no check runs or statuses reported');
    for (const c of s.ci.checks) lines.push(`- check "${c.name}"${c.app ? ` (${c.app})` : ''}: ${c.status}${c.conclusion ? ` / ${c.conclusion}` : ''}${c.title ? ` — ${c.title}` : ''}`);
    for (const st of s.ci.statuses) lines.push(`- status "${st.context}": ${st.state}${st.description ? ` — ${st.description}` : ''}`);
    for (const a of s.ci.annotations) lines.push(`  - ${a.check} annotation ${a.path}:${a.line} [${a.level}] ${a.message.replace(/\s+/g, ' ')}`);
  }
  if (s.linters.length) {
    lines.push('', '### Linters on changed files');
    for (const r of s.linters) {
      if (r.error) {
        lines.push(`- ${r.tool}: not run (${r.error})`);
        continue;
      }
      lines.push(`- ${r.tool}: ${r.total} hit(s)${r.total > r.hits.length ? `, first ${r.hits.length} shown` : ''}`);
      for (const h of r.hits) lines.push(`  - ${h.path}:${h.line}${h.rule ? ` [${h.rule}]` : ''} ${String(h.message).replace(/\s+/g, ' ').slice(0, 200)}${h.on_added_line ? ' (on an added line)' : ''}`);
    }
  }
  lines.push('', '### Test impact');
  if (!s.tests.sources.length) lines.push('- no changed Java/Python source files');
  for (const t of s.tests.sources) {
    if (!t.tests.length) lines.push(`- ${t.source}: no test found by name or reference`);
    else lines.push(`- ${t.source}: ${t.tests.map((x) => `${x.path} (${x.how}${x.changed_in_pr ? ', changed in this PR' : ', not changed in this PR'})`).join('; ')}`);
  }
  lines.push(`- test files changed in this PR: ${s.tests.tests_changed.length ? s.tests.tests_changed.join(', ') : 'none'}`);
  return `${lines.join('\n')}\n`;
}

function collectStatic({ repo, checkout, base, head, changed: changedFiles, reviewable, parsed, local, repoCfg, api, impact = null, log = () => {} }) {
  // git.changedFiles entries ({status, path}); deleted files have no head side.
  const changed = changedFiles.filter((f) => typeof f === 'string' || f.status !== 'D').map((f) => (typeof f === 'string' ? f : f.path));
  const s = {
    collected_at: nowIso(),
    head,
    base,
    ci: local ? null : ciChecks({ repo, head, files: changed, api, log }),
    linters: process.env.ARW_STATIC === 'off' ? [] : runLinters({ checkout, files: reviewable, repoCfg, parsed, log }),
    tests: testImpact({ checkout, head, changed, impact }),
  };
  s.markdown = renderMarkdown(s);
  return s;
}

module.exports = { collectStatic, testImpact, parseLines, renderMarkdown, isTest };
