'use strict';
// The traditional baseline the harness is measured against: one prompt per
// change, answered in one call. No validator, repair loop, red team,
// synthesis or repro; at most one retry when the answer is not JSON. What
// the model wrote is kept as written, quotes included, and scored like the
// harness's own findings.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, ensureDir, writeJsonAtomic, parseModelJson, nowIso, sha256 } = require('./util');
const git = require('./git');

const BASELINE = path.join(ROOT, 'config', 'baselines', 'raw-prompt.md');

function buildPrompt(baseline, { base, head }) {
  return `${String(baseline).trim()}

The working directory is checked out at the PR head (${head}). The change under review is exactly \`git diff ${base} ${head}\`. Do not modify any file.

RAW-PROMPT OUTPUT: answer with exactly one JSON object and nothing else:
{"findings": [{"id": "F1", "severity": "P1|P2|P3|P4", "title": "...", "asis": "what the code does now", "tobe": "what it should do", "impact": "who or what is hurt, and when", "evidence": [{"kind": "code", "path": "repository-relative path", "start_line": 1, "end_line": 1, "quote": "the cited lines copied from the file at the PR head"}]}]}
Use {"findings": []} when you find nothing worth reporting.`;
}

function findingsOf(candidate) {
  const list = candidate && Array.isArray(candidate.findings) ? candidate.findings : null;
  if (!list) return null;
  return list.filter((f) => f && typeof f === 'object').map((f, i) => ({ ...f, id: typeof f.id === 'string' && f.id ? f.id : `F${i + 1}` }));
}

// Returns { status, findings, receipts } and writes <outDir>/raw-review.json.
async function runRawReview({ repo, base, head, outDir, executor, model = null, effort = null, baseline = null, wtDir = null, log = () => {} }) {
  ensureDir(outDir);
  const text = baseline != null ? baseline : fs.readFileSync(BASELINE, 'utf8');
  const prompt = buildPrompt(text, { base, head });
  // The model reads the PR head in its own worktree, like the harness's jobs.
  const wt = path.join(wtDir || path.join(outDir, 'wt'), `raw-${sha256(outDir).slice(0, 10)}`);
  git.git(repo, ['worktree', 'add', '--detach', '--force', wt, head]);
  const receipts = [];
  let findings = null;
  try {
    for (let attempt = 1; attempt <= 2 && !findings; attempt += 1) {
      const attemptDir = ensureDir(path.join(outDir, 'attempts', `raw-${attempt}`));
      const res = await executor({ prompt, cwd: wt, attemptDir, model, effort, sandbox: 'read-only' });
      const receipt = { label: 'raw-prompt', attempt, model: res.model || model, exit_code: res.exit_code, elapsed_ms: res.elapsed_ms, usage: res.usage, turns: res.turns, commands: res.commands, error_class: res.error_class || null, at: nowIso() };
      receipts.push(receipt);
      if (res.output != null) fs.writeFileSync(path.join(attemptDir, 'raw-candidate.txt'), String(res.output));
      try {
        findings = findingsOf(parseModelJson(res.output));
      } catch {
        findings = null;
      }
      receipt.parsed = Boolean(findings);
      if (!findings) log(`raw-prompt attempt ${attempt}: the answer is not a JSON object with findings`);
    }
  } finally {
    git.git(repo, ['worktree', 'remove', '--force', wt], { allowFail: true });
    git.git(repo, ['worktree', 'prune'], { allowFail: true });
  }
  const out = { schema_version: '1.0', config: 'raw-prompt', base, head, model, effort, prompt_sha256: sha256(prompt), status: findings ? 'EXECUTED_PASS' : 'EXECUTED_FAIL', findings: findings || [], receipts, at: nowIso() };
  writeJsonAtomic(path.join(outDir, 'raw-review.json'), out);
  fs.writeFileSync(path.join(outDir, 'prompt.txt'), prompt);
  return out;
}

module.exports = { buildPrompt, runRawReview, BASELINE };
