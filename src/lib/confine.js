'use strict';
// File access inside a worktree that PR code has run in. A tracked symlink,
// or one a build created, can point anywhere: path.join() is not
// confinement, and fs follows links. Every host-side write or read of a path
// inside the worktree goes through here: each existing part of the path must
// be a real directory (no symlink, no junction), and files are opened
// without following a final link where the OS supports it.
//
// Limit: the check and the open are separate calls. That is safe while no
// PR process runs (runs are sequential and awaited), not against a process
// left behind (a build daemon) changing the tree in between.
const fs = require('node:fs');
const path = require('node:path');

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Plain repository-relative paths: segments of letters, digits, _ . -, not
// starting with a dot or dash. No shell syntax, no "..", no hidden dirs.
const PLAIN_REL = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

function isPlainRel(rel) {
  return typeof rel === 'string' && PLAIN_REL.test(rel) && !rel.split('/').includes('..');
}

class ConfinementError extends Error {}

// An entry that cannot be inspected counts as a link: on Docker Desktop for
// Windows a symlink made inside the container shows up on the host as an
// entry whose lstat fails with EACCES.
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ConfinementError(`${p} cannot be inspected (${err.code}); treating it as a link`);
  }
}

// Relative parts of `abs` under `root`; throws when it is not inside.
function partsUnder(root, abs) {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ConfinementError(`${abs} is not inside ${root}`);
  return rel.split(path.sep);
}

// Throws when an existing part of root/<parts> is a link or not a directory
// where one is needed. Returns how many leading parts exist.
function checkParts(root, parts, { file = true } = {}) {
  let cur = path.resolve(root);
  for (let i = 0; i < parts.length; i += 1) {
    cur = path.join(cur, parts[i]);
    const st = lstatOrNull(cur);
    if (!st) return i;
    if (st.isSymbolicLink()) throw new ConfinementError(`${parts.slice(0, i + 1).join('/')} is a link; refusing to follow it out of the worktree`);
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) throw new ConfinementError(`${parts.slice(0, i + 1).join('/')} is not a directory`);
    if (last && file && !st.isFile()) throw new ConfinementError(`${parts.join('/')} is not a regular file`);
  }
  return parts.length;
}

// Creates root/rel (which must not exist), making missing directories one
// at a time.
function writeNewFile(root, rel, content) {
  if (!isPlainRel(rel)) throw new ConfinementError(`${rel} is not a plain relative path`);
  const parts = rel.split('/');
  const existing = checkParts(root, parts);
  if (existing === parts.length) throw new ConfinementError(`${rel} already exists`);
  let cur = path.resolve(root);
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = path.join(cur, parts[i]);
    if (i >= existing) fs.mkdirSync(cur);
  }
  checkParts(root, parts.slice(0, -1), { file: false });
  const fd = fs.openSync(path.join(cur, parts[parts.length - 1]), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

// Replaces the content of an existing regular file abs under root.
function rewriteFile(root, abs, content) {
  checkParts(root, partsUnder(root, abs));
  // O_TRUNC without O_CREAT is EINVAL on Windows: truncate after opening.
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | NOFOLLOW);
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

// Content of a regular file abs under root, or null when it is missing or
// reached through a link.
function readConfined(root, abs) {
  try {
    if (checkParts(root, partsUnder(root, abs)) !== partsUnder(root, abs).length) return null;
    const fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err instanceof ConfinementError || err.code === 'ELOOP' || err.code === 'ENOENT') return null;
    throw err;
  }
}

// Whether abs is a regular file under root reached without links.
function isConfinedFile(root, abs) {
  try {
    const parts = partsUnder(root, abs);
    return checkParts(root, parts) === parts.length;
  } catch (err) {
    if (err instanceof ConfinementError) return false;
    throw err;
  }
}

// Directory entries of abs under root, or [] when it is missing or a link.
function listConfined(root, abs) {
  try {
    const parts = partsUnder(root, abs);
    if (checkParts(root, parts, { file: false }) !== parts.length || !fs.lstatSync(abs).isDirectory()) return [];
    return fs.readdirSync(abs);
  } catch (err) {
    if (err instanceof ConfinementError) return [];
    throw err;
  }
}

// Removes root/<abs> if it is a confined file; a link itself is unlinked
// (never its target), anything reached through a link is left alone.
function removeConfined(root, abs) {
  let parts;
  try {
    parts = partsUnder(root, abs);
    checkParts(root, parts.slice(0, -1), { file: false });
  } catch (err) {
    if (err instanceof ConfinementError) return false;
    throw err;
  }
  let st;
  try {
    st = lstatOrNull(abs);
  } catch (err) {
    if (!(err instanceof ConfinementError)) throw err;
    st = { isDirectory: () => false }; // uninspectable: unlink removes the entry, never a target
  }
  if (!st || st.isDirectory()) return false;
  fs.unlinkSync(abs);
  return true;
}

module.exports = { isPlainRel, writeNewFile, rewriteFile, readConfined, isConfinedFile, listConfined, removeConfined, ConfinementError };
