'use strict';
// Incident (pilot2c, 23 Oct 2026): codex answered "You've hit your usage
// limit ... try again at 7:09 AM". The text matched no error class, so every
// job retried as a process failure, the review ended EXECUTED_FAIL, and the
// eval went on to the next cases, which died at the preflight: 3 of 4 cases
// NO_RESULT. The message is in the eval logs 900+ times, with a time of day
// or, when the limit resets days later, a date.
// Now: the class is "quota"; a job stops at once; an eval waits until the
// reset when it is near and reruns the case, otherwise it stops cleanly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');
const { isUsageLimit, usageLimitReset } = require('../src/lib/quota');
const { classifyError } = require('../src/lib/codex');

const TODAY = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:09 AM.";
const LATER = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 24th, 2026 1:51 AM.";

test('a usage limit is its own error class, not a process failure or a rate limit', () => {
  assert.equal(classifyError(TODAY), 'quota');
  assert.equal(classifyError(`error: executor preflight failed (error): ${LATER}`), 'quota');
  assert.equal(classifyError('429 Too Many Requests'), 'rate_limit');
  assert.equal(isUsageLimit('the review found a usage of limits'), false);
});

test('the reset time: a time of day (today, or tomorrow once past) or a date, in local time', () => {
  const now = new Date(2026, 9, 23, 6, 0, 0);
  assert.deepEqual(usageLimitReset(TODAY, now), new Date(2026, 9, 23, 7, 9, 0));
  assert.deepEqual(usageLimitReset(TODAY, new Date(2026, 9, 23, 19, 0, 0)), new Date(2026, 9, 24, 7, 9, 0), 'past: tomorrow');
  assert.deepEqual(usageLimitReset(LATER, now), new Date(2026, 9, 24, 1, 51, 0));
  assert.deepEqual(usageLimitReset(TODAY.replace('7:09 AM', '4:35 PM'), now), new Date(2026, 9, 23, 16, 35, 0));
  assert.deepEqual(usageLimitReset(TODAY.replace('7:09 AM', '12:05 AM'), now), new Date(2026, 9, 24, 0, 5, 0), '12 AM is midnight');
  assert.equal(usageLimitReset("You’ve hit your usage limit. Upgrade to Pro", now), null);
});

function evalRepo() {
  const dir = tmpDir('arw-quota-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/total.py', 'def total(items):\n    return sum(items)\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/total.py', 'def total(items, n):\n    return sum(items[:n])  # BUG: off by one\n');
  sh(dir, ['commit', '-q', '-am', 'change totals']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

async function evalWithLimit(message, now) {
  const r = evalRepo();
  const dir = tmpDir('arw-quota-eval-');
  fs.mkdirSync(path.join(dir, 'cases'), { recursive: true });
  for (const id of ['first', 'second']) {
    fs.writeFileSync(path.join(dir, 'cases', `${id}.json`), JSON.stringify({ id, repo: r.dir, base: r.base, head: r.head, flags: { skipSynthesis: true }, expected: [{ id: 'E1', path: 'billing/total.py', keywords: ['off by one'] }] }));
  }
  const saved = { ...process.env };
  Object.assign(process.env, {
    ARW_EVAL_DIR: dir,
    ARW_EXECUTOR_MODULE: path.join(__dirname, 'fixtures', 'quota-once-executor.js'),
    ARW_TEST_QUOTA_MARK: path.join(dir, 'quota-hit'),
    ARW_TEST_QUOTA_MESSAGE: message,
  });
  const slept = [];
  const lines = [];
  try {
    const evals = require('../src/lib/eval');
    const res = await evals.runEval({ label: 'quota', log: (l) => lines.push(l), now: () => now, sleep: async (ms) => slept.push(ms) });
    return { ...res, slept, lines };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('eval: a limit that resets soon is waited out and the case runs again', async () => {
  const { card, slept, lines, outDir } = await evalWithLimit(TODAY, new Date(2026, 9, 23, 7, 0, 0));
  assert.deepEqual(slept, [11 * 60 * 1000], 'until 7:09 plus two minutes');
  assert.ok(lines.some((l) => /usage limit: waiting until .* then running first again/.test(l)), lines.join('\n'));
  assert.deepEqual(card.cases.map((c) => [c.id, c.status, c.found]), [['first', 'EXECUTED_PASS', 1], ['second', 'EXECUTED_PASS', 1]], 'no case lost, none counted twice');
  assert.equal(card.stopped, null);
  assert.equal(card.quota_waits.length, 1);
  assert.match(fs.readFileSync(path.join(outDir, 'scorecard.md'), 'utf8'), /usage limit waited out 1 time\(s\): first until /);
});

test('eval: a limit that resets later than ARW_EVAL_QUOTA_WAIT_HOURS stops the eval with the cases left', async () => {
  const { card, slept, outDir } = await evalWithLimit(LATER, new Date(2026, 9, 23, 7, 0, 0));
  assert.deepEqual(slept, []);
  assert.deepEqual(card.cases, [], 'the interrupted case is not scored as a miss');
  assert.equal(card.stopped, `usage limit until ${new Date(2026, 9, 24, 1, 51).toISOString()}; not run: first, second`);
  assert.ok(card.finished_at);
  assert.match(fs.readFileSync(path.join(outDir, 'scorecard.md'), 'utf8'), /- \*\*stopped\*\*: usage limit until .*; not run: first, second/);
});
