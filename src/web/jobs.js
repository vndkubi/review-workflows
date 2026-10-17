'use strict';
// Sequential job queue: each job runs the `arw` CLI as a child process with
// output to a log file, so the dashboard never does model work itself and
// every job is reproducible from the command line it shows.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, writeJsonAtomic, readJsonIfExists, ensureDir, nowIso } = require('../lib/util');
const { RUNS } = require('../lib/runs');

const DIR = path.join(RUNS, '.jobs');
const STATE = path.join(DIR, 'queue.json');
const CLI = path.join(ROOT, 'src', 'cli', 'arw.js');
const KEEP_FINISHED = 50;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class JobQueue {
  constructor() {
    ensureDir(DIR);
    const saved = readJsonIfExists(STATE, { jobs: [] });
    this.jobs = saved.jobs;
    // A restart loses the child handle: adopt jobs whose process still runs,
    // mark the others interrupted rather than pretending they finished.
    for (const job of this.jobs) {
      if (job.status === 'running') {
        if (job.pid && alive(job.pid)) this.watchAdopted(job);
        else Object.assign(job, { status: 'interrupted', finished_at: nowIso() });
      }
    }
    this.save();
    this.pump();
  }

  save() {
    const finished = this.jobs.filter((j) => !['queued', 'running'].includes(j.status));
    const keep = new Set(finished.slice(-KEEP_FINISHED).map((j) => j.id));
    this.jobs = this.jobs.filter((j) => ['queued', 'running'].includes(j.status) || keep.has(j.id));
    writeJsonAtomic(STATE, { jobs: this.jobs });
  }

  list() {
    return [...this.jobs].reverse();
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  // kind: short label; args: CLI arguments after `arw`; target: run link.
  enqueue({ kind, args, target, title }) {
    const dup = this.jobs.find((j) => ['queued', 'running'].includes(j.status) && JSON.stringify(j.args) === JSON.stringify(args));
    if (dup) return dup;
    const job = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      kind,
      title,
      args,
      target,
      command: `node src/cli/arw.js ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
      status: 'queued',
      queued_at: nowIso(),
    };
    job.log = path.join(DIR, `${job.id}.log`);
    this.jobs.push(job);
    this.save();
    this.pump();
    return job;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      Object.assign(job, { status: 'cancelled', finished_at: nowIso() });
      this.save();
    } else if (job.status === 'running' && job.pid) {
      job.cancel_requested = true;
      this.save();
      killTree(job.pid);
    }
    return job;
  }

  pump() {
    if (this.jobs.some((j) => j.status === 'running')) return;
    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return;
    const out = fs.openSync(next.log, 'a');
    fs.writeSync(out, `$ ${next.command}\n`);
    // ARW_DEBUG: an error leaves its stack trace in the job log, for debugging.
    const env = { ...process.env, ARW_DEBUG: process.env.ARW_DEBUG || '1' };
    const child = spawn(process.execPath, [CLI, ...next.args], { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true, env, detached: process.platform !== 'win32' });
    fs.closeSync(out);
    Object.assign(next, { status: 'running', pid: child.pid, started_at: nowIso() });
    this.save();
    child.on('exit', (code) => this.finish(next, code));
    child.on('error', (err) => {
      fs.appendFileSync(next.log, `\nspawn error: ${err.message}\n`);
      this.finish(next, null);
    });
  }

  finish(job, code) {
    if (job.status !== 'running') return;
    const status = job.cancel_requested ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
    Object.assign(job, { status, exit_code: code, finished_at: nowIso() });
    this.save();
    this.pump();
  }

  watchAdopted(job) {
    const timer = setInterval(() => {
      if (!alive(job.pid)) {
        clearInterval(timer);
        this.finish(job, null);
      }
    }, 3000);
    timer.unref();
  }

  readLog(id, from = 0) {
    const job = this.get(id);
    if (!job || !fs.existsSync(job.log)) return { text: '', next: from };
    const size = fs.statSync(job.log).size;
    const start = Math.max(0, Math.min(Number(from) || 0, size));
    const len = Math.min(size - start, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(job.log, 'r');
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), next: start + len, size };
  }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') require('node:child_process').execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM'); // the job's process group: arw and the codex calls it started
  } catch {
    /* already gone */
  }
}

module.exports = { JobQueue };
