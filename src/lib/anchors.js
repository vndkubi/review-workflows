'use strict';
// Diff anchors: every hunk of the frozen review.patch gets an id (H1, H2, ...
// in patch order). Coverage rows and verdicts may cite "H3" (the hunk's first
// changed line) or "H3:47" (line 47 of that file) instead of quoting; the runtime
// fills in path, lines and quote from the frozen source, so the evidence is
// as checkable as a quote without the model copying text. Findings still
// quote verbatim: there the quote is the claim.
const { parsePatch } = require('./patch');

const ANCHOR = /^H([1-9][0-9]*)(?::([1-9][0-9]*))?$/;
const MEANINGFUL = /[\p{L}\p{N}]/u;

function hunkAnchors(patchText) {
  const out = [];
  for (const file of parsePatch(patchText)) {
    if (file.binary) continue;
    for (const h of file.hunks) {
      const added = h.lines.filter((l) => l.type === '+');
      const removed = h.lines.filter((l) => l.type === '-');
      // A hunk that only deletes is anchored on the base side.
      const base = !added.length;
      const side = base ? h.lines.filter((l) => l.type !== '+') : h.lines.filter((l) => l.type !== '-');
      const changed = base ? removed : added;
      const key = base ? 'old_line' : 'new_line';
      if (!side.length) continue;
      const first = changed.find((l) => MEANINGFUL.test(l.text)) || changed[0];
      out.push({
        id: `H${out.length + 1}`,
        path: base ? file.old_path : file.path,
        revision: base ? 'base' : 'reviewed',
        start: side[0][key],
        end: side[side.length - 1][key],
        first_line: first[key],
        first: first.text.trim(),
        added: added.length,
        removed: removed.length,
      });
    }
  }
  return out;
}

// The anchor list a reviewer of these files is shown.
function renderAnchors(anchors, files) {
  const set = new Set(files);
  return anchors
    .filter((a) => set.has(a.path))
    .map((a) => `- ${a.id} ${a.path} lines ${a.start}-${a.end}${a.revision === 'base' ? ' (base, deleted)' : ''} (+${a.added} -${a.removed}): ${a.first.slice(0, 100)}`)
    .join('\n');
}

// Returns { evidence } or { error } for one anchor string.
function resolveAnchor(anchor, anchors, code) {
  const m = String(anchor).match(ANCHOR);
  const a = m && anchors.find((x) => x.id === `H${m[1]}`);
  if (!a) return { error: `"${anchor}" is not a diff hunk of this review (ids are listed under DIFF ANCHORS)` };
  let line = m[2] ? Number(m[2]) : a.first_line;
  const lines = code(a.path, a.revision);
  if (!lines || line > lines.length) return { error: `"${anchor}": ${a.path} has no line ${line}` };
  // A line just outside the hunk is still real code of the same file; a line
  // with nothing to show (a brace) moves to the nearest one that has some,
  // within the hunk when it was inside it, the earlier one on a tie.
  if (!MEANINGFUL.test(lines[line - 1])) {
    const inside = line >= a.start && line <= a.end;
    const lo = inside ? a.start : 1;
    const hi = inside ? a.end : lines.length;
    for (let d = 1; line - d >= lo || line + d <= hi; d++) {
      if (line - d >= lo && MEANINGFUL.test(lines[line - d - 1])) { line -= d; break; }
      if (line + d <= hi && MEANINGFUL.test(lines[line + d - 1])) { line += d; break; }
    }
  }
  return { evidence: { kind: 'code', path: a.path, revision: a.revision, start_line: line, end_line: line, quote: lines[line - 1].trim() || lines[line - 1] } };
}

module.exports = { hunkAnchors, renderAnchors, resolveAnchor, ANCHOR };
