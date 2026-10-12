'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-mcp-runs-');

const { McpClient, interpolate } = require('../src/lib/mcp-client');
const { fetchTicketEvidenceMcp, checkMcp, DEFAULT_TOOLS, jsonToMarkdown } = require('../src/lib/ticket-mcp');
const { advanceTicket } = require('../src/lib/ticket-pipeline');
const { ticketDir } = require('../src/lib/runs');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const stdioConfig = { server: { name: 'atlassian', command: process.execPath, args: [FAKE] }, tools: DEFAULT_TOOLS };

test('stdio MCP: ticket plus linked and searched Confluence pages', async () => {
  const out = await fetchTicketEvidenceMcp('ACME-9', { config: stdioConfig });
  assert.equal(out.server.name, 'fake-atlassian');
  assert.match(out.ticket.text, /^# ACME-9: Refund approval/);
  assert.match(out.ticket.text, /## Acceptance Criteria\n- Refunds over 500 need a second approver\./, 'description keeps its structure');
  assert.match(out.ticket.text, /- status: Open/);
  assert.deepEqual(out.pages.map((p) => [p.id, p.title]).sort(), [['111', 'Refund rules'], ['222', 'Refund FAQ']]);
  assert.match(out.pages.find((p) => p.id === '111').text, /\| > 500 \| 2 \|/, 'Confluence tables survive');
});

test('MCP errors surface clearly; doctor reports missing tool mappings', async () => {
  await assert.rejects(fetchTicketEvidenceMcp('NOPE-1', { config: stdioConfig }), /jira_get_issue failed: Issue does not exist/);
  const ok = await checkMcp(stdioConfig);
  assert.equal(ok.ok, true);
  const bad = await checkMcp({ ...stdioConfig, tools: { ...DEFAULT_TOOLS, issue: { name: 'getJiraIssue', args: {} } } });
  assert.deepEqual(bad.missing, ['issue=getJiraIssue']);
  const dead = await checkMcp({ server: { command: process.execPath, args: ['-e', 'process.exit(3)'] }, tools: DEFAULT_TOOLS });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /exited/);
});

test('Streamable HTTP MCP: JSON and SSE responses, session id kept, auth header sent', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method === 'DELETE') return res.writeHead(204).end();
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'] || null, auth: req.headers.authorization });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'http-atlassian' } } }));
      }
      if (req.headers['mcp-session-id'] !== 'sess-1') return res.writeHead(400).end('missing session');
      if (msg.id == null) return res.writeHead(202).end();
      const result = msg.params.name === 'jira_get_issue'
        ? { content: [{ type: 'text', text: 'ACME-9 Refund approval\n\n## Acceptance Criteria\n- Refunds over 500 need a second approver.' }] }
        : { content: [{ type: 'text', text: '[]' }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.ARW_TEST_MCP_TOKEN = 'tok-123';
  const config = { server: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'Bearer ${ARW_TEST_MCP_TOKEN}' } }, tools: { ...DEFAULT_TOOLS, page: null } };
  const out = await fetchTicketEvidenceMcp('ACME-9', { config });
  assert.match(out.ticket.text, /Refunds over 500 need a second approver/);
  assert.equal(seen[0].session, null);
  assert.ok(seen.slice(1).every((s) => s.session === 'sess-1'));
  assert.ok(seen.every((s) => s.auth === 'Bearer tok-123'), 'headers interpolated from the environment');
});

test('pipeline intake uses MCP when config/mcp.json exists', async () => {
  const cfgFile = path.join(tmpDir(), 'mcp.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ atlassian: { command: process.execPath, args: [FAKE] } }));
  process.env.ARW_MCP_CONFIG = cfgFile;
  try {
    const res = await advanceTicket({ key: 'ACME-9', executor: null });
    assert.equal(res.state, 'FAILED', 'stops at the spec, which needs a model');
    const dir = ticketDir('ACME-9');
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.equal(run.stages.intake.source, 'mcp:fake-atlassian');
    assert.deepEqual(run.stages.intake.confluence_pages.map((p) => p.id).sort(), ['111', '222']);
    const req = JSON.parse(fs.readFileSync(path.join(dir, 'requirements.json'), 'utf8'));
    assert.equal(req.extraction, 'deterministic');
    assert.equal(req.items[0].evidence.quote, 'Refunds over 500 need a second approver.');
    assert.ok(fs.existsSync(path.join(dir, 'evidence', 'confluence-111.md')));
  } finally {
    delete process.env.ARW_MCP_CONFIG;
  }
});

test('config interpolation and JSON rendering helpers', () => {
  assert.deepEqual(interpolate({ a: '${ARW_X}-y', b: ['${ARW_MISSING}'] }, { ARW_X: '1' }), { a: '1-y', b: [''] });
  const md = jsonToMarkdown({ key: 'A-1', status: { name: 'Done' }, description: 'line 1\nline 2', labels: ['x', 'y'] });
  assert.match(md, /- key: A-1/);
  assert.match(md, /- status: Done/);
  assert.match(md, /- labels: x, y/);
  assert.match(md, /## description\n\nline 1\nline 2/);
  assert.ok(McpClient);
});
