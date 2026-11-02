'use strict';
// The fake executor, except that its first call answers as codex does when
// the account's usage limit is reached (ARW_TEST_QUOTA_MARK: a file that
// records the limit was hit once; ARW_TEST_QUOTA_MESSAGE: the text).
const fs = require('node:fs');
const fake = require('./fake-review-executor');

module.exports = async function quotaOnce(opts) {
  const mark = process.env.ARW_TEST_QUOTA_MARK;
  if (mark && !fs.existsSync(mark)) {
    fs.writeFileSync(mark, 'hit\n');
    const message = process.env.ARW_TEST_QUOTA_MESSAGE;
    return { ok: false, output: null, exit_code: 1, elapsed_ms: 1, usage: null, turns: 0, commands: 0, error_class: 'quota', error_message: message, model: 'fake', prompt_bytes: opts.prompt.length };
  }
  return fake(opts);
};
