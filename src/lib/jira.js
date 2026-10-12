'use strict';
// Ticket intake: Jira REST (Server/DC with a PAT, or Cloud with email + API
// token) or a local Markdown/text file. Output is evidence text, not truth.

const TICKET_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

function extractTicketKey(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(TICKET_KEY);
    if (m) return m[1];
  }
  return null;
}

// Jira wiki markup -> Markdown, enough for headings and lists.
function wikiToMarkdown(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const heading = line.match(/^h([1-6])\.\s*(.*)$/);
      if (heading) return `${'#'.repeat(Number(heading[1]))} ${heading[2]}`;
      return line
        .replace(/^(#+)\s+/, (_, hashes) => `${'   '.repeat(hashes.length - 1)}1. `)
        .replace(/^(\*+)\s+/, (_, stars) => `${'  '.repeat(stars.length - 1)}- `)
        .replace(/\{code(?::[^}]*)?\}/g, '```')
        .replace(/\{noformat\}/g, '```');
    })
    .join('\n');
}

// Atlassian Document Format (Cloud v3) -> plain Markdown-ish text.
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const kids = (node.content || []).map(adfToText);
  switch (node.type) {
    case 'text':
      return node.text || '';
    case 'heading':
      return `${'#'.repeat((node.attrs && node.attrs.level) || 2)} ${kids.join('')}\n`;
    case 'paragraph':
      return `${kids.join('')}\n`;
    case 'bulletList':
      return kids.map((k) => `- ${k.trim()}`).join('\n') + '\n';
    case 'orderedList':
      return kids.map((k) => `1. ${k.trim()}`).join('\n') + '\n';
    case 'taskList':
      return kids.map((k) => `- [ ] ${k.trim()}`).join('\n') + '\n';
    case 'codeBlock':
      return `\`\`\`\n${kids.join('')}\n\`\`\`\n`;
    case 'hardBreak':
      return '\n';
    default:
      return kids.join('');
  }
}

function fieldText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return wikiToMarkdown(value);
  if (typeof value === 'object' && value.type === 'doc') return adfToText(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(', ');
  if (typeof value === 'object') return value.name || value.value || value.displayName || '';
  return String(value);
}

function authHeader() {
  if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
    return `Basic ${Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`;
  }
  if (process.env.JIRA_PAT) return `Bearer ${process.env.JIRA_PAT}`;
  return null;
}

async function fetchJiraIssue(key) {
  const base = (process.env.JIRA_URL || '').replace(/\/+$/, '');
  const auth = authHeader();
  if (!base || !auth) throw new Error('Jira is not configured (JIRA_URL plus JIRA_PAT, or JIRA_EMAIL + JIRA_API_TOKEN)');
  const url = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?expand=names`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jira ${res.status} for ${key}: ${(await res.text()).slice(0, 300)}`);
  const issue = await res.json();
  return renderIssue(issue);
}

function renderIssue(issue) {
  const f = issue.fields || {};
  const names = issue.names || {};
  const out = [`# ${issue.key}: ${f.summary || ''}`, ''];
  out.push(`- type: ${fieldText(f.issuetype)} · status: ${fieldText(f.status)} · priority: ${fieldText(f.priority)}`);
  if (f.labels && f.labels.length) out.push(`- labels: ${f.labels.join(', ')}`);
  if (f.components && f.components.length) out.push(`- components: ${fieldText(f.components)}`);
  out.push('', '## Description', '', fieldText(f.description) || '(empty)');
  // Acceptance criteria often live in a custom field.
  for (const [id, name] of Object.entries(names)) {
    if (/acceptance|criteria|definition of done/i.test(name) && f[id]) out.push('', '## Acceptance Criteria', '', fieldText(f[id]));
  }
  const links = (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    return other ? `- ${(l.type && (l.outwardIssue ? l.type.outward : l.type.inward)) || 'relates to'} ${other.key}: ${other.fields && other.fields.summary}` : null;
  });
  if (links.filter(Boolean).length) out.push('', '## Links', '', ...links.filter(Boolean));
  const comments = ((f.comment && f.comment.comments) || []).slice(-20);
  if (comments.length) {
    out.push('', '## Comments (latest 20)', '');
    for (const c of comments) out.push(`### ${fieldText(c.author)} — ${c.created}`, '', fieldText(c.body), '');
  }
  return { key: issue.key, summary: f.summary || '', text: `${out.join('\n')}\n` };
}

