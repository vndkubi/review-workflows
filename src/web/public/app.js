'use strict';
// arw dashboard. All data is rendered through text nodes (h()), never
// innerHTML: findings, quotes and ticket text are untrusted content.

const TOKEN = document.querySelector('meta[name="arw-token"]').content;
const $main = document.getElementById('main');
const $sidebar = document.getElementById('sidebar');
const state = { config: null, runs: { tickets: [], prs: [] }, jobs: [], route: '', viewTimer: null, streams: [], timers: [], filters: { sev: new Set(['P1', 'P2', 'P3', 'P4']), hideDupes: true, showWithdrawn: false } };

// ---------- helpers ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// DOM insertion that flattens nested arrays and skips null/false, so view
// functions can return mixed lists. Native replaceChildren() would print them.
function nodes(kids) {
  return kids.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

function put(el, ...kids) {
  el.replaceChildren(...nodes(kids));
  return el;
}

function add(el, ...kids) {
  el.append(...nodes(kids));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ARW-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  return n == null ? '–' : Number(n).toLocaleString();
}

function fmtMs(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function statusBadge(status) {
  const cls = /PASS|READY|CONFIRMED|succeeded|approved|no_blocking/.test(status) ? 'ok' : /FAIL|BLOCKED|INVALID|EXCEEDED|failed|rejected|changes_requested/.test(status) ? 'bad' : 'warn';
  return h('span', { class: `badge ${cls}` }, status || '–');
}

function sevCounts(c) {
  if (!c) return null;
  return h('span', { class: 'row' }, ['P1', 'P2', 'P3'].filter((s) => c[s]).map((s) => h('span', { class: `badge ${s}` }, `${s} ${c[s]}`)));
}

function section(title, ...children) {
  return [h('h2', {}, title), ...children];
}

// ---------- chrome ----------
async function loadConfig() {
  state.config = await api('GET', '/api/config');
  const c = state.config;
  const chips = document.getElementById('config');
  put(chips, 
    h('span', { class: 'chip', title: 'review model' }, c.model),
    c.judge_model !== c.model ? h('span', { class: 'chip', title: 'judge model' }, `judge ${c.judge_model}`) : null,
    h('span', { class: 'chip' }, `effort ${c.effort || 'default'}`),
    h('span', { class: 'chip' }, c.language),
    h('span', { class: 'chip' }, `workers ${c.workers}`),
  );
}

async function refreshSidebar() {
  try {
    state.runs = await api('GET', '/api/runs');
  } catch (err) {
    return;
  }
  const route = location.hash;
  const prItems = state.runs.prs.map((p) =>
    h('a', { class: `side-item${route === `#/pr/${p.id}` ? ' active' : ''}`, href: `#/pr/${p.id}` },
      h('div', { class: 'line1' }, `${p.repo}#${p.pr}`, sevCounts(p.counts)),
      h('div', { class: 'line2' }, p.recommendation ? `${p.recommendation} · ` : '', p.title || '')),
  );
  const ticketItems = state.runs.tickets.map((t) =>
    h('a', { class: `side-item${route === `#/ticket/${t.key}` ? ' active' : ''}`, href: `#/ticket/${t.key}` },
      h('div', { class: 'line1' }, t.key),
      h('div', { class: 'line2' }, `${t.state} · ${t.items} items`)),
  );
  put($sidebar, 
    h('div', { class: 'side-title' }, 'Pull requests'),
    prItems.length ? prItems : h('div', { class: 'side-empty' }, 'No reviews yet.'),
    h('div', { class: 'side-title' }, 'Tickets'),
    ticketItems.length ? ticketItems : h('div', { class: 'side-empty' }, 'No tickets yet.'),
  );
}

async function refreshJobs() {
  try {
    const before = new Map(state.jobs.map((j) => [j.id, j.status]));
    state.jobs = await api('GET', '/api/jobs');
    const running = state.jobs.find((j) => j.status === 'running');
    const queued = state.jobs.filter((j) => j.status === 'queued').length;
    const ind = document.getElementById('jobs-indicator');
    ind.classList.toggle('running', Boolean(running));
    ind.textContent = running ? `Running: ${running.kind} ${running.title}${queued ? ` (+${queued})` : ''}` : queued ? `Jobs (${queued} queued)` : 'Jobs';
    for (const j of state.jobs) {
      const prev = before.get(j.id);
      if (prev && prev !== j.status && !['queued', 'running'].includes(j.status)) {
        toast(`${j.kind} ${j.title}: ${j.status}`);
        refreshSidebar();
        if (j.target && location.hash === targetHash(j.target)) render();
      }
    }
  } catch {
    /* server restarting */
  }
}

function targetHash(t) {
  return t.type === 'pr' ? `#/pr/${t.id}` : t.type === 'ticket' ? `#/ticket/${t.key}` : '#/settings';
}

async function startJob(promise, label) {
  try {
    const job = await promise;
    toast(`${label} queued`);
    await refreshJobs();
    // Land on the page the job works on: its Live panel streams the log.
    const target = job.target ? targetHash(job.target) : `#/job/${job.id}`;
    if (location.hash === target) render();
    else location.hash = target;
  } catch (err) {
    toast(err.message);
  }
}

// ---------- router ----------
async function render() {
  clearInterval(state.viewTimer);
  closeStreams();
  const hash = location.hash || '#/';
  state.route = hash;
  const [, view, arg] = hash.match(/^#\/([^/]*)\/?(.*)$/) || [];
  refreshSidebar();
  try {
    if (view === 'pr') await renderPr(decodeURIComponent(arg));
    else if (view === 'ticket') await renderTicket(decodeURIComponent(arg));
    else if (view === 'publish') await openPublish(await api('GET', `/api/prs/${encodeURIComponent(decodeURIComponent(arg))}`));
    else if (view === 'new-review') renderNewReview();
    else if (view === 'new-ticket') renderNewTicket();
    else if (view === 'jobs') renderJobs();
    else if (view === 'job') renderJob(arg);
    else if (view === 'settings' || view === 'system') await renderSettings();
    else renderHome();
  } catch (err) {
    put($main, h('div', { class: 'notice bad' }, err.message));
  }
  $main.focus({ preventScroll: true });
}

function renderHome() {
  const prs = state.runs.prs;
  const open = prs.reduce((n, p) => n + (p.counts ? p.counts.P1 + p.counts.P2 : 0), 0);
  const acceptance = h('div', {});
  put($main,
    h('h1', {}, 'Reviews and tickets'),
    h('p', { class: 'muted' }, 'Models propose; the runtime validates every quote; you decide at the gates.'),
    h('div', { class: 'stats' },
      stat(prs.length, 'PR reviews'),
      stat(state.runs.tickets.length, 'tickets'),
      stat(open, 'open P1/P2'),
      stat(state.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length, 'active jobs')),
    !state.config.repos.length ? h('div', { class: 'notice' }, 'No repositories configured. Copy config/repos.example.json to config/repos.json and map owner/name to a local clone.') : null,
    ...section('Recent reviews', prs.length ? prTable(prs.slice(0, 15)) : h('p', { class: 'muted' }, 'Start one with “New review”.')),
    acceptance,
  );
  api('GET', '/api/acceptance').then((s) => put(acceptance, acceptanceView(s))).catch(() => {});
}

// Of the findings a person decided on (submitted GitHub reviews read back),
// how many they kept. Low acceptance in a group points at noise to fix.
function acceptanceView(s) {
  const t = s.total;
  if (!t.kept && !t.edited && !t.dropped) {
    return section('Acceptance', h('p', { class: 'muted small' }, 'No feedback yet. After you submit a published review on GitHub, use “Read back from GitHub” on the review page.'));
  }
  const rows = [];
  for (const [group, buckets] of Object.entries(s.groups)) {
    for (const [k, c] of Object.entries(buckets).sort()) rows.push([group, k, c.kept, c.edited, c.dropped, c.rate == null ? '–' : `${c.rate}%`]);
  }
  return section('Acceptance',
    h('div', { class: 'stats' }, stat(t.rate == null ? '–' : `${t.rate}%`, 'kept or edited'), stat(t.kept, 'kept'), stat(t.edited, 'edited'), stat(t.dropped, 'dropped'), stat(s.runs.length, 'reviews read back')),
    table(['By', 'Group', 'Kept', 'Edited', 'Dropped', 'Acceptance'], rows));
}

function stat(n, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'n' }, fmtNum(n)), h('div', { class: 'l' }, label));
}

function prTable(prs) {
  return h('table', {},
    h('thead', {}, h('tr', {}, ['PR', 'Title', 'Status', 'Recommendation', 'Open', 'Confirmed', 'Calls', 'Tokens in / out', 'Updated'].map((c) => h('th', {}, c)))),
    h('tbody', {}, prs.map((p) => h('tr', {},
      h('td', {}, h('a', { href: `#/pr/${p.id}` }, `${p.repo}#${p.pr}`), activeJobFor('pr', p.id) ? h('span', { class: 'pulse' }) : null),
      h('td', {}, p.title || ''),
      h('td', {}, statusBadge(p.status)),
      h('td', {}, p.recommendation ? statusBadge(p.recommendation) : '–'),
      h('td', {}, sevCounts(p.counts) || '–'),
      h('td', {}, p.confirmed ? h('span', { class: 'badge ok' }, `${p.confirmed} CONFIRMED`) : '–'),
      h('td', {}, p.usage ? fmtNum(p.usage.calls) : '–'),
      h('td', { class: 'small' }, p.usage ? `${fmtNum(p.usage.tokens_in)} / ${fmtNum(p.usage.tokens_out)}` : '–'),
      h('td', { class: 'muted small' }, fmtTime(p.updated_at))))));
}

// ---------- PR view ----------
async function renderPr(id) {
  const [d, repro] = await Promise.all([api('GET', `/api/prs/${encodeURIComponent(id)}`), api('GET', `/api/prs/${encodeURIComponent(id)}/repro`).catch(() => [])]);
  d.reproRecords = new Map(repro.map((r) => [r.finding_id, r]));
  const v = d.validation;
  const idn = d.identity;
  const job = activeJobFor('pr', id);
  const tabs = ['Findings', 'Items', 'Progress', 'Calls', 'Timeline', 'Overview', 'Plan', 'Cost'];
  const current = sessionStorage.getItem('pr-tab') || 'Findings';
  const body = h('div', {});
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map((t) =>
    h('button', { class: `tab${t === current ? ' active' : ''}`, role: 'tab', onclick: () => { sessionStorage.setItem('pr-tab', t); render(); } }, t)));

  put($main, 
    h('h1', {}, idn.title || `${idn.repo}#${idn.pr}`),
    h('div', { class: 'row muted small' },
      idn.url ? h('a', { href: idn.url, target: '_blank', rel: 'noopener noreferrer' }, `${idn.repo}#${idn.pr}`) : h('span', {}, `${idn.repo}#${idn.pr}`),
      h('span', { class: 'mono' }, `head ${String(idn.head_sha || '').slice(0, 12)}`),
      h('span', { class: 'mono' }, `base ${String(idn.base_sha || '').slice(0, 12)}`),
      idn.ticket ? h('a', { href: `#/ticket/${idn.ticket}` }, idn.ticket) : h('span', {}, 'no ticket')),
    job ? livePanel(job, () => prProgressView(id)) : null,
    v ? prSummary(d) : job ? null : h('div', { class: 'notice' }, 'This review has no validation yet.'),
    prActions(d),
    tabBar,
    body,
  );
  // Progress, calls and timeline are useful while a run is still going.
  if (current === 'Progress') return add(body, await prProgressView(id));
  if (current === 'Calls') return add(body, await callsView(id));
  if (current === 'Timeline') return add(body, timelineView(d));
  if (current === 'Plan') return add(body, h('pre', { class: 'code' }, d.plan || 'No plan yet.'));
  if (!v) return add(body, h('p', { class: 'muted' }, 'Results appear here once the run is validated.'));
  if (current === 'Findings') add(body, findingsView(d));
  else if (current === 'Overview') add(body, overviewView(d));
  else if (current === 'Items') add(body, itemsView(d));
  else add(body, costView(d), unitsView(d));
}

function prSummary(d) {
  const v = d.validation;
  const c = v.counts;
  return h('div', {},
    h('div', { class: 'row my10' },
      statusBadge(v.status), statusBadge(v.recommendation), h('span', { class: `badge ${v.complete ? 'ok' : 'warn'}` }, v.complete ? 'complete' : 'incomplete'),
      h('span', { class: 'muted small' }, `context ${v.context_id} · validated ${fmtTime(v.validated_at)}`)),
    h('div', { class: 'stats' }, stat(c.P1, 'P1'), stat(c.P2, 'P2'), stat(c.P3, 'P3'), stat(c.P4, 'P4'), stat(c.withdrawn, 'withdrawn')),
    v.drift && v.drift.length ? h('div', { class: 'notice bad' }, `Context drift: ${v.drift.join('; ')}. Re-run the review with “Refresh”.`) : null,
    v.warnings && v.warnings.length ? h('div', { class: 'notice bad' }, h('strong', {}, `Instruction-like text aimed at AI reviewers (${v.warnings.length}): `), v.warnings.map((w) => h('div', { class: 'small' }, h('code', {}, w.where), ` ${w.text}`))) : null,
    v.gaps.length ? h('div', { class: 'notice' }, h('strong', {}, 'Not verified: '), v.gaps.join(' · ')) : null,
    v.opt_outs && v.opt_outs.length ? h('div', { class: 'notice' }, `Opt-outs recorded: ${v.opt_outs.join(', ')}`) : null,
    v.carried_over ? h('p', { class: 'small muted' }, v.carried_over.skipped
      ? `Full re-review after the push: ${v.carried_over.skipped}.`
      : `Incremental: ${v.carried_over.packets.length} packet(s) (${v.carried_over.packets.join(', ')}) and ${v.carried_over.rebuttals} rebuttal(s) carried over from context ${v.carried_over.from_context_id}; their files did not change and they were re-validated here.`) : null,
  );
}

function prActions(d) {
  const { repo, pr } = d.identity;
  const local = d.identity.local || null;
  const gate = d.gate || { decision: 'NOT_RECORDED' };
  const rerun = () => startJob(local
    ? api('POST', '/api/reviews/local', { dir: local.dir, base: local.base, mode: local.mode })
    : api('POST', '/api/reviews', { repo, pr, refresh: true }), 'Review');
  const readBack = async () => {
    try {
      const r = await api('POST', `/api/prs/${encodeURIComponent(d.id)}/feedback`, {});
      const c = r.record.counts;
      toast(r.record.state === 'PENDING' ? 'Still pending on GitHub' : `kept ${c.kept} · edited ${c.edited} · dropped ${c.dropped}`);
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  const note = h('input', { type: 'text', placeholder: 'note (optional)', class: 'minw' });
  const decide = (decision) => async () => {
    if (!confirm(`${decision === 'approved' ? 'Approve' : 'Reject'} this review as yourself? It binds to context ${d.validation.context_id}.`)) return;
    try {
      await api('POST', `/api/prs/${encodeURIComponent(d.id)}/gate`, { decision, note: note.value });
      toast(`Review ${decision}`);
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'row' },
      h('span', { class: 'label' }, 'Human gate'),
      statusBadge(gate.decision),
      gate.decision !== 'NOT_RECORDED' ? h('span', { class: 'small muted' }, `${gate.by || ''} ${fmtTime(gate.at)}${gate.valid ? '' : ' — STALE: outcome changed since'}`) : null),
    d.validation ? h('div', { class: 'row mt8' },
      note,
      h('button', { class: 'btn', onclick: decide('approved') }, 'Approve'),
      h('button', { class: 'btn danger', onclick: decide('rejected') }, 'Reject'),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `#/publish/${d.id}` }, local ? 'Preview draft…' : 'Publish…'),
      h('button', { class: 'btn', onclick: () => startJob(api('POST', `/api/prs/${encodeURIComponent(d.id)}/validate`, {}), 'Validate') }, 'Re-validate'),
      h('button', { class: 'btn', onclick: rerun }, local ? 'Re-run (new snapshot)' : 'Re-run (refresh)')) : null,
    local ? h('div', { class: 'small muted mt8' }, `Local review of ${local.dir} (${local.mode}, base ${local.base}). There is no pull request yet, so it cannot be published.`) : null,
    d.published ? h('div', { class: 'small muted mt8' },
      `Published ${fmtTime(d.published.at)}: ${d.published.inline.length} inline + ${d.published.summary_only.length} summary${(d.published.omitted || []).length ? `, ${d.published.omitted.length} left out (rejected before)` : ''}`,
      d.published.html_url ? [' · ', h('a', { href: d.published.html_url, target: '_blank', rel: 'noopener noreferrer' }, 'open review on GitHub')] : '',
      !d.published.dry_run ? [' · ', h('button', { type: 'button', class: 'linkbtn', onclick: readBack, title: 'after you submitted the review: which comments you kept, edited or deleted' }, 'Read back from GitHub')] : '') : null,
    d.feedback ? h('div', { class: 'small mt8' },
      h('span', { class: 'label' }, 'Feedback '),
      d.feedback.state === 'PENDING' ? 'the review is still pending on GitHub — submit it, then read back again' : `kept ${d.feedback.counts.kept} · edited ${d.feedback.counts.edited} · dropped ${d.feedback.counts.dropped}`,
      h('span', { class: 'muted' }, ` (${d.feedback.state}, read ${fmtTime(d.feedback.at)})`)) : null,
  );
}

