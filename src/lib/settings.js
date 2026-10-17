'use strict';
// Settings behind the dashboard's Settings page: .env (typed, validated,
// comments and order preserved), config/repos.json and config/mcp.json.
// Secrets are write-only: reads report whether they are set, never values.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, writeFileAtomic, writeJsonAtomic, readJsonIfExists } = require('./util');
const git = require('./git');

const ENV_FILE = () => process.env.ARW_ENV_FILE || path.join(ROOT, '.env');
const REPOS_FILE = () => (process.env.ARW_REPOS_FILE ? path.resolve(process.env.ARW_REPOS_FILE) : path.join(ROOT, 'config', 'repos.json'));
const MCP_FILE = () => (process.env.ARW_MCP_CONFIG ? path.resolve(process.env.ARW_MCP_CONFIG) : path.join(ROOT, 'config', 'mcp.json'));

// key, group, type, default, help. type: string | number | bool | enum | secret | url
const ENV_SETTINGS = [
  ['CODEX_MODEL', 'executor', 'string', 'gpt-6-luna', 'Model for planning, review and repro tests (codex exec -m).'],
  ['CODEX_JUDGE_MODEL', 'executor', 'string', '', 'Model for red-team rebuttals and synthesis. Empty = same as CODEX_MODEL.'],
  ['CODEX_EFFORT', 'executor', 'enum', '', 'Reasoning effort. Empty = codex default.', ['', 'low', 'medium', 'high']],
  ['CODEX_OUTPUT_SCHEMA', 'executor', 'bool', '1', 'Enforce JSON output with --output-schema (falls back automatically if output degenerates).'],
  ['CODEX_USE_USER_CONFIG', 'executor', 'bool', '0', 'Load ~/.codex/config.toml (plugins, MCP servers, profiles). Off = lean workers.'],
  ['CODEX_PROFILE', 'executor', 'string', '', 'codex profile (-p); only with user config.'],
  ['CODEX_WINDOWS_SANDBOX', 'executor', 'enum', 'unelevated', 'Windows sandbox for workers (codex >= 0.162).', ['unelevated', 'elevated']],
  ['CODEX_TIMEOUT_MS', 'executor', 'number', '1800000', 'Timeout per model call (ms).', null, [60000, 7200000]],
  ['ARW_WORKERS', 'review', 'number', '4', 'Parallel review workers.', null, [1, 8]],
  ['ARW_REPAIR_ATTEMPTS', 'review', 'number', '2', 'Repairs of an invalid model answer before one fresh retry.', null, [0, 5]],
  ['ARW_OUTPUT_LANGUAGE', 'review', 'string', 'English', 'Language of titles, explanations and given/when/then. Quotes stay verbatim.'],
  ['ARW_PR_INTENT', 'review', 'enum', 'confirm', 'A PR review without a ticket run derives the intent (business or technical) from the PR description, linked issues, commit messages and the comments and test names its author added (never the code) and builds the usual spec tables. confirm: the review waits until a person approves that spec. unconfirmed: reviews right away with the unapproved items. off: no intent.', ['confirm', 'unconfirmed', 'off']],
  ['ARW_AUTO_APPROVE_SPEC', 'review', 'bool', '0', 'Let a deterministic policy approve clean specs (no gaps, contradictions or inferred rules).'],
  ['ARW_MAX_CALLS', 'review', 'number', '0', 'Budget: most model calls per review run (planning + review + repro). 0 = no limit.', null, [0, 1000]],
  ['ARW_MAX_INPUT_TOKENS', 'review', 'number', '0', 'Budget: most input tokens per review run. 0 = no limit.', null, [0, 100000000]],
  ['ARW_LARGE_PR_FILES', 'review', 'number', '60', 'A PR with more reviewable files is flagged as large (split proposal).', null, [1, 10000]],
  ['ARW_LARGE_PR_LINES', 'review', 'number', '2000', 'A PR with more changed lines is flagged as large.', null, [1, 1000000]],
  ['ARW_VIEWPOINT_FILES', 'review', 'number', '25', 'Most files per whole-diff viewpoint part (V0_1, V0_2, ...).', null, [5, 500]],
  ['ARW_JAVA_AST', 'static', 'enum', 'on', 'Resolve Java calls with javac (needs a JDK 11+ on PATH; nothing from the repository is executed).', ['on', 'off']],
  ['ARW_JAVA_HOME', 'static', 'string', '', 'JDK for the Java indexer (its bin/java is used). Empty = java on PATH. Use a JDK at least as new as the Java your projects build with.'],
  ['ARW_JAVA_CLASSPATH', 'static', 'string', '', 'Extra classpath for javac (library jars), so more calls resolve.'],
  ['ARW_STATIC', 'static', 'enum', 'on', 'Run linters on the changed files before planning.', ['on', 'off']],
  ['ARW_RUN_IMPACTED_TESTS', 'static', 'enum', 'off', 'Run the existing tests that cover changed files at base and head (executes PR code, like repro).', ['off', 'on']],
  ['ARW_IMPACTED_TESTS_MAX', 'static', 'number', '10', 'Most impacted test files to run.', null, [1, 100]],
  ['ARW_RUFF_BIN', 'static', 'string', '', 'Path to ruff when it is not on PATH (e.g. ...\\Python312\\Scripts\\ruff.exe).'],
  ['ARW_SEMGREP_BIN', 'static', 'string', '', 'Path to semgrep when it is not on PATH.'],
  ['ARW_SEMGREP_CONFIG', 'static', 'string', '', 'semgrep rules (file or directory) when the repository has no .semgrep.yml.'],
  ['ARW_PMD_BIN', 'static', 'string', '', 'Path to the pmd executable when it is not on PATH (a .bat cannot be run without a shell).'],
  ['ARW_PMD_RULESETS', 'static', 'string', '', 'PMD rulesets. Empty = rulesets/java/quickstart.xml.'],
  ['ARW_WATCH', 'automation', 'enum', 'off', 'Dashboard polls repositories marked Watch and reviews new PRs and new pushes.', ['off', 'on']],
  ['ARW_WATCH_INTERVAL', 'automation', 'number', '300', 'Seconds between polls (at least 60).', null, [60, 86400]],
  ['ARW_SLACK_WEBHOOK', 'automation', 'secret', '', 'Slack incoming webhook: a summary when a review finishes (finding titles leave this machine).'],
  ['ARW_NOTIFY_WEBHOOK', 'automation', 'secret', '', 'Any URL that accepts a JSON POST when a review finishes.'],
  ['ARW_NOTIFY_ON', 'automation', 'enum', 'findings', 'Notify for every review, only with findings, or only with P1/P2 (or a failed review).', ['all', 'findings', 'blocking']],
  ['ARW_DASHBOARD_URL', 'automation', 'url', '', 'Base URL of this dashboard, for links in notifications.'],
  ['REPRO_TIMEOUT_MS', 'repro', 'number', '900000', 'Timeout per repro test run (ms).', null, [30000, 3600000]],
  ['ARW_SANDBOX', 'repro', 'enum', 'off', 'Where repro and impacted tests run. docker: a container with the images below. bootstrap: offline in an environment set up per review (image found from the source, dependencies resolved at base, in-house libraries built; see the Sandbox page).', ['off', 'docker', 'bootstrap']],
  ['ARW_SANDBOX_RESOLVE_NETWORK', 'repro', 'string', '', 'Docker network for the dependency resolution step of bootstrap (the only step with network). Empty = bridge.'],
  ['ARW_SANDBOX_IMAGE_MAVEN', 'repro', 'string', '', 'Image for Maven runs. Empty = maven:3.9-eclipse-temurin-17.'],
  ['ARW_SANDBOX_IMAGE_GRADLE', 'repro', 'string', '', 'Image for Gradle runs. Empty = gradle:8-jdk17.'],
  ['ARW_SANDBOX_IMAGE_PYTEST', 'repro', 'string', '', 'Image with Python and pytest installed (required for Python in the sandbox).'],
  ['ARW_SANDBOX_M2', 'repro', 'string', '', 'Host Maven repository mounted read-only, so builds work without network.'],
  ['ARW_SANDBOX_NETWORK', 'repro', 'string', '', 'Docker network for the sandbox. Empty = none (no network).'],
  ['ARW_PYTHON', 'repro', 'string', '', 'Python with pytest for repro and impacted tests. Empty = first of python, python3, py that can import pytest.'],
  ['REPRO_MAVEN_OFFLINE', 'repro', 'bool', '0', 'Run Maven with -o (local repository only).'],
  ['JIRA_URL', 'jira', 'url', '', 'Jira base URL (REST source).'],
  ['JIRA_PAT', 'jira', 'secret', '', 'Jira personal access token (Server/DC).'],
  ['JIRA_EMAIL', 'jira', 'string', '', 'Jira Cloud account email.'],
  ['JIRA_API_TOKEN', 'jira', 'secret', '', 'Jira Cloud API token.'],
  ['CONFLUENCE_URL', 'jira', 'url', '', 'Confluence base URL.'],
  ['CONFLUENCE_PAT', 'jira', 'secret', '', 'Confluence personal access token (Server/DC).'],
  ['CONFLUENCE_EMAIL', 'jira', 'string', '', 'Confluence Cloud email (defaults to JIRA_EMAIL).'],
  ['CONFLUENCE_API_TOKEN', 'jira', 'secret', '', 'Confluence Cloud API token (defaults to JIRA_API_TOKEN).'],
  ['ARW_CONFLUENCE_SEARCH', 'jira', 'bool', '1', 'Also search Confluence for pages mentioning the ticket key.'],
  ['ATLASSIAN_MCP_TOKEN', 'mcp', 'secret', '', 'Token an HTTP MCP server expects; reference it as ${ATLASSIAN_MCP_TOKEN} in headers.'],
].map(([key, group, type, def, help, options, range]) => ({ key, group, type, default: def, help, options: options || null, range: range || null }));

