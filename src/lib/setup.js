'use strict';
// First-run setup, shared by `arw setup`, the dashboard's setup wizard and
// the setup scripts: what this machine has, the project files, and presets
// that set the few settings that matter for a way of working.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const settings = require('./settings');
const { fixHint } = require('./setup-hints');

// A preset writes these settings (and ARW_PRESET). leavesOut says what it
// gives up, so choosing the cheap one is an informed choice.
const PRESETS = [
  {
    id: 'fast',
    name: 'Fast and cheap',
    summary: 'One reviewer over the whole diff, no reproduction, low effort, at most 20 model calls.',
    leavesOut: ['no planner, seams, red team or synthesis', 'no reproduction: findings stay SUSPECTED (L1)', 'reviews stop at 20 model calls'],
    needs: [],
    values: { CODEX_EFFORT: 'low', ARW_REVIEW_MODE: 'single-agent', ARW_REPRO: 'off', ARW_MAX_CALLS: '20', ARW_SANDBOX: 'off', ARW_RUN_IMPACTED_TESTS: 'off' },
  },
  {
    id: 'thorough',
    name: 'Thorough',
    summary: 'Every wave (units, seams, red team, synthesis) and reproduction of blocking findings in Docker containers, high effort, at most 120 model calls.',
    leavesOut: ['reviews stop at 120 model calls (raise ARW_MAX_CALLS for very large PRs)'],
    needs: ['docker'],
    values: { CODEX_EFFORT: 'high', ARW_REVIEW_MODE: 'multi-agent', ARW_REPRO: 'on', ARW_MAX_CALLS: '120', ARW_SANDBOX: 'docker', ARW_RUN_IMPACTED_TESTS: 'off' },
  },
  {
    id: 'java-docker',
    name: 'Java + Docker',
    summary: 'Thorough, plus a sandbox built per repository (JDK found from the source, dependencies resolved at base, offline builds), the existing tests that cover the change, and javac call resolution.',
    leavesOut: ['bootstrap builds Maven repositories only; others are reviewed statically', 'reviews stop at 150 model calls'],
    needs: ['docker', 'jdk'],
    values: { CODEX_EFFORT: 'high', ARW_REVIEW_MODE: 'multi-agent', ARW_REPRO: 'on', ARW_MAX_CALLS: '150', ARW_SANDBOX: 'bootstrap', ARW_RUN_IMPACTED_TESTS: 'on', ARW_JAVA_AST: 'on' },
  },
];

// id, label, required, the doctor check name its fix hint is filed under.
const TOOLS = [
  ['node', 'Node 20+', true, 'node >= 20'],
  ['git', 'git', true, 'git'],
  ['codex', 'codex CLI', true, 'codex'],
  ['codex login', 'codex signed in', true, null],
  ['gh', 'GitHub CLI (for GitHub PRs)', false, 'gh auth'],
  ['gh auth', 'GitHub signed in', false, null],
  ['docker', 'Docker (sandboxed tests)', false, 'docker'],
  ['jdk', 'JDK 11+ (Java call resolution)', false, 'JDK for Java impact (javac)'],
];
const SIGN_IN = { 'codex login': 'run: codex login', 'gh auth': 'run: gh auth login (only needed for GitHub PR reviews and publishing)' };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0] || '', missing: Boolean(r.error && r.error.code === 'ENOENT') };
}