function findingsView(d) {
  const f = state.filters;
  const filterBar = h('div', { class: 'filters' },
    ['P1', 'P2', 'P3', 'P4'].map((s) => h('button', { class: `filter${f.sev.has(s) ? ' on' : ''}`, onclick: () => { f.sev.has(s) ? f.sev.delete(s) : f.sev.add(s); render(); } }, s)),
    h('button', { class: `filter${f.hideDupes ? ' on' : ''}`, onclick: () => { f.hideDupes = !f.hideDupes; render(); } }, 'hide duplicates'),
    h('button', { class: `filter${f.showWithdrawn ? ' on' : ''}`, onclick: () => { f.showWithdrawn = !f.showWithdrawn; render(); } }, 'show withdrawn'));
  const rank = { P1: 1, P2: 2, P3: 3, P4: 4 };
  const list = d.findings
    .filter((x) => f.sev.has(x.severity))
    .filter((x) => f.showWithdrawn || x.state !== 'withdrawn')
    .filter((x) => !f.hideDupes || (!x.duplicate_of && x.canonical !== false))
    .sort((a, b) => (a.state === 'withdrawn') - (b.state === 'withdrawn') || rank[a.severity] - rank[b.severity] || b.votes - a.votes);
  const dupesOf = (id) => d.findings.filter((x) => x.duplicate_of === id || (x.cluster_id && x.cluster_id === (d.findings.find((y) => y.id === id) || {}).cluster_id && x.id !== id));
  return [filterBar, list.length ? list.map((x) => findingCard(d, x, dupesOf(x.id))) : h('p', { class: 'muted' }, 'No findings match the filters.')];
}

const STATE_TEXT = { stands: 'defense failed — stands', withdrawn: 'withdrawn by red-team', unresolved: 'red-team undecided', unverified: 'no valid rebuttal', not_challenged: 'not challenged (P3/P4)' };