const BY_KEY = new Map(ENV_SETTINGS.map((s) => [s.key, s]));

// ---------- .env ----------
function parseEnvFile(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) return { line };
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      return { line, key: m[1], value };
    });
}

function readEnvFile() {
  const file = ENV_FILE();
  return fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : [];
}

function quote(value) {
  return /[\s#"'=]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

// Effective values with their source; secrets only as set/unset.
function readEnvSettings() {
  const fileValues = new Map(readEnvFile().filter((e) => e.key).map((e) => [e.key, e.value]));
  return ENV_SETTINGS.map((s) => {
    const inFile = fileValues.has(s.key);
    const value = inFile ? fileValues.get(s.key) : process.env[s.key];
    // A variable set in the shell beats .env (loadEnv never overrides), so
    // say so instead of showing a file value that is not in effect.
    const shadowed = inFile && process.env[s.key] !== undefined && process.env[s.key] !== fileValues.get(s.key);
    const source = shadowed ? 'environment (overrides .env)' : inFile ? '.env' : process.env[s.key] !== undefined ? 'environment' : 'default';
    const base = { key: s.key, group: s.group, type: s.type, default: s.default, help: s.help, options: s.options, range: s.range, source };
    if (s.type === 'secret') return { ...base, set: Boolean(value) };
    return { ...base, value: value === undefined ? '' : value };
  });
}

function validateValue(s, value) {
  if (value === '' && s.type !== 'bool') return null;
  if (/[\r\n]/.test(value)) return `${s.key}: must be a single line`;
  if (s.type === 'bool' && !['0', '1'].includes(value)) return `${s.key}: must be 0 or 1`;
  if (s.type === 'enum' && !s.options.includes(value)) return `${s.key}: must be one of ${s.options.filter(Boolean).join(', ')}`;
  if (s.type === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n)) return `${s.key}: must be a whole number`;
    if (s.range && (n < s.range[0] || n > s.range[1])) return `${s.key}: must be between ${s.range[0]} and ${s.range[1]}`;
  }
  if (s.type === 'url' && !/^https?:\/\/[^\s]+$/.test(value)) return `${s.key}: must be an http(s) URL`;
  if (['CODEX_MODEL', 'CODEX_JUDGE_MODEL', 'CODEX_PROFILE'].includes(s.key) && !/^[A-Za-z0-9._:\-/]+$/.test(value)) return `${s.key}: letters, digits and . _ : - / only`;
  return null;
}

