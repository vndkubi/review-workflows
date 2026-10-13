'use strict';
// Watcher: reviews open PRs of watched repositories when they are new or
// their head moves. A repository is watched when its config/repos.json entry
// has "watch": true. PRs that are drafts (unless "watch_drafts": true) or
// carry the label "arw:skip" are left alone. The state of what was queued
// lives in runs/watch/state.json, so a restart does not re-review.
const path = require('node:path');
const { readJsonIfExists, writeJsonAtomic, nowIso } = require('./util');
const { RUNS } = require('./runs');
const github = require('./github');

const SKIP_LABEL = 'arw:skip';

function stateFile() {
  return path.join(RUNS, 'watch', 'state.json');
}

function loadState() {
  return readJsonIfExists(stateFile(), { prs: {}, polls: [] });
}

function watchedRepos(repos = github.reposConfig().repos) {
  return Object.entries(repos).filter(([, r]) => r && r.watch).map(([name, r]) => ({ name, drafts: Boolean(r.watch_drafts) }));
}

function listOpenPrs(repo) {
  return JSON.parse(github.gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,headRefOid,isDraft,labels,author,updatedAt']));
}

// One poll. enqueue({ repo, pr, title, head }) starts a review; returns what
// was queued and why the rest was skipped.
function pollOnce({ enqueue, list = listOpenPrs, repos = watchedRepos(), log = () => {} }) {
  const state = loadState();
  const result = { at: nowIso(), queued: [], skipped: [], errors: [] };
  for (const repo of repos) {
    let prs;
    try {
      prs = list(repo.name);
    } catch (err) {
      result.errors.push(`${repo.name}: ${err.message.split('\n')[0]}`);
      continue;
    }
    for (const pr of prs) {
      const key = `${repo.name}#${pr.number}`;
      const labels = (pr.labels || []).map((l) => l.name || l);
      if (pr.isDraft && !repo.drafts) {
        result.skipped.push({ key, why: 'draft' });
        continue;
      }
      if (labels.includes(SKIP_LABEL)) {
        result.skipped.push({ key, why: `label ${SKIP_LABEL}` });
        continue;
      }
      const seen = state.prs[key];
      if (seen && seen.head === pr.headRefOid) continue;
      try {
        const job = enqueue({ repo: repo.name, pr: pr.number, title: pr.title, head: pr.headRefOid });
        state.prs[key] = { head: pr.headRefOid, queued_at: nowIso(), job: job && job.id, reason: seen ? 'new push' : 'new PR' };
        result.queued.push({ key, reason: state.prs[key].reason, head: pr.headRefOid.slice(0, 12) });
        log(`watch: queued ${key} (${state.prs[key].reason})`);
      } catch (err) {
        result.errors.push(`${key}: ${err.message}`);
      }
    }
  }
  state.polls = [{ at: result.at, queued: result.queued.length, errors: result.errors }, ...(state.polls || [])].slice(0, 20);
  writeJsonAtomic(stateFile(), state);
  return result;
}

// A loop for `arw watch` and the dashboard. Returns stop().
function startWatcher({ intervalMs, enqueue, log = () => {}, list }) {
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      pollOnce({ enqueue, log, list });
    } catch (err) {
      log(`watch: poll failed: ${err.message}`);
    }
    timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { pollOnce, startWatcher, watchedRepos, loadState, SKIP_LABEL };
