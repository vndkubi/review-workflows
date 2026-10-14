'use strict';
// Repositories that build on each other: which repository produces the
// artifact another one depends on (by Maven groupId:artifactId), in what
// order they must build, and which can build side by side. Built from
// discovery results only; nothing is executed.
//
// It stops instead of guessing: a coordinate produced by two repositories,
// a dependency cycle, or a library compiled for a newer Java than its
// consumer builds with are reported as problems, without an order where it
// matters.

const ga = (x) => `${x.groupId}:${x.artifactId}`;

// discoveries: DiscoveryResult[] (one per repository).
function buildGraph(discoveries) {
  const problems = [];
  const notes = [];
  const producers = new Map(); // groupId:artifactId -> [{ repo, version, module }]
  for (const d of discoveries) {
    for (const p of d.produces) {
      if (!p.groupId || !p.artifactId || /\$\{/.test(ga(p))) continue;
      if (!producers.has(ga(p))) producers.set(ga(p), []);
      producers.get(ga(p)).push({ repo: d.repo, version: p.version, module: p.module });
    }
  }
  for (const [key, list] of producers) {
    const repos = [...new Set(list.map((x) => x.repo))];
    if (repos.length > 1) problems.push({ kind: 'duplicate_coordinate', artifact: key, repos, detail: `${key} is produced by ${repos.join(' and ')}; which one to build is not decided` });
  }
  const byRepo = new Map(discoveries.map((d) => [d.repo, d]));
  const edges = [];
  const external = [];
  const unmatched = [];
  for (const d of discoveries) {
    const seen = new Set();
    for (const dep of d.dependencies) {
      const list = producers.get(ga(dep));
      const from = list && [...new Set(list.map((x) => x.repo))].filter((r) => r !== d.repo);
      if (!from || !from.length) {
        external.push({ repo: d.repo, artifact: `${ga(dep)}:${dep.version || '?'}`, scope: dep.scope });
        continue;
      }
      if (from.length > 1) continue; // a duplicate_coordinate problem already
      const producer = list.find((x) => x.repo === from[0]);
      const key = `${from[0]}\0${ga(dep)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge = { dependency: from[0], consumer: d.repo, artifact: ga(dep), wanted: dep.version || null, produced: producer.version || null, scope: dep.scope, evidence: dep.evidence };
      edge.version_match = edge.wanted == null || edge.produced == null || /\$\{/.test(edge.wanted) ? null : edge.wanted === edge.produced;
      // Only the version the source produces is a reason to build it first.
      // Another version (a release, say) comes from a Maven repository; an
      // unknown one is not decided here.
      if (edge.version_match !== true) {
        unmatched.push(edge);
        continue;
      }
      edges.push(edge);
      // Bytecode for Java N does not load on an older JVM.
      const lib = byRepo.get(from[0]).java;
      const app = d.java;
      if (lib.target != null && app.jdk != null && lib.target > app.jdk) {
        problems.push({ kind: 'java_too_new', artifact: ga(dep), repos: [from[0], d.repo], detail: `${from[0]} compiles for Java ${lib.target}; ${d.repo} builds with JDK ${app.jdk} and cannot load it` });
      }
    }
  }
  // Repository-level edges (a repository builds as one reactor).
  const deps = new Map(discoveries.map((d) => [d.repo, new Set()]));
  for (const e of edges) deps.get(e.consumer).add(e.dependency);
  const { levels, cycle } = levelsOf(deps);
  if (cycle) problems.push({ kind: 'cycle', repos: cycle, detail: `dependency cycle: ${cycle.join(' -> ')}` });
  const nodes = discoveries.map((d) => ({ repo: d.repo, revision: d.revision, jdk: d.java.jdk, java_label: d.java.label, build: d.build_systems[0] || null, image: d.proposal ? d.proposal.image : null, depends_on: [...deps.get(d.repo)].sort() }));
  for (const e of unmatched) {
    notes.push(e.version_match === false
      ? `${e.consumer} wants ${e.artifact}:${e.wanted}; ${e.dependency} at ${byRepo.get(e.dependency).revision.slice(0, 12)} produces ${e.produced}: resolved from a Maven repository, not built from this source`
      : `${e.consumer} wants ${e.artifact} at ${e.wanted || 'an unknown version'}; not decided whether ${e.dependency} must be built from source`);
  }
  return { nodes, edges, unmatched, external, levels: cycle ? null : levels, order: cycle ? null : levels.flat(), problems, notes };
}

// Kahn's algorithm in levels: each level only depends on earlier ones, so a
// level's repositories can build side by side. On a cycle, one cycle.
function levelsOf(deps) {
  const remaining = new Map([...deps].map(([k, v]) => [k, new Set(v)]));
  const levels = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, v]) => [...v].every((x) => !remaining.has(x))).map(([k]) => k).sort();
    if (!ready.length) return { levels, cycle: findCycle(remaining) };
    levels.push(ready);
    for (const k of ready) remaining.delete(k);
  }
  return { levels, cycle: null };
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) || []) {
      if (!graph.has(m)) continue;
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.get(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of [...graph.keys()].sort()) {
    if (!state.get(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

function renderGraph(g) {
  const lines = [];
  for (const n of g.nodes) lines.push(`${n.repo} @ ${n.revision.slice(0, 12)}: ${n.build || 'no build'}, JDK ${n.jdk == null ? 'UNKNOWN' : `${n.jdk} (${n.java_label})`}${n.depends_on.length ? `, needs ${n.depends_on.join(', ')}` : ''}`);
  if (g.edges.length) lines.push('', 'artifacts between repositories:', ...g.edges.map((e) => `  ${e.dependency} -> ${e.consumer}: ${e.artifact}:${e.wanted || '?'}${e.version_match === false ? ` (source produces ${e.produced})` : ''}  ${e.evidence ? `${e.evidence.path}:${e.evidence.line}` : ''}`));
  if (g.levels) lines.push('', 'build order (each line can build in parallel):', ...g.levels.map((l, i) => `  ${i + 1}. ${l.join(', ')}`));
  for (const p of g.problems) lines.push(`problem: ${p.detail}`);
  for (const n of g.notes) lines.push(`note: ${n}`);
  return lines.join('\n');
}

module.exports = { buildGraph, levelsOf, findCycle, renderGraph };
