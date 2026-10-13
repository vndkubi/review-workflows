'use strict';
// Watcher: which PRs get reviewed and when. Notifications: what is sent,
// when, and only to https (or localhost) webhooks.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-watch-runs-');

const { pollOnce, watchedRepos, loadState } = require('../src/lib/watch');
const { notifyReview, shouldNotify, slackText, summary, checkUrl } = require('../src/lib/notify');

test('watcher: new PRs and new pushes are queued once; drafts and arw:skip are not', () => {
  assert.deepEqual(watchedRepos({ 'a/x': { checkout: '/x', watch: true }, 'a/y': { checkout: '/y' }, 'a/z': { checkout: '/z', watch: true, watch_drafts: true } }), [{ name: 'a/x', drafts: false }, { name: 'a/z', drafts: true }]);
  let open = [
    { number: 1, title: 'one', headRefOid: 'a'.repeat(40), isDraft: false, labels: [] },
    { number: 2, title: 'draft', headRefOid: 'b'.repeat(40), isDraft: true, labels: [] },
    { number: 3, title: 'skip', headRefOid: 'c'.repeat(40), isDraft: false, labels: [{ name: 'arw:skip' }] },
  ];
  const queued = [];
  const enqueue = (j) => {
    queued.push(`${j.repo}#${j.pr}`);
    return { id: `job${queued.length}` };
  };
  const repos = [{ name: 'acme/shop', drafts: false }, { name: 'acme/broken', drafts: false }];
  const list = (repo) => {
    if (repo === 'acme/broken') throw new Error('gh pr list failed: HTTP 404');
    return open;
  };
  const r1 = pollOnce({ enqueue, list, repos });
  assert.deepEqual(queued, ['acme/shop#1']);
  assert.deepEqual(r1.skipped.map((s) => s.why), ['draft', 'label arw:skip']);
  assert.match(r1.errors[0], /acme\/broken: gh pr list failed/);
  pollOnce({ enqueue, list, repos });
  assert.deepEqual(queued, ['acme/shop#1'], 'same head: not queued again');
  open = [{ ...open[0], headRefOid: 'd'.repeat(40) }];
  const r3 = pollOnce({ enqueue, list, repos });
  assert.deepEqual(queued, ['acme/shop#1', 'acme/shop#1']);
  assert.equal(r3.queued[0].reason, 'new push');
  const state = loadState();
  assert.equal(state.prs['acme/shop#1'].job, 'job2');
  assert.equal(state.polls.length, 3);
});

const validation = (findings, status = 'EXECUTED_PASS') => ({ status, complete: true, recommendation: findings.length ? 'changes_requested' : 'no_findings', findings });
const P = (id, severity, extra = {}) => ({ id, severity, title: `${severity} problem`, state: 'stands', canonical: true, label: 'SUSPECTED', ...extra });

test('notify: when to send, and what', () => {
  assert.equal(shouldNotify(validation([]), 'findings'), false);
  assert.equal(shouldNotify(validation([]), 'all'), true);
  assert.equal(shouldNotify(validation([P('a', 'P3')]), 'blocking'), false);
  assert.equal(shouldNotify(validation([P('a', 'P2')]), 'blocking'), true);
  assert.equal(shouldNotify(validation([], 'EXECUTED_FAIL'), 'blocking'), true, 'a failed review is worth knowing about');
  assert.equal(shouldNotify(validation([P('a', 'P2', { state: 'withdrawn' })]), 'findings'), false, 'withdrawn findings do not count');
  const s = summary({ identity: { repo: 'acme/shop', pr: 7, title: 'Pricing', url: 'https://github.com/acme/shop/pull/7', head_sha: 'f'.repeat(40) }, validation: validation([P('b', 'P3'), P('a', 'P1', { label: 'CONFIRMED' }), P('c', 'P3', { canonical: false })]) });
  assert.deepEqual(s.counts, { P1: 1, P3: 1 });
  assert.deepEqual(s.findings.map((f) => f.id), ['a', 'b'], 'most severe first, duplicates folded');
  assert.match(slackText(s), /\*acme\/shop#7\* Pricing <https:\/\/github\.com\/acme\/shop\/pull\/7\|open PR>[\s\S]*• \[P1\] P1 problem _\(reproduced\)_/);
  assert.throws(() => checkUrl('http://hooks.example.com/x'), /https/);
  assert.ok(checkUrl('http://127.0.0.1:9/x'));
});

test('notify: posts to Slack and a JSON webhook; failures never throw', async (t) => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push([req.url, JSON.parse(body)]);
      res.statusCode = req.url === '/down' ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const identity = { repo: 'acme/shop', pr: 7, title: 'Pricing', head_sha: 'f'.repeat(40) };
  process.env.ARW_SLACK_WEBHOOK = `${base}/slack`;
  process.env.ARW_NOTIFY_WEBHOOK = `${base}/down`;
  const logs = [];
  try {
    const sent = await notifyReview({ identity, validation: validation([P('a', 'P2')]), link: 'http://dash/#/pr/acme__shop__7', log: (m) => logs.push(m) });
    assert.deepEqual(sent, ['slack']);
    assert.match(got.find(([u]) => u === '/slack')[1].text, /acme\/shop#7[\s\S]*http:\/\/dash\/#\/pr\/acme__shop__7/);
    assert.equal(got.find(([u]) => u === '/down')[1].event, 'review.finished');
    assert.ok(logs.some((l) => /notification to webhook failed: HTTP 500/.test(l)));
    got.length = 0;
    assert.deepEqual(await notifyReview({ identity, validation: validation([]) }), [], 'nothing found: nothing sent by default');
    assert.equal(got.length, 0);
  } finally {
    delete process.env.ARW_SLACK_WEBHOOK;
    delete process.env.ARW_NOTIFY_WEBHOOK;
  }
});
