'use strict';
// A stand-in for codex, loaded through ARW_EXECUTOR_MODULE by tests of the
// eval harness. Planning puts every changed file in one technical unit; a
// reviewer reports one P3 finding per line containing "BUG:" in a file it
// covers, and nothing else.
const fs = require('node:fs');
const path = require('node:path');

function result(output, prompt) {
  return { ok: true, output, exit_code: 0, elapsed_ms: 1, usage: { input_tokens: Math.ceil(prompt.length / 4), cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 }, turns: 1, commands: 0, error_class: null, error_message: null, model: 'fake', prompt_bytes: prompt.length };
}

function plan(prompt) {
  const m = prompt.match(/REVIEWABLE CHANGED FILES \((\d+)\)[^\n]*\n([\s\S]*?)(\n\n|$)/);
  const files = m[2].split('\n').slice(0, Number(m[1])).map((l) => l.replace(/^- /, '').replace(/ \(\+\d+ -\d+\)$/, ''));
  return { schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'all changed files', files, items: [] }], gaps: [], notes: '' };
}

function lineOf(cwd, file, test) {
  const lines = fs.readFileSync(path.join(cwd, file), 'utf8').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (test(l)) out.push({ line: i + 1, text: l });
  });
  return out;
}

function packet(prompt, cwd) {
  const digest = prompt.match(/context_digest: ([a-f0-9]{64})/)[1];
  const unit = JSON.parse(prompt.match(/^UNIT: (.*)$/m)[1]);
  const role = prompt.match(/^JOB: .* role (business|technical)\.$/m)[1];
  const files = unit.covers.filter((c) => c.startsWith('file:')).map((c) => c.slice(5));
  const code = (file, hit) => ({ kind: 'code', path: file, start_line: hit.line, end_line: hit.line, quote: hit.text.trim() });
  const coverage = unit.covers.filter((c) => c.startsWith('file:') || c.startsWith('viewpoint:')).map((id) => {
    if (!id.startsWith('file:')) return { id, disposition: 'unverified', evidence: [], note: 'nothing specific to cite' };
    const first = lineOf(cwd, id.slice(5), (l) => l.trim())[0];
    return { id, disposition: 'reviewed', evidence: [code(id.slice(5), first)], note: 'read the file' };
  });
  const findings = [];
  if (unit.kind !== 'viewpoint') {
    for (const file of files) {
      for (const hit of lineOf(cwd, file, (l) => l.includes('BUG:'))) {
        const ev = code(file, hit);
        findings.push({
          id: `${unit.id}-${role}-F${findings.length + 1}`,
          severity: 'P3',
          confidence: 'LIKELY',
          title: hit.text.split('BUG:')[1].trim(),
          asis: `The code at ${file}:${hit.line} is marked as wrong.`,
          tobe: 'The marked behaviour is fixed.',
          trigger: { given: 'the marked input', when: 'the code runs', then: 'the marked defect shows' },
          impact: 'Wrong result.',
          evidence: [ev],
          fix: { kind: 'code_change', asis: hit.text.trim(), tobe: hit.text.split('BUG:')[0].trim() || 'pass', reason: 'remove the defect' },
          verification: { method: 'inspected', detail: 'read the marked line', evidence: [] },
          authority: { kind: 'inferred', id: 'engineering-judgement', source: ev },
          items: [],
        });
      }
    }
  }
  return { schema_version: '1.0', context_digest: digest, unit_id: unit.id, role, summary: `${unit.id} reviewed`, dependency_refs: [], coverage, item_verdicts: [], findings, recommendation: findings.length ? 'findings' : 'no_findings' };
}

module.exports = async function fakeExecutor(opts) {
  fs.mkdirSync(opts.attemptDir, { recursive: true });
  const p = opts.prompt;
  if (p.startsWith('You are a read-only planner')) return result(JSON.stringify(plan(p)), p);
  if (p.includes('JOB: ')) return result(JSON.stringify(packet(p, opts.cwd)), p);
  return { ok: false, output: null, exit_code: 1, elapsed_ms: 1, usage: null, turns: 0, commands: 0, error_class: 'config', error_message: `fake executor: unexpected prompt ${p.slice(0, 60)}`, model: 'fake', prompt_bytes: p.length };
};
