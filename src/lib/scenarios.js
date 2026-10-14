'use strict';
// Scenario execution (behavioural evidence) and intent drift.
//
// The approved spec's scenario rows run through the reviewed code. A model
// writes only an ADAPTER: a function from one row's input values to the
// observed outcome values, calling the real code. The harness generates the
// test that feeds the adapter every row and records what it returns (the
// test asserts nothing), runs it twice on the head (the second time in
// reverse row order) and once on the base, and
// compares the observations with the expected values it computed itself
// from the approved rules (spec.js). The model never sees or writes an
// expected value or an assertion, so it cannot bend the oracle to the code.
//
// The adapter is a model's code, so it is judged before its observations
// are (see assess): calibration, K1 variance and K2 repeatability. Passing
// all three makes it CALIBRATED; otherwise it is FLAKY (K2) or UNKNOWN.
//
// Drift is then decided per review item, by code only:
//   ALIGNED     reserved for an adapter that also passes K3 (not built yet:
//               nothing reaches it today);
//   CALIBRATED  every executable row of the item matches on the head, with a
//               CALIBRATED adapter;
//   DRIFT       a row stably contradicts the approved rule on the head, with
//               a CALIBRATED adapter;
//   UNKNOWN     no executable row, an unapproved spec, a blocked or failed
//               run, or an adapter that is not CALIBRATED.
// A missing test is never drift; only an executed contradiction is.
const fs = require('node:fs');
const path = require('node:path');
const { sha256, canonicalJson, writeJsonAtomic, readJsonIfExists, nowIso, ensureDir, envInt } = require('./util');
const git = require('./git');
const { parsePatch } = require('./patch');
const { loadContext, verifyContext, revisionDir, readInput } = require('./freeze');
const { validateAgainst, outputSchema } = require('./schema');
const confine = require('./confine');
const repro = require('./repro');

const OUT_DIR = 'arw-scenarios-out';
const MAX_ROWS = 300;
const FINAL = new Set(['OBSERVED', 'INCONCLUSIVE', 'ENVIRONMENT_BLOCKED']);
const NUMERIC = new Set(['integer', 'decimal']);
const FOLLOW = new Set(['ast', 'ast-dispatch', 'typed', 'resolved', 'interface']);
const NOT_TARGETS = new Set(['main', 'equals', 'hashCode', 'toString', 'get', 'set', 'run', 'apply', 'test']);
// K2: the second head run feeds the same rows in reverse order. Fixed by the
// phase, so validation never takes the order from disk.
const REVERSED = new Set(['head-2']);

function rowsForPhase(phase, rows) {
  return REVERSED.has(phase) ? [...rows].reverse() : rows;
}

// ---------- names ----------
function javaNames(featureId) {
  return { adapter: `ArwScenarioAdapter${featureId}`, test: `ArwScenario${featureId}Test` };
}

function pythonNames(featureId) {
  const f = featureId.toLowerCase();
  return { adapter: `arw_scenario_adapter_${f}`, test: `test_arw_scenario_${f}` };
}

// The input file inside OUT_DIR the generated test writes.
function outFile(featureId) {
  return `${OUT_DIR}/${featureId}.json`;
}

// ---------- targets ----------
// Methods the PR changed (from the frozen patch) and, when the evidence pack
// found them, their callers: an adapter must call one of them, or it does
// not exercise the change.
function changedTargets(runDir, context) {
  const { indexFile, changedMethods } = require('./impact');
  const patchFile = path.join(revisionDir(runDir, context.context_id), 'review.patch');
  if (!fs.existsSync(patchFile)) return [];
  const parsed = parsePatch(fs.readFileSync(patchFile, 'utf8')).filter((f) => /\.(java|py)$/.test(f.path));
  const { checkout, head_sha: head, base_sha: base } = context.source;
  const indexes = [];
  const baseIndexes = new Map();
  for (const f of parsed) {
    const text = git.showFile(checkout, head, f.path);
    if (text != null) indexes.push(indexFile(f.path, text));
    const old = git.showFile(checkout, base, f.old_path || f.path);
    if (old != null) baseIndexes.set(f.old_path || f.path, indexFile(f.old_path || f.path, old));
  }
  const names = new Set(changedMethods(indexes.filter(Boolean), parsed, baseIndexes).map((m) => m.name));
  const impact = (readJsonIfExists(path.join(runDir, 'static.json'), {}) || {}).impact;
  for (const e of (impact && impact.edges) || []) {
    if (!FOLLOW.has(e.confidence) || e.repo) continue;
    const sym = String((e.from && e.from.symbol) || '').split('.').pop();
    if (/^[A-Za-z_$][\w$]*$/.test(sym)) names.add(sym);
  }
  return [...names].filter((n) => n.length >= 3 && !NOT_TARGETS.has(n));
}

