'use strict';
// arw dashboard. All data is rendered through text nodes (h()), never
// innerHTML: findings, quotes and ticket text are untrusted content.

const TOKEN = document.querySelector('meta[name="arw-token"]').content;
const $main = document.getElementById('main');
const $sidebar = document.getElementById('sidebar');
const state = { config: null, runs: { tickets: [], prs: [] }, jobs: [], route: '', viewTimer: null, filters: { sev: new Set(['P1', 'P2', 'P3', 'P4']), hideDupes: true, showWithdrawn: false } };

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
  const cls = /PASS|READY|CONFIRMED|succeeded|approved|no_blocking/.test(status) ? 'ok' : /FAIL|BLOCKED|INVALID|failed|rejected|changes_requested/.test(status) ? 'bad' : 'warn';
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
  return t.type === 'pr' ? `#/pr/${t.id}` : `#/ticket/${t.key}`;
}

async function startJob(promise, label) {
  try {
    const job = await promise;
    toast(`${label} queued`);
    await refreshJobs();
    location.hash = `#/job/${job.id}`;
  } catch (err) {
    toast(err.message);
  }
}

// ---------- router ----------
async function render() {
  clearInterval(state.viewTimer);
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
    else renderHome();
  } catch (err) {
    put($main, h('div', { class: 'notice bad' }, err.message));
  }
  $main.focus({ preventScroll: true });
}

function renderHome() {
  const prs = state.runs.prs;
  const open = prs.reduce((n, p) => n + (p.counts ? p.counts.P1 + p.counts.P2 : 0), 0);
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
  );
}

function stat(n, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'n' }, fmtNum(n)), h('div', { class: 'l' }, label));
}

function prTable(prs) {
  return h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'PR'), h('th', {}, 'Title'), h('th', {}, 'Status'), h('th', {}, 'Recommendation'), h('th', {}, 'Open'), h('th', {}, 'Updated'))),
    h('tbody', {}, prs.map((p) => h('tr', {},
      h('td', {}, h('a', { href: `#/pr/${p.id}` }, `${p.repo}#${p.pr}`)),
      h('td', {}, p.title || ''),
      h('td', {}, statusBadge(p.status)),
      h('td', {}, p.recommendation ? statusBadge(p.recommendation) : '–'),
      h('td', {}, sevCounts(p.counts) || '–'),
      h('td', { class: 'muted small' }, fmtTime(p.updated_at))))));
}

// ---------- PR view ----------
async function renderPr(id) {
  const d = await api('GET', `/api/prs/${encodeURIComponent(id)}`);
  const v = d.validation;
  const idn = d.identity;
  const tabs = ['Findings', 'Items', 'Overview', 'Units', 'Plan', 'Cost'];
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
    v ? prSummary(d) : h('div', { class: 'notice' }, 'This review has no validation yet. It may still be running.'),
    prActions(d),
    tabBar,
    body,
  );
  if (!v) return;
  if (current === 'Findings') add(body, findingsView(d));
  else if (current === 'Overview') add(body, overviewView(d));
  else if (current === 'Items') add(body, itemsView(d));
  else if (current === 'Units') add(body, unitsView(d));
  else if (current === 'Plan') add(body, h('pre', { class: 'code' }, d.plan || 'No plan.'));
  else add(body, costView(d));
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
    v.gaps.length ? h('div', { class: 'notice' }, h('strong', {}, 'Not verified: '), v.gaps.join(' · ')) : null,
    v.opt_outs && v.opt_outs.length ? h('div', { class: 'notice' }, `Opt-outs recorded: ${v.opt_outs.join(', ')}`) : null,
  );
}

