'use strict';
// Project policy: what one repository adds to the shared charters and
// checklist. It lives in config/projects/<owner>/<name>/, written by people,
// and is never read from the reviewed checkout: there the PR author controls
// every file.
//   checklist.md  viewpoints "- PRJ-<AREA>-<n>: text", each with an indented
//                 "- source:" (where the rule comes from: path:line, ADR,
//                 incident) and optionally "- paths:" (globs) and "- lines:"
//                 (/regex/flags over changed lines) saying when it applies.
//                 Cited as curated_viewpoint authority like CK-* items.
//   profile.md    context for reviewers: glossary, architecture, hot spots.
//                 Frozen and shown to every worker, never authority.
// A malformed checklist stops the review: a viewpoint silently dropped
// would be a blind spot nobody sees.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./util');
const git = require('./git');

const ITEM = /^-\s*(PRJ-[A-Z]+-[0-9]+):\s*(\S.*)$/;
const SUB = /^\s+-\s*([a-z]+):\s*(.*)$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

function projectsDir() {
  return process.env.ARW_PROJECTS_DIR ? path.resolve(process.env.ARW_PROJECTS_DIR) : path.join(ROOT, 'config', 'projects');
}

function projectDir(repo) {
  const parts = String(repo || '').split('/');
  if (parts.length !== 2 || parts.some((p) => !NAME.test(p) || /^\.+$/.test(p))) throw new Error(`bad repository name ${JSON.stringify(repo)}: expected owner/name`);
  return path.join(projectsDir(), ...parts.map((p) => p.toLowerCase()));
}

// "**" spans folders, "*" and "?" stay within one.
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function parseChecklist(text) {
  const items = [];
  const errors = [];
  let current = null;
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const at = `line ${i + 1}`;
    const sub = line.match(SUB);
    if (sub) {
      const [, key, value] = sub;
      if (!current) return errors.push(`${at}: "${key}:" outside a viewpoint`);
      if (key === 'source') current.source = value.trim();
      else if (key === 'paths') current.paths = value.split(',').map((g) => g.trim()).filter(Boolean);
      else if (key === 'lines') {
        const m = value.trim().match(/^\/(.+)\/([imsu]*)$/);
        if (!m) errors.push(`${current.id}: lines must be written /regex/flags`);
        else {
          try {
            current.lines = new RegExp(m[1], m[2]);
          } catch (err) {
            errors.push(`${current.id}: bad lines regex: ${err.message}`);
          }
        }
      } else errors.push(`${current.id}: unknown key "${key}" (source, paths, lines)`);
      return undefined;
    }
    if (!/^-/.test(line)) {
      if (line.trim() && !/^\s*#/.test(line) && current && /^\s/.test(line)) current.text += ` ${line.trim()}`;
      return undefined;
    }
    const m = line.match(ITEM);
    if (!m) {
      current = null;
      return errors.push(`${at}: only PRJ-<AREA>-<n> viewpoints belong here ("- PRJ-PAY-1: text"); shared ones go in config/policies/checklist.md`);
    }
    if (items.some((x) => x.id === m[1])) errors.push(`duplicate id ${m[1]}`);
    current = { id: m[1], text: m[2].trim(), source: '', paths: [], lines: null };
    items.push(current);
    return undefined;
  });
  for (const item of items) {
    if (!item.source) errors.push(`${item.id}: needs a "source:" line (path:line, ADR or incident it comes from)`);
    item.pathRes = item.paths.map(globRegex);
  }
  return { items, errors };
}

// null when the repository has no project folder.
function loadProject(repo) {
  const dir = projectDir(repo);
  if (!fs.existsSync(dir)) return null;
  const read = (name) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const checklist = read('checklist.md');
  const profile = read('profile.md');
  const { items, errors } = parseChecklist(checklist);
  if (errors.length) throw new Error(`project policy for ${repo} (${dir}) is invalid:\n- ${errors.join('\n- ')}\nFix it, then run: arw project check ${repo}`);
  const inputs = [];
  if (checklist != null) inputs.push({ id: 'policy-project-checklist', kind: 'policy', content: checklist });
  if (profile != null) inputs.push({ id: 'project-profile', kind: 'project', content: profile });
  return { repo, dir, inputs, rules: items };
}

const CHECKLIST_TEMPLATE = (repo) => `# Project checklist: ${repo}

Viewpoints only this repository needs. Each one says where it comes from
(source) and, optionally, when the runtime asks it: paths (globs, "**" spans
folders) and lines (/regex/flags over the changed lines). With neither, it
is asked for every changed non-test source file.
Add one when an eval or a kept finding shows a defect the shared checklist
misses, and add that case to the eval corpus.

## Example (replace)
- PRJ-GEN-1: Every public endpoint checks the caller's tenant before reading data.
  - source: docs/architecture.md:1
  - paths: src/**
  - lines: /@(Get|Post|Put|Delete|Patch)Mapping/
`;

const PROFILE_TEMPLATE = (repo) => `# ${repo}

Context for reviewers. Never authority: a finding cannot cite this file.
Keep it short; every claim with where it comes from.

## Domain glossary

## Architecture and invariants

## Hot spots
`;

function initProject(repo) {
  const dir = projectDir(repo);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'checklist.md'), CHECKLIST_TEMPLATE(repo));
  fs.writeFileSync(path.join(dir, 'profile.md'), PROFILE_TEMPLATE(repo));
  return dir;
}

// Parse errors, plus warnings for path:line sources that HEAD of the
// checkout does not have (a cite may go stale; that is for a person to fix,
// not a reason to stop reviews).
function checkProject(repo, { checkout = null } = {}) {
  const dir = projectDir(repo);
  if (!fs.existsSync(dir)) return { dir, errors: [`no project folder ${dir} (arw project init ${repo})`], warnings: [], items: [] };
  const file = path.join(dir, 'checklist.md');
  const { items, errors } = parseChecklist(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const warnings = [];
  if (checkout) {
    for (const item of items) {
      const m = item.source.match(/^([\w./-]+\.[\w]+)(?::(\d+))?$/);
      if (!m) continue;
      const text = git.git(checkout, ['show', `HEAD:${m[1]}`], { allowFail: true });
      if (text == null) {
        warnings.push(`${item.id}: source ${m[1]} is not in ${checkout} at HEAD`);
        continue;
      }
      const count = text.replace(/\n$/, '').split('\n').length;
      if (m[2] && Number(m[2]) > count) warnings.push(`${item.id}: source ${m[1]} has ${count} lines, not ${m[2]}`);
    }
  }
  return { dir, errors, warnings, items };
}

module.exports = { projectsDir, projectDir, parseChecklist, loadProject, initProject, checkProject, globRegex };
