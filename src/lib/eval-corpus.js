'use strict';
// Building the eval corpus without a model.
//
//   mineFixes       a fix commit's changed lines are blamed back (SZZ) to the
//                   change that introduced them; that PR (or commit) becomes a
//                   *candidate* case expecting those lines. A person confirms
//                   or rejects each one: a fix commit is a guess, not a label.
//   importMartian   the Martian offline benchmark's golden comments (prose,
//                   no coordinates) become path-scoped keyword labels on the
//                   PR range. Comments with nothing to anchor on are reported.
//
// Candidates live in evals/candidates/<id>.json, confirmed cases in
// evals/cases/. Both may hold reviewed-project code: evals/ is gitignored.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJsonAtomic, ensureDir, nowIso, sha256Value } = require('./util');
const { evalDir, casesDir, writeCase, validateCase } = require('./eval');
const git = require('./git');

const FIX_RE = /\b(fix(e[sd])?|bug|bugfix|hotfix|regression)\b|sửa|lỗi/i;
const SOURCE_RE = /\.(java|kt|kts|scala|groovy|py|js|jsx|ts|tsx|mjs|cjs|go|rb|cs|php|rs|c|cc|cpp|h|hpp|swift|sql)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec|testing)\/|(Test|Tests|IT)\.(java|kt)$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(spec|test)\.[jt]sx?$/;
const DIFF_CAP = 6000;

const candidatesDir = () => path.join(evalDir(), 'candidates');
const isSource = (p) => SOURCE_RE.test(p) && !TEST_RE.test(p);

