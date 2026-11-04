'use strict';
// The environment a model worker inherits. A worker reads untrusted PR code,
// so it gets only the system, home, toolchain and provider variables it needs
// to start and to run its read commands; Jira, GitHub, Confluence and every
// other dashboard credential stay behind.
// Keep this an allowlist: adding a variable here is a security decision.
const fs = require('node:fs');
const path = require('node:path');

const PATH_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Session: PowerShell, git and the codex Windows sandbox look these up.
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'PSMODULEPATH',
  'USER', 'LOGNAME', 'SHELL', 'TERM',
  // Toolchains the read commands may start (javac, mvn, gradle, python).
  'JAVA_HOME', 'MAVEN_HOME', 'M2_HOME', 'GRADLE_HOME', 'GRADLE_USER_HOME', 'VIRTUAL_ENV', 'CONDA_PREFIX',
]);

// A codex API-key or BYOK setup keeps its provider key in one of these names,
// or in the name a model provider's env_key gives (see providerKeys).
// They are credentials, and deliberately the only credentials on the list.
const PROVIDER_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT',
  'CODEX_API_KEY',
]);

// Per private home: variables only that worker gets. Copilot workers use their
// own COPILOT_HOME, so a GitHub sign-in reaches them only through
// COPILOT_GITHUB_TOKEN (setup-hints). GH_TOKEN and GITHUB_TOKEN stay behind:
// they are the dashboard's publishing credentials.
const HOME_KEYS = { CODEX_HOME: new Set(), COPILOT_HOME: new Set(['COPILOT_GITHUB_TOKEN']) };

function allowed(key) {
  const upper = key.toUpperCase();
  return PATH_KEYS.has(upper) || PROVIDER_KEYS.has(upper) || upper === 'LANG' || upper.startsWith('LC_');
}

// The names `env_key = "..."` declares in the codex config files of a worker
// home: the BYOK provider keys codex itself will read.
function providerKeys(home) {
  const out = new Set();
  let names = [];
  try {
    names = fs.readdirSync(home).filter((n) => n.endsWith('.toml'));
  } catch {
    return out;
  }
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(home, name), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gm)) out.add(m[1].toUpperCase());
  }
  return out;
}

// homeKey: the private home the caller set (CODEX_HOME or COPILOT_HOME).
// extra: non-secret variables the launcher itself adds (RUST_LOG, ...).
// ARW_WORKER_ENV: further names a person chose to pass, comma-separated.
function workerEnv({ home = null, homeKey = 'CODEX_HOME', extra = {}, source = process.env } = {}) {
  const chosen = new Set(String(source.ARW_WORKER_ENV || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const forHome = HOME_KEYS[homeKey] || new Set();
  const fromConfig = homeKey === 'CODEX_HOME' && home ? providerKeys(home) : new Set();
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value == null || upper in HOME_KEYS) continue;
    if (allowed(key) || forHome.has(upper) || fromConfig.has(upper) || chosen.has(upper)) out[key] = value;
  }
  if (home) out[homeKey] = home;
  for (const [key, value] of Object.entries(extra || {})) out[key] = value;
  return out;
}

module.exports = { workerEnv, allowed, providerKeys };
