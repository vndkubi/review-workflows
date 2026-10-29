'use strict';
// Skills and agents are written once, in .agents/, and copied or rendered
// for each tool:
// - .agents/skills/<name>/ is read as is by codex and Copilot; Claude Code
//   reads only .claude/skills/, so each skill is copied there byte for byte
//   (Copilot keeps the .agents copy when the names match).
// - .agents/agents/<name>.md (frontmatter name and description, body = the
//   charter) is read by no tool: it is rendered to .claude/agents/<name>.md,
//   .github/agents/<name>.agent.md and .codex/agents/<name>.toml, each
//   made read-only as far as that tool allows (see render below). Copilot also
//   reads .claude/agents/ and keeps the .github one when the names match.
//   node scripts/ai-sync.js          write every copy
//   node scripts/ai-sync.js --check  exit 1 when a copy is missing or differs
// A skill or agent in the tool folders with no source is reported, never
// deleted: it may be someone's own.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, '.agents', 'skills');
const TARGET = path.join(ROOT, '.claude', 'skills');
const AGENTS = path.join(ROOT, '.agents', 'agents');
const AGENT_DIRS = { claude: '.claude/agents', copilot: '.github/agents', codex: '.codex/agents' };
const AGENT_FILE = { claude: (n) => `${n}.md`, copilot: (n) => `${n}.agent.md`, codex: (n) => `${n}.toml` };

function files(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]);
}

function parseAgent(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const field = (k) => (m[1].match(new RegExp(`^${k}: (.+)$`, 'm')) || [])[1];
  const name = field('name');
  const description = field('description');
  if (!name || !description) throw new Error(`${file}: frontmatter needs name and description`);
  return { name, description, body: m[2] };
}

const yamlString = (s) => JSON.stringify(s);
const note = (name) => `<!-- Generated from .agents/agents/${name}.md by scripts/ai-sync.js: edit the source. -->`;

// Read-only in each tool's terms:
// - Claude: no edit tools, and Bash only through the read-only list of
//   scripts/hooks/readonly-bash.js (a PreToolUse hook in the frontmatter).
// - Copilot: read and search tools only; custom agents have no hook to
//   narrow a shell, so they get none.
// - codex: nothing yet. codex 0.163 runs a role with its parent's sandbox:
//   with sandbox_mode = "read-only" in the role file, the rollout of the
//   spawned impact-analyst still recorded sandbox_policy workspace-write. So
//   the file sets no sandbox_mode it would ignore; the charter is the only
//   guard there until a codex hook (whose payload names the agent_type) is in.
function render(tool, a) {
  if (tool === 'claude') {
    return `---\nname: ${a.name}\ndescription: ${yamlString(a.description)}\ntools: Read, Grep, Glob, Bash\ndisallowedTools: Edit, Write, NotebookEdit\nhooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: 'node "$CLAUDE_PROJECT_DIR/scripts/hooks/readonly-bash.js"'\n---\n\n${note(a.name)}\n\n${a.body}`;
  }
  if (tool === 'copilot') {
    return `---\nname: ${a.name}\ndescription: ${yamlString(a.description)}\ntools: ["read", "search"]\n---\n\n${note(a.name)}\n\n${a.body}\n## Here\nYou have no shell in this tool. Where these steps run a command, name it for the caller to run\nand go on with what you can read.\n`;
  }
  if (a.body.includes("'''")) throw new Error(`${a.name}: the body may not contain ''' (TOML literal string)`);
  return `# Generated from .agents/agents/${a.name}.md by scripts/ai-sync.js: edit the source.\nname = ${JSON.stringify(a.name)}\ndescription = ${JSON.stringify(a.description)}\ndeveloper_instructions = '''\n${a.body}'''\n`;
}

// Repository-relative path -> the content it must have.
function expected() {
  const out = new Map();
  for (const f of files(SOURCE)) out.set(`.claude/skills/${f}`, fs.readFileSync(path.join(SOURCE, f)));
  for (const f of files(AGENTS).filter((x) => x.endsWith('.md') && !x.includes('/'))) {
    const a = parseAgent(path.join(AGENTS, f));
    if (`${a.name}.md` !== f) throw new Error(`.agents/agents/${f}: name ${a.name} differs from the file name`);
    for (const tool of Object.keys(AGENT_DIRS)) out.set(`${AGENT_DIRS[tool]}/${AGENT_FILE[tool](a.name)}`, Buffer.from(render(tool, a)));
  }
  return out;
}

function compare() {
  const want = expected();
  const drift = [...want].filter(([rel, buf]) => !fs.existsSync(path.join(ROOT, rel)) || !fs.readFileSync(path.join(ROOT, rel)).equals(buf)).map(([rel]) => rel);
  // Stray: a file inside a managed skill folder that the source no longer has.
  const skillNames = new Set(files(SOURCE).map((f) => f.split('/')[0]));
  const present = files(TARGET).map((f) => `.claude/skills/${f}`);
  const stray = present.filter((rel) => skillNames.has(rel.split('/')[2]) && !want.has(rel));
  const unmanaged = [...new Set(present.map((rel) => rel.split('/')[2]))].filter((n) => !skillNames.has(n)).map((n) => `.claude/skills/${n}`);
  for (const dir of Object.values(AGENT_DIRS)) {
    for (const f of files(path.join(ROOT, dir)).filter((x) => !x.includes('/'))) if (!want.has(`${dir}/${f}`)) unmanaged.push(`${dir}/${f}`);
  }
  return { src: [...want.keys()], drift, stray, unmanaged };
}

function sync() {
  const want = expected();
  const { drift, stray } = compare();
  for (const rel of drift) {
    fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, rel), want.get(rel));
  }
  for (const rel of stray) fs.unlinkSync(path.join(ROOT, rel));
  return { copied: drift, removed: stray };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const before = compare();
  if (before.unmanaged.length) console.log(`not from .agents/ (left alone): ${before.unmanaged.join(', ')}`);
  if (check) {
    const bad = [...before.drift.map((f) => `missing or different: ${f}`), ...before.stray.map((f) => `no source: ${f}`)];
    if (bad.length) {
      console.error(`${bad.join('\n')}\nrun: node scripts/ai-sync.js`);
      process.exit(1);
    }
    console.log(`skill and agent copies match .agents/ (${before.src.length} files)`);
  } else {
    const { copied, removed } = sync();
    console.log(`wrote ${copied.length}, removed ${removed.length}; ${before.src.length} files in sync`);
  }
}

module.exports = { compare, sync, render, parseAgent, SOURCE, TARGET, AGENTS };