// ---------- SZZ ----------
// Old-side line ranges a diff deletes or modifies, per source file.
function oldRanges(repo, parent, sha) {
  const out = git.git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', parent, sha]);
  const ranges = [];
  let file = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('--- ')) file = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '');
    const m = file && isSource(file) && /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (m && (m[2] === undefined ? 1 : Number(m[2])) > 0) ranges.push({ path: file, start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return ranges;
}

// [{ sha, line (in that commit), path (there), text }] for the range at rev.
function blame(repo, rev, r) {
  const out = git.git(repo, ['blame', '--porcelain', '-w', '-L', `${r.start},+${r.count}`, rev, '--', r.path], { allowFail: true });
  if (!out) return [];
  const rows = [];
  const files = new Map();
  let cur = null;
  for (const line of out.split('\n')) {
    const h = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (h) cur = { sha: h[1], line: Number(h[2]) };
    else if (cur && line.startsWith('filename ')) files.set(cur.sha, line.slice(9));
    else if (cur && line.startsWith('\t')) {
      rows.push({ ...cur, path: files.get(cur.sha) || r.path, text: line.slice(1) });
      cur = null;
    }
  }
  return rows;
}

// The PR that brought `sha` in: the first commit on tip's first-parent line
// that descends from it, when that is a merge whose second parent has it.
// null for squash/rebase or a commit made on the main line. One rev-list,
// not one process per merge (Mindustry has thousands).
function mergeOf(repo, sha, tip) {
  const out = git.git(repo, ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${sha}..${tip}`], { allowFail: true }) || '';
  const m = out.split(/\s+/).filter(Boolean)[0];
  if (!m) return null;
  const isAnc = (a, b) => git.git(repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null;
  const second = git.git(repo, ['rev-parse', '--verify', '--quiet', `${m}^2`], { allowFail: true });
  return second && isAnc(sha, `${m}^2`) && !isAnc(sha, `${m}^1`) ? m : null;
}

// Where a block of lines sits in `rev`: exactly one place, or null.
function locate(repo, rev, file, texts) {
  const body = git.showFile(repo, rev, file);
  if (body == null) return null;
  const lines = body.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i + texts.length <= lines.length; i += 1) {
    if (texts.every((t, k) => lines[i + k] === t)) hits.push(i + 1);
  }
  return hits.length === 1 ? [hits[0], hits[0] + texts.length - 1] : null;
}

// Consecutive runs of blamed lines, one label each.
function runsOf(rows) {
  const sorted = [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.path === r.path && r.line === last.end + 1) {
      last.end = r.line;
      last.texts.push(r.text);
    } else out.push({ path: r.path, start: r.line, end: r.line, texts: [r.text] });
  }
  return out;
}

function knownFixes() {
  const seen = new Set();
  for (const dir of [candidatesDir(), casesDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const c = readJson(path.join(dir, f));
      if (c.source && c.source.fix) seen.add(c.source.fix);
    }
  }
  return seen;
}

function mineFixes({ repo, prefix, limit = 20, maxCommits = 3000, maxLines = 4000, rev = 'HEAD', pattern = FIX_RE } = {}) {
  if (!repo || !path.isAbsolute(repo)) throw new Error('--repo: absolute path of a local clone');
  const name = String(prefix || path.basename(repo)).replace(/[^A-Za-z0-9._-]/g, '_');
  const log = git.git(repo, ['log', '--no-merges', `-n${maxCommits}`, '--format=%H%x1f%P%x1f%s', rev]);
  const seen = knownFixes();
  const candidates = [];
  const skipped = [];
  for (const row of log.split('\n').filter(Boolean)) {
    if (candidates.length >= limit) break;
    const [sha, parents, subject] = row.split('\x1f');
    if (!pattern.test(subject) || seen.has(sha)) continue;
    const skip = (reason) => skipped.push({ sha, subject, reason });
    const parent = parents.split(' ')[0];
    if (!parent) {
      skip('root commit');
      continue;
    }
    const ranges = oldRanges(repo, parent, sha);
    if (!ranges.length) {
      skip('no source lines deleted or changed (only additions, tests or docs)');
      continue;
    }
    const rows = ranges.flatMap((r) => blame(repo, parent, r)).filter((r) => r.text.trim());
    const bySha = new Map();
    for (const r of rows) bySha.set(r.sha, (bySha.get(r.sha) || 0) + 1);
    const intro = [...bySha.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!intro) {
      skip('nothing to blame');
      continue;
    }
    const introSha = intro[0];
    const introParent = (git.git(repo, ['rev-parse', '--verify', '--quiet', `${introSha}^`], { allowFail: true }) || '').trim();
    if (!introParent) {
      skip('introduced by the root commit');
      continue;
    }
    const blamed = runsOf(rows.filter((r) => r.sha === introSha));
    // The PR range when there is a merge, else the commit itself.
    const merge = mergeOf(repo, introSha, parent);
    let base = introParent;
    let head = introSha;
    let expected = blamed.map((b) => ({ path: b.path, lines: [b.start, b.end] }));
    let kind = 'commit';
    if (merge) {
      const prHead = git.revParse(repo, `${merge}^2`);
      const located = blamed.map((b) => ({ path: b.path, lines: locate(repo, prHead, b.path, b.texts) }));
      if (located.every((l) => l.lines)) {
        base = git.mergeBase(repo, `${merge}^1`, prHead);
        head = prHead;
        expected = located;
        kind = 'merge';
      }
    }
    const size = git.git(repo, ['diff', '--shortstat', base, head]).match(/\d+/g) || [];
    const changed = Number(size[1] || 0) + Number(size[2] || 0);
    if (changed > maxLines) {
      skip(`introducing change too large (${changed} lines)`);
      continue;
    }
    const sourcePaths = [...new Set(ranges.map((r) => r.path))];
    const diff = git.git(repo, ['show', '--no-color', '--format=', sha, '--', ...sourcePaths]);
    const mergeSubject = merge ? git.git(repo, ['log', '-1', '--format=%s', merge]).trim() : '';
    const pr = /#(\d+)/.exec(merge ? mergeSubject : '') || /\(#(\d+)\)\s*$/.exec(git.git(repo, ['log', '-1', '--format=%s', introSha]).trim());
    const c = {
      id: `${name}-${sha.slice(0, 8)}`,
      status: 'candidate',
      repo,
      base,
      head,
      source: { kind: 'szz', fix: sha, introduced_by: introSha, range: kind, merge: merge || null, pr: pr ? Number(pr[1]) : null, mined_at: nowIso() },
      expected: expected.map((e, i) => ({ id: `E${i + 1}`, path: e.path, lines: e.lines, fix_subject: subject })),
      not_expected: [],
      evidence: {
        fix: { sha, subject, diff: diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n... (${diff.length - DIFF_CAP} more characters)` : diff },
        introduced_by: introSha,
        introduced_subject: git.git(repo, ['log', '-1', '--format=%s', introSha]).trim(),
        blamed_lines: rows.filter((r) => r.sha === introSha).length,
        other_blamed: [...bySha.entries()].filter(([s]) => s !== introSha).map(([s, n]) => ({ sha: s, lines: n })),
        changed_lines: changed,
      },
    };
    const errors = validateCase(c);
    if (errors.length) {
      skip(`invalid case: ${errors.join('; ')}`);
      continue;
    }
    writeJsonAtomic(path.join(ensureDir(candidatesDir()), `${c.id}.json`), c);
    seen.add(sha);
    candidates.push(c);
  }
  return { candidates, skipped };
}

