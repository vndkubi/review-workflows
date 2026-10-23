'use strict';
// Incident (eval pilot, martian-sentry-5): codex calls were killed as
// "degenerate" because Sentry's own code, printed by `git diff` inside a
// command's output, contains max_output_tokens=150. A cut response is told
// only by codex's own error events, never by text from the repository or
// the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { degenerateEvent } = require('../src/lib/codex');

test('degenerate output: codex error events only, not command output or messages', () => {
  const ev = (o) => JSON.stringify(o);
  assert.equal(degenerateEvent(ev({ type: 'error', message: 'Incomplete response returned, reason: max_output_tokens' })), true);
  assert.equal(degenerateEvent(ev({ type: 'turn.failed', error: { message: 'Incomplete response returned, reason: max_output_tokens' } })), true);
  assert.equal(degenerateEvent(ev({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '         max_output_tokens=150,\n' } })), false);
  assert.equal(degenerateEvent(ev({ type: 'item.completed', item: { type: 'agent_message', text: 'the max_output_tokens argument is ignored' } })), false);
  assert.equal(degenerateEvent(ev({ type: 'error', message: 'stream disconnected' })), false);
  assert.equal(degenerateEvent('not json max_output_tokens'), false);
});