function findingCard(d, meta, dupes) {
  const f = meta.detail;
  const card = h('details', { class: `finding${meta.state === 'withdrawn' ? ' withdrawn' : ''}` },
    h('summary', {},
      h('span', { class: `badge ${meta.severity}` }, meta.severity),
      h('span', { class: 'title' }, meta.title),
      h('span', { class: `badge ${meta.state === 'stands' ? 'bad' : meta.state === 'withdrawn' ? 'ok' : 'warn'}` }, STATE_TEXT[meta.state] || meta.state),
      h('span', { class: 'badge' }, `votes ${meta.votes}`),
      h('span', { class: 'badge', title: 'SUSPECTED = static evidence validated; CONFIRMED needs an executed reproduction' }, `${meta.label} ${meta.evidence_level}`),
      meta.rejected ? h('span', { class: 'badge warn', title: meta.rejected.reason }, meta.rejected.same ? 'rejected' : 'rejected before') : null,
      h('span', { class: 'muted small mono' }, meta.id)));
  if (!f) return card;
  const body = h('div', { class: 'body' },
    h('p', {}, h('span', { class: 'label' }, 'Current '), f.asis),
    h('p', {}, h('span', { class: 'label' }, 'Expected '), f.tobe),
    h('p', {}, h('span', { class: 'label' }, 'Scenario '), `Given ${f.trigger.given}; when ${f.trigger.when}; then ${f.trigger.then}.`),
    h('p', {}, h('span', { class: 'label' }, 'Impact '), f.impact),
    h('p', {}, h('span', { class: 'label' }, 'Authority '), `${f.authority.kind} `, h('code', {}, f.authority.id), ` · confidence ${f.confidence}`),
    f.fix.kind === 'code_change'
      ? [h('div', { class: 'label' }, 'Suggested fix'), h('p', { class: 'small' }, f.fix.reason), diffView(f.fix.asis, f.fix.tobe)]
      : h('p', {}, h('span', { class: 'label' }, 'Decision needed '), f.fix.reason),
    meta.repro
      ? [
        meta.repro.from !== meta.id ? h('p', { class: 'small muted' }, `Reproduction shared with ${meta.repro.from} (same defect):`) : null,
        reproDetail(d, d.reproRecords && d.reproRecords.get(meta.repro.from)) || h('p', {}, h('span', { class: 'label' }, 'Reproduction '), statusBadge(meta.repro.status)),
      ]
      : null,
    meta.rebuttal ? h('p', {}, h('span', { class: 'label' }, `Rebuttal ${meta.rebuttal.verdict}${meta.rebuttal_from && meta.rebuttal_from !== meta.id ? ` (from ${meta.rebuttal_from})` : ''} `), `Tried: ${meta.rebuttal.defense_attempted} ${meta.rebuttal.reason}`) : null,
    h('div', { class: 'label' }, 'Evidence'),
    h('ul', {}, f.evidence.map((ev) => evidenceItem(d, ev))),
    dupes.length ? h('p', { class: 'small muted' }, `Same defect also reported by: ${dupes.map((x) => x.id).join(', ')}`) : null,
    rejectPanel(d, meta),
  );
  add(card, body);
  return card;
}

// Rejecting a finding remembers it for this repository: look-alikes in later
// reviews are marked, and minor ones are left out of the published draft.
function rejectPanel(d, meta) {
  const r = meta.rejected;
  const forget = async () => {
    try {
      await api('POST', `/api/memory/${encodeURIComponent(r.entry_id)}/forget`, {});
      toast('Forgotten');
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  const note = r ? h('div', { class: 'notice' },
    r.same ? 'You rejected this finding' : `Looks like a finding rejected earlier (similarity ${r.score})`,
    `: ${r.reason} — ${r.source || ''} ${fmtTime(r.at)}. `,
    meta.publish_action === 'omit' ? 'It is left out of the published draft. ' : 'It is still published because of its severity. ',
    h('button', { type: 'button', class: 'linkbtn', onclick: forget }, r.same ? 'Undo' : 'Forget that rejection')) : null;
  if (r && r.same) return note;
  const reason = h('input', { type: 'text', class: 'minw', placeholder: 'why it is wrong or not worth raising', maxlength: '500' });
  const reject = async () => {
    if (!reason.value.trim()) return toast('Give a reason: it is shown when a similar finding comes back');
    try {
      await api('POST', `/api/prs/${encodeURIComponent(d.id)}/findings/${encodeURIComponent(meta.id)}/reject`, { reason: reason.value.trim() });
      toast('Rejected and remembered');
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  return [note, h('div', { class: 'row mt8' }, reason, h('button', { type: 'button', class: 'btn danger', onclick: reject }, 'Reject finding'))];
}

function diffView(asis, tobe) {
  const lines = [
    ...String(asis).replace(/\n$/, '').split('\n').map((l) => h('span', { class: 'diff-line del' }, `- ${l}`)),
    ...String(tobe).replace(/\n$/, '').split('\n').map((l) => h('span', { class: 'diff-line add' }, `+ ${l}`)),
  ];
  return h('pre', { class: 'code' }, lines);
}

function evidenceItem(d, ev) {
  const holder = h('div', {});
  const where = `${ev.path}:${ev.start_line}-${ev.end_line}${ev.revision === 'base' ? ' (base)' : ''}`;
  if (ev.kind !== 'code') return h('li', {}, h('span', { class: 'mono small' }, `${ev.kind} ${where}`), ' — ', h('q', {}, ev.quote));
  const toggle = async () => {
    if (holder.childNodes.length) return put(holder);
    try {
      const q = new URLSearchParams({ path: ev.path, start: ev.start_line, end: ev.end_line, revision: ev.revision || 'reviewed' });
      const s = await api('GET', `/api/prs/${encodeURIComponent(d.id)}/source?${q}`);
      put(holder, h('pre', { class: 'code' }, s.lines.map((line, i) => {
        const n = s.from + i;
        return h('span', { class: `src-line${n >= s.highlight[0] && n <= s.highlight[1] ? ' hl' : ''}` }, h('span', { class: 'ln' }, n), line);
      })));
    } catch (err) {
      put(holder, h('div', { class: 'notice bad' }, err.message));
    }
  };
  return h('li', {}, h('button', { type: 'button', class: 'linkbtn mono small', onclick: toggle }, where), ' ', h('code', {}, ev.quote.split('\n')[0].trim().slice(0, 120)), holder);
}

function overviewView(d) {
  const out = [];
  if (d.overview) {
    out.push(...section('Flows', h('ul', {}, d.overview.flows.map((fl) => h('li', {}, h('strong', {}, fl.flow), ` — ${fl.change}`, fl.finding_ids.length ? h('span', { class: 'muted small' }, ` (${fl.finding_ids.join(', ')})`) : null)))));
    if (d.overview.unverified.length) out.push(...section('Unverified', h('ul', {}, d.overview.unverified.map((u) => h('li', {}, u)))));
  } else {
    out.push(h('p', { class: 'muted' }, 'No valid synthesis for this context.'));
  }
  if (d.static) out.push(...staticView(d.static));
  return out;
}

// CI results, linter hits and test impact collected before planning. They
// were given to the reviewers as leads; they are not findings.
function staticView(s) {
  const out = [];
  const ciCls = { success: 'ok', failure: 'bad', timed_out: 'bad', action_required: 'warn', neutral: '', skipped: '' };
  if (s.ci) {
    out.push(...section(`CI at ${String(s.head).slice(0, 12)}`,
      s.ci.error ? h('div', { class: 'notice' }, `Unavailable: ${s.ci.error}`) : null,
      !s.ci.error && !s.ci.checks.length && !s.ci.statuses.length ? h('p', { class: 'muted small' }, 'No check runs or statuses reported.') : null,
      s.ci.checks.length || s.ci.statuses.length ? table(['Check', 'Result', 'Detail'], [
        ...s.ci.checks.map((c) => [c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.name) : c.name, h('span', { class: `badge ${ciCls[c.conclusion] || 'warn'}` }, c.conclusion || c.status), c.title || '']),
        ...s.ci.statuses.map((st) => [st.context, h('span', { class: `badge ${st.state === 'success' ? 'ok' : st.state === 'pending' ? 'warn' : 'bad'}` }, st.state), st.description || '']),
      ]) : null,
      s.ci.annotations.length ? h('ul', {}, s.ci.annotations.map((a) => h('li', { class: 'small' }, h('span', { class: 'mono' }, `${a.path}:${a.line}`), ` ${a.check} [${a.level}] ${a.message}`))) : null));
  }
  if (s.linters.length) {
    out.push(...section('Linters on changed files', s.linters.map((l) => h('div', {},
      h('p', {}, h('strong', {}, l.tool), l.error ? h('span', { class: 'muted small' }, ` not run: ${l.error}`) : ` ${l.total} hit(s), ${l.hits.filter((x) => x.on_added_line).length} on added lines`),
      l.hits.length ? h('ul', {}, l.hits.map((x) => h('li', { class: 'small' }, h('span', { class: 'mono' }, `${x.path}:${x.line}`), x.rule ? ` [${x.rule}]` : '', ` ${x.message}`, x.on_added_line ? h('span', { class: 'badge warn' }, 'added line') : null))) : null))));
  }
  out.push(...section('Test impact', table(['Changed source', 'Tests found'], s.tests.sources.map((t) => [
    h('span', { class: 'mono small' }, t.source),
    t.tests.length ? h('div', {}, t.tests.map((x) => h('div', { class: 'small' }, h('span', { class: 'mono' }, x.path), ` (${x.how})`, x.changed_in_pr ? h('span', { class: 'badge ok' }, 'changed in PR') : h('span', { class: 'badge' }, 'not changed')))) : h('span', { class: 'badge warn' }, 'no test found'),
  ]))));
  return out;
}

function itemsView(d) {
  if (!d.items || !d.items.length) return [h('p', { class: 'muted' }, 'No review items: the PR has no ticket spec or requirement items.')];
  const tally = {};
  for (const r of d.items) tally[r.result] = (tally[r.result] || 0) + 1;
  const cls = { pass: 'ok', fail: 'bad', not_applicable: '', cannot_determine: 'warn', not_graded: 'warn' };
  return [
    h('div', { class: 'stats mt12' }, Object.entries(tally).map(([k, n]) => stat(n, k))),
    table(['Item', 'Kind', 'Risk', 'Result', 'Expected', 'Reviewer verdicts'], d.items.map((r) => [
      h('strong', { title: r.text }, r.id), r.kind, r.risk, h('span', { class: `badge ${cls[r.result] || ''}` }, r.result), r.expected,
      h('div', { class: 'small' }, r.verdicts.map((v) => h('div', {}, h('span', { class: 'mono' }, `${v.unit_id}/${v.role} `), `${v.verdict} — ${v.note}`))),
    ])),
  ];
}

function unitsView(d) {
  const v = d.validation;
  const unitById = new Map(d.units.map((u) => [u.id, u]));
  return [h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Unit'), h('th', {}, 'Role'), h('th', {}, 'Kind'), h('th', {}, 'Status'), h('th', {}, 'Description / first error'))),
    h('tbody', {}, v.jobs.map((j) => {
      const u = unitById.get(j.unit_id) || {};
      return h('tr', {}, h('td', { class: 'mono' }, j.unit_id), h('td', {}, j.role), h('td', {}, u.kind || ''), h('td', {}, statusBadge(j.status)),
        h('td', {}, u.desc || '', j.errors && j.errors[0] ? h('div', { class: 'small err' }, j.errors[0]) : null));
    })))];
}

function costView(d) {
  const u = d.validation.usage;
  const p = u.plan || {};
  const cached = u.input_tokens ? Math.round((100 * u.cached_input_tokens) / u.input_tokens) : 0;
  return [
    h('div', { class: 'stats mt12' },
      stat(u.calls, 'review calls'), stat(u.repair_calls, 'repairs'), stat(u.input_tokens, 'input tokens'), stat(`${cached}%`, 'cached'),
      stat(u.output_tokens, 'output tokens'), stat(fmtMs(u.elapsed_ms), 'model time (sum)')),
    h('p', { class: 'muted small' }, `Planning: ${fmtNum(p.calls)} call(s), ${fmtNum(p.input_tokens)} input / ${fmtNum(p.output_tokens)} output tokens. Token counts come from codex turn.completed events.`),
  ];
}

async function openPublish(d) {
  const min = h('select', {}, ['P1', 'P2', 'P3', 'P4'].map((s) => h('option', { value: s, selected: s === 'P3' }, `${s} and above`)));
  const preview = h('div', {}, h('p', { class: 'muted' }, 'Loading preview…'));
  const load = async () => {
    try {
      const r = await api('GET', `/api/prs/${encodeURIComponent(d.id)}/publish-preview?min=${min.value}`);
      put(preview, 
        h('p', {}, `${r.comments.length} inline comment(s), ${r.summary_only.length} in the summary. It is created as a PENDING review: only you see it until you submit it on GitHub.`),
        r.omitted && r.omitted.length ? h('div', { class: 'notice' }, h('strong', {}, `Left out (${r.omitted.length}) — rejected before: `),
          r.omitted.map((o) => h('div', { class: 'small' }, h('span', { class: 'mono' }, o.finding_id), ` [${o.severity}] ${o.title} — ${o.rejected.reason}`))) : null,
        h('h3', {}, 'Review body'), h('pre', { class: 'log' }, r.body),
        ...r.comments.map((c) => [h('h3', { class: 'mono' }, `${c.path}:${c.line}`), h('pre', { class: 'log' }, c.body)]),
      );
    } catch (err) {
      put(preview, h('div', { class: 'notice bad' }, err.message));
    }
  };
  min.addEventListener('change', load);
  put($main, 
    h('a', { href: `#/pr/${d.id}` }, '← back'),
    h('h1', {}, `Publish ${d.identity.repo}#${d.identity.pr}`),
    h('div', { class: 'row' }, min,
      d.identity.local
        ? h('span', { class: 'muted small' }, 'Local review: preview only. Open a PR and review it to publish.')
        : h('button', { class: 'btn primary', onclick: () => { if (confirm('Create a pending review on GitHub as you?')) startJob(api('POST', `/api/prs/${encodeURIComponent(d.id)}/publish`, { minSeverity: min.value }), 'Publish'); } }, 'Create pending review')),
    preview,
  );
  load();
}

// ---------- ticket view ----------
async function renderTicket(key) {
  const job = activeJobFor('ticket', key);
  let t;
  try {
    t = await api('GET', `/api/tickets/${encodeURIComponent(key)}`);
  } catch (err) {
    // A brand-new ticket has no run yet while its first job is running.
    if (job) return put($main, h('h1', {}, key), livePanel(job));
    throw err;
  }
  const extras = await ticketExtras(key).catch(() => []);
  const repo = repoSelect(true);
  const advance = (redo) => () => startJob(api('POST', `/api/tickets/${encodeURIComponent(key)}/advance`, { repo: repo.value || undefined, redo }), 'Ticket');
  const s = t.spec;
  put($main,
    h('h1', {}, key),
    h('div', { class: 'row' }, statusBadge(t.state), s ? h('span', { class: `badge ${s.clean ? 'ok' : 'warn'}` }, s.clean ? 'spec clean' : 'spec needs a decision') : null,
      h('span', { class: 'muted small' }, `model calls ${t.usage.calls} · ${fmtNum(t.usage.input_tokens)} input tokens`)),
    h('div', { class: 'panel' },
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Pipeline'), repo,
        h('button', { class: 'btn primary', onclick: advance() }, 'Continue'),
        h('button', { class: 'btn', onclick: advance('spec') }, 'Rebuild spec'),
        h('button', { class: 'btn', onclick: advance('analysis') }, 'Redo analysis')),
      h('p', { class: 'small muted' }, 'Stops at the SPEC gate. After approval the analysis reads the repository (read-only) for every review item.')),
    job ? livePanel(job) : null,
    s ? specGate(key, t) : null,
    s ? specView(s) : section('Spec', h('p', { class: 'muted' }, 'Not built yet.')),
    t.analysis ? analysisView(t.analysis, s) : [],
    section('Requirement items', t.requirements ? requirementsTable(t.requirements) : h('p', { class: 'muted' }, 'Not extracted yet.')),
    extras,
    section('Ticket evidence', t.evidence ? h('details', {}, h('summary', {}, 'Show ticket text (untrusted)'), h('pre', { class: 'log' }, t.evidence)) : h('p', { class: 'muted' }, 'None.')),
    section('Stages', h('table', {}, h('tbody', {}, Object.entries(t.stages).map(([name, st]) => h('tr', {}, h('td', {}, name), h('td', {}, statusBadge(st.status)), h('td', { class: 'small muted' }, fmtTime(st.at))))))),
  );
}

function specGate(key, t) {
  const g = t.gates.SPEC || { decision: 'NOT_RECORDED' };
  const note = h('textarea', { class: 'wide', placeholder: 'Rejection note: what is wrong or missing. It is sent to the model to rebuild the spec.' });
  const decide = (decision) => async () => {
    if (decision === 'rejected' && !note.value.trim()) return toast('Write what is wrong first: the note drives the rebuild.');
    if (!confirm(`${decision === 'approved' ? 'Approve' : 'Reject'} the spec as yourself? Approval binds to the current spec.json.`)) return;
    try {
      await api('POST', `/api/tickets/${encodeURIComponent(key)}/gate`, { gate: 'SPEC', decision, note: note.value });
      toast(`SPEC ${decision}`);
      if (decision === 'rejected') startJob(api('POST', `/api/tickets/${encodeURIComponent(key)}/advance`, {}), 'Spec rebuild');
      else render();
    } catch (err) {
      toast(err.message);
    }
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'row' }, h('span', { class: 'label' }, 'Gate SPEC'), statusBadge(g.decision),
      g.decision !== 'NOT_RECORDED' ? h('span', { class: 'small muted' }, `${g.by || ''} ${fmtTime(g.at)}${g.valid ? '' : ' — not bound to the current spec'}`) : null),
    g.note ? h('p', { class: 'small' }, h('span', { class: 'label' }, 'Last note '), g.note) : null,
    note,
    h('div', { class: 'row mt8' }, h('button', { class: 'btn primary', onclick: decide('approved') }, 'Approve spec'), h('button', { class: 'btn danger', onclick: decide('rejected') }, 'Reject and rebuild')));
}