// ---------- adapter validation ----------
function validateAdapter(candidate, { context, feature, targets = [] }) {
  const errors = validateAgainst('repro', candidate, 'scenarioAdapter');
  if (errors.length) return errors;
  const p = candidate.path.replace(/\\/g, '/');
  if (p !== candidate.path || path.isAbsolute(p) || !confine.isPlainRel(p)) return ['$.path: repository-relative, forward slashes, no "..", each part only letters, digits, _ . - (not starting with . or -)'];
  if (git.showFile(context.source.checkout, context.source.head_sha, p) != null) errors.push(`$.path: ${p} already exists; write a NEW file`);
  const c = candidate.content;
  if (candidate.language === 'java') {
    const { adapter } = javaNames(feature.id);
    const m = p.match(new RegExp(`(^|/)src/test/java/(.+)/${adapter}\\.java$`));
    if (!m) errors.push(`$.path: the adapter is src/test/java/<package of the code it calls>/${adapter}.java (inside the module that holds that code)`);
    else {
      const pkg = m[2].replace(/\//g, '.');
      if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(pkg)) errors.push(`$.path: "${pkg}" is not a Java package`);
      if (!new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, '\\.')}\\s*;`, 'm').test(c)) errors.push(`$.content: must declare "package ${pkg};"`);
    }
    if (!new RegExp(`\\bpublic\\s+(final\\s+)?class\\s+${adapter}\\b`).test(c)) errors.push(`$.content: must declare public class ${adapter}`);
    if (!/\bpublic\s+static\b[^;{=]*\bobserve\s*\(\s*(final\s+)?(java\.util\.)?Map\s*<\s*String\s*,\s*String\s*>\s+\w+\s*\)/.test(c)) errors.push('$.content: must declare "public static java.util.Map<String, ?> observe(java.util.Map<String, String> in)" (it may declare "throws Exception")');
  } else {
    const { adapter } = pythonNames(feature.id);
    if (!new RegExp(`(^|/)${adapter}\\.py$`).test(p)) errors.push(`$.path: the adapter is <a test directory>/${adapter}.py`);
    if (!/^def\s+observe\s*\(\s*\w+\s*\)\s*(->[^:]+)?:/m.test(c)) errors.push('$.content: must define a top-level "def observe(inputs):" returning a dict');
  }
  // Recording, not judging: an adapter that asserts or compares with expected
  // values is doing the harness's job.
  if (/\bassert(Equals|That|True|False)?\b|\bpytest\.fail\b|\bfail\s*\(/.test(c)) errors.push('$.content: the adapter must not assert or fail; it returns what the code produced and the harness compares');
  if (targets.length) {
    const calls = (n) => new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(c);
    if (!targets.some(calls)) errors.push(`$.content: the adapter does not call code this pull request changed (one of: ${targets.slice(0, 20).join(', ')})`);
  }
  return errors;
}

// ---------- generated tests ----------
function javaString(s) {
  if (s == null) return 'null';
  let out = '"';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (code >= 0x20 && code < 0x7f) out += ch;
    // A \u escape of a line break would end the literal (escapes are
    // decoded before lexing): control characters go as octal escapes.
    else if (code < 0x20) out += `\\${code.toString(8).padStart(3, '0')}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else {
      const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const lo = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
    }
  }
  return `${out}"`;
}

// Missing inputs (spec class "missing") reach the adapter as null.
function rowInputs(feature, row) {
  return Object.fromEntries(feature.variables.map((v) => [v.id, row.values[v.id] === '(missing)' ? null : row.values[v.id] == null ? null : String(row.values[v.id])]));
}

// junit: 4 or 5. Java 8 compatible; writes OUT_DIR/<feature>.json found by
// walking up from the working directory (a module dir in a multi-module build).
function javaTest({ pkg, feature, rows, junit }) {
  const { adapter, test } = javaNames(feature.id);
  const data = rows.map((r) => {
    const inputs = rowInputs(feature, r);
    return `        { ${[r.id, ...Object.entries(inputs).flat()].map(javaString).join(', ')} }`;
  });
  const imp = junit === 4 ? 'import org.junit.Test;' : 'import org.junit.jupiter.api.Test;';
  return `package ${pkg};

// Generated by the review harness. It feeds the approved spec's scenario rows
// to ${adapter} and records what the code returns. It asserts nothing.
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;
${imp}

public class ${test} {
    private static final String[][] ROWS = {
${data.join(',\n')}
    };

    @Test
    public void observeScenarios() throws Exception {
        StringBuilder out = new StringBuilder("[");
        for (int r = 0; r < ROWS.length; r++) {
            String[] row = ROWS[r];
            Map<String, String> in = new LinkedHashMap<String, String>();
            for (int i = 1; i + 1 < row.length; i += 2) in.put(row[i], row[i + 1]);
            if (r > 0) out.append(',');
            out.append("{\\"id\\":").append(q(row[0]));
            try {
                Map<String, ?> got = ${adapter}.observe(in);
                out.append(",\\"observed\\":{");
                boolean first = true;
                if (got != null) {
                    for (Map.Entry<String, ?> e : got.entrySet()) {
                        if (!first) out.append(',');
                        first = false;
                        out.append(q(String.valueOf(e.getKey()))).append(':').append(q(text(e.getValue())));
                    }
                }
                out.append('}');
            } catch (Throwable t) {
                out.append(",\\"error\\":").append(q(t.getClass().getName() + ": " + t.getMessage()));
            }
            out.append('}');
        }
        out.append(']');
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve(${javaString(OUT_DIR)}))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("no ${OUT_DIR} directory above " + Paths.get("").toAbsolutePath());
        Files.write(dir.resolve(${javaString(OUT_DIR)}).resolve(${javaString(`${feature.id}.json`)}), out.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String text(Object v) {
        if (v == null) return "null";
        if (v instanceof java.math.BigDecimal) return ((java.math.BigDecimal) v).toPlainString();
        return String.valueOf(v);
    }

    private static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\\\') b.append('\\\\').append(c);
            else if (c < 0x20) b.append(String.format("\\\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
}
`;
}

