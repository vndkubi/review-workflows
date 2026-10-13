'use strict';
// Runs every test/*.test.js with node --test. Node 20 does not expand globs
// itself, and cmd.exe does not either, so the file list is built here.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const only = process.argv.slice(2);
const res = spawnSync(process.execPath, ['--test', ...(only.length ? only : files)], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
