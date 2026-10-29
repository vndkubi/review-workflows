'use strict';
// PreToolUse hook (Bash) of the read-only Claude agents in .claude/agents/:
// a command runs only when every part of it is on the read-only list below.
// Anything else (a write, a redirection into a file, command substitution,
// an unknown program) is refused, so the agent's charter is not the guard.
// Exit 2 blocks the call and shows the reason to the model.
const fs = require('node:fs');

const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'egrep', 'rg', 'find', 'sed', 'sort', 'uniq', 'cut', 'tr', 'jq', 'pwd', 'diff', 'file', 'stat', 'du', 'which', 'basename', 'dirname', 'realpath', 'echo', 'true', 'cd', 'nl']);
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'grep', 'blame', 'rev-parse', 'merge-base', 'cat-file', 'shortlog', 'describe', 'ls-tree', 'rev-list']);
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
// arw subcommands that only read (help text: "arw --help").
const ARW_READS = [
  (a) => a.length === 0 || a[0] === '--help' || a[0] === 'help' || a[0] === 'status' || a[0] === 'acceptance',
  (a) => a[0] === 'gate' && a[1] === 'status',
  (a) => a[0] === 'retro' && !a.includes('--save'),
  (a) => a[0] === 'setup' && a.includes('--check'),
  (a) => a[0] === 'sandbox' && ['discover', 'graph', 'records'].includes(a[1]),
];

// Splits a command line into segments of words, honouring quotes. Returns
// a string (the reason) for anything it will not interpret.
function parse(command) {
  if (/`|\$\(|<\(|>\(|<</.test(command)) return 'command substitution, process substitution or a here-document';
  const segments = [[]];
  let word = null;
  let quote = null;
  const end = () => { if (word !== null) segments[segments.length - 1].push(word); word = null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word = word || ''; continue; }
    if (c === '\\' && i + 1 < command.length) { word = (word || '') + command[++i]; continue; }
    if (/\s/.test(c) && c !== '\n') { end(); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if (c === '&' && command[i + 1] === '>') { // &>/dev/null
        const m = command.slice(i).match(/^&>\s*(\S+)/);
        if (!m || m[1] !== '/dev/null') return 'output redirected into a file';
        end();
        i += m[0].length - 1;
        continue;
      }
      end();
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      segments.push([]);
      continue;
    }
    if (c === '>') {
      const fd = word !== null && /^\d$/.test(word) ? word : null;
      if (word !== null && !fd) end();
      word = null;
      const m = command.slice(i).match(/^>(&\d|\s*(\S+))/);
      if (command[i + 1] === '>' || !m || (!m[1].startsWith('&') && m[2] !== '/dev/null')) return 'output redirected into a file';
      i += m[0].length - 1;
      continue;
    }
    if (c === '<') return 'input redirection';
    word = (word || '') + c;
  }
  if (quote) return 'unbalanced quote';
  end();
  return segments.filter((s) => s.length);
}

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const isScript = (p, rel) => norm(p) === rel || norm(p).endsWith(`/${rel}`);

function checkSegment(words) {
  let w = [...words];
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
  if (!w.length) return 'an assignment alone';
  const [cmd, ...args] = w;
  if (READERS.has(cmd)) {
    if (cmd === 'find' && args.some((a) => FIND_WRITES.test(a))) return 'find with an action that writes or runs commands';
    if (cmd === 'sort' && args.some((a) => /^(-o|--output)/.test(a))) return 'sort -o writes a file';
    if (cmd === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) return 'uniq with an output file';
    if (cmd === 'sed') {
      const script = args.filter((a) => !a.startsWith('-'))[0] || '';
      if (!args.includes('-n') || args.some((a) => /^(-i|--in-place)/.test(a)) || !/^([0-9,$]+|\/[^/]*\/)p$/.test(script)) return "sed other than sed -n '<lines>p'";
    }
    return null;
  }
  if (cmd === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C') i += 2;
      else if (args[i] === '--no-pager') i += 1;
      else return `git option ${args[i]}`;
    }
    if (!GIT_READS.has(args[i])) return `git ${args[i] || ''} is not a read`;
    if (args.some((a) => /^--output/.test(a))) return 'git --output writes a file';
    return null;
  }
  if (cmd === 'node') {
    const [script, ...rest] = args;
    if (!script) return 'node without a script';
    if (isScript(script, 'scripts/dev-impact.js') || isScript(script, 'scripts/test.js')) return null;
    if (isScript(script, 'scripts/ai-sync.js') && rest.includes('--check')) return null;
    if (isScript(script, 'src/cli/arw.js') && ARW_READS.some((ok) => ok(rest))) return null;
    return `node ${script} ${rest.join(' ')} is not on the read-only list`;
  }
  if (cmd === 'npm' && (args.join(' ') === 'test' || args.join(' ') === 'run test')) return null;
  return `${cmd} is not on the read-only list`;
}

// null when the command only reads; otherwise why it is refused.
function verdict(command) {
  if (typeof command !== 'string' || !command.trim()) return 'empty command';
  const segments = parse(command);
  if (typeof segments === 'string') return segments;
  for (const s of segments) {
    const why = checkSegment(s);
    if (why) return why;
  }
  return null;
}

if (require.main === module) {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  if (input.tool_name !== 'Bash') process.exit(0);
  const why = verdict(input.tool_input && input.tool_input.command);
  if (why) {
    process.stderr.write(`read-only agent: refused (${why}). Allowed: git reads, cat/grep/rg/ls/find/sed -n, node scripts/dev-impact.js, node scripts/test.js, read-only arw subcommands. Report what you would run instead.\n`);
    process.exit(2);
  }
}

module.exports = { verdict };