function pythonTest({ feature, rows }) {
  const { adapter, test } = pythonNames(feature.id);
  const data = JSON.stringify(rows.map((r) => ({ id: r.id, inputs: rowInputs(feature, r) })));
  return `# Generated by the review harness. It feeds the approved spec's scenario rows
# to ${adapter}.py and records what the code returns. It asserts nothing.
import importlib.util
import json
import pathlib

ROWS = json.loads(${JSON.stringify(data)})


def _adapter():
    path = pathlib.Path(__file__).with_name("${adapter}.py")
    spec = importlib.util.spec_from_file_location("${adapter}", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _text(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return str(v)


def ${test.replace(/^test_/, 'test_observe_')}():
    observe = _adapter().observe
    out = []
    for row in ROWS:
        rec = {"id": row["id"]}
        try:
            got = observe(dict(row["inputs"]))
            rec["observed"] = {str(k): _text(v) for k, v in (got or {}).items()}
        except Exception as e:  # recorded, judged by the harness
            rec["error"] = type(e).__name__ + ": " + str(e)[:300]
        out.append(rec)
    d = pathlib.Path.cwd().resolve()
    while not (d / "${OUT_DIR}").is_dir():
        if d.parent == d:
            raise RuntimeError("no ${OUT_DIR} directory above " + str(pathlib.Path.cwd()))
        d = d.parent
    (d / "${OUT_DIR}" / "${feature.id}.json").write_text(json.dumps(out), encoding="utf-8")
`;
}

// JUnit 4 or 5 from the build files between the adapter and the root, then
// from the existing tests; null when neither is found.
function junitFlavor(wt, adapterRel) {
  const dirs = [];
  let d = path.posix.dirname(adapterRel);
  while (true) {
    dirs.push(d === '.' ? '' : d);
    if (d === '.' || d === '' || d === '/') break;
    d = path.posix.dirname(d);
  }
  let four = false;
  for (const dir of dirs) {
    for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      const text = confine.readConfined(wt, path.join(wt, dir, name));
      if (!text) continue;
      if (/junit-jupiter|useJUnitPlatform/.test(text)) return 5;
      if (/<artifactId>junit<\/artifactId>|junit:junit/.test(text)) four = true;
    }
  }
  if (four) return 4;
  const hits = String(git.git(wt, ['grep', '-l', '-E', 'org\\.junit\\.jupiter|import org\\.junit\\.Test', '--', '*.java'], { allowFail: true }) || '').split('\n').filter(Boolean);
  for (const f of hits.slice(0, 20)) {
    const text = confine.readConfined(wt, path.join(wt, f)) || '';
    if (text.includes('org.junit.jupiter')) return 5;
    if (text.includes('import org.junit.Test')) return 4;
  }
  return null;
}

