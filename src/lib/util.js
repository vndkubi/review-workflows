'use strict';
// Shared helpers: hashing, canonical JSON, atomic writes, env, CLI args.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Stable JSON: object keys sorted recursively, so equal values hash equally.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256Value(value) {
  return sha256(canonicalJson(value));
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write to a temp file then rename, so readers never see a half-written file.
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file, fallback = null) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

// Model output: accept raw JSON, or JSON wrapped in one Markdown fence.
// Anything else is a parse error the repair loop reports back verbatim.
function parseModelJson(text) {
  let body = String(text || '').replace(/^﻿/, '').trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) body = fence[1].trim();
  if (!body.startsWith('{')) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('output contains no JSON object');
    body = body.slice(start, end + 1);
  }
  // Raw control characters inside strings are the most common breakage.
  body = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  try {
    return JSON.parse(body);
  } catch (err) {
    // Show where it broke: a position alone does not let the model repair it.
    const m = err.message.match(/position (\d+)/);
    const near = m ? ` near: «${body.slice(Math.max(0, Number(m[1]) - 120), Number(m[1]))}⟨HERE⟩${body.slice(Number(m[1]), Number(m[1]) + 60)}»` : '';
    throw new Error(`invalid JSON: ${err.message}${near}`);
  }
}

// Variables already in the environment win over the file.
function loadEnv(file = process.env.ARW_ENV_FILE || path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// --flag value | --flag=value | --bool ; positional args collected in _.
function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) out[key] = arg.slice(eq + 1);
    else if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function log(...parts) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${parts.join(' ')}\n`);
}

function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

// Run fn over items with at most `width` in flight; results keep input order.
async function runPool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// Two paths name the same directory: symlinks and Windows 8.3 short names
// resolved, case-insensitive on Windows.
function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    try {
      r = fs.realpathSync.native(r);
    } catch {
      /* missing: compare as given */
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return Boolean(a && b) && norm(a) === norm(b);
}

module.exports = {
  ROOT,
  samePath,
  sha256,
  sha256File,
  sha256Value,
  canonicalJson,
  ensureDir,
  writeFileAtomic,
  writeJsonAtomic,
  readJson,
  readJsonIfExists,
  parseModelJson,
  loadEnv,
  envInt,
  parseArgs,
  nowIso,
  log,
  relPosix,
  runPool,
};
