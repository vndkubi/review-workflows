'use strict';
// Runs every test/*.test.js with node --test. Node 20 does not expand globs
// itself, and cmd.exe does not either, so the file list is built here.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const only = process.argv.slice(2);
// A git hook (pre-push) exports GIT_DIR and friends; left in place, every
// fixture repository's git commands would act on this repository instead
// (one set core.bare=true here). Drop git's repository-local variables.
const env = { ...process.env };
let local = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];
const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', env: {} });
if (listed.status === 0) local = local.concat(listed.stdout.split(/\s+/).filter(Boolean));
for (const key of local) delete env[key];
// Fixture PRs are small: keep the planner path unless a test asks otherwise.
// The plain review adds a unit to every plan; tests that need it turn it on.
const res = spawnSync(process.execPath, ['--test', ...(only.length ? only : files)], { stdio: 'inherit', env: { ...env, ARW_SMALL_PR: process.env.ARW_SMALL_PR || 'off', ARW_PLAIN_REVIEW: process.env.ARW_PLAIN_REVIEW || 'off' } });
process.exit(res.status == null ? 1 : res.status);
