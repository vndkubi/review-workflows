'use strict';
// How to fix what `arw doctor` finds missing, per platform. The setup scripts
// (scripts/setup.ps1, scripts/setup.sh) run these steps for you.

const SETUP = { win32: 'or run scripts\\setup.ps1', darwin: 'or run scripts/setup.sh', linux: 'or run scripts/setup.sh' };

const HINTS = [
  [/^node\b/, {
    win32: 'winget install OpenJS.NodeJS.LTS (Node 20+; npm comes with it)',
    darwin: 'brew install node@22 (Node 20+; npm comes with it)',
    linux: 'install Node 20+ from https://nodejs.org or with nvm/fnm (npm comes with it)',
  }],
  [/^git$/, { win32: 'winget install Git.Git', darwin: 'xcode-select --install (or brew install git)', linux: 'sudo apt install git (or your package manager)' }],
  [/^gh auth$/, {
    win32: 'winget install GitHub.cli, then gh auth login (only needed for GitHub PR reviews and publishing)',
    darwin: 'brew install gh, then gh auth login (only needed for GitHub PR reviews and publishing)',
    linux: 'install gh (https://cli.github.com), then gh auth login (only needed for GitHub PR reviews and publishing)',
  }],
  [/^codex$/, { all: 'npm i -g @openai/codex, then codex login (or set CODEX_BIN to a codex binary)' }],
  [/^JDK\b/, {
    win32: 'optional: winget install EclipseAdoptium.Temurin.17.JDK (or set ARW_JAVA_HOME); without it set ARW_JAVA_AST=off',
    darwin: 'optional: brew install --cask temurin@17 (or set ARW_JAVA_HOME); without it set ARW_JAVA_AST=off',
    linux: 'optional: sudo apt install openjdk-17-jdk (or set ARW_JAVA_HOME); without it set ARW_JAVA_AST=off',
  }],
  [/^config\/repos\.json$/, { local: true, all: 'add a repository: node src/cli/arw.js sandbox setup <folder> --register (or edit config/repos.json)' }],
  [/^codex preflight\b/, { local: true, all: 'codex login; if the model is not offered to your login, set CODEX_MODEL in .env to one that is' }],
  [/^Jira\b/, { local: true, all: 'optional: set JIRA_URL and a token in .env, configure config/mcp.json, or use arw ticket KEY --from-file' }],
];

function fixHint(check, platform = process.platform) {
  const row = HINTS.find(([re]) => re.test(check));
  if (!row) return null;
  const hint = row[1].all || row[1][platform] || row[1].linux;
  // Installs are what the setup scripts do; configuration stays local.
  return row[1].local ? hint : `${hint} — ${SETUP[platform] || SETUP.linux}`;
}

module.exports = { fixHint };