// ---------- judging ----------
function parseNumber(s) {
  const t = String(s == null ? '' : s).trim().replace(/[,_\s]/g, '');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

// Whether an observed value equals the expected one for the outcome type.
function sameValue(outcome, expected, observed) {
  if (observed == null) return false;
  if (outcome.type === 'boolean') return String(observed).trim().toLowerCase() === expected;
  if (outcome.type === 'enum') return String(observed).trim().toLowerCase() === String(expected).trim().toLowerCase();
  if (NUMERIC.has(outcome.type)) {
    const o = parseNumber(observed);
    const e = Number(expected);
    if (Number.isNaN(o)) return false;
    if (outcome.type === 'decimal' && outcome.step && Number(outcome.step) > 0) return Math.abs(o - e) < Number(outcome.step) / 2;
    return Math.abs(o - e) <= 1e-9 * Math.max(1, Math.abs(e));
  }
  return String(observed).trim() === String(expected).trim();
}

// One row in one run: { result: match|mismatch|error|observed, observed, mismatched }.
function judgeRow(feature, row, rec) {
  if (!rec) return { result: 'error', error: 'no record for this row' };
  if (rec.error != null) return { result: 'error', error: String(rec.error).slice(0, 300) };
  const observed = rec.observed && typeof rec.observed === 'object' ? rec.observed : {};
  if (!row.expected) return { result: 'observed', observed };
  const mismatched = [];
  for (const [id, exp] of Object.entries(row.expected)) {
    const o = feature.outcomes.find((x) => x.id === id);
    if (!(id in observed)) return { result: 'error', observed, error: `the adapter returned no "${id}"` };
    if (!sameValue(o, exp, observed[id])) mismatched.push(id);
  }
  return { result: mismatched.length ? 'mismatch' : 'match', observed, mismatched };
}

function checkedOnly(row, observed) {
  if (!observed) return null;
  const keys = row.expected ? Object.keys(row.expected) : Object.keys(observed);
  return JSON.stringify(keys.map((k) => [k, observed[k] == null ? null : String(observed[k])]));
}

// rows of the frozen input + observations per phase -> per-row verdicts.
function judgeRows(feature, rows, obs) {
  const byPhase = Object.fromEntries(Object.entries(obs).map(([phase, list]) => [phase, list ? new Map(list.map((r) => [r.id, r])) : null]));
  return rows.map((row) => {
    const h1 = byPhase['head-1'] ? judgeRow(feature, row, byPhase['head-1'].get(row.id)) : null;
    const h2 = byPhase['head-2'] ? judgeRow(feature, row, byPhase['head-2'].get(row.id)) : null;
    const b = byPhase.base ? judgeRow(feature, row, byPhase.base.get(row.id)) : null;
    let verdict;
    if (!h1 || !h2) verdict = 'NOT_RUN';
    else if (h1.result === 'error' || h2.result === 'error') verdict = 'ERROR';
    else if (checkedOnly(row, h1.observed) !== checkedOnly(row, h2.observed)) verdict = 'FLAKY';
    else verdict = { match: 'MATCH', mismatch: 'MISMATCH', observed: 'OBSERVED' }[h1.result];
    const out = { id: row.id, verdict, expected: row.expected, observed: h1 && h1.observed ? h1.observed : null, base: b ? b.result : null, items: row.items, rules: row.rules, labels: row.labels };
    if (h1 && h1.mismatched && h1.mismatched.length) out.mismatched = h1.mismatched;
    const err = (h1 && h1.error) || (h2 && h2.error);
    if (err) out.error = err;
    if (b && b.observed && row.expected) out.base_observed = b.observed;
    return out;
  });
}

// Calibration: at most half of the checkable rows error on the head, and at
// least one row matches the spec on the head or on the base. An adapter that
// is wrong everywhere (a bad fixture, the wrong method) fails it. Necessary,
// not sufficient: an adapter that calls the code, discards the result and
// returns a constant equal to one row's expected value passes it (see K1).
function calibrate(rows) {
  const checkable = rows.filter((r) => r.expected);
  const errors = checkable.filter((r) => r.verdict === 'ERROR').length;
  const headMatch = checkable.filter((r) => r.verdict === 'MATCH').length;
  const baseMatch = checkable.filter((r) => r.base === 'match').length;
  const reasons = [];
  if (!checkable.length) reasons.push('no checkable row');
  if (errors * 2 > checkable.length) reasons.push(`${errors} of ${checkable.length} rows raised an error in the adapter`);
  if (!headMatch && !baseMatch) reasons.push('no row matches the spec on the head or the base, so the adapter is not shown to call the code correctly');
  return { passed: reasons.length === 0, checkable: checkable.length, errors, head_matches: headMatch, base_matches: baseMatch, reasons };
}

// One key per meaning, for counting distinct values: numbers by value (to
// the step for a stepped decimal), booleans and enums case-blind.
function valueKey(outcome, v) {
  if (v == null) return 'null';
  if (outcome && NUMERIC.has(outcome.type)) {
    const n = parseNumber(v);
    if (Number.isNaN(n)) return `text:${String(v).trim()}`;
    const step = outcome.type === 'decimal' && Number(outcome.step) > 0 ? Number(outcome.step) : 0;
    return `num:${step ? Math.round(n / step) : n}`;
  }
  if (outcome && ['boolean', 'enum'].includes(outcome.type)) return String(v).trim().toLowerCase();
  return String(v).trim();
}

// K1 variance: for every outcome whose expected value takes >= 2 distinct
// values across the executed rows (checkable, no error on head-1), the
// observed value must take >= 2 as well; otherwise the adapter does not
// respond to its inputs. No extra execution.
function varianceControl(feature, rows, head1) {
  const executed = rows.filter((r) => {
    const rec = r.expected && head1.get(r.id);
    return rec && rec.error == null && rec.observed && typeof rec.observed === 'object';
  });
  const insensitive = [];
  let applicable = false;
  for (const o of feature.outcomes) {
    const expected = new Set();
    const observed = new Set();
    for (const r of executed) {
      if (!(o.id in r.expected)) continue;
      expected.add(valueKey(o, r.expected[o.id]));
      observed.add(valueKey(o, head1.get(r.id).observed[o.id]));
    }
    if (expected.size < 2) continue;
    applicable = true;
    if (observed.size < 2) insensitive.push({ outcome: o.id, expected_values: expected.size, observed_values: observed.size });
  }
  const reasons = insensitive.map((x) => `K1 variance: ${x.outcome} takes ${x.observed_values} value on ${executed.length} executed rows where the spec expects ${x.expected_values}, so the adapter does not respond to its inputs`);
  return { passed: insensitive.length === 0, applicable, executed: executed.length, insensitive, reasons };
}

// What K2 compares for one row: the checked values, or the error class (an
// error message may carry an address or a time).
function repeatKey(row, rec) {
  if (!rec) return 'missing';
  if (rec.error != null) return `error:${String(rec.error).split(':')[0].trim()}`;
  return checkedOnly(row, rec.observed && typeof rec.observed === 'object' ? rec.observed : {});
}

function shownRecord(row, rec) {
  if (!rec) return 'missing';
  if (rec.error != null) return `error: ${String(rec.error).slice(0, 200)}`;
  const o = rec.observed && typeof rec.observed === 'object' ? rec.observed : {};
  const keys = row.expected ? Object.keys(row.expected) : Object.keys(o).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, o[k] == null ? null : String(o[k])])));
}

