'use strict';
// Fail the Docker/ruff isolation job when node:test marked one of those tests
// as skipped. The normal matrix may skip them; the isolation job exists to run
// them, so a skip there is a failed check, not a green run.
const fs = require('node:fs');

const ISOLATION = /docker|real containers|ruff|ARW_DOCKER_TESTS/i;

function skippedIsolation(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /#\s*SKIP\b/i.test(line) && ISOLATION.test(line));
}

function main(argv = process.argv) {
  const file = argv[2];
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const skipped = skippedIsolation(text);
  if (!skipped.length) {
    console.log('isolation tests ran: no Docker or ruff test was skipped');
    return 0;
  }
  console.error('Docker and ruff tests must run in this job; these were skipped:');
  for (const line of skipped) console.error(`  ${line.trim()}`);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { skippedIsolation, main };
