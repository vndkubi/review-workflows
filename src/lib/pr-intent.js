'use strict';
// The intent of a PR that has no ticket, read from what its author wrote:
// title, description, the issues and PRs it links to, and commit messages.
// Never the diff: a spec read from the code only restates the code, and every
// defect would match it. The result is the author's claim, so it goes through
// the usual requirements -> spec -> SPEC gate and a person confirms it.
const { execFileSync } = require('node:child_process');
const { envInt } = require('./util');

// A ticket key for the PR: PR<NAME>-<number>, NAME from the repository name.
function prTicketKey(repo, pr) {
  const name = String(repo).split('/').pop().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
  return `PR${name}-${Number(pr)}`;
}

// Issues and PRs the description refers to, in order, without the PR itself.
// relation: "fixes" for fixes/closes/resolves, else "mentions".
function linkedRefs(body, repo, self) {
  const out = [];
  const seen = new Set([`${repo}#${self}`.toLowerCase()]);
  const add = (r, n, before) => {
    const key = `${r}#${n}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ repo: r, number: Number(n), relation: /\b(fix(e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*$/i.test(before) ? 'fixes' : 'mentions' });
  };
  const text = String(body || '');
  const re = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/])([\w.-]+\/[\w.-]+)#(\d+)|(?<![\w/&])#(\d+)\b/g;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (m[1]) add(m[1], m[2], before);
    else if (m[3]) add(m[3], m[4], before);
    else add(repo, m[5], before);
  }
  return out;
}

// { title, body, state, url } of an issue or PR through gh, or null.
async function ghIssue(repo, number) {
  const out = execFileSync('gh', ['api', `repos/${repo}/issues/${number}`, '--jq', '{title, body, state, url: .html_url}'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// Commit subjects and bodies between base and head, oldest first.
function commitMessages(checkout, base, head) {
  const git = require('./git');
  const out = git.git(checkout, ['log', '--reverse', '--no-merges', '--format=%B%x00', `${base}..${head}`]);
  return out.split('\0').map((s) => s.trim()).filter(Boolean);
}

// { text, linked: [{ key, relation, text }], notes } for the ticket intake.
async function prIntentEvidence({ repo, pr, info, commits = [], fetchIssue = ghIssue, limit = envInt('ARW_LINKED_ISSUES', 5) }) {
  const lines = [
    `# ${repo}#${pr}: ${info.title}`,
    '',
    `Source: the pull request description written by the author of the change${info.url ? ` (${info.url})` : ''}. It states what the author intends the change to do; it is not an independent requirement.`,
    '',
    '## Description',
    '',
    String(info.body || '').trim() || '(empty)',
  ];
  commits = commits.filter((c) => !/^Merge (remote-tracking )?branch |^Merge pull request /.test(String(c)));
  if (commits.length) lines.push('', '## Commit messages', '', ...commits.map((c) => `- ${String(c).split(/\r?\n/).filter(Boolean).join(' / ')}`));
  const linked = [];
  const notes = [];
  for (const ref of linkedRefs(info.body, repo, pr).slice(0, limit)) {
    let issue = null;
    try {
      issue = await fetchIssue(ref.repo, ref.number);
    } catch (err) {
      notes.push(`${ref.repo}#${ref.number} could not be read: ${String(err.message || err).split('\n')[0]}`);
      continue;
    }
    if (!issue) continue;
    linked.push({
      key: `${ref.repo.replace(/[^A-Za-z0-9]+/g, '-')}-${ref.number}`,
      relation: ref.relation,
      text: [`# ${ref.repo}#${ref.number}: ${issue.title}`, '', `${ref.relation === 'fixes' ? 'Fixed' : 'Mentioned'} by ${repo}#${pr}${issue.state ? ` · ${issue.state}` : ''}${issue.url ? ` · ${issue.url}` : ''}`, '', String(issue.body || '').trim() || '(empty)'].join('\n'),
    });
  }
  return { text: `${lines.join('\n')}\n`, linked, notes };
}

// Commit messages of a PR through gh (when there is no local checkout).
function ghCommits(repo, pr) {
  const out = execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'commits', '--jq', '[.commits[] | (.messageHeadline + "\\n" + .messageBody)]'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).map((s) => s.trim()).filter(Boolean);
}

function enabled() {
  return process.env.ARW_PR_INTENT !== 'off';
}

module.exports = { prTicketKey, linkedRefs, prIntentEvidence, commitMessages, ghIssue, ghCommits, enabled };
