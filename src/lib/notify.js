'use strict';
// Notifications when a review finishes: a Slack incoming webhook and/or a
// generic JSON webhook. Off unless a URL is configured. The message carries
// finding titles, so it leaves this machine: point it at a channel the
// reviewed code may be discussed in.
//   ARW_SLACK_WEBHOOK   Slack incoming webhook URL
//   ARW_NOTIFY_WEBHOOK  any URL that accepts a JSON POST
//   ARW_NOTIFY_ON       all | findings | blocking   (default findings)
const { SEVERITY_RANK } = require('./cluster');

function checkUrl(raw) {
  const u = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('webhooks must use https (http only for localhost)');
  return u.toString();
}

function shownFindings(validation) {
  return (validation.findings || [])
    .filter((f) => f.state !== 'withdrawn' && f.canonical !== false)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function shouldNotify(validation, on = process.env.ARW_NOTIFY_ON || 'findings') {
  if (on === 'all') return true;
  const shown = shownFindings(validation);
  if (on === 'blocking') return shown.some((f) => ['P1', 'P2'].includes(f.severity)) || validation.status !== 'EXECUTED_PASS';
  return shown.length > 0 || validation.status !== 'EXECUTED_PASS';
}

function summary({ identity, validation, link }) {
  const shown = shownFindings(validation);
  const counts = ['P1', 'P2', 'P3', 'P4'].map((s) => [s, shown.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  return {
    event: 'review.finished',
    repo: identity.repo,
    pr: identity.pr,
    title: identity.title,
    url: identity.url || null,
    head: identity.head_sha,
    local: Boolean(identity.local),
    status: validation.status,
    complete: validation.complete,
    recommendation: validation.recommendation,
    counts: Object.fromEntries(counts),
    findings: shown.slice(0, 10).map((f) => ({ id: f.id, severity: f.severity, label: f.label, title: f.title })),
    link: link || null,
  };
}

function slackText(s) {
  const head = `*${s.repo}#${s.pr}* ${s.title || ''}${s.url ? ` <${s.url}|open PR>` : ''}`;
  const counts = Object.entries(s.counts).map(([k, n]) => `${k}: ${n}`).join(' · ') || 'no findings';
  const lines = [head, `${s.status}${s.complete ? '' : ' (incomplete)'} · recommendation *${s.recommendation}* · ${counts}`];
  for (const f of s.findings.slice(0, 5)) lines.push(`• [${f.severity}] ${f.title}${f.label === 'CONFIRMED' ? ' _(reproduced)_' : ''}`);
  if (s.link) lines.push(s.link);
  lines.push('_Draft by the review runtime; a person decides._');
  return lines.join('\n');
}

async function post(url, body, timeoutMs = 10000) {
  const res = await fetch(checkUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Never throws: a failed notification is logged, the review stands.
async function notifyReview({ identity, validation, link, log = () => {} }) {
  const slack = process.env.ARW_SLACK_WEBHOOK;
  const hook = process.env.ARW_NOTIFY_WEBHOOK;
  const sent = [];
  if ((!slack && !hook) || !shouldNotify(validation)) return sent;
  const s = summary({ identity, validation, link });
  for (const [name, url, body] of [['slack', slack, { text: slackText(s) }], ['webhook', hook, s]]) {
    if (!url) continue;
    try {
      await post(url, body);
      sent.push(name);
      log(`notified ${name}`);
    } catch (err) {
      log(`notification to ${name} failed: ${err.message}`);
    }
  }
  return sent;
}

module.exports = { notifyReview, summary, slackText, shouldNotify, checkUrl };