function specView(s) {
  const st = s.stats;
  const out = [
    h('h2', {}, 'Spec'),
    h('div', { class: 'stats' }, stat(st.rules, 'rules'), stat(st.combinations, 'combinations checked'), stat(st.scenarios, 'scenarios'), stat(st.items, 'review items'),
      stat(st.gaps, 'gaps'), stat(st.contradictions, 'contradictions'), stat(st.inferred_rules, 'inferred rules')),
  ];
  if (s.questions.length) out.push(h('h3', {}, 'Open questions'), h('ul', {}, s.questions.map((q) => h('li', {}, h('strong', {}, q.id), ` (${q.kind}) ${q.text}`))));
  if (s.warnings.length) out.push(h('div', { class: 'notice' }, s.warnings.join(' · ')));
  for (const f of s.features) {
    const vars = f.variables.map((v) => v.id);
    const outs = f.outcomes.map((o) => o.id);
    out.push(
      h('h3', {}, `${f.id} — ${f.name}`),
      h('p', { class: 'small muted' }, `${f.combinations} value combinations checked exhaustively · scenarios ${f.mode} · ${f.gaps} uncovered combinations`),
      h('div', { class: 'label' }, 'Input matrix'),
      table(['Variable', 'Type', 'Class', 'Validity', 'Range / value', 'Example'], f.variables.flatMap((v) => v.classes.map((c) => [v.id, `${v.type}${v.unit ? ` (${v.unit})` : ''}`, c.label, statusBadge(c.validity === 'valid' ? 'valid' : 'INVALID'), h('code', {}, c.range), c.example]))),
      h('div', { class: 'label mt12' }, 'Decision table'),
      table(['Rule', ...vars, ...outs.map((o) => `→ ${o}`), 'AC', 'Label'], f.decision_table.map((r) => [h('strong', {}, r.rule), ...vars.map((v) => r.conditions[v].join(', ')), ...outs.map((o) => h('strong', {}, r.results[o])), r.acs.join(', '), statusBadge(r.label)])),
      h('div', { class: 'label mt12' }, 'Scenarios'),
      table(['ID', ...vars, 'Expected', 'Rule'], f.scenarios.map((sc) => [sc.boundary ? h('span', {}, sc.id, ' ', h('span', { class: 'badge warn' }, 'boundary')) : sc.id, ...vars.map((v) => h('code', {}, sc.values[v])), sc.kind === 'rule' ? sc.expected : h('span', { class: 'badge bad' }, sc.expected), sc.rules.join(', ') || '—'])),
    );
  }
  out.push(h('h3', {}, 'Review items'), table(['ID', 'Kind', 'Risk', 'Label', 'Item'], s.review_items.map((i) => [h('strong', {}, i.id), i.kind, i.risk !== 'normal' ? h('span', { class: 'badge warn' }, i.risk) : 'normal', statusBadge(i.label), i.text])));
  return out;
}

