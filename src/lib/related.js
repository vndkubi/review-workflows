'use strict';
// Related repositories (BFF, shared libraries, other services, apps) that a
// review reads but never reviews. Each is read at one revision: the ref the
// team pins in config/repos.json ("related": [{ "repo": "acme/bff", "ref":
// "v1.4.0" }]), or its checkout's HEAD. The revision is resolved to a sha and
// frozen with the context, so a quote from that repository is checked
// against the same code the reviewer read, whatever its checkout holds later.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

// entries: "owner/name" | absolute path | { repo | path, ref }.
// repos: configured repositories ({ "owner/name": { checkout } }).
// Returns [{ name, dir, ref?, sha }] or [{ name, error }] per entry.
function resolveRelated(entries, repos = {}) {
  return (entries || []).map((entry) => {
    const spec = typeof entry === 'string' ? (path.isAbsolute(entry) ? { path: entry } : { repo: entry }) : entry || {};
    let name;
    let dir;
    if (spec.repo) {
      name = spec.repo;
      dir = repos[spec.repo] && repos[spec.repo].checkout;
    } else if (spec.path && path.isAbsolute(spec.path)) {
      name = spec.name || path.basename(spec.path);
      dir = spec.path;
    }
    if (!name) return { name: String(entry), error: `${JSON.stringify(entry)}: give "owner/name", an absolute path, or { "repo" | "path", "ref" }` };
    if (!dir || !fs.existsSync(dir)) return { name, error: `${name}: not a configured repository with a checkout, nor an existing directory` };
    const ref = spec.ref || 'HEAD';
    const sha = String(git.git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) || '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { name, error: `${name}: ref "${ref}" does not resolve in its checkout` };
    return { name, dir, ...(spec.ref ? { ref: spec.ref } : {}), sha };
  });
}

// Source files of a related repository at its frozen revision.
function filesAt(dir, sha, re = /\.(java|py)$/, max = Infinity) {
  const all = String(git.git(dir, ['ls-tree', '-r', '--name-only', sha], { allowFail: true }) || '').split('\n').filter((f) => f && re.test(f));
  return all.slice(0, max);
}

module.exports = { resolveRelated, filesAt };
