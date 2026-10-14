'use strict';
// Bootstrap: build and test repositories in containers, in dependency
// order, and keep what was verified so the next run can reuse it.
//
// Per repository (a node of the build graph), in a fresh task directory:
//   1. source snapshot of the exact revision (git archive: no .git, no links);
//   2. resolve, WITH network: Maven fills this repository's dependency cache
//      (one test class per module runs, so test providers are fetched too;
//      nothing is installed). It runs the revision's build plugins with
//      network, so it is only for revisions you trust (yours, a base branch);
//      it is skipped when the same build files were resolved before;
//   3. build and test, WITHOUT network: `mvn -o install` into a task-private
//      local repository, reading the cache and the artifacts staged from the
//      repositories it depends on read-only (maven.repo.local.tail);
//   4. the produced artifacts (jar, pom, ...) are copied out of the task,
//      hashed, and stored with a verification record: status from the exit
//      code and the JUnit reports, logs and reports hashed as evidence.
//
// A record is keyed by a fingerprint of everything that decides the result:
// source tree, recipe (image id, commands), the digests of the artifacts it
// consumed, the execution policy. Same fingerprint and intact artifacts:
// reused, nothing runs. A consumer runs only when every repository it
// depends on has a usable record; otherwise it is BLOCKED, with the reason.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256, sha256Value, writeJsonAtomic, readJsonIfExists, nowIso, ensureDir } = require('./util');
const git = require('./git');
const confine = require('./confine');
const { snapshot } = require('./snapshot');
const { parseCases } = require('./impacted-tests');
const { buildGraph } = require('./build-graph');

const RECIPE_VERSION = 'maven-bootstrap/1';

function home() {
  return process.env.ARW_SANDBOX_HOME ? path.resolve(process.env.ARW_SANDBOX_HOME) : path.join(require('./runs').RUNS, 'sandbox');
}

const keyOf = (repo) => String(repo).replace(/[^A-Za-z0-9_.-]+/g, '__');

// Statuses a consumer may build on.
const USABLE = new Set(['TESTS_PASSED', 'ARTIFACT_BUILT']);