function table(cols, rows) {
  return h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
}

function requirementsTable(req) {
  return [
    h('p', { class: 'small muted' }, `extraction ${req.extraction} · sources ${req.sources.join(', ')}`),
    req.note ? h('div', { class: 'notice' }, req.note) : null,
    table(['ID', 'Kind', 'Risk', 'Given', 'When', 'Then', 'Quote'], req.items.map((i) => [i.id, i.kind, i.risk, i.given, i.when, i.then, h('span', { class: 'small muted' }, i.evidence.quote)])),
  ];
}

function analysisView(a, s) {
  const items = new Map(((s && s.review_items) || []).map((i) => [i.id, i]));
  const statusCls = { matches: 'ok', differs: 'bad', not_implemented: 'warn', unknown: 'warn' };
  return [
    h('h2', {}, 'Analysis against the repository'),
    table(['Item', 'Expected', 'Current behaviour', 'Status', 'Label'], a.items.map((x) => [h('strong', {}, x.item), (items.get(x.item) || {}).expected || '', x.current, h('span', { class: `badge ${statusCls[x.status]}` }, x.status), statusBadge(x.label)])),
    a.questions.length ? [h('h3', {}, 'Questions'), h('ul', {}, a.questions.map((q) => h('li', {}, h('strong', {}, q.id), ` ${q.question} `, h('span', { class: 'muted' }, `— ${q.why}`))))] : [],
    h('h3', {}, 'Impacted'),
    h('ul', {}, a.impacted.map((x) => h('li', {}, h('code', {}, x.path), x.symbol ? ` (${x.symbol})` : '', ' ', statusBadge(x.label), ` ${x.reason}`))),
    a.options.length ? [h('h3', {}, 'Options'), h('ul', {}, a.options.map((o) => h('li', {}, h('strong', {}, o.name), ` — ${o.summary} `, h('span', { class: 'muted' }, `Trade-offs: ${o.tradeoffs}`))))] : [],
    h('h3', {}, 'Acceptance tests'),
    h('ul', {}, a.acceptance_tests.map((x) => h('li', {}, h('strong', {}, x.item), ` ${x.test}`, x.existing_test ? h('span', { class: 'muted small' }, ` (existing: ${x.existing_test})`) : ''))),
  ];
}

// ---------- forms ----------
function repoSelect(optional) {
  return h('select', { 'aria-label': 'repository' },
    optional ? h('option', { value: '' }, '(no repository)') : null,
    state.config.repos.map((r) => h('option', { value: r }, r)));
}

function renderNewReview() {
  const repo = repoSelect(false);
  const pr = h('input', { type: 'number', min: '1', placeholder: 'PR number', required: true });
  const ticket = h('input', { type: 'text', placeholder: 'optional, e.g. ACME-7 (taken from title/branch otherwise)' });
  const workers = h('input', { type: 'number', min: '1', max: '8', value: String(state.config.workers) });
  const prList = h('div', {});
  const flags = { singleRole: 'Single role (business units: business pass only)', skipSeams: 'Skip seams', skipRebuttals: 'Skip red-team', skipSynthesis: 'Skip synthesis', noRepro: 'Skip repro tests', refresh: 'Refresh (re-plan, re-freeze)' };
  const boxes = Object.fromEntries(Object.keys(flags).map((k) => [k, h('input', { type: 'checkbox' })]));
  const loadPrs = async () => {
    if (!repo.value) return;
    put(prList, h('p', { class: 'muted small' }, 'Loading open PRs…'));
    try {
      const list = await api('GET', `/api/github/prs?repo=${encodeURIComponent(repo.value)}`);
      put(prList, list.length ? h('table', {}, h('tbody', {}, list.map((p) => h('tr', {},
        h('td', {}, h('button', { type: 'button', class: 'linkbtn', onclick: () => { pr.value = p.number; } }, `#${p.number}`)),
        h('td', {}, p.title, p.isDraft ? h('span', { class: 'badge' }, 'draft') : null),
        h('td', { class: 'small muted' }, `${p.author && p.author.login} · ${p.headRefName} · ${fmtTime(p.updatedAt)}`))))) : h('p', { class: 'muted small' }, 'No open PRs.'));
    } catch (err) {
      put(prList, h('div', { class: 'notice bad' }, err.message));
    }
  };
  repo.addEventListener('change', loadPrs);
  // Local self-review: no PR yet, the diff comes from a directory on disk.
  const source = h('select', { 'aria-label': 'what to review' },
    h('option', { value: 'pr' }, 'A pull request on GitHub'),
    h('option', { value: 'local' }, 'Local changes (before opening a PR)'));
  const dir = h('input', { type: 'text', list: 'arw-checkouts', placeholder: 'absolute path of the repository, e.g. D:\\code\\shop' });
  const dirList = h('datalist', { id: 'arw-checkouts' }, (state.config.checkouts || []).map((c) => h('option', { value: c })));
  const base = h('input', { type: 'text', value: 'main', pattern: '[A-Za-z0-9._][A-Za-z0-9._/-]*' });
  const mode = h('select', { 'aria-label': 'local mode' },
    h('option', { value: 'branch' }, 'Branch: commits on the current branch since it left the base'),
    h('option', { value: 'staged' }, 'Staged: what is in the index now (git add)'),
    h('option', { value: 'worktree' }, 'Working tree: all tracked edits, committed or not'));
  const prPart = h('div', { class: 'stack' },
    h('label', { class: 'field' }, 'Repository', repo),
    prList,
    h('label', { class: 'field' }, 'Pull request', pr),
    h('label', { class: 'field' }, 'Ticket', ticket));
  const localPart = h('div', { class: 'stack', hidden: true },
    h('label', { class: 'field' }, 'Directory', dir, dirList),
    h('label', { class: 'field' }, 'Base branch', base),
    h('label', { class: 'field' }, 'What to review', mode),
    h('p', { class: 'small muted' }, 'Staged and working-tree reviews use a snapshot commit; your branch, index and files are not changed. The result cannot be published until a PR exists.'));
  const syncSource = () => {
    const local = source.value === 'local';
    prPart.hidden = local;
    localPart.hidden = !local;
    pr.required = !local;
    dir.required = local;
    boxes.refresh.closest('label').hidden = local;
  };
  source.addEventListener('change', syncSource);
  const submit = (e) => {
    e.preventDefault();
    if (source.value === 'local') {
      const body = { dir: dir.value.trim(), base: base.value.trim() || 'main', mode: mode.value, workers: Number(workers.value) || undefined };
      for (const k of Object.keys(flags)) if (k !== 'refresh') body[k] = boxes[k].checked;
      startJob(api('POST', '/api/reviews/local', body), 'Local review');
      return;
    }
    const body = { repo: repo.value, pr: Number(pr.value), ticket: ticket.value.trim() || undefined, workers: Number(workers.value) || undefined };
    for (const k of Object.keys(flags)) body[k] = boxes[k].checked;
    startJob(api('POST', '/api/reviews', body), 'Review');
  };
  put($main,
    h('h1', {}, 'New review'),
    !state.config.repos.length ? h('div', { class: 'notice bad' }, 'No repositories in config/repos.json.') : null,
    h('form', { class: 'stack', onsubmit: submit },
      h('label', { class: 'field' }, 'Review', source),
      prPart,
      localPart,
      h('label', { class: 'field' }, 'Parallel workers', workers),
      h('div', { class: 'checks' }, Object.entries(flags).map(([k, label]) => h('label', {}, boxes[k], ` ${label}`))),
      h('p', { class: 'small muted' }, 'Opt-outs are recorded in validation.json and shown in the report.'),
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Start review'))),
  );
  loadPrs();
}

function renderNewTicket() {
  const key = h('input', { type: 'text', placeholder: 'ABC-123', required: true, pattern: '[A-Z][A-Z0-9]+-[0-9]+' });
  const repo = repoSelect(true);
  const text = h('textarea', { placeholder: 'Paste the ticket (Markdown). Leave empty to fetch it from Jira.' });
  const submit = (e) => {
    e.preventDefault();
    startJob(api('POST', '/api/tickets', { key: key.value.trim(), repo: repo.value || undefined, text: text.value }), 'Ticket');
  };
  put($main, 
    h('h1', {}, 'New ticket'),
    h('p', { class: 'muted' }, 'Extracts checkable requirement items, then stops for your approval before analysing the repository.'),
    h('form', { class: 'stack', onsubmit: submit },
      h('label', { class: 'field' }, 'Ticket key', key),
      h('label', { class: 'field' }, 'Repository for the analysis (read-only)', repo),
      h('label', { class: 'field' }, `Ticket text${state.config.jira ? ' (optional: Jira is configured)' : ' (required: Jira is not configured)'}`, text),
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Start'))),
  );
}

// ---------- jobs ----------
function renderJobs() {
  put($main, 
    h('h1', {}, 'Jobs'),
    h('p', { class: 'muted small' }, 'Jobs run one at a time. Each is an arw CLI command you can also run in a terminal.'),
    state.jobs.length ? h('table', {},
      h('thead', {}, h('tr', {}, ['Job', 'Status', 'Queued', 'Finished', 'Command'].map((c) => h('th', {}, c)))),
      h('tbody', {}, state.jobs.map((j) => h('tr', {},
        h('td', {}, h('a', { href: `#/job/${j.id}` }, `${j.kind} ${j.title}`)),
        h('td', {}, statusBadge(j.status)),
        h('td', { class: 'small muted' }, fmtTime(j.queued_at)),
        h('td', { class: 'small muted' }, fmtTime(j.finished_at)),
        h('td', { class: 'mono small' }, j.command))))) : h('p', { class: 'muted' }, 'No jobs yet.'),
  );
  state.viewTimer = setInterval(() => { if (location.hash === '#/jobs') renderJobs(); }, 3000);
}

// The log streams over Server-Sent Events as the job writes it.
function renderJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return put($main, h('div', { class: 'notice bad' }, 'Unknown job.'));
  const log = h('pre', { class: 'log live-log tall-log' });
  const head = h('div', {});
  const progress = h('div', {});
  const drawHead = (j, ended) => put(head,
    h('h1', {}, `${j.kind} ${j.title}`),
    h('div', { class: 'row' }, statusBadge(j.status), ended ? null : h('span', { class: 'pulse' }), h('span', { class: 'mono small' }, j.command),
      j.started_at ? h('span', { class: 'small muted' }, `started ${fmtTime(j.started_at)}`) : null,
      j.finished_at ? h('span', { class: 'small muted' }, `finished ${fmtTime(j.finished_at)}`) : null,
      h('span', { class: 'spacer' }),
      h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { log.dataset.follow = e.target.checked ? '1' : '0'; } }), ' follow'),
      ['queued', 'running'].includes(j.status) ? h('button', { class: 'btn danger', onclick: async () => { await api('POST', `/api/jobs/${id}/cancel`, {}); toast('Cancel requested'); } }, 'Cancel') : null,
      j.target && j.target.type !== 'system' && !['queued', 'running'].includes(j.status) ? h('a', { class: 'btn primary', href: targetHash(j.target) }, 'Open result') : null));
  drawHead(job, !['queued', 'running'].includes(job.status));
  put($main, head, progress, log);
  if (job.target && job.target.type === 'pr' && ['queued', 'running'].includes(job.status)) {
    const refresh = async () => {
      try {
        put(progress, await prProgressView(job.target.id));
      } catch {
        /* not started yet */
      }
    };
    refresh();
    state.timers.push(setInterval(refresh, 2000));
  }
  followJob(id, {
    pre: log,
    onStatus: (j) => drawHead(j, false),
    onEnd: async () => {
      await refreshJobs();
      drawHead(state.jobs.find((j) => j.id === id) || job, true);
      for (const t of state.timers) clearInterval(t);
    },
  });
}

