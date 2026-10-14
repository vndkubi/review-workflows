'use strict';
// Dashboard endpoints for the sandbox: discovery, build graph, verification
// records and their evidence, and bootstrap as a queued CLI job. Only
// configured repositories are accepted; record files are served only when
// the record lists them.
const fs = require('node:fs');
const path = require('node:path');
const { reposConfig } = require('../lib/github');
const data = require('./data');

const MAX_FILE = 512 * 1024;

function configured() {
  return Object.entries(reposConfig().repos || {}).map(([name, r]) => ({ name, checkout: r.checkout || null, exists: Boolean(r.checkout && fs.existsSync(r.checkout)) }));
}

function repoOrThrow(name) {
  const r = configured().find((x) => x.name === name);
  if (!r) throw data.httpError(404, `${name} is not a configured repository`);
  if (!r.exists) throw data.httpError(400, `the checkout of ${name} does not exist`);
  return r;
}

const REV = /^[A-Za-z0-9._/-]{1,100}$/;

// An absolute path to a git checkout.
function sourceDir(raw) {
  const dir = String(raw || '').trim();
  if (!dir || !path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) throw data.httpError(400, 'dir must be an absolute path to a git repository');
  if (!fs.existsSync(dir) || !require('../lib/git').git(dir, ['rev-parse', '--git-dir'], { allowFail: true })) throw data.httpError(400, `${dir} is not a git repository`);
  return path.resolve(dir);
}

function recordSummary(r) {
  return { fingerprint: r.fingerprint, repo: r.repo, revision: r.revision, status: r.status, reason: r.reason || null, image: r.image, at: r.at, elapsed_ms: r.elapsed_ms, tests: r.tests || null, artifacts: (r.artifacts || []).length, inputs: r.inputs || [] };
}

function routes({ queue }) {
  const b = () => require('../lib/bootstrap');
  const discovery = () => require('../lib/discovery');
  return [
    ['GET', /^\/api\/sandbox$/, () => {
      const sandbox = require('../lib/sandbox');
      const records = b().listRecords();
      const latest = {};
      for (const r of records) latest[r.repo] = recordSummary(r);
      return { mode: sandbox.mode(), manifest: sandbox.manifest(), docker: sandbox.daemonError(), home: b().home(), repos: configured().map((r) => ({ ...r, latest: latest[r.name] || null })) };
    }],
    ['GET', /^\/api\/sandbox\/discover$/, (m, q) => {
      const r = repoOrThrow(String(q.get('repo') || ''));
      const rev = String(q.get('rev') || 'HEAD');
      if (!REV.test(rev)) throw data.httpError(400, 'bad revision');
      try {
        return discovery().discoverRepo({ checkout: r.checkout, rev, repo: r.name });
      } catch (err) {
        throw data.httpError(400, err.message);
      }
    }],
    ['GET', /^\/api\/sandbox\/graph$/, () => {
      const discs = [];
      const skipped = [];
      for (const r of configured().filter((x) => x.exists)) {
        try {
          discs.push(discovery().discoverRepo({ checkout: r.checkout, repo: r.name }));
        } catch (err) {
          skipped.push({ repo: r.name, error: err.message });
        }
      }
      return { ...require('../lib/build-graph').buildGraph(discs), skipped };
    }],
    ['GET', /^\/api\/sandbox\/records$/, () => b().listRecords().reverse().map(recordSummary)],
    ['GET', /^\/api\/sandbox\/records\/([0-9a-f]{24})$/, (m) => {
      const rec = b().listRecords().find((r) => r.fingerprint === m[1]);
      if (!rec) throw data.httpError(404, 'no such record');
      return { ...rec, intact: Boolean(b().loadRecord(m[1])) };
    }],
    ['GET', /^\/api\/sandbox\/records\/([0-9a-f]{24})\/file$/, (m, q) => {
      const rec = b().listRecords().find((r) => r.fingerprint === m[1]);
      const rel = String(q.get('path') || '');
      const entry = rec && [...(rec.evidence || []), ...(rec.artifacts || [])].find((e) => e.path === rel);
      if (!entry || !/\.(log|xml|pom)$/.test(rel)) throw data.httpError(404, 'not a file of this record');
      const abs = path.join(b().home(), 'records', m[1], ...rel.split('/'));
      const buf = fs.readFileSync(abs);
      return { path: rel, size: buf.length, truncated: buf.length > MAX_FILE, text: buf.subarray(Math.max(0, buf.length - MAX_FILE)).toString('utf8') };
    }],
    // A source folder anywhere on this machine: detect what it needs (git
    // objects only, nothing runs). POST, so it needs the page's token.
    ['POST', /^\/api\/sandbox\/detect$/, (m, q, body) => {
      const dir = sourceDir(body.dir);
      const configuredAs = configured().find((r) => r.checkout && path.resolve(r.checkout).toLowerCase() === path.resolve(dir).toLowerCase());
      const name = configuredAs ? configuredAs.name : discovery().suggestName(dir);
      try {
        return { dir, configured_as: configuredAs ? configuredAs.name : null, suggested_name: name, discovery: discovery().discoverRepo({ checkout: dir, repo: name }) };
      } catch (err) {
        throw data.httpError(400, err.message);
      }
    }],
    // One step: detect, pull the images, build and test it and what it needs.
    ['POST', /^\/api\/sandbox\/setup$/, (m, q, body) => {
      let target;
      const args = ['sandbox', 'setup'];
      if (body.repo) {
        target = repoOrThrow(String(body.repo)).name;
        args.push(target);
      } else {
        const dir = sourceDir(body.dir);
        const configuredAs = configured().find((r) => r.checkout && path.resolve(r.checkout).toLowerCase() === path.resolve(dir).toLowerCase());
        if (configuredAs) {
          target = configuredAs.name;
          args.push(target);
        } else if (body.register) {
          const name = String(body.name || '').trim();
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) throw data.httpError(400, 'name must be owner/repository');
          if (configured().some((r) => r.name === name)) throw data.httpError(409, `${name} is already configured for another folder`);
          target = name;
          args.push(dir, '--register', '--name', name);
        } else {
          target = path.basename(dir);
          args.push(dir);
        }
      }
      if (body.force) args.push('--force');
      return queue.enqueue({ kind: 'setup', title: target, args, target: { type: 'sandbox', id: 'sandbox' } });
    }],
    ['POST', /^\/api\/sandbox\/bootstrap$/, (m, q, body) => {
      const repos = Array.isArray(body.repos) ? body.repos.map(String) : [];
      if (!repos.length) throw data.httpError(400, 'repos: a list of configured repositories');
      const targets = repos.map((spec) => {
        const at = spec.lastIndexOf('@');
        const [name, rev] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, null];
        repoOrThrow(name);
        if (rev != null && !REV.test(rev)) throw data.httpError(400, `bad revision in ${spec}`);
        return rev ? `${name}@${rev}` : name;
      });
      const args = ['sandbox', 'bootstrap', ...targets];
      if (body.force) args.push('--force');
      if (body.allowTestFailures) args.push('--allow-test-failures');
      return queue.enqueue({ kind: 'bootstrap', title: targets.join(', '), args, target: { type: 'sandbox', id: 'sandbox' } });
    }],
  ];
}

module.exports = { routes };