// changes: { KEY: "value" | null }. null removes the key (back to default).
// Secrets: "" keeps the current value; null clears it.
function writeEnvSettings(changes) {
  const errors = [];
  const apply = new Map();
  for (const [key, raw] of Object.entries(changes || {})) {
    const s = BY_KEY.get(key);
    if (!s) {
      errors.push(`${key}: not a known setting`);
      continue;
    }
    if (raw === null) {
      apply.set(key, null);
      continue;
    }
    const value = String(raw).trim();
    if (s.type === 'secret' && value === '') continue;
    const err = validateValue(s, value);
    if (err) errors.push(err);
    else apply.set(key, value);
  }
  if (errors.length) {
    const e = new Error(errors.join('; '));
    e.status = 422;
    throw e;
  }
  const entries = readEnvFile();
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e.key || !apply.has(e.key)) {
      out.push(e.line);
      continue;
    }
    seen.add(e.key);
    const v = apply.get(e.key);
    if (v !== null && v !== '') out.push(`${e.key}=${quote(v)}`);
  }
  const added = [...apply].filter(([k, v]) => !seen.has(k) && v !== null && v !== '');
  if (added.length) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push('# set from the dashboard');
    for (const [k, v] of added) out.push(`${k}=${quote(v)}`);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  writeFileAtomic(ENV_FILE(), `${out.join('\n')}\n`);
  // Jobs are spawned with this process's environment: apply immediately.
  for (const [k, v] of apply) {
    if (v === null || v === '') delete process.env[k];
    else process.env[k] = v;
  }
  return { updated: [...apply.keys()] };
}

