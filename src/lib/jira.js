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

module.exports = { extractTicketKey, fetchJiraIssue, renderIssue, wikiToMarkdown, adfToText };