// ---------- live streaming ----------
// One EventSource per visible log; closed whenever the route changes.
function closeStreams() {
  for (const s of state.streams || []) s.close();
  state.streams = [];
  for (const t of state.timers || []) clearInterval(t);
  state.timers = [];
}

const LOG_CLASSES = [
  [/\b(accepted|-> green|READY|EXECUTED_PASS|RED_PROVEN|fix -> green|succeeded)\b/, 'log-ok'],
  [/\b(rejected|blocked|process failure|invalid JSON|FAIL|failed|error:|Error:|degenerate|-> red|INVALIDATED)\b/, 'log-bad'],
  [/\bW\d\b|batch (start|done)|froze context|^\$ /, 'log-wave'],
  [/\bstart \S+ attempt=/, 'log-dim'],
];

function logLine(text) {
  const cls = (LOG_CLASSES.find(([re]) => re.test(text)) || [])[1] || '';
  // display:block already breaks the line; a space keeps empty lines visible.
  return h('span', { class: `log-line ${cls}` }, text || ' ');
}

// Appends streamed text to a <pre>, line by line, keeping a partial tail.
function logSink(pre, { maxLines = 4000 } = {}) {
  let partial = '';
  return (text) => {
    const atBottom = pre.dataset.follow === '1' || (pre.dataset.follow !== '0' && pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30);
    const lines = (partial + text).split('\n');
    partial = lines.pop();
    for (const l of lines) pre.append(logLine(l));
    while (pre.childNodes.length > maxLines) pre.removeChild(pre.firstChild);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
}

function followJob(jobId, { pre, onStatus, onEnd }) {
  const sink = logSink(pre);
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
  es.addEventListener('log', (e) => sink(JSON.parse(e.data).text));
  es.addEventListener('status', (e) => onStatus && onStatus(JSON.parse(e.data)));
  es.addEventListener('end', (e) => {
    es.close();
    if (onEnd) onEnd(JSON.parse(e.data));
  });
  es.onerror = () => {
    /* the browser reconnects; the server resends from the start */
  };
  state.streams.push(es);
  return es;
}

function activeJobFor(type, idOrKey) {
  return state.jobs.find((j) => ['queued', 'running'].includes(j.status) && j.target && j.target.type === type && (j.target.id === idOrKey || j.target.key === idOrKey));
}

// Live panel: streamed log of the running job, plus a progress view that is
// refreshed while it runs. Re-renders the page when the job ends.
function livePanel(job, progressView) {
  const pre = h('pre', { class: 'log live-log' });
  const status = h('span', {}, statusBadge(job.status));
  const progress = h('div', {});
  const panel = h('div', { class: 'panel live' },
    h('div', { class: 'row' }, h('span', { class: 'label' }, 'Live'), h('span', { class: 'pulse' }), status,
      h('span', { class: 'mono small' }, job.command), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: `#/job/${job.id}` }, 'Full log'),
      h('button', { class: 'btn danger', onclick: async () => { await api('POST', `/api/jobs/${job.id}/cancel`, {}); toast('Cancel requested'); } }, 'Cancel')),
    progress, pre);
  followJob(job.id, {
    pre,
    onStatus: (j) => put(status, statusBadge(j.status)),
    onEnd: (e) => {
      toast(`${job.kind} ${job.title}: ${e.status}`);
      refreshJobs().then(render);
    },
  });
  if (progressView) {
    const refresh = async () => {
      try {
        put(progress, await progressView());
      } catch {
        /* run dir not ready yet */
      }
    };
    refresh();
    state.timers.push(setInterval(refresh, 2000));
  }
  return panel;
}

// ---------- PR progress, calls, timeline ----------
const LIVE_CLS = { running: 'warn', accepted: 'ok', rejected: 'bad', failed: 'bad' };

async function prProgressView(id) {
  const p = await api('GET', `/api/prs/${encodeURIComponent(id)}/progress`);
  const done = p.units.filter((u) => u.status === 'EXECUTED_PASS').length;
  return [
    h('div', { class: 'row small' },
      timelineChips(p.phases),
      h('span', { class: 'muted' }, `units ${done}/${p.units.length} · model calls ${p.calls} · tokens in ${fmtNum(p.tokens_in)} / out ${fmtNum(p.tokens_out)}`)),
    p.units.length
      ? table(['Unit', 'Kind', 'Role', 'Now', 'Status', 'Last error'], p.units.map((u) => [
        h('span', { class: 'mono' }, u.unit), u.kind, u.role,
        u.live ? h('span', { class: `badge ${LIVE_CLS[u.live] || ''}` }, `${u.live}${u.attempt ? ` #${u.attempt} ${u.mode}` : ''}`) : '—',
        statusBadge(u.status), h('span', { class: 'small err' }, (u.error || '').slice(0, 160))]))
      : h('p', { class: 'muted small' }, 'Planning — units appear after the context is frozen.'),
    p.other.length ? h('div', { class: 'row small mt8' }, p.other.map((o) => h('span', { class: `badge ${LIVE_CLS[o.state] || ''}` }, `${o.label}: ${o.state}`))) : null,
    p.repro.length ? h('div', { class: 'row small mt8' }, p.repro.map((r) => h('span', { class: `badge ${r.status === 'RED_PROVEN' ? 'ok' : 'warn'}` }, `repro ${r.finding}: ${r.status} (${r.runs.join(', ')})${r.fix ? ' · fix verified' : ''}`))) : null,
  ];
}

const PHASE_ORDER = ['prepare', 'ticket', 'plan', 'freeze', 'batch', 'repro'];

function timelineChips(phases) {
  return h('span', { class: 'row' }, PHASE_ORDER.filter((n) => phases[n]).map((n) => h('span', { class: `badge ${/PASS|READY/.test(phases[n].status) ? 'ok' : /FAIL|BLOCK|INVALID/.test(phases[n].status) ? 'bad' : 'warn'}` }, `${n}: ${phases[n].status}`)));
}

function timelineView(d) {
  const rows = PHASE_ORDER.filter((n) => d.phases[n]).map((n) => {
    const p = d.phases[n];
    const { status, at, ...rest } = p;
    const extra = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    return [h('strong', {}, n), statusBadge(status), h('span', { class: 'small muted' }, fmtTime(at)), h('span', { class: 'small' }, extra)];
  });
  return [table(['Phase', 'Status', 'At', 'Details'], rows)];
}

// A button that loads a run file into an inline <pre> on demand.
function fileToggle(url, label) {
  const holder = h('div', {});
  const btn = h('button', { type: 'button', class: 'linkbtn small', onclick: async () => {
    if (holder.childNodes.length) return put(holder);
    try {
      const f = await api('GET', url);
      put(holder, h('div', { class: 'small muted' }, `${f.path} · ${fmtNum(f.size)} bytes${f.truncated ? ' · truncated' : ''}`), h('pre', { class: 'log file-view' }, f.text));
    } catch (err) {
      put(holder, h('div', { class: 'notice bad' }, err.message));
    }
  } }, label);
  return [btn, holder];
}

function callsTable(rows, fileUrl) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No model calls recorded.');
  const tin = rows.reduce((n, r) => n + r.tokens_in, 0);
  const tout = rows.reduce((n, r) => n + r.tokens_out, 0);
  const cached = rows.reduce((n, r) => n + r.tokens_cached, 0);
  return [
    h('p', { class: 'small muted' }, `${rows.length} calls · ${rows.filter((r) => r.mode === 'repair').length} repairs · tokens in ${fmtNum(tin)} (cached ${tin ? Math.round((100 * cached) / tin) : 0}%) / out ${fmtNum(tout)} · model time ${fmtMs(rows.reduce((n, r) => n + (r.elapsed_ms || 0), 0))}`),
    table(['When', 'Job', 'Attempt', 'Model', 'Time', 'Tokens in / cached / out', 'Result', 'Files'], rows.map((r) => [
      h('span', { class: 'small muted' }, fmtTime(r.at)),
      h('span', { class: 'mono' }, r.label),
      `${r.attempt} ${r.mode}`,
      r.model || 'default',
      fmtMs(r.elapsed_ms),
      `${fmtNum(r.tokens_in)} / ${fmtNum(r.tokens_cached)} / ${fmtNum(r.tokens_out)}`,
      r.error_class ? h('span', { class: 'badge bad', title: r.error_message || '' }, r.error_class) : r.validation_errors ? h('span', { class: 'badge warn' }, `${r.validation_errors} validation errors`) : h('span', { class: 'badge ok' }, 'ok'),
      h('div', {}, r.files.filter((f) => !/output-schema\.json$/.test(f)).map((f) => fileToggle(`${fileUrl}?path=${encodeURIComponent(f)}`, f.split('/').pop()))),
    ])),
  ];
}