function prActions(d) {
  const { repo, pr } = d.identity;
  const gate = d.gate || { decision: 'NOT_RECORDED' };
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
      h('a', { class: 'btn', href: `#/publish/${d.id}` }, 'Publish…'),
      h('button', { class: 'btn', onclick: () => startJob(api('POST', `/api/prs/${encodeURIComponent(d.id)}/validate`, {}), 'Validate') }, 'Re-validate'),
      h('button', { class: 'btn', onclick: () => startJob(api('POST', '/api/reviews', { repo, pr, refresh: true }), 'Review') }, 'Re-run (refresh)')) : null,
    d.published ? h('div', { class: 'small muted mt8' },
      `Published ${fmtTime(d.published.at)}: ${d.published.inline.length} inline + ${d.published.summary_only.length} summary`,
      d.published.html_url ? [' · ', h('a', { href: d.published.html_url, target: '_blank', rel: 'noopener noreferrer' }, 'open pending review on GitHub')] : '') : null,
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
    meta.rebuttal ? h('p', {}, h('span', { class: 'label' }, `Rebuttal ${meta.rebuttal.verdict}${meta.rebuttal_from && meta.rebuttal_from !== meta.id ? ` (from ${meta.rebuttal_from})` : ''} `), `Tried: ${meta.rebuttal.defense_attempted} ${meta.rebuttal.reason}`) : null,
    h('div', { class: 'label' }, 'Evidence'),
    h('ul', {}, f.evidence.map((ev) => evidenceItem(d, ev))),
    dupes.length ? h('p', { class: 'small muted' }, `Same defect also reported by: ${dupes.map((x) => x.id).join(', ')}`) : null,
  );
  add(card, body);
  return card;
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
      h('button', { class: 'btn primary', onclick: () => { if (confirm('Create a pending review on GitHub as you?')) startJob(api('POST', `/api/prs/${encodeURIComponent(d.id)}/publish`, { minSeverity: min.value }), 'Publish'); } }, 'Create pending review')),
    preview,
  );
  load();
}

// ---------- ticket view ----------
async function renderTicket(key) {
  const t = await api('GET', `/api/tickets/${encodeURIComponent(key)}`);
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
    s ? specGate(key, t) : null,
    s ? specView(s) : section('Spec', h('p', { class: 'muted' }, 'Not built yet.')),
    t.analysis ? analysisView(t.analysis, s) : [],
    section('Requirement items', t.requirements ? requirementsTable(t.requirements) : h('p', { class: 'muted' }, 'Not extracted yet.')),
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
  const flags = { singleRole: 'Single role (business units: business pass only)', skipSeams: 'Skip seams', skipRebuttals: 'Skip red-team', skipSynthesis: 'Skip synthesis', refresh: 'Refresh (re-plan, re-freeze)' };
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
  const submit = (e) => {
    e.preventDefault();
    const body = { repo: repo.value, pr: Number(pr.value), ticket: ticket.value.trim() || undefined, workers: Number(workers.value) || undefined };
    for (const k of Object.keys(flags)) body[k] = boxes[k].checked;
    startJob(api('POST', '/api/reviews', body), 'Review');
  };
  put($main, 
    h('h1', {}, 'New review'),
    !state.config.repos.length ? h('div', { class: 'notice bad' }, 'No repositories in config/repos.json.') : null,
    h('form', { class: 'stack', onsubmit: submit },
      h('label', { class: 'field' }, 'Repository', repo),
      prList,
      h('label', { class: 'field' }, 'Pull request', pr),
      h('label', { class: 'field' }, 'Ticket', ticket),
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

function renderJob(id) {
  const log = h('pre', { class: 'log' });
  const head = h('div', {});
  let offset = 0;
  const tick = async () => {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) {
      put(head, h('div', { class: 'notice bad' }, 'Unknown job.'));
      return;
    }
    put(head, 
      h('h1', {}, `${job.kind} ${job.title}`),
      h('div', { class: 'row' }, statusBadge(job.status), h('span', { class: 'mono small' }, job.command),
        ['queued', 'running'].includes(job.status) ? h('button', { class: 'btn danger', onclick: async () => { await api('POST', `/api/jobs/${id}/cancel`, {}); refreshJobs(); } }, 'Cancel') : null,
        job.target && !['queued', 'running'].includes(job.status) ? h('a', { class: 'btn primary', href: targetHash(job.target) }, 'Open result') : null),
    );
    try {
      const chunk = await api('GET', `/api/jobs/${id}/log?from=${offset}`);
      if (chunk.text) {
        const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
        log.append(document.createTextNode(chunk.text));
        if (atBottom) log.scrollTop = log.scrollHeight;
      }
      offset = chunk.next;
    } catch {
      /* transient */
    }
  };
  put($main, head, log);
  tick();
  state.viewTimer = setInterval(() => { if (location.hash === `#/job/${id}`) tick(); }, 1500);
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