// ---------- Confluence ----------
const MAX_PAGES = 10;
const MAX_PAGE_CHARS = 40000;

function confluenceAuth() {
  if (process.env.CONFLUENCE_PAT) return `Bearer ${process.env.CONFLUENCE_PAT}`;
  const email = process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;
  if (email && token) return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return null;
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ge: '≥', le: '≤', ne: '≠', rarr: '→', larr: '←',
    hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', plusmn: '±',
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] != null ? named[e.toLowerCase()] : m;
  });
}

// Confluence storage format (XHTML) -> Markdown-ish text that keeps the
// structure spec tables come from: headings, lists, table rows.
function storageToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<ac:structured-macro[^>]*ac:name="(?:toc|children|jira)"[\s\S]*?<\/ac:structured-macro>/g, '')
      .replace(/<h([1-6])[^>]*>/g, (_, n) => `\n${'#'.repeat(Number(n))} `)
      .replace(/<\/h[1-6]>/g, '\n')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<tr[^>]*>/g, '\n|')
      .replace(/<\/t[dh]>/g, ' |')
      .replace(/<(br|\/p|\/div|\/ul|\/ol|\/table)[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pageIdsIn(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/pageId=(\d+)|\/pages\/(\d+)/g)) ids.add(m[1] || m[2]);
  return [...ids];
}

async function getJson(url, auth) {
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${url.replace(/\?.*$/, '')}`);
  return res.json();
}

// Ticket plus the Confluence pages it links to or that mention its key.
// Confluence problems are logged and never block the ticket.
async function fetchTicketEvidence(key, { log = () => {} } = {}) {
  const ticket = await fetchJiraIssue(key);
  const pages = [];
  const base = (process.env.CONFLUENCE_URL || '').replace(/\/+$/, '');
  const auth = confluenceAuth();
  if (!base || !auth) return { ticket, pages };
  const ids = new Set(pageIdsIn(ticket.text));
  try {
    const jiraBase = process.env.JIRA_URL.replace(/\/+$/, '');
    const links = await getJson(`${jiraBase}/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`, authHeader());
    for (const l of links) pageIdsIn((l.object && l.object.url) || '').forEach((id) => ids.add(id));
  } catch (err) {
    log(`confluence: remote links unavailable (${err.message})`);
  }
  if (process.env.ARW_CONFLUENCE_SEARCH !== '0') {
    try {
      const cql = encodeURIComponent(`type=page and text ~ "${key}"`);
      const found = await getJson(`${base}/rest/api/content/search?cql=${cql}&limit=5`, auth);
      for (const r of found.results || []) ids.add(String(r.id));
    } catch (err) {
      log(`confluence: search unavailable (${err.message})`);
    }
  }
  for (const id of [...ids].slice(0, MAX_PAGES)) {
    try {
      const page = await getJson(`${base}/rest/api/content/${id}?expand=body.storage,version`, auth);
      const body = storageToText(page.body && page.body.storage && page.body.storage.value).slice(0, MAX_PAGE_CHARS);
      pages.push({ id: String(id), title: page.title, text: `# Confluence: ${page.title}\n\n${body}\n` });
    } catch (err) {
      log(`confluence: page ${id} unavailable (${err.message})`);
    }
  }
  return { ticket, pages };
}

module.exports = { extractTicketKey, fetchJiraIssue, fetchTicketEvidence, renderIssue, wikiToMarkdown, adfToText, storageToText, pageIdsIn };
