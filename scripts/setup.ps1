<#
.SYNOPSIS
  One-step setup of agent-review-workflows on Windows.

.DESCRIPTION
  Checks what arw needs and offers to install what is missing:
    required  Node 20+ (npm comes with it), git, codex CLI (+ codex login)
    for PRs   GitHub CLI (+ gh auth login): GitHub PR reviews and publishing
    optional  JDK 17 (-WithJava): precise Java impact analysis, repro of Java PRs on this machine
              Docker Desktop (-WithDocker): sandboxed repro; then no Java or Maven is needed here
  Then creates .env and config/repos.json if they are missing, and runs `arw doctor`.
  It asks before every install (unless -Yes) and is safe to run again.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -CheckOnly
#>
param(
  [switch]$CheckOnly,   # report only: install and change nothing
  [switch]$Yes,         # install without asking
  [switch]$WithJava,    # also offer Temurin JDK 17
  [switch]$WithDocker,  # also offer Docker Desktop
  [switch]$SkipLogin,   # do not run gh auth login / codex login
  [switch]$SkipDoctor   # do not run arw doctor (it makes one tiny codex call)
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$summary = New-Object System.Collections.ArrayList

function Say($text) { Write-Host $text }
function Ok($name, $detail) { Write-Host ('  ok    {0,-14} {1}' -f $name, $detail) -ForegroundColor Green; [void]$summary.Add(@($name, 'ok', $detail)) }
function Miss($name, $detail) { Write-Host ('  MISS  {0,-14} {1}' -f $name, $detail) -ForegroundColor Yellow; [void]$summary.Add(@($name, 'missing', $detail)) }
function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Ask($question) {
  if ($CheckOnly) { return $false }
  if ($Yes) { return $true }
  $answer = Read-Host "$question [y/N]"
  return ($answer -match '^(y|yes)$')
}

function Install-Winget($id, $what) {
  if (-not (Has 'winget')) {
    Say "  winget is not available: install $what yourself, then run this script again."
    return $false
  }
  & winget install --id $id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  return ($LASTEXITCODE -eq 0)
}

function Node-Major {
  if (-not (Has 'node')) { return 0 }
  $v = & node -p "process.versions.node.split('.')[0]"
  return [int]$v
}

function Codex-Js {
  return (Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js')
}

# Found only when it can run: the npm package needs node.
function Codex-Found {
  if ($env:CODEX_BIN -and (Test-Path $env:CODEX_BIN)) { return $true }
  if ((Test-Path (Codex-Js)) -and (Has 'node')) { return $true }
  return (Has 'codex')
}

function Run-Codex {
  # The npm shim is a .cmd; run the package's JS entry with node when it is there.
  if ((Test-Path (Codex-Js)) -and (Has 'node')) { & node (Codex-Js) @args } else { & codex @args }
}

Say ''
Say "agent-review-workflows setup ($Root)"
if ($CheckOnly) { Say '(check only: nothing is installed or changed)' }
Say ''
Say 'Tools'

# Node 20+ (the runtime; npm comes with it)
if ((Node-Major) -lt 20) {
  if (Ask 'Node 20+ is required. Install Node LTS with winget?') { [void](Install-Winget 'OpenJS.NodeJS.LTS' 'Node 20+') }
}
if ((Node-Major) -ge 20) { Ok 'node' (& node --version) } else { Miss 'node' 'Node 20+ is required: https://nodejs.org' }

# git
if (-not (Has 'git')) {
  if (Ask 'git is required. Install Git with winget?') { [void](Install-Winget 'Git.Git' 'Git') }
}
if (Has 'git') { Ok 'git' (& git --version) } else { Miss 'git' 'required: https://git-scm.com' }

# codex CLI (every model call)
if (-not (Codex-Found)) {
  if ((Has 'npm') -and (Ask 'The codex CLI is required. Install it with npm i -g @openai/codex?')) {
    & npm i -g '@openai/codex'
    Refresh-Path
  }
}
if (Codex-Found) { Ok 'codex' ((Run-Codex --version) | Select-Object -First 1) } else { Miss 'codex' 'required: npm i -g @openai/codex' }

# GitHub CLI (PR reviews and publishing)
if (-not (Has 'gh')) {
  if (Ask 'GitHub CLI is needed to review GitHub PRs. Install it with winget?') { [void](Install-Winget 'GitHub.cli' 'GitHub CLI') }
}
if (Has 'gh') { Ok 'gh' ((& gh --version) | Select-Object -First 1) } else { Miss 'gh' 'needed for GitHub PRs: winget install GitHub.cli' }

# Optional: JDK 17
$hasJdk = Has 'javac'
if (-not $hasJdk -and $WithJava) {
  if (Ask 'Install Temurin JDK 17 with winget?') { $hasJdk = Install-Winget 'EclipseAdoptium.Temurin.17.JDK' 'a JDK 17'; $hasJdk = Has 'javac' }
}
if ($hasJdk) { Ok 'jdk' ((& javac -version 2>$null) | Select-Object -First 1) } else { Say '  --    jdk            optional (-WithJava): without it Java impact uses the structural index; set ARW_JAVA_AST=off to silence doctor' }

# Optional: Docker Desktop
$hasDocker = Has 'docker'
if (-not $hasDocker -and $WithDocker) {
  if (Ask 'Install Docker Desktop with winget?') { [void](Install-Winget 'Docker.DockerDesktop' 'Docker Desktop'); $hasDocker = Has 'docker' }
}
if ($hasDocker) { Ok 'docker' ((& docker --version) | Select-Object -First 1) } else { Say '  --    docker         optional (-WithDocker): runs PR code in containers (then set ARW_SANDBOX=docker)' }

Say ''
Say 'Project files'
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) { Ok '.env' 'exists' }
elseif ($CheckOnly) { Miss '.env' 'would be copied from .env.example' }
else { Copy-Item (Join-Path $Root '.env.example') $envFile; Ok '.env' 'created from .env.example' }

$reposFile = Join-Path $Root 'config\repos.json'
if (Test-Path $reposFile) { Ok 'repos.json' 'exists' }
elseif ($CheckOnly) { Miss 'repos.json' 'would be created empty' }
else { Set-Content -Path $reposFile -Value "{`n  `"repos`": {}`n}" -Encoding ascii; Ok 'repos.json' 'created empty: add repositories later' }

if (-not $SkipLogin) {
  Say ''
  Say 'Sign-in'
  if (Has 'gh') {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { Ok 'gh auth' 'signed in' }
    elseif (Ask 'Sign in to GitHub now (gh auth login)?') { & gh auth login }
    else { Miss 'gh auth' 'run: gh auth login' }
  }
  if (Codex-Found) {
    Run-Codex login status *> $null
    if ($LASTEXITCODE -eq 0) { Ok 'codex login' 'signed in' }
    elseif (Ask 'Sign in to codex now (codex login)?') { Run-Codex login }
    else { Miss 'codex login' 'run: codex login' }
  }
}

if (-not $SkipDoctor -and -not $CheckOnly -and (Node-Major) -ge 20) {
  Say ''
  Say 'arw doctor (one tiny codex call)'
  & node (Join-Path $Root 'src\cli\arw.js') doctor
}

$missing = @($summary | Where-Object { $_[1] -eq 'missing' })
Say ''
if ($missing.Count) {
  Say ('Still missing: ' + (($missing | ForEach-Object { $_[0] }) -join ', ') + '. Install them and run this script again.')
} else {
  Say 'Ready. Next:'
}
Say '  add a repository   node src\cli\arw.js sandbox setup <folder> --register   (or edit config\repos.json)'
Say '  open the dashboard npm start'
Say '  review a PR        node src\cli\arw.js review --repo owner/name --pr <n>'
if ($missing.Count) { exit 1 } else { exit 0 }