async function callsView(id) {
  return callsTable(await api('GET', `/api/prs/${encodeURIComponent(id)}/calls`), `/api/prs/${encodeURIComponent(id)}/file`);
}

// Reproduction detail inside a finding card.
function reproDetail(d, rec) {
  if (!rec) return null;
  const fileUrl = (p) => `/api/prs/${encodeURIComponent(d.id)}/file?path=${encodeURIComponent(p)}`;
  return h('div', { class: 'repro' },
    h('div', { class: 'row' }, h('span', { class: 'label' }, 'Reproduction'), statusBadge(rec.status),
      rec.fix && rec.fix.verified === true ? h('span', { class: 'badge ok' }, 'fix verified') : rec.fix && rec.fix.verified === false ? h('span', { class: 'badge bad' }, 'fix does not pass') : null,
      rec.toolchain ? h('span', { class: 'small muted' }, rec.toolchain) : null,
      rec.reason ? h('span', { class: 'small muted' }, rec.reason) : null),
    rec.test ? h('p', { class: 'small' }, h('code', {}, rec.test.selector), ` — ${rec.test.fails_because}`) : null,
    (rec.runs || []).length ? table(['Run', 'Result', 'JUnit', 'Time', 'Log'], rec.runs.map((r) => [
      r.phase, statusBadge(r.status === 'red' ? 'RED' : r.status === 'green' ? 'GREEN' : r.status),
      h('span', { class: 'small' }, r.junit ? `${r.junit.tests} tests, ${r.junit.failures} failures, ${r.junit.errors} errors${r.junit.message ? ` — ${r.junit.message}` : ''}` : 'no report'),
      fmtMs(r.elapsed_ms), r.log_path ? fileToggle(fileUrl(r.log_path), 'log') : '—'])) : null,
    rec.test && rec.test.source ? h('details', {}, h('summary', { class: 'small' }, `Test written by the model: ${rec.test.path}`), h('pre', { class: 'code' }, rec.test.source)) : null);
}

// ---------- ticket extras ----------
async function ticketExtras(key) {
  const [intake, calls] = await Promise.all([api('GET', `/api/tickets/${encodeURIComponent(key)}/intake`), api('GET', `/api/tickets/${encodeURIComponent(key)}/calls`)]);
  const fileUrl = (p) => `/api/tickets/${encodeURIComponent(key)}/file?path=${encodeURIComponent(p)}`;
  return [
    h('h2', {}, 'Intake'),
    h('div', { class: 'kv' },
      h('dt', {}, 'Source'), h('dd', {}, intake.source || '—'),
      h('dt', {}, 'Confluence pages'), h('dd', {}, intake.confluence_pages.length ? intake.confluence_pages.map((p) => `${p.title} (${p.id})`).join(' · ') : 'none'),
      h('dt', {}, 'Evidence files'), h('dd', {}, intake.evidence.map((f) => fileToggle(fileUrl(f), f))),
      h('dt', {}, 'Documents'), h('dd', {}, intake.docs.map((f) => fileToggle(fileUrl(f), f))),
      h('dt', {}, 'Rejected specs'), h('dd', {}, intake.spec_history.length ? intake.spec_history.map((f) => fileToggle(fileUrl(f), f.split('/').pop())) : 'none')),
    h('h2', {}, 'Model calls'),
    callsTable(calls, `/api/tickets/${encodeURIComponent(key)}/file`),
  ];
}

// ---------- settings ----------
const GROUP_TITLES = { executor: 'Executor (codex)', review: 'Review', repro: 'Reproduction tests' };

// One input per setting; returns { row, read } where read() yields the
// change to send (undefined = unchanged, null = reset to default).
function settingField(s) {
  const id = `set-${s.key}`;
  let input;
  let reset = false;
  if (s.type === 'bool') input = h('input', { id, type: 'checkbox', checked: (s.value || s.default) === '1' });
  else if (s.type === 'enum') input = h('select', { id }, s.options.map((o) => h('option', { value: o, selected: (s.value || s.default) === o }, o || '(default)')));
  else if (s.type === 'secret') input = h('input', { id, type: 'password', autocomplete: 'off', placeholder: s.set ? '•••••• (set — type to replace)' : '(not set)' });
  else input = h('input', { id, type: s.type === 'number' ? 'number' : 'text', value: s.value, placeholder: s.default || '', min: s.range ? s.range[0] : null, max: s.range ? s.range[1] : null, list: /MODEL$/.test(s.key) ? 'model-list' : null, class: 'wide' });
  const clear = s.type === 'secret' && s.set ? h('label', { class: 'small' }, h('input', { type: 'checkbox', onchange: (e) => { reset = e.target.checked; } }), ' clear') : null;
  const resetBtn = s.source === '.env' && s.type !== 'secret' ? h('button', { type: 'button', class: 'linkbtn small', title: `back to default (${s.default || 'empty'})`, onclick: () => { reset = true; input.disabled = true; } }, 'reset') : null;
  const row = h('div', { class: 'setting' },
    h('label', { for: id, class: 'setting-key' }, h('code', {}, s.key), h('span', { class: `badge ${s.source === '.env' ? 'ok' : ''}` }, s.source)),
    h('div', {}, h('div', { class: 'row' }, input, clear, resetBtn), h('div', { class: 'small muted' }, s.help, s.default && s.type !== 'secret' ? ` Default: ${s.default}.` : '')));
  const read = () => {
    if (reset) return null;
    if (s.type === 'bool') {
      const v = input.checked ? '1' : '0';
      return v === (s.value || s.default) ? undefined : v;
    }
    if (s.type === 'secret') return input.value ? input.value : undefined;
    // A select starts on the effective value (often the default): compare to that.
    if (s.type === 'enum') return input.value === (s.value || s.default) ? undefined : input.value;
    return input.value === s.value ? undefined : input.value;
  };
  return { row, read };
}

function settingsSection(title, list, models, after) {
  const fields = list.map((s) => settingField(s));
  const msg = h('span', { class: 'small' });
  const save = async () => {
    const changes = {};
    for (const [i, f] of fields.entries()) {
      const v = f.read();
      if (v !== undefined) changes[list[i].key] = v;
    }
    if (!Object.keys(changes).length) return put(msg, 'Nothing changed.');
    try {
      const r = await api('PUT', '/api/settings/env', { changes });
      toast(`Saved ${r.updated.join(', ')}`);
      await loadConfig();
      render();
    } catch (err) {
      put(msg, h('span', { class: 'err' }, err.message));
    }
  };
  return h('section', { class: 'panel' }, h('h2', {}, title), fields.map((f) => f.row), after || null,
    h('div', { class: 'row mt12' }, h('button', { class: 'btn primary', onclick: save }, 'Save'), msg));
}