function imageIdOf(image) {
  const { execFileSync } = require('node:child_process');
  const bin = process.env.ARW_DOCKER || 'docker';
  try {
    return execFileSync(bin, ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

// One test class per module (surefire fetches its test provider only when
// it runs a test), by simple name.
function probeTests(snapshotFiles, modules) {
  const names = new Set();
  for (const m of modules) {
    const prefix = m.path ? `${m.path}/src/test/java/` : 'src/test/java/';
    const hit = snapshotFiles.find((f) => f.startsWith(prefix) && /\/(Test\w*|\w*(Test|Tests|TestCase))\.java$/.test(f));
    if (hit) names.add(path.posix.basename(hit, '.java'));
  }
  return [...names].sort();
}

function recipeFor(disc, { image, staged, probes }) {
  const tail = staged ? ['/staged'] : [];
  return {
    version: RECIPE_VERSION,
    toolchain: 'maven',
    image,
    resolve: ['mvn', '-B', '-q', '-Dmaven.repo.local=/m2', ...(tail.length ? [`-Dmaven.repo.local.tail=${tail.join(',')}`] : []), `-Dtest=${probes.length ? probes.join(',') : 'ArwNoTests'}`, '-Dsurefire.failIfNoSpecifiedTests=false', '-DfailIfNoTests=false', '-Dmaven.install.skip=true', 'install'],
    // Test failures do not stop the install: the record keeps "the artifact
    // built" apart from "its tests passed".
    build: ['mvn', '-B', '-o', '-Dmaven.repo.local=/m2', `-Dmaven.repo.local.tail=${[...tail, '/m2cache'].join(',')}`, '-Dmaven.test.failure.ignore=true', 'install'],
  };
}

// Files under dir (relative, posix), not following links.
function walk(root, dir = root, out = []) {
  for (const name of dir === root ? fs.readdirSync(root) : confine.listConfined(root, dir)) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

function gavDir(g, a, v) {
  return path.join(...g.split('.'), a, v);
}

// ---------- the registry ----------
function recordFile(fp) {
  return path.join(home(), 'records', `${fp}.json`);
}

// Outcomes the same inputs reproduce. An environment problem (no docker, no
// network, a timeout) is not: it is never reused.
const REUSABLE = new Set(['TESTS_PASSED', 'ARTIFACT_BUILT', 'TESTS_FAILED', 'BUILD_FAILED']);

// A reusable record whose stored files still have their hashes, or null.
function loadRecord(fp) {
  const rec = readJsonIfExists(recordFile(fp));
  if (!rec || rec.fingerprint !== fp || !REUSABLE.has(rec.status)) return null;
  const dir = path.join(home(), 'records', fp);
  for (const f of [...(rec.artifacts || []), ...(rec.evidence || [])]) {
    const abs = path.join(dir, ...f.path.split('/'));
    if (!fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== f.sha256) return null;
  }
  return rec;
}

function listRecords() {
  const dir = path.join(home(), 'records');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJsonIfExists(path.join(dir, n))).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// ---------- one repository ----------
// disc: its DiscoveryResult; inputs: [{ repo, record }] of what it consumes.
async function bootstrapNode({ disc, inputs = [], image = null, runner, imageId = imageIdOf, force = false, keep = false, timeoutMs = 30 * 60 * 1000, log = () => {} }) {
  const started = Date.now();
  const base = { repo: disc.repo, revision: disc.revision };
  if (!disc.build_systems.includes('maven')) return { ...base, status: 'ENVIRONMENT_BLOCKED', reason: disc.build_systems.length ? `bootstrap supports Maven only (found ${disc.build_systems.join(', ')})` : 'no build system found' };
  image = image || (disc.proposal && disc.proposal.image);
  if (!image) return { ...base, status: 'ENVIRONMENT_BLOCKED', reason: 'Java version unknown and no --image given' };
  const id = imageId(image);
  if (!id) return { ...base, status: 'ENVIRONMENT_BLOCKED', reason: `image ${image} is not available locally (docker pull it first)` };

  const tree = git.git(disc.checkout, ['rev-parse', `${disc.revision}^{tree}`]).trim();
  const staged = inputs.flatMap((i) => i.record.artifacts.map((a) => ({ repo: i.repo, path: a.path, sha256: a.sha256 })));
  const files = git.git(disc.checkout, ['ls-tree', '-r', '--name-only', '-z', disc.revision]).split('\0').filter(Boolean);
  const recipe = recipeFor(disc, { image, staged: staged.length > 0, probes: probeTests(files, disc.modules) });
  const policy = { build_network: 'none', resolve_network: process.env.ARW_SANDBOX_RESOLVE_NETWORK || 'bridge', memory: process.env.ARW_SANDBOX_MEMORY || '4g', cpus: process.env.ARW_SANDBOX_CPUS || '2' };
  const fingerprint = sha256Value({ tree, recipe, image_id: id, staged, policy });
  const fp = fingerprint.slice(0, 24);
  ensureDir(path.join(home(), 'locks'));
  // One build per key at a time: a second request waits for the record.
  const { acquireLockFile } = require('./driver');
  let release;
  for (let i = 0; ; i += 1) {
    const cached = !force && loadRecord(fp);
    if (cached) {
      log(`${disc.repo}: reused ${cached.status} record ${fp}`);
      return { ...cached, cache: 'hit' };
    }
    try {
      release = acquireLockFile(path.join(home(), 'locks', `${fp}.lock`), 'bootstrap');
      break;
    } catch (err) {
      if (i >= 360) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const task = path.join(home(), 'tasks', `${keyOf(disc.repo)}-${fp.slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}`);
  const recDir = path.join(home(), 'records', fp);
  try {
    fs.rmSync(recDir, { recursive: true, force: true });
    ensureDir(recDir);
    const evidence = [];
    const keepFile = (rel, content) => {
      const abs = path.join(recDir, ...rel.split('/'));
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, content);
      evidence.push({ path: rel, sha256: sha256(content) });
    };
    const finish = (fields) => {
      const rec = { schema_version: '1.0', fingerprint: fp, ...base, tree, image, image_id: id, recipe, policy, inputs: inputs.map((i) => ({ repo: i.repo, fingerprint: i.record.fingerprint, status: i.record.status })), staged, at: nowIso(), elapsed_ms: Date.now() - started, artifacts: [], evidence, ...fields };
      writeJsonAtomic(recordFile(fp), rec);
      return { ...rec, cache: 'miss' };
    };

    // 1. Source snapshot.
    const snap = snapshot(disc.checkout, disc.revision, path.join(task, 'src'));
    const notes = snap.skipped.length ? [`${snap.skipped.length} archive entries not extracted (${[...new Set(snap.skipped.map((s) => s.why))].join(', ')})`] : [];
    // Artifacts it consumes, copied from verified records into a read-only tree.
    const stagedDir = path.join(task, 'staged');
    for (const i of inputs) {
      for (const a of i.record.artifacts) {
        const from = path.join(home(), 'records', i.record.fingerprint, ...a.path.split('/'));
        const bytes = fs.readFileSync(from);
        if (sha256(bytes) !== a.sha256) return finish({ status: 'BLOCKED', reason: `${i.repo} artifact ${a.path} changed since it was verified` });
        const to = path.join(stagedDir, ...a.path.split('/').slice(1)); // drop the leading "artifacts/"
        ensureDir(path.dirname(to));
        fs.writeFileSync(to, bytes, { flag: 'wx' });
      }
    }
    const mounts = (extra) => [...(staged.length ? [{ host: stagedDir, container: '/staged', readonly: true }] : []), ...extra];
    const cache = ensureDir(path.join(home(), 'm2-cache', keyOf(disc.repo)));

    // 2. Resolve (network), unless these build files were resolved before.
    //    Staged POMs count (they bring transitive dependencies), jars do not.
    const buildFiles = files.filter((f) => /(^|\/)pom\.xml$|^\.mvn\//.test(f));
    const resolveKey = sha256Value({ files: buildFiles.map((f) => [f, sha256(fs.readFileSync(path.join(task, 'src', ...f.split('/'))))]), image_id: id, staged: staged.filter((a) => a.path.endsWith('.pom')), recipe: recipe.resolve });
    const resolvedFile = path.join(cache, '.arw-resolved.json');
    const resolved = readJsonIfExists(resolvedFile, { keys: [] });
    const runStep = async (step, argv, network, stepMounts) => {
      const logFile = path.join(task, `${step}.log`);
      const res = await runner({ command: argv.join(' '), argv, cwd: path.join(task, 'src'), logFile, timeoutMs, toolchain: 'maven', image, network, mounts: mounts(stepMounts) });
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile) : Buffer.from('');
      keepFile(`logs/${step}.log`, Buffer.concat([text, Buffer.from(`\n[arw] exit_code=${res.exit_code} timed_out=${Boolean(res.timed_out)} spawn_error=${JSON.stringify(res.spawn_error || null)}\n`)]));
      log(`${disc.repo}: ${step} exit ${res.exit_code}${res.timed_out ? ' (timed out)' : ''} in ${Math.round((res.elapsed_ms || 0) / 1000)} s`);
      return { ...res, log: text.toString('utf8') };
    };
    const blocked = (res, step) => (res.spawn_error ? `${step}: ${res.spawn_error}` : res.timed_out ? `${step}: timed out` : null);
    let resolveStep = 'skipped (resolved before)';
    if (!resolved.keys.includes(resolveKey)) {
      const releaseCache = acquireLockFile(path.join(cache, '.arw-cache.lock'), 'resolve');
      try {
        const res = await runStep('resolve', recipe.resolve, policy.resolve_network, [{ host: cache, container: '/m2' }]);
        const why = blocked(res, 'resolve');
        if (why) return finish({ status: 'ENVIRONMENT_BLOCKED', reason: why, notes });
        if (res.exit_code !== 0) return finish({ status: 'RESOLVE_FAILED', reason: 'dependency resolution failed (see logs/resolve.log)', notes });
        writeJsonAtomic(resolvedFile, { keys: [...resolved.keys, resolveKey].slice(-50) });
        resolveStep = 'ran';
      } finally {
        releaseCache();
      }
    }

    // 3. Build and test, offline.
    const taskM2 = ensureDir(path.join(task, 'm2'));
    const res = await runStep('build', recipe.build, 'none', [{ host: cache, container: '/m2cache', readonly: true }, { host: taskM2, container: '/m2' }]);
    const why = blocked(res, 'build');
    if (why) return finish({ status: 'ENVIRONMENT_BLOCKED', reason: why, resolve: resolveStep, notes });
    // JUnit reports, read without following links (the build is the repository's code).
    const srcRoot = path.join(task, 'src');
    const reports = walk(srcRoot).filter((f) => /(^|\/)target\/surefire-reports\/TEST-[^/]+\.xml$/.test(f));
    const cases = [];
    for (const r of reports) {
      const xml = confine.readConfined(srcRoot, path.join(srcRoot, ...r.split('/')));
      if (xml == null) continue;
      keepFile(`reports/${r}`, xml);
      cases.push(...parseCases(xml));
    }
    const tests = { total: cases.length, failed: cases.filter((c) => c.status === 'fail').length, errors: cases.filter((c) => c.status === 'error').length, skipped: cases.filter((c) => c.status === 'skipped').length };
    tests.failing = cases.filter((c) => c.status === 'fail' || c.status === 'error').slice(0, 10).map((c) => `${c.classname}.${c.name}: ${c.message || ''}`.slice(0, 300));
    if (res.exit_code !== 0) {
      // Offline and something missing: the cache is incomplete, not the build broken.
      if (/has not been downloaded from it before|in offline mode/.test(res.log)) return finish({ status: 'RESOLUTION_INCOMPLETE', reason: 'the offline build needed an artifact the resolve step did not fetch (see logs/build.log)', resolve: resolveStep, tests, notes });
      return finish({ status: 'BUILD_FAILED', reason: 'the build failed (see logs/build.log)', resolve: resolveStep, tests, notes });
    }

    // 4. Produced artifacts, out of the task's local repository.
    const artifacts = [];
    const missing = [];
    for (const p of disc.produces) {
      if (!p.groupId || !p.artifactId || !p.version || /\$\{/.test(`${p.groupId}${p.version}`)) {
        missing.push(`${p.groupId}:${p.artifactId}:${p.version} (coordinates not resolved)`);
        continue;
      }
      const dir = path.join(taskM2, gavDir(p.groupId, p.artifactId, p.version));
      const names = confine.listConfined(taskM2, dir).filter((n) => n.startsWith(`${p.artifactId}-`) || n === 'maven-metadata-local.xml');
      if (!names.some((n) => n.endsWith('.pom'))) {
        missing.push(`${p.groupId}:${p.artifactId}:${p.version}`);
        continue;
      }
      for (const n of names.sort()) {
        const bytes = confine.readConfined(taskM2, path.join(dir, n), { encoding: null });
        if (bytes == null) continue;
        const rel = ['artifacts', ...p.groupId.split('.'), p.artifactId, p.version, n].join('/');
        const abs = path.join(recDir, ...rel.split('/'));
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, bytes);
        artifacts.push({ path: rel, sha256: sha256(bytes), size: bytes.length });
      }
    }
    if (missing.length) notes.push(`not installed: ${missing.join(', ')}`);
    const status = tests.failed + tests.errors > 0 ? 'TESTS_FAILED' : tests.total > 0 ? 'TESTS_PASSED' : 'ARTIFACT_BUILT';
    return finish({ status, resolve: resolveStep, tests, artifacts, notes });
  } finally {
    release();
    if (!keep) fs.rmSync(task, { recursive: true, force: true });
  }
}

// ---------- a graph of repositories ----------
// discoveries: DiscoveryResult[]. Builds in order; a repository whose
// dependencies have no usable record is BLOCKED and does not run.
async function bootstrapGraph({ discoveries, runner = null, images = {}, allowTestFailures = false, force = false, keep = false, imageId, log = () => {} }) {
  runner = runner || require('./sandbox').dockerRunner;
  const graph = buildGraph(discoveries);
  if (graph.problems.length) return { graph, results: [], status: 'BLOCKED', reason: graph.problems.map((p) => p.detail).join('; ') };
  const byRepo = new Map(discoveries.map((d) => [d.repo, d]));
  const usable = new Set(allowTestFailures ? [...USABLE, 'TESTS_FAILED'] : USABLE);
  const done = new Map();
  const results = [];
  for (const repo of graph.order) {
    const node = graph.nodes.find((n) => n.repo === repo);
    const bad = node.depends_on.filter((d) => !done.has(d) || !usable.has(done.get(d).status));
    let result;
    if (bad.length) {
      result = { repo, revision: byRepo.get(repo).revision, status: 'BLOCKED', reason: bad.map((d) => `${d}: ${done.has(d) ? done.get(d).status : 'not built'}`).join('; ') };
      log(`${repo}: BLOCKED (${result.reason})`);
    } else {
      const inputs = node.depends_on.map((d) => ({ repo: d, record: done.get(d) }));
      result = await bootstrapNode({ disc: byRepo.get(repo), inputs, image: images[repo] || null, runner, force, keep, log, ...(imageId ? { imageId } : {}) });
    }
    done.set(repo, result);
    results.push(result);
  }
  const ok = results.every((r) => usable.has(r.status));
  return { graph, results, status: ok ? 'READY' : 'BLOCKED' };
}

function renderBootstrap(out) {
  const lines = [];
  if (out.reason && !out.results.length) lines.push(`BLOCKED: ${out.reason}`);
  for (const r of out.results) {
    const t = r.tests ? ` tests ${r.tests.total - r.tests.failed - r.tests.errors - r.tests.skipped}/${r.tests.total} passed` : '';
    lines.push(`${r.repo} @ ${String(r.revision).slice(0, 12)}: ${r.status}${r.cache ? ` (cache ${r.cache}${r.fingerprint ? ` ${r.fingerprint}` : ''})` : ''}${t}${r.elapsed_ms != null && r.cache === 'miss' ? `, ${Math.round(r.elapsed_ms / 1000)} s` : ''}`);
    if (r.reason) lines.push(`  ${r.reason}`);
    if (r.image) lines.push(`  image ${r.image} (${String(r.image_id).slice(0, 19)})${r.cache === 'miss' ? `, resolve ${r.resolve || '-'}` : ''}`);
    for (const f of (r.tests && r.tests.failing) || []) lines.push(`  failing: ${f}`);
    if (r.artifacts && r.artifacts.length) lines.push(`  artifacts: ${r.artifacts.filter((a) => /\.(jar|pom)$/.test(a.path)).map((a) => a.path.split('/').pop()).join(', ')}`);
    for (const n of r.notes || []) lines.push(`  note: ${n}`);
  }
  lines.push(`=> ${out.status}`);
  return lines.join('\n');
}

module.exports = { bootstrapNode, bootstrapGraph, renderBootstrap, loadRecord, listRecords, recipeFor, probeTests, home, USABLE };