// Model names codex knows about, for suggestions.
function modelSuggestions() {
  const cache = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
  try {
    const text = fs.readFileSync(cache, 'utf8');
    return [...new Set([...text.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

// ---------- repositories ----------
function readRepos() {
  return readJsonIfExists(REPOS_FILE(), { repos: {} }).repos || {};
}

function writeRepos(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('repos must be a list'), { status: 422 });
  const errors = [];
  const repos = {};
  // Fields the editor does not show (static_commands, ...) are kept as they are.
  const previous = readJsonIfExists(REPOS_FILE(), { repos: {} }).repos || {};
  const MANAGED = ['checkout', 'remote', 'test_command', 'watch'];
  list.forEach((r, i) => {
    const at = `repo ${i + 1}`;
    const name = String((r && r.name) || '').trim();
    const checkout = String((r && r.checkout) || '').trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) return errors.push(`${at}: name must be owner/repository`);
    if (repos[name]) return errors.push(`${at}: ${name} is listed twice`);
    if (!checkout || !fs.existsSync(checkout)) return errors.push(`${name}: checkout ${checkout || '(empty)'} does not exist`);
    if (!git.git(checkout, ['rev-parse', '--git-dir'], { allowFail: true })) return errors.push(`${name}: ${checkout} is not a git repository`);
    const kept = Object.fromEntries(Object.entries(previous[name] || {}).filter(([k]) => !MANAGED.includes(k)));
    const entry = { checkout: checkout.replace(/\\/g, '/'), ...kept };
    const remote = String(r.remote || '').trim();
    if (remote && remote !== 'origin') {
      if (!/^[A-Za-z0-9._-]+$/.test(remote)) return errors.push(`${name}: bad remote name`);
      entry.remote = remote;
    }
    const cmd = String(r.test_command || '').trim();
    if (cmd) {
      if (/[\r\n]/.test(cmd)) return errors.push(`${name}: test command must be one line`);
      entry.test_command = cmd;
    }
    if (r.watch === true) {
      entry.watch = true;
    }
    repos[name] = entry;
  });
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 422 });
  writeJsonAtomic(REPOS_FILE(), { repos });
  return { repos };
}

// ---------- MCP (ticket source) ----------
function readMcp() {
  const cfg = readJsonIfExists(MCP_FILE(), null);
  return cfg && cfg.atlassian ? cfg.atlassian : null;
}

// server: { transport, command, args[], env{}, url, headers{}, tools{} } or null to remove.
function writeMcp(server) {
  if (server === null) {
    if (fs.existsSync(MCP_FILE())) fs.rmSync(MCP_FILE());
    return { removed: true };
  }
  const errors = [];
  const transport = server.transport === 'http' ? 'http' : 'stdio';
  const strMap = (obj, what) => {
    if (obj == null) return {};
    if (typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push(`${what} must be an object`);
      return {};
    }
    for (const [k, v] of Object.entries(obj)) if (typeof v !== 'string' || !/^[A-Za-z_][\w-]*$/.test(k)) errors.push(`${what}.${k}: string values with simple names only`);
    return obj;
  };
  const out = { transport };
  if (transport === 'stdio') {
    if (!server.command || typeof server.command !== 'string') errors.push('command is required for stdio');
    if (server.args != null && (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string'))) errors.push('args must be a list of strings');
    Object.assign(out, { command: server.command, args: server.args || [], env: strMap(server.env, 'env') });
  } else {
    if (!/^https?:\/\/\S+$/.test(String(server.url || ''))) errors.push('url must be an http(s) URL');
    Object.assign(out, { url: server.url, headers: strMap(server.headers, 'headers') });
  }
  // Literal secrets in the file are refused: reference ${VAR} from .env.
  for (const [k, v] of Object.entries({ ...(out.env || {}), ...(out.headers || {}) })) {
    if (/token|secret|password|authorization|pat/i.test(k) && v && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)) errors.push(`${k}: put the secret in a setting and reference it as \${NAME}`);
  }
  if (server.tools != null) {
    out.tools = {};
    for (const [k, v] of Object.entries(server.tools)) {
      if (!['issue', 'page', 'search', 'attachments'].includes(k)) errors.push(`tools.${k}: only issue, page, search, attachments`);
      else if (v === null) out.tools[k] = null;
      else if (!v || typeof v.name !== 'string' || !v.name) errors.push(`tools.${k}.name is required`);
      else out.tools[k] = { name: v.name, ...(v.args ? { args: v.args } : {}) };
    }
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 422 });
  writeJsonAtomic(MCP_FILE(), { atlassian: out });
  return { atlassian: out };
}

function readAll() {
  return { env: readEnvSettings(), repos: readRepos(), mcp: readMcp(), models: modelSuggestions(), files: { env: ENV_FILE(), repos: REPOS_FILE(), mcp: MCP_FILE() } };
}

// Adds one repository (sandbox setup from a source folder), keeping the
// others as they are. The same name at the same checkout is a no-op.
function addRepo(name, checkout) {
  const current = readJsonIfExists(REPOS_FILE(), { repos: {} }).repos || {};
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (current[name]) {
    if (current[name].checkout && same(current[name].checkout, checkout)) return { repos: current, added: false };
    throw Object.assign(new Error(`${name} is already configured at ${current[name].checkout}`), { status: 409 });
  }
  const list = Object.entries(current).map(([n, r]) => ({ name: n, ...r }));
  list.push({ name, checkout });
  return { ...writeRepos(list), added: true };
}

module.exports = { ENV_SETTINGS, readAll, readEnvSettings, writeEnvSettings, readRepos, writeRepos, addRepo, readMcp, writeMcp, parseEnvFile, modelSuggestions };