function linesToMap(text, sep) {
  const out = {};
  for (const line of String(text).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const MCP_PRESET = {
  transport: 'stdio',
  command: 'docker',
  args: ['run', '-i', '--rm', '-e', 'JIRA_URL', '-e', 'JIRA_PERSONAL_TOKEN', '-e', 'CONFLUENCE_URL', '-e', 'CONFLUENCE_PERSONAL_TOKEN', 'ghcr.io/sooperset/mcp-atlassian:latest'],
  env: { JIRA_URL: '${JIRA_URL}', JIRA_PERSONAL_TOKEN: '${JIRA_PAT}', CONFLUENCE_URL: '${CONFLUENCE_URL}', CONFLUENCE_PERSONAL_TOKEN: '${CONFLUENCE_PAT}' },
  tools: {},
};

function mcpEditor(saved, mcpSecret) {
  let cfg = saved ? JSON.parse(JSON.stringify(saved)) : null;
  const holder = h('div', {});
  const result = h('div', {});
  const draw = () => {
    const c = cfg || { transport: 'stdio', command: '', args: [], env: {}, tools: {} };
    const transport = h('select', {}, ['stdio', 'http'].map((t) => h('option', { value: t, selected: c.transport === t }, t)));
    const command = h('input', { type: 'text', class: 'wide', value: c.command || '', placeholder: 'docker / npx / uvx / path to server' });
    const args = h('textarea', { class: 'wide', placeholder: 'one argument per line' });
    args.value = (c.args || []).join('\n');
    const env = h('textarea', { class: 'wide', placeholder: 'NAME=${SETTING} per line' });
    env.value = Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const url = h('input', { type: 'text', class: 'wide', value: c.url || '', placeholder: 'https://mcp.example/atlassian/mcp' });
    const headers = h('textarea', { class: 'wide', placeholder: 'Authorization: Bearer ${ATLASSIAN_MCP_TOKEN}' });
    headers.value = Object.entries(c.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const toolRow = (kind, def) => {
      const t = c.tools && kind in c.tools ? c.tools[kind] : undefined;
      const off = h('input', { type: 'checkbox', checked: t === null });
      const name = h('input', { type: 'text', value: t && t.name ? t.name : '', placeholder: def });
      const args2 = h('input', { type: 'text', class: 'wide', value: t && t.args ? JSON.stringify(t.args) : '', placeholder: 'arguments JSON (default for the server)' });
      return { kind, off, name, args: args2, row: h('tr', {}, h('td', {}, kind), h('td', {}, name), h('td', {}, args2), h('td', {}, kind === 'issue' ? '' : h('label', { class: 'small' }, off, ' off'))) };
    };
    const tools = [toolRow('issue', 'jira_get_issue'), toolRow('page', 'confluence_get_page'), toolRow('search', 'confluence_search')];
    const stdioBox = h('div', { hidden: c.transport !== 'stdio' }, h('label', { class: 'field' }, 'Command', command), h('label', { class: 'field' }, 'Arguments', args), h('label', { class: 'field' }, 'Environment (values may use ${SETTING})', env));
    const httpBox = h('div', { hidden: c.transport !== 'http' }, h('label', { class: 'field' }, 'URL', url), h('label', { class: 'field' }, 'Headers (Name: value)', headers));
    transport.addEventListener('change', () => {
      stdioBox.hidden = transport.value !== 'stdio';
      httpBox.hidden = transport.value !== 'http';
    });
    const collect = () => {
      const out = { transport: transport.value, tools: {} };
      if (out.transport === 'stdio') Object.assign(out, { command: command.value.trim(), args: args.value.split('\n').map((s) => s.trim()).filter(Boolean), env: linesToMap(env.value, '=') });
      else Object.assign(out, { url: url.value.trim(), headers: linesToMap(headers.value, ':') });
      for (const t of tools) {
        if (t.off.checked) out.tools[t.kind] = null;
        else if (t.name.value.trim()) {
          let a;
          if (t.args.value.trim()) a = JSON.parse(t.args.value);
          out.tools[t.kind] = { name: t.name.value.trim(), ...(a ? { args: a } : {}) };
        }
      }
      return out;
    };
    const guard = (fn) => async () => {
      try {
        await fn();
      } catch (err) {
        put(result, h('div', { class: 'notice bad' }, err.message));
      }
    };
    put(holder,
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Transport'), transport,
        h('button', { type: 'button', class: 'btn', onclick: () => { cfg = JSON.parse(JSON.stringify(MCP_PRESET)); draw(); } }, 'Preset: mcp-atlassian (docker)')),
      stdioBox, httpBox,
      h('div', { class: 'label mt12' }, 'Tool mapping (empty = mcp-atlassian names)'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Use', 'Tool name', 'Arguments', ''].map((c) => h('th', {}, c)))), h('tbody', {}, tools.map((x) => x.row))),
      mcpSecret,
      h('div', { class: 'row mt12' },
        h('button', { class: 'btn', onclick: guard(async () => {
          put(result, h('p', { class: 'small muted' }, 'Connecting…'));
          const r = await api('POST', '/api/settings/mcp/test', { server: collect() });
          put(result, r.ok ? h('div', { class: 'notice' }, `Connected to ${(r.server && r.server.name) || 'server'}: ${r.tools} tools, mapped tools present.`) : h('div', { class: 'notice bad' }, r.error || `Missing tools on the server: ${r.missing.join(', ')}`));
        }) }, 'Test connection'),
        h('button', { class: 'btn primary', onclick: guard(async () => {
          await api('PUT', '/api/settings/mcp', { server: collect() });
          toast('MCP configuration saved');
          render();
        }) }, 'Save MCP server'),
        saved ? h('button', { class: 'btn danger', onclick: guard(async () => {
          if (!confirm('Remove the MCP configuration? Ticket intake falls back to REST or files.')) return;
          await api('PUT', '/api/settings/mcp', { server: null });
          toast('MCP configuration removed');
          render();
        }) }, 'Remove') : null),
      result);
  };
  draw();
  return holder;
}

function reposEditor(repos) {
  const rows = Object.entries(repos).map(([name, r]) => ({ name, checkout: r.checkout, remote: r.remote || '', test_command: r.test_command || '' }));
  const body = h('tbody', {});
  const msg = h('div', {});
  const draw = () => put(body, rows.map((r, i) => h('tr', {},
    ...['name', 'checkout', 'remote', 'test_command'].map((k) => h('td', {}, h('input', { type: 'text', class: 'wide', value: r[k], placeholder: { name: 'owner/repository', checkout: 'D:/src/repo', remote: 'origin', test_command: 'auto (Maven/Gradle/pytest)' }[k], oninput: (e) => { r[k] = e.target.value; } }))),
    h('td', {}, h('button', { type: 'button', class: 'linkbtn', onclick: () => { rows.splice(i, 1); draw(); } }, 'remove')))));
  draw();
  return h('div', {},
    h('table', {}, h('thead', {}, h('tr', {}, ['Repository', 'Local checkout', 'Remote', 'Test command', ''].map((c) => h('th', {}, c)))), body),
    h('p', { class: 'small muted' }, 'Test command placeholders: {selector} {class} {path} {junit}. Leave empty to detect Maven, Gradle or pytest.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { rows.push({ name: '', checkout: '', remote: '', test_command: '' }); draw(); } }, 'Add repository'),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          await api('PUT', '/api/settings/repos', { repos: rows.filter((r) => r.name || r.checkout) });
          toast('Repositories saved');
          await loadConfig();
          render();
        } catch (err) {
          put(msg, h('div', { class: 'notice bad' }, err.message));
        }
      } }, 'Save')),
    msg);
}

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

async function diskPanel() {
  const rows = await api('GET', '/api/disk').catch(() => []);
  const days = h('input', { type: 'number', min: '0', value: '14' });
  const runs = h('input', { type: 'checkbox' });
  const go = (apply) => () => {
    if (apply && !confirm(`Remove ${runs.checked ? 'whole runs' : 'worktrees and attempt files'} untouched for ${days.value} days?`)) return;
    startJob(api('POST', '/api/clean', { olderThan: Number(days.value), runs: runs.checked, apply }), apply ? 'Cleanup' : 'Cleanup preview');
  };
  const total = rows.reduce((n, r) => n + r.size, 0);
  return h('section', { class: 'panel' },
    h('h2', {}, `Disk usage (${mb(total)})`),
    rows.length ? table(['Run', 'Size', 'Worktrees', 'Attempt files', 'Last activity'], rows.slice(0, 20).map((r) => [h('a', { href: r.kind === 'pr' ? `#/pr/${r.id}` : `#/ticket/${r.id}` }, r.id), mb(r.size), r.worktrees ? `${r.worktrees} · ${mb(r.worktree_bytes)}` : '—', mb(r.attempts), h('span', { class: 'small muted' }, fmtTime(r.last))])) : h('p', { class: 'muted' }, 'No runs yet.'),
    h('div', { class: 'row mt12' }, h('label', { class: 'small' }, 'Untouched for ', days, ' days'), h('label', { class: 'small' }, runs, ' whole runs (otherwise worktrees and attempt files)'),
      h('button', { class: 'btn', onclick: go(false) }, 'Preview'), h('button', { class: 'btn danger', onclick: go(true) }, 'Clean up')),
    h('p', { class: 'small muted' }, 'Removing a review worktree makes that run read-only: reports stay, re-validation and the source view need it.'));
}

async function memoryPanel() {
  const entries = await api('GET', '/api/memory').catch(() => []);
  const forget = (id) => async () => {
    try {
      await api('POST', `/api/memory/${encodeURIComponent(id)}/forget`, {});
      toast(`Forgot ${id}`);
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  return h('section', { class: 'panel' },
    h('h2', {}, `Rejected findings (${entries.length})`),
    h('p', { class: 'small muted' }, 'Findings a person rejected. Similar findings in the same repository are marked; P3/P4 look-alikes are left out of published drafts, P1/P2 are still published with a note. Validation itself never reads this list.'),
    entries.length
      ? table(['Id', 'Repository', 'Finding', 'Reason', 'By', ''], entries.map((e) => [
        h('span', { class: 'mono small' }, e.id), e.scope,
        h('div', {}, h('span', { class: `badge ${e.severity}` }, e.severity), ` ${e.title}`, e.path ? h('div', { class: 'mono small muted' }, e.path) : null),
        e.reason, h('span', { class: 'small muted' }, `${e.source} ${fmtTime(e.at)}`),
        h('button', { type: 'button', class: 'btn', onclick: forget(e.id) }, 'Forget')]))
      : h('p', { class: 'muted small' }, 'Nothing rejected yet.'));
}

async function renderSettings() {
  const s = await api('GET', '/api/settings');
  const by = (g) => s.env.filter((e) => e.group === g);
  const jira = by('jira');
  const active = s.mcp ? 'MCP server' : jira.find((e) => e.key === 'JIRA_URL').value ? 'Jira REST' : 'files only (--from-file / paste)';
  const mcpSecret = settingsSection('Secret for the MCP server', by('mcp'), s.models);
  const running = state.jobs.find((j) => j.kind === 'doctor' && ['queued', 'running'].includes(j.status));
  const last = !running && state.jobs.find((j) => j.kind === 'doctor');
  let diag = null;
  if (running) diag = livePanel(running);
  else if (last) {
    const pre = h('pre', { class: 'log live-log' });
    diag = h('div', {}, h('div', { class: 'row' }, h('span', { class: 'label' }, 'Last check'), statusBadge(last.status), h('span', { class: 'small muted' }, fmtTime(last.finished_at))), pre);
    followJob(last.id, { pre });
  }
  put($main,
    h('h1', {}, 'Settings'),
    h('p', { class: 'muted small' }, 'Saved to .env and config/*.json. New jobs use the new values right away; secrets are never shown again after saving.'),
    h('datalist', { id: 'model-list' }, s.models.map((m) => h('option', { value: m }))),
    ['executor', 'review', 'repro'].map((g) => settingsSection(GROUP_TITLES[g], by(g), s.models)),
    h('section', { class: 'panel' },
      h('h2', {}, 'Ticket source'),
      h('p', {}, 'Active: ', h('strong', {}, active), h('span', { class: 'small muted' }, ' — an MCP server wins, then Jira REST, then files.')),
      h('h3', {}, 'MCP server (when Jira/Confluence are not reachable from this machine)'),
      mcpEditor(s.mcp, mcpSecret)),
    settingsSection('Jira / Confluence REST', jira, s.models),
    h('section', { class: 'panel' }, h('h2', {}, 'Repositories'), reposEditor(s.repos)),
    await memoryPanel(),
    await diskPanel(),
    h('section', { class: 'panel' },
      h('h2', {}, 'Diagnostics'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => startJob(api('POST', '/api/doctor', {}), 'Doctor') }, 'Run doctor'),
        h('span', { class: 'small muted' }, 'git, gh, codex (a real call that must read a file), repositories and the ticket source.')),
      diag),
    h('p', { class: 'small muted' }, `Files: ${s.files.env} · ${s.files.repos} · ${s.files.mcp}`),
  );
}

// ---------- boot ----------
window.addEventListener('hashchange', render);
(async () => {
  try {
    await loadConfig();
  } catch (err) {
    put($main, h('div', { class: 'notice bad' }, `Cannot reach the dashboard server: ${err.message}`));
    return;
  }
  await refreshJobs();
  await refreshSidebar();
  render();
  setInterval(refreshJobs, 2000);
  setInterval(refreshSidebar, 10000);
})();
