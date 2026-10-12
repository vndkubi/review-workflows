'use strict';
// Dashboard server: request guards and the ticket/gate endpoints. No model
// calls: the ticket below has an explicit acceptance-criteria section.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, scriptedExecutor } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-web-runs-');

const { createServer } = require('../src/web/server');
const { advanceTicket } = require('../src/lib/ticket-pipeline');
const { gateState, ticketDir } = require('../src/lib/runs');

const TOKEN = 't'.repeat(48);
const fakeQueue = { list: () => [], get: () => null, readLog: () => ({ text: '', next: 0 }), cancel: () => null, enqueue: (j) => ({ id: 'job1', ...j }) };

function call(port, method, url, { body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, headers: res.headers, json: res.headers.get('content-type').includes('json') ? await res.json() : null, text: res.headers.get('content-type').includes('html') ? await res.text() : null }));
}

test('dashboard server', async (t) => {
  const ticketFile = path.join(tmpDir(), 'T.md');
  fs.writeFileSync(ticketFile, '# WEB-1\n\n## Acceptance Criteria\n- Refunds over 500 need a second approver.\n');
  const refundModel = {
    schema_version: '1.0',
    ticket: 'WEB-1',
    features: [{
      id: 'F1',
      name: 'Refund approval',
      variables: [{ id: 'amount', description: 'refund amount', type: 'integer', classes: [
        { id: 'neg', label: 'negative', validity: 'invalid', max: '0', max_inclusive: false },
        { id: 'small', label: '0..500', validity: 'valid', min: '0', min_inclusive: true, max: '500', max_inclusive: true },
        { id: 'large', label: '> 500', validity: 'valid', min: '500', min_inclusive: false },
      ] }],
      outcomes: [{ id: 'approvers', description: 'approvers needed' }],
      rules: [
        { id: 'R1', conditions: [{ variable: 'amount', classes: ['large'] }], results: [{ outcome: 'approvers', value: '2' }], acs: ['AC1'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'Refunds over 500 need a second approver.' } },
        { id: 'R2', conditions: [{ variable: 'amount', classes: ['small'] }], results: [{ outcome: 'approvers', value: '1' }], acs: ['AC1'], label: 'INFERRED', source: { source: 'ticket', quote: '' } },
      ],
    }],
    other_acs: [],
    notes: '',
  };
  const exec = scriptedExecutor((prompt) => (prompt.startsWith('You audit') ? '{"missing":[],"invalid":[]}' : JSON.stringify(refundModel)));
  const res = await advanceTicket({ key: 'WEB-1', fromFile: ticketFile, executor: exec });
  assert.equal(res.state, 'AWAIT_GATE_SPEC', res.message);

  const server = createServer({ port: 0, token: TOKEN, queue: fakeQueue });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // createServer computed allowed hosts from port 0; rebuild with the real port.
  server.close();
  const real = createServer({ port, token: TOKEN, queue: fakeQueue });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  t.after(() => real.close());
  const auth = { 'X-ARW-Token': TOKEN };

  await t.test('page carries the token and a strict CSP', async () => {
    const r = await call(port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(TOKEN));
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('unexpected Host is refused (DNS rebinding)', async () => {
    // fetch() drops a custom Host header, so use a raw request.
    const status = await new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/api/runs', headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  await t.test('writes need the token and a same-origin request', async () => {
    const body = { gate: 'SPEC', decision: 'approved' };
    assert.equal((await call(port, 'POST', '/api/tickets/WEB-1/gate', { body })).status, 403);
    assert.equal((await call(port, 'POST', '/api/tickets/WEB-1/gate', { body, headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
    assert.equal(gateState(ticketDir('WEB-1'), 'SPEC').decision, 'NOT_RECORDED');
  });

  await t.test('runs and ticket detail', async () => {
    const runs = await call(port, 'GET', '/api/runs');
    assert.deepEqual(runs.json.tickets.map((x) => [x.key, x.state]), [['WEB-1', 'AWAIT_GATE_SPEC']]);
    assert.ok(runs.json.tickets[0].items >= 3);
    const d = await call(port, 'GET', '/api/tickets/WEB-1');
    assert.equal(d.json.requirements.items[0].risk, 'money');
    assert.equal((await call(port, 'GET', '/api/tickets/..%2F..%2Fetc')).status, 400);
  });

  await t.test('spec detail; a rejection needs a note; approval binds the spec', async () => {
    const d = await call(port, 'GET', '/api/tickets/WEB-1');
    assert.equal(d.json.spec.features[0].boundaries[0].at.join('|'), '-1|0');
    assert.ok(d.json.spec.features[0].boundaries.some((b) => b.at.join('|') === '500|501'));
    const noNote = await call(port, 'POST', '/api/tickets/WEB-1/gate', { body: { gate: 'SPEC', decision: 'rejected' }, headers: auth });
    assert.equal(noNote.status, 400);
    assert.equal((await call(port, 'PUT', '/api/tickets/WEB-1/requirements', { body: { items: [] }, headers: auth })).status, 404, 'no editing: approve or reject only');
    const ok = await call(port, 'POST', '/api/tickets/WEB-1/gate', { body: { gate: 'SPEC', decision: 'approved', note: 'checked' }, headers: auth });
    assert.equal(ok.status, 200);
    assert.match(ok.json.by, /\(dashboard\)$/);
    assert.equal(gateState(ticketDir('WEB-1'), 'SPEC').valid, true);
  });

  await t.test('job logs stream over SSE until the job ends', async () => {
    // A queue whose job writes its log in three steps, then finishes.
    let step = 0;
    const lines = ['$ node src/cli/arw.js review\n', 'start B1-business attempt=1 mode=full\n', 'accepted B1-business\n'];
    const job = { id: 'j1', kind: 'review', title: 'x', status: 'running' };
    const streamQueue = {
      ...fakeQueue,
      get: () => job,
      readLog: (id, from) => {
        const text = lines.slice(0, step).join('');
        return { text: text.slice(from), next: text.length, size: text.length };
      },
    };
    const srv = createServer({ port: port + 1, token: TOKEN, queue: streamQueue });
    await new Promise((r) => srv.listen(port + 1, '127.0.0.1', r));
    const timer = setInterval(() => {
      step += 1;
      if (step >= lines.length) {
        step = lines.length;
        job.status = 'succeeded';
        clearInterval(timer);
      }
    }, 150);
    try {
      const res = await fetch(`http://127.0.0.1:${port + 1}/api/jobs/j1/stream`);
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const body = await res.text(); // the server closes the stream after "end"
      const events = body.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => [b.match(/^event: (\w+)/)[1], JSON.parse(b.split('\ndata: ')[1])]);
      const logText = events.filter(([e]) => e === 'log').map(([, d]) => d.text).join('');
      assert.equal(logText, lines.join(''), 'every line arrives exactly once, in order');
      assert.deepEqual(events.filter(([e]) => e === 'status').map(([, d]) => d.status), ['running', 'succeeded']);
      assert.deepEqual(events[events.length - 1], ['end', { status: 'succeeded' }]);
    } finally {
      clearInterval(timer);
      srv.close();
    }
  });

  await t.test('run files are readable only inside their run', async () => {
    const ok = await call(port, 'GET', '/api/tickets/WEB-1/file?path=spec.md');
    assert.equal(ok.status, 200);
    assert.match(ok.json.text, /# Spec — WEB-1/);
    assert.equal((await call(port, 'GET', `/api/tickets/WEB-1/file?path=${encodeURIComponent('../../../package.json')}`)).status, 400);
    assert.equal((await call(port, 'GET', '/api/tickets/WEB-1/file?path=nope.md')).status, 404);
    const calls = await call(port, 'GET', '/api/tickets/WEB-1/calls');
    // (prompt.txt is written by the real codex runner; the scripted one does not)
    assert.ok(calls.json.some((c) => c.label === 'spec' && c.files.some((f) => f.endsWith('raw-candidate.txt'))), 'each call lists its attempt files');
    const intake = await call(port, 'GET', '/api/tickets/WEB-1/intake');
    assert.match(intake.json.source, /^file:/);
    const sys = await call(port, 'GET', '/api/system');
    assert.equal(sys.json.ticket_source.kind, 'file');
    assert.ok(!JSON.stringify(sys.json).includes('secret'), 'no secret values in the system view');
  });

  await t.test('reviews only for configured repositories', async () => {
    const r = await call(port, 'POST', '/api/reviews', { body: { repo: 'someone/else', pr: 1 }, headers: auth });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not in config\/repos\.json/);
  });
});