function listCandidates() {
  const dir = candidatesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(dir, f)));
}

// A person's decision on a candidate. Confirming writes the case; the
// candidate keeps the decision so mining never offers it again.
function decideCandidate(id, { decision, by, note = '' } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id || ''))) throw new Error('bad candidate id');
  if (!['confirm', 'reject'].includes(decision)) throw new Error('decision: confirm | reject');
  const file = path.join(candidatesDir(), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`no candidate ${id}`);
  const cand = readJson(file);
  if (cand.status !== 'candidate') throw new Error(`candidate ${id} is already ${cand.status}`);
  const decided = { by: by || 'unknown', at: nowIso(), note, candidate_sha256: sha256Value(cand) };
  let caseFile = null;
  if (decision === 'confirm') {
    const { status: _s, evidence: _e, ...rest } = cand;
    caseFile = writeCase({ ...rest, confirmed: decided });
  }
  writeJsonAtomic(file, { ...cand, status: decision === 'confirm' ? 'confirmed' : 'rejected', decided });
  return { file: caseFile, candidate: file };
}

// ---------- Martian offline benchmark ----------
const FILE_TOKEN = /[\w./-]+\.(java|kt|py|js|jsx|ts|tsx|go|rb|html|hbs|gjs|sql|ya?ml|json|ftl|properties|xml|scss|css)\b/gi;

// Code-like tokens of a comment: backticked text, calls, dotted names,
// snake_case, camelCase and multi-capital PascalCase. Plain words are not.
function identifiers(text) {
  const files = new Set((text.match(FILE_TOKEN) || []).map((f) => f.toLowerCase()));
  const out = [];
  const add = (t) => {
    const k = t.toLowerCase();
    if (k.length > 2 && !files.has(k) && !out.includes(k)) out.push(k);
  };
  for (const m of text.matchAll(/`([^`]+)`/g)) add(m[1].replace(/\(.*$/, '').trim());
  // Quoted strings count when they look like code ('idp-alias-'), not words ('alias').
  for (const m of text.matchAll(/'([^'\s]{3,})'|"([^"\s]{3,})"/g)) if (/[-_.:/=]/.test(m[1] || m[2])) add(m[1] || m[2]);
  for (const m of text.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(\(\))?/g)) {
    const t = m[0];
    if (/^(e\.g|i\.e|etc)$/i.test(t)) continue;
    const codeLike = m[1] || t.includes('.') || /[a-z0-9]_[a-z0-9]/i.test(t) || /[a-z][A-Z]/.test(t) || (/^[A-Z]/.test(t) && /[a-z]/.test(t) && (t.match(/[A-Z]/g) || []).length >= 2);
    if (!codeLike) continue;
    add(t.replace(/\(\)$/, ''));
    if (t.includes('.')) for (const part of t.replace(/\(\)$/, '').split('.')) if (/_|[a-z][A-Z]/.test(part)) add(part);
  }
  return out;
}

function changedLinesByFile(repo, base, head) {
  const byFile = new Map();
  let file = null;
  for (const line of git.diffPatch(repo, base, head).split('\n')) {
    if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('--- ') && line !== '--- /dev/null') file = line.slice(4).replace(/^a\//, '');
    else if (file && /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) byFile.set(file, `${byFile.get(file) || ''}${line.slice(1).toLowerCase()}\n`);
  }
  return byFile;
}

function defaultPrInfo(repo, pr, repoDir) {
  const { prView } = require('./github');
  const info = prView(repo, pr);
  const url = `https://github.com/${repo}.git`;
  const has = (sha) => git.git(repoDir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) !== null;
  if (!has(info.headRefOid)) git.git(repoDir, ['fetch', '-q', url, `pull/${pr}/head`]);
  if (!has(info.baseRefOid)) git.git(repoDir, ['fetch', '-q', url, info.baseRefOid]);
  return { base: info.baseRefOid, head: info.headRefOid };
}

