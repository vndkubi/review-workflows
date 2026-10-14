'use strict';
// A source snapshot: the files of one revision in a fresh directory, made
// from `git archive`. It has no .git (git on the host never runs in it), no
// symlinks (they are skipped and listed), and nothing outside the
// directory (an entry with "..", an absolute path or a drive is refused).
// A build in a container gets this directory, not a worktree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BLOCK = 512;

function field(buf, start, len) {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? len : nul).toString('utf8');
}

function octal(buf, start, len) {
  const s = field(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

// pax records: "<len> key=value\n".
function paxRecords(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// Why a path from the archive cannot be written, or null.
function badPath(p) {
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\') || p.includes('\0')) return 'absolute or not a plain path';
  const parts = p.replace(/\/+$/, '').split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'contains "." or ".." or an empty part';
  if (parts.some((s) => /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s))) return 'a name this filesystem cannot hold';
  if (parts[0] === '.git') return 'git metadata';
  return null;
}

// Extracts a tar file into `dest` (which must not exist). Returns
// { files, skipped: [{ path, why }] }.
function extractTar(tarFile, dest) {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  fs.mkdirSync(dest, { recursive: true });
  const fd = fs.openSync(tarFile, 'r');
  const header = Buffer.alloc(BLOCK);
  let pos = 0;
  let files = 0;
  const skipped = [];
  let pax = {};
  const readAt = (buf, at) => fs.readSync(fd, buf, 0, buf.length, at);
  try {
    for (;;) {
      if (readAt(header, pos) < BLOCK || header.every((b) => b === 0)) break;
      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] || 48);
      const prefix = field(header, 345, 155);
      const name = pax.path || (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
      const mode = octal(header, 100, 8);
      const dataAt = pos + BLOCK;
      pos = dataAt + Math.ceil(size / BLOCK) * BLOCK;
      if (type === 'x' || type === 'g') {
        const body = Buffer.alloc(size);
        readAt(body, dataAt);
        if (type === 'x') pax = paxRecords(body.toString('utf8'));
        continue;
      }
      pax = {};
      if (type === '5') {
        const why = badPath(name);
        if (why) skipped.push({ path: name, why });
        else fs.mkdirSync(path.join(dest, ...name.replace(/\/+$/, '').split('/')), { recursive: true });
        continue;
      }
      if (type !== '0' && type !== '\0' && type !== '7') {
        skipped.push({ path: name, why: type === '2' ? 'symlink' : type === '1' ? 'hard link' : `entry type ${type}` });
        continue;
      }
      const why = badPath(name);
      if (why) {
        skipped.push({ path: name, why });
        continue;
      }
      const target = path.join(dest, ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = Buffer.alloc(size);
      if (size) readAt(body, dataAt);
      // 'wx': never through anything already there (nothing should be).
      fs.writeFileSync(target, body, { flag: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 });
      files += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files, skipped };
}

// Snapshot of `rev` of `checkout` into `dest`.
function snapshot(checkout, rev, dest) {
  const tarFile = `${dest}.tar`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, rev], { cwd: checkout, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  try {
    return { dir: dest, ...extractTar(tarFile, dest) };
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
}

module.exports = { snapshot, extractTar, badPath };
