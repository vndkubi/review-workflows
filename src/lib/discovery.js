'use strict';
// Environment discovery for a repository at one revision: build systems,
// the Java version it compiles for and the JDK it builds with, the Maven
// coordinates it produces and depends on, and a proposed sandbox (image and
// commands). Read from git objects (`git show <rev>:<path>`), never the
// working tree; nothing is executed. Every signal carries evidence
// (path, line, the line's text) that can be checked against the revision.
//
// What it says is DECLARED (explicit metadata), INFERRED (a default or a
// weaker hint) or UNKNOWN. Whether the proposal actually builds is for a
// bootstrap run to show, not for discovery.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const { readPom, kid, kids, textOf } = require('./pom');

// ---------- java versions ----------
// '1.8' -> 8, '11' -> 11, 'VERSION_1_8' -> 8, '[1.8,)' -> 8, '11.0.20-tem' -> 11.
function parseJava(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^['"]|['"]$/g, '');
  const m = /(?:VERSION_)?(?:^|[^\d])?(1[._](\d+)|(\d+))/.exec(s.replace(/^[[(]/, ''));
  if (!m) return null;
  const v = m[2] ? Number(m[2]) : Number(m[3]);
  return v >= 5 && v <= 40 ? v : null;
}

// The Java version in an image reference, if it names one.
function javaOfImage(ref) {
  const m = /(?:jdk|jre|temurin|openjdk|corretto|zulu|java|semeru|liberica)[-:_]?(\d+(?:[._]\d+)?)/i.exec(ref);
  return m ? parseJava(m[1]) : null;
}

// ---------- reading a revision ----------
// The build metadata files discovery may read.
const METADATA = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|maven-wrapper\.properties|gradle-wrapper\.properties|Dockerfile[^/]*|Jenkinsfile|\.java-version|\.sdkmanrc|\.tool-versions|\.gitlab-ci\.yml|bitbucket-pipelines\.yml|\.travis\.yml|azure-pipelines\.yml)$|^\.github\/workflows\/[^/]+\.ya?ml$/;

// All of them in one `git cat-file --batch` (one git per file is ~50 ms
// each on Windows; a large repository has hundreds).
function readBlobs(checkout, rev, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const { execFileSync } = require('node:child_process');
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: checkout, input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<object> missing"
    const size = Number(m[2]);
    if (m[1] === 'blob') out.set(p, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

function revisionReader(checkout, rev) {
  const files = git.git(checkout, ['ls-tree', '-r', '--name-only', '-z', rev]).split('\0').filter(Boolean);
  const set = new Set(files);
  const cache = readBlobs(checkout, rev, files.filter((f) => METADATA.test(f)));
  const read = (p) => {
    if (!set.has(p)) return null;
    if (!cache.has(p)) cache.set(p, git.showFile(checkout, rev, p));
    return cache.get(p);
  };
  // Evidence: the text of a line, as `git show` returns it.
  const ev = (p, line) => {
    const text = read(p);
    const quote = text == null ? '' : (text.split('\n')[line - 1] || '').trim();
    return { path: p, line, quote };
  };
  return { files, has: (p) => set.has(p), read, ev };
}

// ---------- maven ----------
const SPRING_BOOT_PARENT = 'org.springframework.boot:spring-boot-starter-parent';

function discoverMaven(r, out) {
  const poms = new Map();
  const load = (p) => {
    if (poms.has(p)) return poms.get(p);
    let entry = null;
    const text = r.read(p);
    if (text != null) {
      try {
        entry = { path: p, pom: readPom(text) };
      } catch (err) {
        out.unknowns.push(`${p}: unreadable POM (${err.message})`);
      }
    }
    poms.set(p, entry);
    return entry;
  };
  const eff = new Map();
  // The model with what it inherits from a parent POM inside the repository.
  const effective = (p) => {
    if (eff.has(p)) return eff.get(p);
    eff.set(p, null); // a parent cycle ends here
    const { pom } = load(p);
    let parent = null;
    if (pom.parent && pom.parent.relativePath) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(p), pom.parent.relativePath));
      const candidate = rel.endsWith('.xml') ? rel : path.posix.join(rel, 'pom.xml');
      const loaded = r.has(candidate) && load(candidate);
      if (loaded && loaded.pom.artifactId === pom.parent.artifactId) parent = effective(candidate);
    }
    const props = { ...(parent ? parent.props : {}) };
    for (const [k, v] of Object.entries(pom.properties)) props[k] = { ...v, path: p };
    const groupId = pom.groupId || (pom.parent && pom.parent.groupId);
    const version = pom.version || (pom.parent && pom.parent.version);
    const builtin = { 'project.groupId': groupId, 'project.artifactId': pom.artifactId, 'project.version': version, 'project.parent.version': pom.parent && pom.parent.version, 'project.parent.groupId': pom.parent && pom.parent.groupId, version, 'pom.version': version };
    // ${x} from properties and project fields; `via` lists the property
    // definitions a value came from.
    const resolve = (raw) => {
      if (raw == null) return { value: null, via: [] };
      let value = raw;
      const via = [];
      for (let i = 0; i < 10 && /\$\{[^}]+\}/.test(value); i += 1) {
        value = value.replace(/\$\{([^}]+)\}/g, (all, name) => {
          if (builtin[name] != null) return builtin[name];
          if (props[name]) {
            via.push({ path: props[name].path, line: props[name].line, name });
            return props[name].value;
          }
          return all;
        });
      }
      return { value, via, unresolved: /\$\{[^}]+\}/.test(value) };
    };
    const byId = (list) => new Map(list.map((x) => [x.artifactId, { ...x, path: p }]));
    const plugins = new Map([...(parent ? parent.plugins : []), ...byId(pom.plugins)]);
    const managedPlugins = new Map([...(parent ? parent.managedPlugins : []), ...byId(pom.managedPlugins)]);
    const managed = [...pom.managed.map((d) => ({ ...d, path: p })), ...(parent ? parent.managed : [])];
    const model = { path: p, pom, parent, props, groupId, version, resolve, plugins, managedPlugins, managed };
    eff.set(p, model);
    return model;
  };

  // The module tree from the root POM; POMs outside it are listed as unknown.
  const reached = [];
  const walk = (p) => {
    if (reached.includes(p) || !load(p)) return;
    reached.push(p);
    for (const m of poms.get(p).pom.modules) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(p), m));
      walk(rel.endsWith('.xml') ? rel : path.posix.join(rel, 'pom.xml'));
    }
  };
  if (r.has('pom.xml')) walk('pom.xml');
  const stray = r.files.filter((f) => /(^|\/)pom\.xml$/.test(f) && !reached.includes(f) && !/(^|\/)(src\/test|target)\//.test(f));
  if (stray.length) out.unknowns.push(`POMs outside the module tree (not discovered): ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? ` and ${stray.length - 5} more` : ''}`);
  if (!reached.length) return;
  out.build_systems.push('maven');

  for (const p of reached) {
    const m = effective(p);
    const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
    const mod = { path: dir, build: 'maven', groupId: m.groupId, artifactId: m.pom.artifactId, version: m.version, packaging: m.pom.packaging, evidence: r.ev(p, 1), dependencies: [] };
    out.modules.push(mod);
    const signal = (kind, raw, node, from, srcPath = p) => {
      const res = m.resolve(raw);
      const version = parseJava(res.value);
      if (version == null) {
        if (raw != null) out.unknowns.push(`${p}: ${from} is ${JSON.stringify(res.value)}, not a Java version`);
        return;
      }
      out.signals.push({ kind, version, raw: res.value, from, module: dir, evidence: [r.ev(srcPath, node), ...res.via.map((v) => r.ev(v.path, v.line))] });
    };
    // Properties the compiler plugin reads by default.
    for (const [name, kind] of [['maven.compiler.release', 'release'], ['maven.compiler.target', 'target'], ['maven.compiler.source', 'source'], ['java.version', 'target']]) {
      const prop = m.props[name];
      if (!prop) continue;
      const res = m.resolve(prop.value);
      const version = parseJava(res.value);
      if (version != null) out.signals.push({ kind, version, raw: res.value, from: `property ${name}`, module: dir, evidence: [r.ev(prop.path, prop.line), ...res.via.map((v) => r.ev(v.path, v.line))] });
    }
    const compiler = m.plugins.get('maven-compiler-plugin') || m.managedPlugins.get('maven-compiler-plugin');
    if (compiler && compiler.configuration) {
      for (const kind of ['release', 'target', 'source']) {
        const node = kid(compiler.configuration, kind);
        if (node) signal(kind, textOf(node), node.line, `maven-compiler-plugin <${kind}>`, compiler.path);
      }
    }
    const toolchains = m.plugins.get('maven-toolchains-plugin');
    const jdkVersion = toolchains && toolchains.configuration && kid(kid(kid(toolchains.configuration, 'toolchains'), 'jdk'), 'version');
    if (jdkVersion) signal('toolchain', textOf(jdkVersion), jdkVersion.line, 'maven-toolchains-plugin jdk version', toolchains.path);
    const enforcer = m.plugins.get('maven-enforcer-plugin');
    for (const conf of enforcer ? [enforcer.configuration, ...enforcer.executions].filter(Boolean) : []) {
      const v = kid(kid(kid(conf, 'rules'), 'requireJavaVersion'), 'version');
      if (v) signal('minimum', textOf(v), v.line, 'enforcer requireJavaVersion', enforcer.path);
    }
    // Spring Boot's parent sets java.version: 1.8 in 2.x, 17 in 3.x.
    const top = (() => {
      let x = m;
      while (x.parent) x = x.parent;
      return x;
    })();
    const ext = top.pom.parent;
    if (ext && `${ext.groupId}:${ext.artifactId}` === SPRING_BOOT_PARENT && !m.props['java.version']) {
      const major = Number(String(ext.version).split('.')[0]);
      if (major >= 2) out.signals.push({ kind: 'inferred_target', version: major >= 3 ? 17 : 8, raw: ext.version, from: `spring-boot-starter-parent ${ext.version} default java.version`, module: dir, evidence: [r.ev(top.path, ext.line)] });
    }
    // An external parent is a dependency too (its POM must be resolvable).
    if (m.pom.parent && !m.parent) {
      mod.dependencies.push({ groupId: m.pom.parent.groupId, artifactId: m.pom.parent.artifactId, version: m.pom.parent.version, scope: 'parent', evidence: r.ev(p, m.pom.parent.line) });
    }
    for (const d of m.pom.dependencies) {
      const groupId = m.resolve(d.groupId).value;
      const artifactId = m.resolve(d.artifactId).value;
      let version = m.resolve(d.version);
      let managedBy = null;
      if (!d.version) {
        const hit = m.managed.find((x) => m.resolve(x.groupId).value === groupId && x.artifactId === artifactId);
        if (hit) {
          version = effective(hit.path).resolve(hit.version);
          managedBy = r.ev(hit.path, hit.line);
        }
      }
      const dep = { groupId, artifactId, version: version.value || null, scope: d.scope || 'compile', evidence: r.ev(p, d.line) };
      if (managedBy) dep.managed_by = managedBy;
      if (!dep.version) dep.version_note = 'managed outside the repository (parent or BOM)';
      else if (version.unresolved) dep.version_note = 'property not defined in the repository';
      mod.dependencies.push(dep);
    }
    for (const d of m.managed.filter((x) => x.scope === 'import' && x.path === p)) {
      mod.dependencies.push({ groupId: m.resolve(d.groupId).value, artifactId: d.artifactId, version: m.resolve(d.version).value, scope: 'import', evidence: r.ev(p, d.line) });
    }
  }
  const wrapper = r.read('.mvn/wrapper/maven-wrapper.properties');
  const mw = wrapper && /apache-maven-(\d+(?:\.\d+)+)/.exec(wrapper);
  if (mw) out.wrappers.maven = { version: mw[1], evidence: r.ev('.mvn/wrapper/maven-wrapper.properties', wrapper.slice(0, mw.index).split('\n').length) };
}

