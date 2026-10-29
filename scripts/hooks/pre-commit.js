'use strict';
// Git pre-commit (.githooks/pre-commit). The repository is public: refuse
// staged files that are private or hold reviewed-project code, and staged
// JavaScript that does not parse. Checks the staged content, not the files.
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const HANDBOOK = 'Sổ tay làm việc với AI.md'.normalize('NFC');
const PRIVATE = [
  [(p) => p.normalize('NFC') === HANDBOOK, 'personal handbook'],
  // .claude/skills/ and .claude/agents/ hold what scripts/ai-sync.js writes for Claude.
  [(p) => p.startsWith('.claude/') && !/^\.claude\/(skills|agents)\//.test(p), 'local Claude Code state (worktrees, launch configs with local paths)'],
  [(p) => /^(runs|wt|evals|_study)\//.test(p), 'run data, eval cases or study notes: may hold reviewed-project code'],
  [(p) => p === '.env', 'secrets'],
  [(p) => /^config\/(repos|mcp)\.json$/.test(p), 'local checkout / MCP mapping'],
  [(p) => p.startsWith('config/projects/'), 'per-repository viewpoints describe private code'],
];

function git(args) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
}

const staged = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).toString('utf8').split('\0').filter(Boolean);
const problems = [];
for (const p of staged) {
  const hit = PRIVATE.find(([test]) => test(p));
  if (hit) problems.push(`${p}: ${hit[1]}`);
}
for (const p of staged.filter((f) => f.endsWith('.js'))) {
  let src = git(['show', `:${p}`]).toString('utf8');
  if (src.startsWith('#!')) src = `//${src.slice(2)}`;
  try {
    vm.compileFunction(src, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: p });
  } catch (err) {
    problems.push(`${p}: does not parse: ${err.message}`);
  }
}
if (staged.some((p) => /^\.(agents|claude)\/(skills|agents)\/|^\.(github|codex)\/agents\//.test(p))) {
  const { drift, stray } = require('../ai-sync').compare();
  for (const f of [...drift, ...stray]) problems.push(`${f}: not what .agents/ generates (run node scripts/ai-sync.js)`);
}
if (problems.length) {
  process.stderr.write(`pre-commit: refused\n${problems.map((x) => `  ${x}`).join('\n')}\nUnstage with: git restore --staged <path>\n`);
  process.exit(1);
}
