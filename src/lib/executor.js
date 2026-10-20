'use strict';
// Which CLI runs the model jobs: codex (default) or GitHub Copilot CLI
// (ARW_EXECUTOR=copilot). Both return the runCodex result shape.
function backend() {
  if (process.env.ARW_EXECUTOR === 'copilot') {
    const c = require('./copilot');
    return { name: 'copilot', run: c.runCopilot, preflight: c.preflight, executorConfig: c.executorConfig, manifest: c.manifest };
  }
  const c = require('./codex');
  return { name: 'codex', run: c.runCodex, preflight: c.preflight, executorConfig: c.executorConfig, manifest: () => ({ executor: 'codex' }) };
}

module.exports = { backend };
