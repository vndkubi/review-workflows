'use strict';
// Dashboard server: request guards and the ticket/gate endpoints. No model
// calls: the ticket below has an explicit acceptance-criteria section.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

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
  const res = await advanceTicket({ key: 'WEB-1', fromFile: ticketFile, executor: null });
  assert.equal(res.state, 'AWAIT_GATE_REQUIREMENTS');

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
    const body = { gate: 'REQUIREMENTS', decision: 'approved' };
    assert.equal((await call(port, 'POST', '/api/tickets/WEB-1/gate', { body })).status, 403);
    assert.equal((await call(port, 'POST', '/api/tickets/WEB-1/gate', { body, headers: { ...auth, Origin: 'http://evil.example' } })).status, 403);
    assert.equal(gateState(ticketDir('WEB-1'), 'REQUIREMENTS').decision, 'NOT_RECORDED');
  });

  await t.test('runs and ticket detail', async () => {
    const runs = await call(port, 'GET', '/api/runs');
    assert.deepEqual(runs.json.tickets.map((x) => [x.key, x.state, x.items]), [['WEB-1', 'AWAIT_GATE_REQUIREMENTS', 1]]);
    const d = await call(port, 'GET', '/api/tickets/WEB-1');
    assert.equal(d.json.requirements.items[0].risk, 'money');
    assert.equal((await call(port, 'GET', '/api/tickets/..%2F..%2Fetc')).status, 400);
  });

  await t.test('requirements edits are schema-checked, then the gate binds the edit', async () => {
    const d = await call(port, 'GET', '/api/tickets/WEB-1');
    const bad = await call(port, 'PUT', '/api/tickets/WEB-1/requirements', { body: { items: [{ id: 'X' }] }, headers: auth });
    assert.equal(bad.status, 422);
    const items = d.json.requirements.items.map((i) => ({ ...i, then: 'a second approver must approve refunds over 500' }));
    assert.equal((await call(port, 'PUT', '/api/tickets/WEB-1/requirements', { body: { items }, headers: auth })).status, 200);
    const ok = await call(port, 'POST', '/api/tickets/WEB-1/gate', { body: { gate: 'REQUIREMENTS', decision: 'approved', note: 'checked' }, headers: auth });
    assert.equal(ok.status, 200);
    assert.match(ok.json.by, /\(dashboard\)$/);
    assert.equal(gateState(ticketDir('WEB-1'), 'REQUIREMENTS').valid, true);
  });

  await t.test('reviews only for configured repositories', async () => {
    const r = await call(port, 'POST', '/api/reviews', { body: { repo: 'someone/else', pr: 1 }, headers: auth });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not in config\/repos\.json/);
  });
});
