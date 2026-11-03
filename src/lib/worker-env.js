'use strict';
// The environment a model worker inherits. A worker reads untrusted PR code,
// so it gets only the system, home and provider variables it needs to start;
// Jira, GitHub, Confluence and every other dashboard credential stay behind.
// Keep this an allowlist: adding a variable here is a security decision.
const PATH_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

// A codex API-key or BYOK setup keeps its provider key in one of these names.
// They are credentials, and deliberately the only credentials on the list.
const PROVIDER_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT',
  'CODEX_API_KEY',
]);

const HOME_KEYS = new Set(['CODEX_HOME', 'COPILOT_HOME']);

function allowed(key) {
  const upper = key.toUpperCase();
  return PATH_KEYS.has(upper) || PROVIDER_KEYS.has(upper) || upper === 'LANG' || upper.startsWith('LC_');
}

// homeKey: the private home the caller set (CODEX_HOME or COPILOT_HOME).
// extra: non-secret variables the launcher itself adds (RUST_LOG, ...).
function workerEnv({ home = null, homeKey = 'CODEX_HOME', extra = {}, source = process.env } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null || !allowed(key)) continue;
    if (HOME_KEYS.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  if (home) out[homeKey] = home;
  for (const [key, value] of Object.entries(extra || {})) out[key] = value;
  return out;
}

module.exports = { workerEnv, allowed };
