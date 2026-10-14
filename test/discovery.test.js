'use strict';
// Environment discovery from git objects: build system, Java target and
// build JDK, coordinates and dependencies, with evidence that matches the
// revision; UNKNOWN when nothing is declared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

const { discoverRepo, decideJava } = require('../src/lib/discovery');
const git = require('../src/lib/git');

function repoWith(files) {
  const dir = tmpDir('arw-disc-');
  sh(dir, ['init', '-q', '-b', 'main']);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const LIB_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <!-- the shared library -->
  <groupId>com.company</groupId>
  <artifactId>payment-lib</artifactId>
  <version>1.2.0-SNAPSHOT</version>
  <properties>
    <maven.compiler.source>1.8</maven.compiler.source>
    <maven.compiler.target>1.8</maven.compiler.target>
  </properties>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

const SERVER_ROOT = `<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.7.18</version>
  </parent>
  <groupId>com.company</groupId>
  <artifactId>payment-server-parent</artifactId>
  <version>3.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>server-api</module>
    <module>server-app</module>
  </modules>
  <properties>
    <java.version>11</java.version>
    <payment-lib.version>1.2.0-SNAPSHOT</payment-lib.version>
  </properties>
  <build>
    <pluginManagement>
      <plugins>
        <plugin>
          <artifactId>maven-compiler-plugin</artifactId>
          <configuration>
            <release>\${java.version}</release>
          </configuration>
        </plugin>
      </plugins>
    </pluginManagement>
  </build>
</project>
`;

const SERVER_API = `<project>
  <parent>
    <groupId>com.company</groupId>
    <artifactId>payment-server-parent</artifactId>
    <version>3.0.0</version>
  </parent>
  <artifactId>server-api</artifactId>
</project>
`;

const SERVER_APP = `<project>
  <parent>
    <groupId>com.company</groupId>
    <artifactId>payment-server-parent</artifactId>
    <version>3.0.0</version>
  </parent>
  <artifactId>server-app</artifactId>
  <dependencies>
    <dependency>
      <groupId>\${project.groupId}</groupId>
      <artifactId>server-api</artifactId>
      <version>\${project.version}</version>
    </dependency>
    <dependency>
      <groupId>com.company</groupId>
      <artifactId>payment-lib</artifactId>
      <version>\${payment-lib.version}</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`;

function paymentLib() {
  return repoWith({ 'pom.xml': LIB_POM, '.github/workflows/ci.yml': "jobs:\n  build:\n    steps:\n      - uses: actions/setup-java@v4\n        with:\n          java-version: '8'\n" });
}

function paymentServer() {
  return repoWith({ 'pom.xml': SERVER_ROOT, 'server-api/pom.xml': SERVER_API, 'server-app/pom.xml': SERVER_APP, 'server-app/Dockerfile': 'FROM eclipse-temurin:11-jre\n' });
}

// Every evidence line must be the revision's text at that line.
function assertEvidence(result) {
  const all = [];
  const visit = (x) => {
    if (!x || typeof x !== 'object') return;
    if (typeof x.path === 'string' && Number.isInteger(x.line) && typeof x.quote === 'string') all.push(x);
    for (const v of Object.values(x)) visit(v);
  };
  visit(result);
  assert.ok(all.length > 0);
  for (const e of all) {
    const text = git.showFile(result.checkout, result.revision, e.path);
    assert.ok(text != null, `${e.path} exists at the revision`);
    assert.equal(text.split('\n')[e.line - 1].trim(), e.quote, `${e.path}:${e.line}`);
  }
}

test('payment-lib: Java 8 from the compiler properties, the build JDK from CI, its coordinates', () => {
  const r = discoverRepo({ checkout: paymentLib(), repo: 'company/payment-lib' });
  assert.deepEqual(r.build_systems, ['maven']);
  assert.deepEqual([r.java.target, r.java.jdk, r.java.decided_by, r.java.label], [8, 8, 'ci', 'DECLARED']);
  assert.deepEqual(r.produces.map((p) => `${p.groupId}:${p.artifactId}:${p.version}`), ['com.company:payment-lib:1.2.0-SNAPSHOT']);
  assert.deepEqual(r.dependencies.map((d) => [`${d.groupId}:${d.artifactId}:${d.version}`, d.scope]), [['junit:junit:4.13.2', 'test']]);
  assert.equal(r.proposal.image, 'maven:3.9-eclipse-temurin-8');
  assert.equal(r.proposal.verified, false, 'a proposal until a bootstrap run proves it');
  assertEvidence(r);
});

test('payment-server: modules, inherited release ${java.version} = 11, dependency on payment-lib through a property', () => {
  const r = discoverRepo({ checkout: paymentServer(), repo: 'company/payment-server' });
  assert.deepEqual(r.modules.map((m) => [m.path, m.artifactId, m.version]), [['', 'payment-server-parent', '3.0.0'], ['server-api', 'server-api', '3.0.0'], ['server-app', 'server-app', '3.0.0']]);
  assert.deepEqual([r.java.target, r.java.jdk, r.java.label], [11, 11, 'DECLARED'], JSON.stringify(r.java));
  const release = r.signals.find((s) => s.kind === 'release' && s.module === 'server-app');
  assert.ok(release, 'the release setting reaches the modules from pluginManagement');
  assert.ok(release.evidence.some((e) => e.quote === '<java.version>11</java.version>'), 'the property definition is cited');
  assert.ok(!r.signals.some((s) => s.kind === 'inferred_target'), 'java.version is set, so Boot’s default does not apply');
  const lib = r.dependencies.find((d) => d.artifactId === 'payment-lib');
  assert.equal(lib.version, '1.2.0-SNAPSHOT');
  assert.ok(!r.dependencies.some((d) => d.artifactId === 'server-api'), 'a module of the same repository is not an external dependency');
  const web = r.dependencies.find((d) => d.artifactId === 'spring-boot-starter-web');
  assert.equal(web.version, null);
  assert.match(web.version_note, /outside the repository/);
  assert.ok(r.dependencies.some((d) => d.scope === 'parent' && d.artifactId === 'spring-boot-starter-parent'));
  assertEvidence(r);
});

test('Gradle: toolchain and compatibility, coordinates from literals, wrapper version', () => {
  const dir = repoWith({
    'settings.gradle': "rootProject.name = 'ledger'\n",
    'build.gradle': "plugins { id 'java' }\ngroup = 'com.company'\nversion = '0.4.0'\njava {\n    sourceCompatibility = JavaVersion.VERSION_17\n    toolchain {\n        languageVersion = JavaLanguageVersion.of(17)\n    }\n}\ndependencies {\n    implementation 'com.company:payment-lib:1.2.0-SNAPSHOT'\n}\n",
    'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n',
  });
  const r = discoverRepo({ checkout: dir });
  assert.deepEqual(r.build_systems, ['gradle']);
  assert.deepEqual([r.java.jdk, r.java.decided_by], [17, 'toolchain']);
  assert.deepEqual(r.produces.map((p) => `${p.groupId}:${p.artifactId}:${p.version}`), ['com.company:ledger:0.4.0']);
  assert.equal(r.dependencies[0].artifactId, 'payment-lib');
  assert.equal(r.wrappers.gradle.version, '8.5');
  assert.equal(r.proposal.image, 'gradle:8-jdk17');
  assert.ok(r.unknowns.some((u) => /build scripts are code/.test(u)));
  assertEvidence(r);
});

test('nothing declared: UNKNOWN, no proposal', () => {
  const r = discoverRepo({ checkout: repoWith({ 'README.md': 'hi\n', 'pom.xml': '<project><artifactId>x</artifactId></project>\n' }) });
  assert.deepEqual([r.java.jdk, r.java.label], [null, 'UNKNOWN']);
  assert.equal(r.proposal, null);
  assert.ok(r.unknowns.some((u) => /no Java version declared/.test(u)));
});

test('a JDK older than the target is a conflict, and the target wins', () => {
  const pom = '<project>\n  <groupId>g</groupId>\n  <artifactId>a</artifactId>\n  <version>1</version>\n  <properties>\n    <maven.compiler.release>11</maven.compiler.release>\n  </properties>\n</project>\n';
  const r = discoverRepo({ checkout: repoWith({ 'pom.xml': pom, '.java-version': '1.8\n' }) });
  assert.equal(r.java.jdk, 11);
  assert.match(r.java.conflicts.join('\n'), /older than the target 11/);
  assert.match(decideJava([{ kind: 'target', version: 6 }, { kind: 'ci', version: 17 }], []).conflicts.join('\n'), /JDK 17 cannot compile for Java 6/);
});

test('discovery reads the revision, not the working tree, and survives a malformed POM', () => {
  const dir = paymentLib();
  fs.writeFileSync(path.join(dir, 'pom.xml'), LIB_POM.replace(/1\.8/g, '17'));
  assert.equal(discoverRepo({ checkout: dir }).java.target, 8, 'uncommitted edits are not read');
  const broken = repoWith({ 'pom.xml': '<project><groupId>g</groupId>\n<artifactId>a</artifact>\n</project>\n' });
  const r = discoverRepo({ checkout: broken });
  assert.match(r.unknowns.join('\n'), /unreadable POM/);
  assert.equal(r.java.label, 'UNKNOWN');
});

test('only a framework default: Spring Boot 3 implies Java 17, labelled INFERRED', () => {
  const pom = '<project>\n  <parent>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.2.1</version>\n  </parent>\n  <groupId>g</groupId>\n  <artifactId>svc</artifactId>\n  <version>1</version>\n</project>\n';
  const r = discoverRepo({ checkout: repoWith({ 'pom.xml': pom }) });
  assert.deepEqual([r.java.jdk, r.java.decided_by, r.java.label], [17, 'inferred_target', 'INFERRED']);
  assertEvidence(r);
});