function importMartian({ file, repoDir, name, prInfo = defaultPrInfo, force = false } = {}) {
  if (!repoDir || !path.isAbsolute(repoDir)) throw new Error('--repo: absolute path of a local clone');
  const golden = readJson(file);
  if (!Array.isArray(golden)) throw new Error(`${file}: expected a list of PRs`);
  const label = String(name || path.basename(file, '.json')).replace(/[^A-Za-z0-9._-]/g, '_');
  const cases = [];
  const unanchored = [];
  const skipped = [];
  const ids = new Set();
  for (const entry of golden) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(entry.url || '');
    if (!m) {
      skipped.push({ url: entry.url, reason: 'not a GitHub PR url' });
      continue;
    }
    const [, repo, n] = m;
    let id = `martian-${label}-${n}`;
    if (ids.has(id)) id = `${id}-${repo.split('/')[0].replace(/[^A-Za-z0-9._-]/g, '_')}`;
    ids.add(id);
    let info;
    try {
      info = prInfo(repo, Number(n), repoDir);
    } catch (err) {
      skipped.push({ url: entry.url, reason: err.message.slice(0, 300) });
      continue;
    }
    const diffFiles = git.changedFiles(repoDir, info.base, info.head).map((f) => f.path);
    const changed = changedLinesByFile(repoDir, info.base, info.head);
    const expected = [];
    for (const cm of entry.comments || []) {
      const text = String(cm.comment || '');
      const keywords = identifiers(text);
      if (!keywords.length) {
        unanchored.push({ case: id, comment: text });
        continue;
      }
      const named = (text.match(FILE_TOKEN) || []).map((t) => t.replace(/^\.?\//, ''));
      let paths = diffFiles.filter((p) => named.some((t) => p === t || p.endsWith(`/${t}`)));
      if (!paths.length) paths = diffFiles.filter((p) => keywords.some((k) => (changed.get(p) || '').includes(k)));
      expected.push({ id: `M${expected.length + 1}`, prose: text, ...(paths.length ? { paths } : {}), keywords, min_keywords: 1, approx: true, source_severity: cm.severity || null, category: cm.category || null });
    }
    if (!expected.length) {
      skipped.push({ url: entry.url, reason: 'no comment had anything to anchor on' });
      continue;
    }
    const c = {
      id,
      repo: repoDir,
      base: info.base,
      head: info.head,
      source: { kind: 'martian', benchmark: 'withmartian/code-review-benchmark (offline)', pr_url: entry.url, original_url: entry.original_url || null, title: entry.pr_title || null, imported_at: nowIso() },
      expected,
      not_expected: [],
    };
    const errors = validateCase(c);
    if (errors.length) {
      skipped.push({ url: entry.url, reason: `invalid case: ${errors.join('; ')}` });
      continue;
    }
    writeCase(c, { force });
    cases.push(c);
  }
  return { cases, unanchored, skipped };
}

module.exports = { mineFixes, listCandidates, decideCandidate, importMartian, identifiers, isSource };