// { ok, detail } for one tool on this machine.
function defaultProbe(id) {
  const { resolveCodex } = require('./codex');
  const codex = (args) => {
    const { cmd, pre } = resolveCodex();
    return run(cmd, [...pre, ...args]);
  };
  switch (id) {
    case 'node': {
      const major = Number(process.versions.node.split('.')[0]);
      return { ok: major >= 20, detail: process.version };
    }
    case 'git': {
      const r = run('git', ['--version']);
      return { ok: r.ok, detail: r.ok ? r.out : 'not found' };
    }
    case 'codex': {
      const r = codex(['--version']);
      return { ok: r.ok, detail: r.ok ? r.out : 'not found' };
    }
    case 'codex login': {
      const r = codex(['login', 'status']);
      return { ok: r.ok, detail: r.ok ? r.out : 'not signed in' };
    }
    case 'gh': {
      const r = run('gh', ['--version']);
      return { ok: r.ok, detail: r.ok ? r.out : 'not found' };
    }
    case 'gh auth': {
      const r = run('gh', ['auth', 'status']);
      return { ok: r.ok, detail: r.ok ? 'signed in' : 'not signed in' };
    }
    case 'docker': {
      const r = run(process.env.ARW_DOCKER || 'docker', ['info', '--format', '{{.ServerVersion}}']);
      if (r.ok || r.missing) return { ok: r.ok, detail: r.ok ? `daemon ${r.out}` : 'not found' };
      // Installed but not running: starting it is the fix, not installing it.
      return { ok: false, detail: 'installed, daemon not running', fix: 'start Docker Desktop (or the docker service), then check again' };
    }
    case 'jdk': {
      const ji = require('./java-ast').javaInfo();
      const ok = Boolean(ji.version >= 11 && ji.compiler);
      return { ok, detail: ji.version ? `Java ${ji.version}${ji.compiler ? '' : ' (no javac: a JRE?)'}` : 'not found' };
    }
    default:
      return { ok: false, detail: 'unknown check' };
  }
}

// { items: [{ id, label, required, ok, detail, fix }], ready } — ready when
// every required tool is there.
function checkEnvironment({ probe = defaultProbe, platform = process.platform } = {}) {
  const items = TOOLS.map(([id, label, required, hintName]) => {
    const r = probe(id);
    const fix = r.ok ? null : r.fix || SIGN_IN[id] || (hintName && fixHint(hintName, platform)) || null;
    return { id, label, required, ok: Boolean(r.ok), detail: r.detail || '', fix };
  });
  return { items, ready: items.every((i) => !i.required || i.ok) };
}

function projectState() {
  const { env } = settings.files();
  const preset = (settings.readEnvSettings().find((e) => e.key === 'ARW_PRESET') || {}).value || null;
  return { env: fs.existsSync(env), repos: Object.keys(settings.readRepos()).length, preset: preset || null };
}

// The project files a first run needs; existing ones are left as they are.
function init() {
  const { env, repos } = settings.files();
  const created = [];
  if (!fs.existsSync(env)) {
    fs.writeFileSync(env, '# arw settings, created by arw setup. Edit here or in the dashboard (Settings).\n');
    created.push('.env');
  }
  if (!fs.existsSync(repos)) {
    fs.writeFileSync(repos, `${JSON.stringify({ repos: {} }, null, 2)}\n`);
    created.push('repos.json');
  }
  return { created };
}

function applyPreset(id, { probe = defaultProbe, force = false } = {}) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw Object.assign(new Error(`unknown preset "${id}": one of ${PRESETS.map((p) => p.id).join(', ')}`), { status: 400 });
  if (!force) {
    const missing = preset.needs.map((need) => [need, probe(need)]).filter(([, r]) => !r.ok);
    if (missing.length) {
      const why = missing.map(([need, r]) => `${need} (${r.detail || 'missing'})`).join(', ');
      throw Object.assign(new Error(`${preset.name} needs ${why}: install it first, or apply anyway`), { status: 409, missing: missing.map(([need]) => need) });
    }
  }
  const r = settings.writeEnvSettings({ ...preset.values, ARW_PRESET: id });
  return { preset: id, updated: r.updated };
}

// Review options from settings when the command line does not set them.
function reviewDefaults(args, env = process.env) {
  return {
    singleAgent: Boolean(args.singleAgent) || env.ARW_REVIEW_MODE === 'single-agent',
    noRepro: Boolean(args.noRepro) || env.ARW_REPRO === 'off',
  };
}

module.exports = { PRESETS, TOOLS, checkEnvironment, defaultProbe, projectState, init, applyPreset, reviewDefaults };
