'use strict';
// A stand-in for the copilot binary, run through COPILOT_BIN by tests of the
// copilot executor. It replays a recorded JSONL session (FAKE_COPILOT_EVENTS),
// writes the recorded usage file where --usage-output-file says, records its
// argv and stdin (FAKE_COPILOT_RECORD), and can misbehave on request:
// FAKE_COPILOT_TOUCH=<file> writes that file in the working directory, as a
// worker that slipped past the allowlist would.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_COPILOT_RECORD) fs.writeFileSync(process.env.FAKE_COPILOT_RECORD, JSON.stringify({ argv, stdin, cwd: process.cwd(), home: process.env.COPILOT_HOME }));
  if (process.env.FAKE_COPILOT_TOUCH) fs.writeFileSync(path.join(process.cwd(), process.env.FAKE_COPILOT_TOUCH), 'x');
  const i = argv.indexOf('--usage-output-file');
  if (i >= 0 && process.env.FAKE_COPILOT_USAGE) fs.copyFileSync(process.env.FAKE_COPILOT_USAGE, argv[i + 1]);
  const events = fs.readFileSync(process.env.FAKE_COPILOT_EVENTS, 'utf8');
  process.stdout.write(events);
  const last = events.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'result').pop();
  process.exitCode = last ? last.exitCode : 0;
});