// K2 repeatability: head-1 (rows in order) and head-2 (the same rows in
// reverse order) must observe the same thing row by row, gap rows included.
// A difference is nondeterminism or state carried from one row to the next.
function repeatControl(rows, head1, head2) {
  const differing = rows
    .filter((r) => repeatKey(r, head1.get(r.id)) !== repeatKey(r, head2.get(r.id)))
    .map((r) => ({ id: r.id, first: shownRecord(r, head1.get(r.id)), reversed: shownRecord(r, head2.get(r.id)) }));
  const ids = differing.slice(0, 5).map((d) => d.id).join(', ') + (differing.length > 5 ? ', …' : '');
  const reasons = differing.length ? [`K2 repeat: ${differing.length} of ${rows.length} rows differ between the run in order and the run in reverse order (${ids})`] : [];
  return { passed: differing.length === 0, rows: rows.length, differing: differing.slice(0, 50), reasons };
}

// The rows judged and the adapter's status, from calibration, K1 and K2,
// all computed from recorded observations: { rows, trust }. No model
// decides any of it.
function assess(feature, rows, obs) {
  const judged = judgeRows(feature, rows, obs);
  const byId = (list) => new Map((list || []).map((r) => [r.id, r]));
  const head1 = byId(obs['head-1']);
  const calibration = calibrate(judged);
  const k1 = varianceControl(feature, rows, head1);
  const k2 = repeatControl(rows, head1, byId(obs['head-2']));
  const status = !k2.passed ? 'FLAKY' : calibration.passed && k1.passed ? 'CALIBRATED' : 'UNKNOWN';
  const reasons = [...k2.reasons, ...calibration.reasons.map((r) => `calibration: ${r}`), ...k1.reasons];
  return { rows: judged, trust: { status, reasons, calibration, k1, k2 } };
}

// ---------- runs ----------
function classifyRun(outcome, text, rows) {
  if (outcome.spawn_error) return 'environment';
  if (outcome.timed_out) return 'timeout';
  if (text == null) return outcome.exit_code === 0 ? 'no_report' : 'build_error';
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return 'bad_report';
  }
  if (!Array.isArray(list) || list.length !== rows.length || list.some((r, i) => !r || r.id !== rows[i].id)) return 'bad_report';
  if (outcome.exit_code !== 0 && outcome.exit_code != null) return 'command_failed';
  return 'observed';
}

function statusFromRuns(runs) {
  const head = runs.filter((r) => r.phase.startsWith('head'));
  if (!head.length) return { status: 'INCONCLUSIVE', reason: 'not run' };
  if (head.some((r) => r.status === 'environment')) return { status: 'ENVIRONMENT_BLOCKED', reason: 'the build tool could not be started' };
  const bad = head.find((r) => r.status !== 'observed');
  if (bad || head.length < 2) return { status: 'INCONCLUSIVE', reason: bad ? `${bad.phase}: ${bad.status}` : 'the head ran once' };
  return { status: 'OBSERVED', reason: null };
}

function scenariosDir(runDir, context) {
  return path.join(revisionDir(runDir, context.context_id), 'scenarios');
}

function loadInput(runDir, context) {
  const text = readInput(runDir, context, 'scenarios');
  return text ? JSON.parse(text) : null;
}

function capRows(feature) {
  return feature.rows.slice(0, MAX_ROWS);
}

// Model-free check of every scenario record bound to this context: its
// artifacts keep their hashes, and every run status, row verdict, the
// calibration and the K1/K2 controls are re-derived from the raw logs and
// observations and the frozen scenario input. A record whose stored controls
// differ from the derived ones is rejected.
// Returns { records: Map(feature -> record), errors }.
function loadScenarioRecords(runDir, context) {
  const records = new Map();
  const errors = [];
  const dir = scenariosDir(runDir, context);
  const input = loadInput(runDir, context);
  if (!input || !fs.existsSync(dir)) return { records, errors };
  const rdir = revisionDir(runDir, context.context_id);
  for (const name of fs.readdirSync(dir).filter((n) => /^F\d+\.json$/.test(n))) {
    const rec = readJsonIfExists(path.join(dir, name));
    if (!rec || !rec.feature) continue;
    const bad = (msg) => errors.push(`scenarios ${rec.feature}: ${msg}`);
    const feature = input.features.find((f) => f.id === rec.feature);
    if (!feature) {
      bad('not a feature of the frozen scenario input');
      continue;
    }
    if (rec.context_digest !== context.context_digest) {
      bad('bound to another context');
      continue;
    }
    const artifacts = [rec.adapter && rec.adapter.artifact, rec.test && rec.test.artifact, rec.test && rec.test.reversed_artifact, ...(rec.runs || []).flatMap((r) => [r.log, r.observations])].filter(Boolean);
    const broken = artifacts.find((a) => {
      const f = path.join(rdir, a.path);
      return !fs.existsSync(f) || sha256(fs.readFileSync(f)) !== a.sha256;
    });
    if (broken) {
      bad(`artifact ${broken.path} is missing or changed`);
      continue;
    }
    const rows = capRows(feature);
    let raw = true;
    const obs = {};
    const runs = (rec.runs || []).map((r) => {
      const outcome = repro.parseTrailer(fs.readFileSync(path.join(rdir, r.log.path), 'utf8'));
      if (!outcome) {
        raw = false;
        return r;
      }
      const text = r.observations ? fs.readFileSync(path.join(rdir, r.observations.path), 'utf8') : null;
      const status = classifyRun(outcome, text, rowsForPhase(r.phase, rows));
      obs[r.phase] = status === 'observed' ? JSON.parse(text) : null;
      return { ...r, status };
    });
    if (!raw) {
      bad('a run has no raw evidence (log trailer); run the scenarios again');
      continue;
    }
    const mismatch = runs.find((r, i) => r.status !== rec.runs[i].status);
    if (mismatch) {
      bad(`run ${mismatch.phase} does not follow from its raw evidence (${rec.runs.find((r) => r.phase === mismatch.phase).status} recorded, ${mismatch.status} in the artifacts)`);
      continue;
    }
    const derived = runs.length ? statusFromRuns(runs) : { status: rec.status, reason: rec.reason };
    if (!runs.length && !['ENVIRONMENT_BLOCKED', 'INCONCLUSIVE'].includes(rec.status)) {
      bad(`status ${rec.status} without runs`);
      continue;
    }
    if (derived.status !== rec.status) {
      bad(`status ${rec.status} does not follow from its runs (${derived.status})`);
      continue;
    }
    const assessed = derived.status === 'OBSERVED' ? assess(feature, rows, { 'head-1': obs['head-1'], 'head-2': obs['head-2'], base: obs.base || null }) : { rows: [], trust: null };
    if (canonicalJson(rec.controls == null ? null : rec.controls) !== canonicalJson(assessed.trust)) {
      bad(`recorded controls do not follow from the observations (${rec.controls ? rec.controls.status : 'none'} recorded, ${assessed.trust ? assessed.trust.status : 'none'} derived)`);
      continue;
    }
    records.set(rec.feature, { ...rec, reason: rec.reason || derived.reason, rows: assessed.rows, trust: assessed.trust, truncated: feature.rows.length > rows.length });
  }
  return { records, errors };
}

