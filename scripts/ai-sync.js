'use strict';
// Skills live once, in .agents/skills/<name>/ (codex and Copilot read it).
// Claude Code reads only .claude/skills/, so each skill is copied there,
// byte for byte. Copilot reads both folders and keeps the .agents copy when
// the names match, so the copies never show up twice.
//   node scripts/ai-sync.js          copy every skill to .claude/skills
//   node scripts/ai-sync.js --check  exit 1 when a copy is missing or differs
// A .claude/skills/<name> with no source is reported, never deleted: it may
// be someone's own skill.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, '.agents', 'skills');
const TARGET = path.join(ROOT, '.claude', 'skills');

function files(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]);
}

function compare() {
  const src = files(SOURCE);
  const dst = new Set(files(TARGET));
  const drift = src.filter((f) => !dst.has(f) || !fs.readFileSync(path.join(SOURCE, f)).equals(fs.readFileSync(path.join(TARGET, f))));
  const names = new Set(src.map((f) => f.split('/')[0]));
  const stray = [...dst].filter((f) => names.has(f.split('/')[0]) && !src.includes(f));
  const unmanaged = [...new Set([...dst].map((f) => f.split('/')[0]))].filter((n) => !names.has(n));
  return { src, drift, stray, unmanaged };
}

function sync() {
  const { drift, stray } = compare();
  for (const f of drift) {
    fs.mkdirSync(path.dirname(path.join(TARGET, f)), { recursive: true });
    fs.copyFileSync(path.join(SOURCE, f), path.join(TARGET, f));
  }
  for (const f of stray) fs.unlinkSync(path.join(TARGET, f));
  return { copied: drift, removed: stray };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const before = compare();
  if (before.unmanaged.length) console.log(`not from .agents/skills (left alone): ${before.unmanaged.join(', ')}`);
  if (check) {
    const bad = [...before.drift.map((f) => `missing or different: .claude/skills/${f}`), ...before.stray.map((f) => `no source: .claude/skills/${f}`)];
    if (bad.length) {
      console.error(`${bad.join('\n')}\nrun: node scripts/ai-sync.js`);
      process.exit(1);
    }
    console.log(`.claude/skills matches .agents/skills (${before.src.length} files)`);
  } else {
    const { copied, removed } = sync();
    console.log(`copied ${copied.length}, removed ${removed.length}; ${before.src.length} files in sync`);
  }
}

module.exports = { compare, sync, SOURCE, TARGET };
