'use strict';
// Ticket evidence through an MCP server (for machines that cannot reach Jira
// or Confluence directly). The server and its tool names come from
// config/mcp.json; defaults match the mcp-atlassian server. Everything a
// tool returns is evidence text, rendered for reading, never instructions.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson } = require('./util');
const { McpClient } = require('./mcp-client');
const { pageIdsIn } = require('./jira');

const MAX_PAGES = 10;
const MAX_PAGE_CHARS = 40000;

// Tool names and argument templates. {key}, {id} and {cql} are filled in.
const DEFAULT_TOOLS = {
  issue: { name: 'jira_get_issue', args: { issue_key: '{key}', comment_limit: 20 } },
  page: { name: 'confluence_get_page', args: { page_id: '{id}', convert_to_markdown: true } },
  search: { name: 'confluence_search', args: { query: 'type=page and text ~ "{key}"', limit: 5 } },
};

function configPath() {
  return process.env.ARW_MCP_CONFIG ? path.resolve(process.env.ARW_MCP_CONFIG) : path.join(ROOT, 'config', 'mcp.json');
}

// { server, tools } for the Atlassian server, or null when not configured.
function atlassianConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  const cfg = readJson(file);
  const server = cfg.atlassian;
  if (!server || (!server.command && !server.url)) return null;
  const tools = { ...DEFAULT_TOOLS };
  for (const [k, v] of Object.entries(server.tools || {})) tools[k] = v === null ? null : { ...DEFAULT_TOOLS[k], ...v };
  return { server: { name: 'atlassian', ...server }, tools };
}

function fillArgs(template, vars) {
  const fill = (v) => (typeof v === 'string' ? v.replace(/\{(key|id|cql)\}/g, (_, k) => vars[k] || '') : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
  return fill(template || {});
}

function tryJson(text) {
  const t = String(text || '').trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Generic JSON -> Markdown: long or multi-line strings become sections (they
// carry descriptions and tables), short values become list items.
function jsonToMarkdown(value, depth = 2, label = null) {
  const h = '#'.repeat(Math.min(depth, 6));
  if (value == null || value === '') return '';
  if (typeof value !== 'object') {
    const s = String(value);
    if (label == null) return s;
    return s.includes('\n') || s.length > 160 ? `${h} ${label}\n\n${s}\n` : `- ${label}: ${s}`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (value.every((v) => v == null || typeof v !== 'object')) return label ? `- ${label}: ${value.join(', ')}` : value.join(', ');
    const parts = value.map((v, i) => jsonToMarkdown(v, depth + 1, `${label || 'item'} ${i + 1}`)).filter(Boolean);
    return parts.join('\n\n');
  }
  // A nested object with only a name/value is just that value.
  const keys = Object.keys(value);
  for (const k of ['name', 'displayName', 'value']) {
    if (keys.length <= 3 && typeof value[k] === 'string' && label) return `- ${label}: ${value[k]}`;
  }
  const lines = [];
  const sections = [];
  for (const [k, v] of Object.entries(value)) {
    if (v == null || k === 'self' || k === 'avatarUrls' || k === 'iconUrl') continue;
    const md = jsonToMarkdown(v, depth + 1, k);
    if (!md) continue;
    (md.startsWith('- ') ? lines : sections).push(md);
  }
  const body = [...lines, ...(sections.length ? ['', ...sections] : [])].join('\n');
  return label ? `${h} ${label}\n\n${body}` : body;
}

function issueText(key, raw) {
  const json = tryJson(raw);
  if (!json) return `# ${key}\n\n${raw}\n`;
  const issue = json.issue || json;
  const title = issue.summary || (issue.fields && issue.fields.summary) || '';
  return `# ${key}: ${title}\n\n${jsonToMarkdown(issue, 2)}\n`;
}

function pageFrom(id, raw) {
  const json = tryJson(raw);
  if (!json) return { id: String(id), title: `page ${id}`, text: String(raw) };
  const meta = json.metadata || json;
  const title = meta.title || json.title || `page ${id}`;
  const content = (json.content && (json.content.value || json.content.markdown)) || json.body || json.markdown || json.text;
  const text = typeof content === 'string' ? content : jsonToMarkdown(json, 2);
  return { id: String(id), title, text };
}

function idsFromSearch(raw) {
  const json = tryJson(raw);
  if (!json) return pageIdsIn(raw);
  const list = Array.isArray(json) ? json : json.results || json.pages || [];
  return list.map((r) => String((r && (r.id || (r.content && r.content.id))) || '')).filter((id) => /^\d+$/.test(id));
}

async function fetchTicketEvidenceMcp(key, { log = () => {}, config = atlassianConfig() } = {}) {
  if (!config) throw new Error(`no MCP server configured in ${configPath()}`);
  const client = new McpClient(config.server, { timeoutMs: Number(process.env.ARW_MCP_TIMEOUT_MS) || 60000 });
  try {
    await client.connect();
    const t = config.tools;
    const raw = await client.callTool(t.issue.name, fillArgs(t.issue.args, { key }));
    const ticket = { key, text: issueText(key, raw) };
    const ids = new Set(pageIdsIn(raw));
    if (t.search) {
      try {
        idsFromSearch(await client.callTool(t.search.name, fillArgs(t.search.args, { key, cql: `type=page and text ~ "${key}"` }))).forEach((id) => ids.add(id));
      } catch (err) {
        log(`mcp: confluence search unavailable (${err.message})`);
      }
    }
    const pages = [];
    if (t.page) {
      for (const id of [...ids].slice(0, MAX_PAGES)) {
        try {
          const page = pageFrom(id, await client.callTool(t.page.name, fillArgs(t.page.args, { key, id })));
          pages.push({ ...page, text: `# Confluence: ${page.title}\n\n${page.text.slice(0, MAX_PAGE_CHARS)}\n` });
        } catch (err) {
          log(`mcp: page ${id} unavailable (${err.message})`);
        }
      }
    }
    return { ticket, pages, server: client.serverInfo };
  } finally {
    await client.close();
  }
}

// For `arw doctor`: can we connect, and do the mapped tools exist?
async function checkMcp(config = atlassianConfig()) {
  if (!config) return { configured: false };
  const client = new McpClient(config.server, { timeoutMs: 30000 });
  try {
    await client.connect();
    const names = new Set((await client.listTools()).map((tool) => tool.name));
    const missing = Object.entries(config.tools).filter(([, v]) => v && !names.has(v.name)).map(([k, v]) => `${k}=${v.name}`);
    return { configured: true, ok: missing.length === 0, server: client.serverInfo, tools: names.size, missing };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  } finally {
    await client.close();
  }
}

module.exports = { fetchTicketEvidenceMcp, checkMcp, atlassianConfig, jsonToMarkdown, issueText, pageFrom, idsFromSearch, fillArgs, DEFAULT_TOOLS };