// ---------- orchestration ----------
async function runScenarios({ runDir, executor, models = {}, runner = null, log = () => {}, testCommand, prompts, runModelJob, makeSources }) {
  const context = loadContext(runDir);
  const drift = verifyContext(runDir, context);
  if (drift.length) throw new Error(`context no longer holds: ${drift.join('; ')}`);
  const input = loadInput(runDir, context);
  if (!input) {
    log('scenarios: no approved spec with machine-checkable outcomes');
    return [];
  }
  const execRun = runner || repro.defaultRunner(runDir);
  const rdir = revisionDir(runDir, context.context_id);
  const outDir = ensureDir(scenariosDir(runDir, context));
  const existing = loadScenarioRecords(runDir, context).records;
  const timeoutMs = envInt('REPRO_TIMEOUT_MS', 15 * 60 * 1000);
  const receiptsFile = path.join(rdir, 'receipts.json');
  const receipts = readJsonIfExists(receiptsFile, {});
  const env = { runDir, context, executor, log, receipts, flushReceipts: () => writeJsonAtomic(receiptsFile, receipts), sources: makeSources(runDir, context) };
  const targets = changedTargets(runDir, context);
  const results = [];
  let wt = null;

  for (const feature of input.features) {
    const prior = existing.get(feature.id);
    if (prior && FINAL.has(prior.status)) {
      results.push(prior);
      continue;
    }
    const recordFile = path.join(outDir, `${feature.id}.json`);
    const base = { schema_version: '1.0', context_digest: context.context_digest, feature: feature.id, at: nowIso() };
    const rows = capRows(feature);
    log(`scenarios ${feature.id}: writing an adapter (${rows.length} rows)`);
    const gen = await runModelJob(env, {
      label: `scenario-adapter-${feature.id}`,
      outRel: `scenarios/${feature.id}.adapter.json`,
      model: models.repro || models.review,
      effort: models.effort,
      outputSchema: outputSchema('repro', 'scenarioAdapter'),
      buildPrompt: (repair) => prompts.scenarioAdapterPrompt(context, { feature, rows, targets, repair }),
      validate: (c) => validateAdapter(c, { context, feature, targets }),
    });
    if (gen.status !== 'EXECUTED_PASS') {
      const rec = { ...base, status: gen.status === 'ENVIRONMENT_BLOCKED' ? 'ENVIRONMENT_BLOCKED' : 'INCONCLUSIVE', reason: `no valid adapter: ${(gen.errors || [])[0] || gen.status}`, runs: [] };
      writeJsonAtomic(recordFile, rec);
      results.push(rec);
      continue;
    }
    const adapter = gen.value;
    if (!wt) wt = repro.ensureReproWorktree(runDir, context);
    const toolchain = repro.detectToolchain(wt, adapter.language);
    const blocked = (reason) => {
      const rec = { ...base, status: 'ENVIRONMENT_BLOCKED', reason, runs: [] };
      writeJsonAtomic(recordFile, rec);
      results.push(rec);
    };
    if (!toolchain && !testCommand) {
      blocked(`no ${adapter.language} build tool detected (pom.xml, build.gradle) and no test_command configured`);
      continue;
    }
    const dirRel = path.posix.dirname(adapter.path);
    let testRel;
    let selector;
    let testFor;
    if (adapter.language === 'java') {
      const junit = junitFlavor(wt, adapter.path);
      if (!junit) {
        blocked('no JUnit 4 or 5 dependency found for the generated test');
        continue;
      }
      const pkg = adapter.path.match(/src\/test\/java\/(.+)\/[^/]+\.java$/)[1].replace(/\//g, '.');
      testRel = `${dirRel}/${javaNames(feature.id).test}.java`;
      selector = `${pkg}.${javaNames(feature.id).test}`;
      testFor = (list) => javaTest({ pkg, feature, rows: list, junit });
    } else {
      testRel = `${dirRel}/${pythonNames(feature.id).test}.py`;
      selector = testRel;
      testFor = (list) => pythonTest({ feature, rows: list });
    }
    // Hash-bound copies of what the harness ran.
    const fdir = ensureDir(path.join(outDir, feature.id));
    const keep = (name, content) => {
      fs.writeFileSync(path.join(fdir, name), content);
      return { path: `scenarios/${feature.id}/${name}`, sha256: sha256(content) };
    };
    const adapterInfo = { language: adapter.language, path: adapter.path, calls: adapter.calls, artifact: keep(path.basename(adapter.path), adapter.content) };
    // The same test with the rows reversed, for the K2 run.
    const testContent = testFor(rows);
    const reversedContent = testFor(rowsForPhase('head-2', rows));
    const testInfo = { path: testRel, selector, artifact: keep(path.basename(testRel), testContent), reversed_artifact: keep(`reversed.${path.basename(testRel)}`, reversedContent) };
    const test = { language: adapter.language, path: testRel, selector };
    const { command, argv } = repro.commandFor(toolchain, test, wt, testCommand);
    const placed = [adapter.path, testRel];
    const obsAbs = path.join(wt, outFile(feature.id));
    const marker = `${OUT_DIR}/README.txt`;
    const place = () => {
      if (!confine.isConfinedFile(wt, path.join(wt, marker))) confine.writeNewFile(wt, marker, 'Scenario observations written by the review harness.\n');
      confine.writeNewFile(wt, adapter.path, adapter.content);
      confine.writeNewFile(wt, testRel, testContent);
    };
    const swapTest = (content) => {
      confine.removeConfined(wt, path.join(wt, testRel));
      confine.writeNewFile(wt, testRel, content);
    };
    const unplace = () => {
      for (const rel of [...placed, outFile(feature.id), marker]) confine.removeConfined(wt, path.join(wt, rel));
      const d = path.join(wt, OUT_DIR);
      if (confine.listConfined(wt, d).length === 0 && fs.existsSync(d) && fs.lstatSync(d).isDirectory()) fs.rmdirSync(d);
    };
    const runs = [];
    const runPhase = async (phase) => {
      confine.removeConfined(wt, obsAbs);
      const logRel = `scenarios/${feature.id}/${phase}.log`;
      const logFile = path.join(rdir, logRel);
      const res = await execRun({ command, argv, cwd: wt, logFile, timeoutMs, test, phase, toolchain: toolchain || 'custom' });
      fs.appendFileSync(logFile, `\n${repro.trailer(res)}\n`);
      const text = confine.readConfined(wt, obsAbs);
      const run = { phase, command, exit_code: res.exit_code, elapsed_ms: res.elapsed_ms, timed_out: Boolean(res.timed_out), spawn_error: res.spawn_error || null, environment: res.environment || null };
      run.status = classifyRun(res, text, rowsForPhase(phase, rows));
      run.log = { path: logRel, sha256: sha256(fs.readFileSync(logFile)) };
      if (text != null) {
        const obsRel = `scenarios/${feature.id}/${phase}.observations.json`;
        fs.writeFileSync(path.join(rdir, obsRel), text);
        run.observations = { path: obsRel, sha256: sha256(text) };
      }
      runs.push(run);
      log(`scenarios ${feature.id}: ${phase} -> ${run.status}`);
      return run;
    };
    const notes = [];
    try {
      if (!repro.trackedClean(context.source.checkout, wt)) throw new Error('scenario worktree has modified tracked files');
      try {
        place();
      } catch (err) {
        if (!(err instanceof confine.ConfinementError)) throw err;
        unplace();
        blocked(`cannot place the adapter in the worktree: ${err.message}`);
        continue;
      }
      const first = await runPhase('head-1');
      // K2: the same rows again, in reverse order. The budget is unchanged:
      // this run used to be a same-order repeat, which it subsumes.
      if (first.status === 'observed') {
        swapTest(reversedContent);
        await runPhase('head-2');
        swapTest(testContent);
      }
      // Control: the same adapter and rows on the base commit. It fails to
      // build when the adapter calls code the PR added; that only removes
      // the control.
      if (first.status === 'observed') {
        unplace();
        git.worktreeGit(context.source.checkout, wt, ['checkout', '--', '.'], { allowFail: true });
        git.worktreeGit(context.source.checkout, wt, ['checkout', '--detach', '--force', context.source.base_sha]);
        let ok = true;
        try {
          place();
        } catch (err) {
          if (!(err instanceof confine.ConfinementError)) throw err;
          ok = false;
          notes.push(`base control not run: ${err.message}`);
        }
        if (ok) await runPhase('base');
      }
    } finally {
      unplace();
      git.worktreeGit(context.source.checkout, wt, ['checkout', '--', '.'], { allowFail: true });
      git.worktreeGit(context.source.checkout, wt, ['checkout', '--detach', '--force', context.source.head_sha], { allowFail: true });
    }
    const { status, reason } = statusFromRuns(runs);
    const rec = { ...base, status, ...(reason ? { reason } : {}), adapter: adapterInfo, test: testInfo, toolchain: toolchain || 'custom', runs, ...(notes.length ? { notes } : {}) };
    // The controls, from the observations just kept; validation computes
    // them again from the hash-bound copies and rejects a disagreement.
    const obs = Object.fromEntries(runs.map((r) => [r.phase, r.status === 'observed' ? JSON.parse(fs.readFileSync(path.join(rdir, r.observations.path), 'utf8')) : null]));
    rec.controls = status === 'OBSERVED' ? assess(feature, rows, { 'head-1': obs['head-1'], 'head-2': obs['head-2'], base: obs.base || null }).trust : null;
    writeJsonAtomic(recordFile, rec);
    const loaded = loadScenarioRecords(runDir, context).records.get(feature.id) || rec;
    if (loaded.trust) log(`scenarios ${feature.id}: adapter ${loaded.trust.status}, ${loaded.rows.filter((r) => r.verdict === 'MATCH').length} match, ${loaded.rows.filter((r) => r.verdict === 'MISMATCH').length} mismatch${loaded.trust.reasons.length ? ` (${loaded.trust.reasons.join('; ')})` : ''}`);
    results.push(loaded);
  }
  return results;
}

// ---------- intent drift ----------
// Per rule/boundary review item: CALIBRATED, DRIFT or UNKNOWN (ALIGNED
// needs K3, not built yet), from the validated records only. testsGreen: the impacted tests pass on the head
// (machine evidence), which makes a drift "green tests, wrong behaviour".
function computeDrift({ input, records, items, testsGreen = null }) {
  const out = [];
  for (const item of items || []) {
    if (!['rule', 'boundary'].includes(item.kind)) continue;
    const entry = { item: item.id, kind: item.kind, risk: item.risk, label: item.label };
    const rows = [];
    for (const f of (input && input.features) || []) for (const r of f.rows) if (r.expected && r.items.includes(item.id)) rows.push({ feature: f.id, id: r.id });
    if (!input) {
      out.push({ ...entry, verdict: 'UNKNOWN', reason: 'no approved spec with machine-checkable outcomes' });
      continue;
    }
    if (!rows.length) {
      out.push({ ...entry, verdict: 'UNKNOWN', reason: 'no machine-checkable scenario (text outcome, or not computable)' });
      continue;
    }
    const features = [...new Set(rows.map((r) => r.feature))];
    // DRIFT, like CALIBRATED, only from an adapter that passed calibration, K1 and K2.
    const missing = features.map((f) => [f, records.get(f)]).find(([, rec]) => !rec || rec.status !== 'OBSERVED' || !rec.trust || rec.trust.status !== 'CALIBRATED');
    if (missing) {
      const [f, rec] = missing;
      const why = !rec ? 'not run' : rec.status !== 'OBSERVED' ? `${rec.status}${rec.reason ? `: ${rec.reason}` : ''}` : `adapter ${rec.trust ? rec.trust.status : 'UNKNOWN'}: ${rec.trust ? rec.trust.reasons.join('; ') : 'no controls'}`;
      out.push({ ...entry, verdict: 'UNKNOWN', reason: `scenarios ${f} ${why}` });
      continue;
    }
    const judged = rows.map((r) => records.get(r.feature).rows.find((x) => x.id === r.id)).filter(Boolean);
    const mismatches = judged.filter((r) => r.verdict === 'MISMATCH');
    const view = (r) => ({ id: r.id, verdict: r.verdict, expected: r.expected, observed: r.observed, base: r.base, labels: r.labels });
    if (mismatches.length) {
      const control = mismatches.some((r) => r.base === 'match') ? 'base' : null;
      out.push({ ...entry, verdict: 'DRIFT', control, evidence_level: control ? 'L3' : 'L2', tests_green: testsGreen, rows: judged.map(view), reason: `${mismatches.length} of ${judged.length} executed scenario(s) contradict the approved rule${control ? '; the base commit gives the expected result (regression)' : ''}` });
    } else if (judged.length && judged.every((r) => r.verdict === 'MATCH')) {
      out.push({ ...entry, verdict: 'CALIBRATED', rows: judged.map(view), reason: `${judged.length} executed scenario(s) match; the adapter passed calibration, K1 and K2, not yet K3` });
    } else {
      const odd = judged.filter((r) => r.verdict !== 'MATCH');
      out.push({ ...entry, verdict: 'UNKNOWN', rows: judged.map(view), reason: `${odd.length} scenario(s) ${[...new Set(odd.map((r) => r.verdict))].join('/')}` });
    }
  }
  return out;
}

// What the code does where the spec is silent (gap rows), for the report;
// only from a CALIBRATED adapter, since nothing else checks these rows.
function gapObservations(records) {
  const out = [];
  for (const rec of records.values()) for (const r of (rec.trust && rec.trust.status === 'CALIBRATED' && rec.rows) || []) if (r.verdict === 'OBSERVED') out.push({ feature: rec.feature, id: r.id, observed: r.observed, items: r.items });
  return out;
}

module.exports = { runScenarios, loadScenarioRecords, computeDrift, gapObservations, validateAdapter, changedTargets, javaTest, pythonTest, junitFlavor, judgeRows, calibrate, varianceControl, repeatControl, assess, rowsForPhase, sameValue, classifyRun, statusFromRuns, javaNames, pythonNames, OUT_DIR };
