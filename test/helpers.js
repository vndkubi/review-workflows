'use strict';
// Test helpers: a throwaway git repo (Java + Python) and a scripted executor
// that stands in for codex.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function tmpDir(prefix = 'arw-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sh(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const ORDER_BASE = `package com.acme;

import java.math.BigDecimal;

public class OrderService {
    private static final BigDecimal THRESHOLD = new BigDecimal("1000000");

    public BigDecimal discount(boolean member, BigDecimal total) {
        return BigDecimal.ZERO;
    }
}
`;

const ORDER_HEAD = `package com.acme;

import java.math.BigDecimal;

public class OrderService {
    private static final BigDecimal THRESHOLD = new BigDecimal("1000000");

    public BigDecimal discount(boolean member, BigDecimal total) {
        if (member && total.compareTo(THRESHOLD) > 0) {
            return total.multiply(new BigDecimal("0.10"));
        }
        return BigDecimal.ZERO;
    }
}
`;

const CONTROLLER = `package com.acme;

import java.math.BigDecimal;

public class CheckoutController {
    private final OrderService orders = new OrderService();

    public BigDecimal quote(boolean member, BigDecimal total) {
        return total.subtract(orders.discount(member, total));
    }
}
`;

const FEES_BASE = `def late_fee(days):
    return 0
`;

const FEES_HEAD = `def late_fee(days, rate=0.5):
    if days > 30:
        return days * rate
    return 0
`;

// A buildable Maven project (JUnit 5) using plugin versions that are usually
// in a local repository already; used by live repro smoke runs.
const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>shop</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.8.1</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin>
    </plugins>
  </build>
</project>
`;

// Returns { dir, base, head }: base on main, head one commit later.
function makeRepo({ maven = false } = {}) {
  const dir = tmpDir('arw-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  if (maven) {
    write(dir, 'pom.xml', POM);
    write(dir, '.gitignore', 'target/\n');
  }
  write(dir, 'src/main/java/com/acme/OrderService.java', ORDER_BASE);
  write(dir, 'src/main/java/com/acme/CheckoutController.java', CONTROLLER);
  write(dir, 'billing/fees.py', FEES_BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'src/main/java/com/acme/OrderService.java', ORDER_HEAD);
  write(dir, 'billing/fees.py', FEES_HEAD);
  write(dir, 'package-lock.json', '{"lockfileVersion":3}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'ACME-7 member discount and late fee']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  return { dir, base, head };
}

// handler(prompt, opts, callIndex) -> string output, or an object
// { error_class, error_message } to simulate a process failure.
function scriptedExecutor(handler) {
  const calls = [];
  const exec = async (opts) => {
    calls.push({ prompt: opts.prompt, model: opts.model, cwd: opts.cwd });
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const out = await handler(opts.prompt, opts, calls.length - 1);
    const usage = { input_tokens: Math.ceil(opts.prompt.length / 4), cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    if (out && typeof out === 'object') {
      return { ok: false, output: null, exit_code: 1, elapsed_ms: 1, usage, turns: 0, commands: 0, error_class: out.error_class, error_message: out.error_message, model: opts.model || null, prompt_bytes: opts.prompt.length };
    }
    return { ok: true, output: out, exit_code: 0, elapsed_ms: 1, usage, turns: 1, commands: 0, error_class: null, error_message: null, model: opts.model || null, prompt_bytes: opts.prompt.length };
  };
  exec.calls = calls;
  return exec;
}

// The viewpoint matrix as a scripted reviewer answers it: "fail" for a
// viewpoint one of its findings cites, "cannot_determine" for the rest.
function viewpointVerdicts(prompt, findings = []) {
  const m = prompt.match(/^VIEWPOINT CHECKS \(required\): give exactly one viewpoint_verdicts entry for each of (.*?) \(text/m);
  if (!m) return [];
  return m[1].split(', ').map((viewpoint) => {
    const f = findings.find((x) => x.authority.kind === 'curated_viewpoint' && x.authority.id === viewpoint);
    return f ? { viewpoint, verdict: 'fail', evidence: f.evidence, note: f.title } : { viewpoint, verdict: 'cannot_determine', evidence: [], note: 'not checked by the scripted reviewer' };
  });
}

// Evidence pointing at the first line of `file` at `rev` containing `quote`.
function evidenceAt(dir, rev, file, quote, extra = {}) {
  const text = sh(dir, ['show', `${rev}:${file}`]);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(quote));
  if (i < 0) throw new Error(`quote ${quote} not in ${file}`);
  return { kind: 'code', path: file, start_line: i + 1, end_line: i + 1, quote, ...extra };
}

module.exports = { tmpDir, sh, write, makeRepo, scriptedExecutor, evidenceAt, viewpointVerdicts, ORDER_HEAD, FEES_HEAD };
