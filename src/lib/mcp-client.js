'use strict';
// Minimal MCP client (JSON-RPC 2.0): stdio servers (a command, often
// `docker run -i ...`) and Streamable HTTP servers (one URL; JSON or SSE
// responses; Mcp-Session-Id kept across calls). No dependencies.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'agent-review-workflows', version: '0.1.0' };

// "${VAR}" in config values comes from the environment; secrets stay in .env.
function interpolate(value, env = process.env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => env[k] || '');
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}

// Windows: run .exe directly; .cmd/.bat shims (npx, uvx) need a shell, so
// their arguments are quoted here rather than joined raw.
function resolveCommand(command, args) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|com)$/i.test(command)) return { file: command, args, shell: false };
  const exts = /\.(cmd|bat)$/i.test(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      if (!fs.existsSync(full)) continue;
      if (/\.(exe|com)$/i.test(full)) return { file: full, args, shell: false };
      const quoted = [full, ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ');
      return { file: quoted, args: [], shell: true };
    }
  }
  return { file: command, args, shell: false };
}

class StdioTransport {
  constructor({ command, args = [], env = {}, cwd, timeoutMs }) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    const r = resolveCommand(command, args);
    this.child = spawn(r.file, r.args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: r.shell });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => {
      if (this.stderr.length < 20000) this.stderr += d;
    });
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => {
        this.failAll(new Error(`MCP server failed to start: ${err.message}`));
        resolve();
      });
      this.child.on('exit', (code) => {
        this.failAll(new Error(`MCP server exited (${code}): ${this.stderr.trim().split('\n').slice(-3).join(' | ')}`));
        resolve();
      });
    });
  }

  onData(d) {
    this.buffer += d;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id != null && this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (message.id != null) {
        const timer = setTimeout(() => {
          this.pending.delete(message.id);
          reject(new Error(`MCP request ${message.method} timed out after ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        this.pending.set(message.id, { resolve, reject, timer });
      }
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) reject(err);
        else if (message.id == null) resolve(null);
      });
    });
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* closed */
    }
    const t = setTimeout(() => this.child.kill(), 3000);
    await this.exited;
    clearTimeout(t);
  }
}

class HttpTransport {
  constructor({ url, headers = {}, timeoutMs }) {
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
  }

  async send(message) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (message.id == null) return null;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} for ${message.method}: ${(await res.text()).slice(0, 300)}`);
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    if (type.includes('text/event-stream')) {
      // Take the JSON-RPC response for our id from the SSE stream.
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === message.id) return msg;
        } catch {
          /* not JSON */
        }
      }
      throw new Error(`MCP HTTP: no response for ${message.method} in the event stream`);
    }
    return JSON.parse(body);
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...this.headers }, signal: AbortSignal.timeout(5000) });
    } catch {
      /* best effort */
    }
  }
}

class McpClient {
  constructor(server, { timeoutMs = 60000 } = {}) {
    const cfg = interpolate(server);
    this.name = cfg.name || 'mcp';
    this.transport = cfg.transport === 'http' || cfg.url ? new HttpTransport({ url: cfg.url, headers: cfg.headers, timeoutMs }) : new StdioTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd, timeoutMs });
    this.nextId = 1;
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = await this.transport.send({ jsonrpc: '2.0', id, method, params });
    if (msg.error) throw new Error(`MCP ${method} error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  async connect() {
    const result = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.serverInfo = result.serverInfo || null;
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  // Returns the tool's text (text parts joined; structuredContent as JSON).
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 300)}`);
    return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '');
  }

  close() {
    return this.transport.close();
  }
}

module.exports = { McpClient, interpolate, PROTOCOL_VERSION };
