'use strict';
// Unified-diff parsing: per-file hunks with old/new line numbers.

function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(patch || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = { path: null, old_path: null, hunks: [], added: 0, removed: 0, binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('--- ')) file.old_path = stripPrefix(line.slice(4));
      else if (line.startsWith('+++ ')) file.path = stripPrefix(line.slice(4));
      else if (line.startsWith('Binary files ')) file.binary = true;
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('rename from ')) file.old_path = line.slice(12);
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      hunk = { old_start: Number(header[1]), new_start: Number(header[2]), lines: [] };
      file.hunks.push(hunk);
      oldLine = hunk.old_start;
      newLine = hunk.new_start;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ type: '+', text: line.slice(1), new_line: newLine++ });
      file.added += 1;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: '-', text: line.slice(1), old_line: oldLine++ });
      file.removed += 1;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: ' ', text: line.slice(1), old_line: oldLine++, new_line: newLine++ });
    }
  }
  for (const f of files) {
    if (!f.path) f.path = f.old_path;
    if (!f.old_path) f.old_path = f.path;
  }
  return files;
}

function stripPrefix(name) {
  if (name === '/dev/null') return null;
  return name.replace(/^[ab]\//, '');
}

// Lines GitHub accepts for a RIGHT-side review comment: added or context lines.
function commentableLines(parsedFile) {
  const lines = new Set();
  for (const hunk of parsedFile.hunks) {
    for (const l of hunk.lines) if (l.type !== '-') lines.add(l.new_line);
  }
  return lines;
}

module.exports = { parsePatch, commentableLines };