// ---------- gradle ----------
// Build scripts are programs: only literal assignments are read.
function discoverGradle(r, out) {
  // Scripts under a src/ directory are test fixtures, not modules.
  const scripts = r.files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f) && !/(^|\/)src\//.test(f));
  if (!scripts.length) return;
  out.build_systems.push('gradle');
  out.unknowns.push('Gradle build scripts are code: only literal values are read; anything computed is not seen');
  const settingsPath = ['settings.gradle', 'settings.gradle.kts'].find((f) => r.has(f));
  const settings = settingsPath ? r.read(settingsPath) : '';
  const rootName = (/rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(settings) || [])[1] || null;
  const props = {};
  for (const [i, l] of (r.read('gradle.properties') || '').split('\n').entries()) {
    const m = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(l);
    if (m) props[m[1]] = { value: m[2], line: i + 1 };
  }
  for (const s of scripts) {
    const text = r.read(s);
    const dir = path.posix.dirname(s) === '.' ? '' : path.posix.dirname(s);
    const mod = { path: dir, build: 'gradle', groupId: null, artifactId: dir ? dir.split('/').pop() : rootName, version: null, packaging: 'jar', evidence: r.ev(s, 1), dependencies: [] };
    if (!dir && props.group) mod.groupId = props.group.value;
    if (!dir && props.version) mod.version = props.version.value;
    out.modules.push(mod);
    const lines = text.split('\n');
    for (const [i, l] of lines.entries()) {
      const line = i + 1;
      const push = (kind, raw, from) => {
        const version = parseJava(raw);
        if (version != null) out.signals.push({ kind, version, raw, from, module: dir, evidence: [r.ev(s, line)] });
      };
      let m;
      if ((m = /\b(source|target)Compatibility\s*=\s*(?:JavaVersion\.(?:toVersion\(\s*)?)?['"]?(VERSION_[\d_]+|[\d.]+)/.exec(l))) push(m[1], m[2], `${m[1]}Compatibility`);
      if ((m = /options\.release(?:\.set)?\s*[=(]\s*(\d+)/.exec(l))) push('release', m[1], 'options.release');
      if ((m = /languageVersion(?:\.set)?\s*[=(]\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(l))) push('toolchain', m[1], 'java toolchain languageVersion');
      if ((m = /^\s*group\s*=\s*['"]([^'"]+)['"]/.exec(l))) mod.groupId = m[1];
      if ((m = /^\s*version\s*=\s*['"]([^'"]+)['"]/.exec(l))) mod.version = m[1];
      if ((m = /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|compile|testCompile|annotationProcessor)\s*\(?\s*['"]([^'":\s]+):([^'":\s]+)(?::([^'"\s@]+))?['"]/.exec(l))) {
        mod.dependencies.push({ groupId: m[2], artifactId: m[3], version: m[4] || null, scope: m[1], evidence: r.ev(s, line) });
      }
    }
  }
  const wrapper = r.read('gradle/wrapper/gradle-wrapper.properties');
  const gw = wrapper && /gradle-(\d+(?:\.\d+)+)-(?:bin|all)\.zip/.exec(wrapper);
  if (gw) out.wrappers.gradle = { version: gw[1], evidence: r.ev('gradle/wrapper/gradle-wrapper.properties', wrapper.slice(0, gw.index).split('\n').length) };
}

// ---------- CI, version files, images ----------
function discoverBuildJdkHints(r, out) {
  const hint = (kind, version, raw, from, p, line) => {
    if (version != null) out.signals.push({ kind, version, raw, from, module: null, evidence: [r.ev(p, line)] });
  };
  const eachLine = (p, fn) => (r.read(p) || '').split('\n').forEach((l, i) => fn(l, i + 1));
  for (const p of ['.java-version', '.sdkmanrc', '.tool-versions']) {
    eachLine(p, (l, line) => {
      const m = p === '.java-version' ? /^\s*(\S+)/.exec(l) : p === '.sdkmanrc' ? /^\s*java\s*=\s*(\S+)/.exec(l) : /^\s*java\s+(\S+)/.exec(l);
      if (m) hint('version_file', parseJava(m[1].replace(/^[a-z]+-/i, '')), m[1], p, p, line);
    });
  }
  for (const p of r.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    eachLine(p, (l, line) => {
      let m = /java-version\s*:\s*['"]?([\w.-]+)/.exec(l);
      if (m && !m[1].startsWith('$')) hint('ci', parseJava(m[1]), m[1], `GitHub Actions ${p}`, p, line);
      m = /^\s*(?:java|jdk|java-version)\s*:\s*\[([^\]]+)\]/.exec(l);
      if (m) for (const v of m[1].split(',')) hint('ci', parseJava(v), v.trim(), `GitHub Actions matrix ${p}`, p, line);
    });
  }
  for (const p of ['.gitlab-ci.yml', 'bitbucket-pipelines.yml', '.travis.yml', 'azure-pipelines.yml'].filter((f) => r.has(f))) {
    eachLine(p, (l, line) => {
      const m = /^\s*-?\s*(?:image|jdk)\s*:\s*['"]?([^\s'"#]+)/.exec(l);
      if (m) hint('ci', javaOfImage(m[1]) || parseJava(/jdk/i.test(l) ? m[1] : null), m[1], p, p, line);
    });
  }
  if (r.has('Jenkinsfile')) {
    eachLine('Jenkinsfile', (l, line) => {
      const m = /\bjdk\s*\(?\s*['"]([^'"]+)['"]/i.exec(l) || /(?:image|docker\.image)\s*\(?\s*['"]([^'"]+)['"]/.exec(l);
      if (m) hint('ci', javaOfImage(m[1]) || parseJava((/\d+(?:[._]\d+)?/.exec(m[1]) || [])[0]), m[1], 'Jenkinsfile', 'Jenkinsfile', line);
    });
  }
  for (const p of r.files.filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f))) {
    eachLine(p, (l, line) => {
      const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(l);
      if (m) hint('docker', javaOfImage(m[1]), m[1], p, p, line);
    });
  }
}

// ---------- deciding ----------
const LTS = [8, 11, 17, 21, 25];
// The oldest a JDK's javac can still target (JDK 9 dropped 5, 12 dropped 6, 20 dropped 7).
function minTargetOf(jdk) {
  return jdk >= 20 ? 8 : jdk >= 12 ? 7 : jdk >= 9 ? 6 : 1;
}

function decideJava(signals, unknowns) {
  const of = (...kinds) => signals.filter((s) => kinds.includes(s.kind));
  const declaredTarget = of('release', 'target');
  const targetSignals = declaredTarget.length ? declaredTarget : of('source').length ? of('source') : of('inferred_target');
  const target = targetSignals.length ? Math.max(...targetSignals.map((s) => s.version)) : null;
  const conflicts = [];
  const targets = [...new Set(declaredTarget.map((s) => s.version))];
  const notes = [];
  if (targets.length > 1) notes.push(`modules compile for different Java versions (${targets.join(', ')}); the build needs a JDK >= ${Math.max(...targets)}`);
  // The JDK the build runs on: an explicit toolchain, then CI, then version
  // files; otherwise the declared target itself. A Dockerfile (usually the
  // runtime image) and framework defaults only count when nothing else does.
  let jdk = null;
  let decidedBy = null;
  const pick = (kind) => {
    const vs = [...new Set(of(kind).map((s) => s.version))].sort((a, b) => a - b);
    if (!vs.length) return false;
    jdk = (target && vs.find((v) => v >= target)) || vs[0];
    decidedBy = kind;
    return true;
  };
  if (!['toolchain', 'ci', 'version_file'].some(pick)) {
    if (declaredTarget.length || of('source').length) {
      jdk = target;
      decidedBy = declaredTarget.length ? 'target' : 'source';
    } else if (!pick('docker') && target != null) {
      jdk = target;
      decidedBy = 'inferred_target';
    }
  }
  if (jdk != null && target != null && jdk < target) conflicts.push(`the ${decidedBy} JDK ${jdk} is older than the target ${target}; using ${target}`);
  if (jdk != null && target != null && jdk < target) jdk = target;
  if (jdk != null && target != null && target < minTargetOf(jdk)) conflicts.push(`JDK ${jdk} cannot compile for Java ${target}`);
  const min = of('minimum').map((s) => s.version);
  if (jdk != null && min.length && jdk < Math.max(...min)) conflicts.push(`the build requires Java >= ${Math.max(...min)} (enforcer) but ${jdk} was chosen`);
  const label = jdk == null ? 'UNKNOWN' : ['toolchain', 'ci', 'target', 'source'].includes(decidedBy) || (decidedBy === 'version_file' && target) ? 'DECLARED' : 'INFERRED';
  if (jdk == null) unknowns.push('no Java version declared (compiler settings, toolchains, CI, version files)');
  return { target, jdk, decided_by: decidedBy, label, conflicts, notes };
}

function proposal(buildSystems, java, wrappers) {
  if (!buildSystems.length || java.jdk == null) return null;
  const lts = LTS.find((v) => v >= java.jdk) || LTS[LTS.length - 1];
  const notes = lts !== java.jdk ? [`no maintained image for Java ${java.jdk}; proposing ${lts}`] : [];
  if (buildSystems[0] === 'maven') {
    return { toolchain: 'maven', image: `maven:3.9-eclipse-temurin-${lts}`, commands: { install: ['mvn', '-B', '-q', '-DskipTests', 'install'], test: ['mvn', '-B', 'test'] }, notes, verified: false };
  }
  const major = wrappers.gradle ? wrappers.gradle.version.split('.')[0] : '8';
  return { toolchain: 'gradle', image: `gradle:${major}-jdk${lts}`, commands: { install: ['gradle', '--no-daemon', '-x', 'test', 'build'], test: ['gradle', '--no-daemon', 'test'] }, notes, verified: false };
}

// The DiscoveryResult of `checkout` at `rev` (default HEAD).
function discoverRepo({ checkout, rev = 'HEAD', repo = null }) {
  const revision = git.revParse(checkout, rev);
  const r = revisionReader(checkout, revision);
  const out = { schema_version: '1.0', repo: repo || path.basename(path.resolve(checkout)), checkout: path.resolve(checkout), revision, build_systems: [], modules: [], wrappers: {}, signals: [], unknowns: [] };
  discoverMaven(r, out);
  discoverGradle(r, out);
  discoverBuildJdkHints(r, out);
  if (!out.build_systems.length) out.unknowns.push('no Maven or Gradle build found');
  out.java = decideJava(out.signals, out.unknowns);
  const own = new Set(out.modules.map((m) => `${m.groupId}:${m.artifactId}`));
  // Parent POMs too: a consumer resolving a module needs its parent chain.
  out.produces = out.modules.map((m) => ({ groupId: m.groupId, artifactId: m.artifactId, version: m.version, packaging: m.packaging, module: m.path }));
  out.dependencies = [];
  for (const m of out.modules) {
    for (const d of m.dependencies) {
      if (own.has(`${d.groupId}:${d.artifactId}`)) continue; // another module of this repository
      out.dependencies.push({ ...d, module: m.path });
    }
  }
  out.proposal = proposal(out.build_systems, out.java, out.wrappers);
  return out;
}

// A configured repository ("owner/name" in config/repos.json) or a directory.
function checkoutOf(target) {
  const entry = require('./github').reposConfig().repos[target];
  if (entry && entry.checkout) return { repo: target, checkout: entry.checkout };
  if (fs.existsSync(target)) return { repo: path.basename(path.resolve(target)), checkout: target };
  throw new Error(`${target} is neither a configured repository nor a directory`);
}

function renderDiscovery(r) {
  const cite = (e) => `${e.path}:${e.line}`;
  const lines = [`${r.repo} @ ${r.revision.slice(0, 12)}: ${r.build_systems.join(', ') || 'no build system'}`];
  const j = r.java;
  lines.push(`  Java: ${j.jdk == null ? 'UNKNOWN' : `JDK ${j.jdk} (${j.label}, by ${j.decided_by}${j.target ? `; compiles for ${j.target}` : ''})`}`);
  // Long lists are cut in text; --json has everything.
  const capped = (items, fmt, max = 15) => [...items.slice(0, max).map(fmt), ...(items.length > max ? [`    ... ${items.length - max} more (--json for all)`] : [])];
  // One line per distinct signal; modules that inherit it are counted.
  const grouped = new Map();
  for (const s of r.signals) {
    const key = `${s.kind}\0${s.version}\0${s.from}\0${s.evidence.map(cite).join(', ')}`;
    if (!grouped.has(key)) grouped.set(key, { ...s, modules: 0 });
    grouped.get(key).modules += 1;
  }
  lines.push(...capped([...grouped.values()], (s) => `    ${s.kind} ${s.version}  ${s.from}${s.modules > 1 ? ` (${s.modules} modules)` : s.module ? ` [${s.module}]` : ''}  ${s.evidence.map(cite).join(', ')}`));
  for (const c of j.conflicts) lines.push(`  conflict: ${c}`);
  for (const n of j.notes) lines.push(`  note: ${n}`);
  for (const [tool, w] of Object.entries(r.wrappers)) lines.push(`  ${tool} wrapper ${w.version}  ${cite(w.evidence)}`);
  if (r.produces.length) lines.push(`  produces (${r.produces.length}):`, ...capped(r.produces, (p) => `    ${p.groupId}:${p.artifactId}:${p.version}${p.module ? ` (${p.module})` : ''}`));
  if (r.dependencies.length) lines.push(`  depends on (${r.dependencies.length}):`, ...capped(r.dependencies, (d) => `    ${d.groupId}:${d.artifactId}:${d.version || '?'} ${d.scope}${d.version_note ? ` — ${d.version_note}` : ''}`));
  if (r.proposal) lines.push(`  proposal (not verified): ${r.proposal.image}; test: ${r.proposal.commands.test.join(' ')}`, ...r.proposal.notes.map((n) => `    ${n}`));
  for (const u of r.unknowns) lines.push(`  unknown: ${u}`);
  return lines.join('\n');
}

module.exports = { discoverRepo, renderDiscovery, checkoutOf, parseJava, javaOfImage, decideJava, minTargetOf };
