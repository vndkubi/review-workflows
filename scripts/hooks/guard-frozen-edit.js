'use strict';
// Claude Code PreToolUse hook for Edit|Write|MultiEdit|NotebookEdit.
// - runs/ is evidence: never edited by hand.
// - The tool digest (src/lib, src/cli) and the frozen policy files (agents,
//   config/policies, config/schemas, config/projects) are checked before and
//   after every model call; editing them while a review or eval of this
//   checkout runs aborts it as drift. Such edits wait, or go to a worktree.
// Exit 2 blocks the tool call and shows stderr to the model.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FROZEN = /^(src\/lib|src\/cli|agents|config\/policies|config\/schemas|config\/projects)\//;
// arw subcommands that freeze a context or run model jobs against it.
const RUNNING = /arw\.js["']?\s+(review|raw-review|repro|validate|ticket|watch|eval\s+(run|matrix))\b/;

function readStdin() {
  try {
    return JSON.parse(require('node:fs').readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function commandLines() {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', timeout: 15000, windowsHide: true }).split(/\r?\n/);
    }
    return execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 15000 }).split('\n');
  } catch {
    return [];
  }
}

const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

// An absolute arw.js path must be this checkout's; a relative one cannot be
// placed, so it counts.
function ofThisCheckout(line) {
  const m = line.match(/(\S*?)arw\.js/);
  const dir = m ? m[1].replace(/^["']/, '') : '';
  if (!path.isAbsolute(dir)) return true;
  return norm(path.join(dir, 'arw.js')) === norm(path.join(ROOT, 'src', 'cli', 'arw.js'));
}

const input = readStdin();
const target = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '';
if (!target) process.exit(0);
const rel = path.relative(ROOT, path.resolve(input.cwd || ROOT, target)).replace(/\\/g, '/');
if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

if (rel.startsWith('runs/')) {
  process.stderr.write(`${rel}: run data is hash-bound evidence; it is never edited by hand. Change the code and re-run instead.\n`);
  process.exit(2);
}
if (!FROZEN.test(rel)) process.exit(0);
const live = commandLines().filter((l) => RUNNING.test(l) && ofThisCheckout(l));
if (live.length) {
  process.stderr.write(`${rel} is part of the frozen tool/policy hash, and a run of this checkout is in progress:\n${live.map((l) => `  ${l.trim().slice(0, 200)}`).join('\n')}\nEditing it now aborts that run as drift. Wait for it to finish, or make the change in a worktree.\n`);
  process.exit(2);
}
