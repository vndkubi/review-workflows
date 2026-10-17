#!/usr/bin/env bash
# One-step setup of agent-review-workflows on macOS and Linux.
#
# Checks what arw needs and offers to install what is missing:
#   required  Node 20+ (npm comes with it), git, codex CLI (+ codex login)
#   for PRs   GitHub CLI (+ gh auth login): GitHub PR reviews and publishing
#   optional  JDK 17 (--with-java): precise Java impact analysis, repro of Java PRs on this machine
#             Docker (--with-docker): sandboxed repro; then no Java or Maven is needed here
# Then runs `arw setup` (project files, --preset fast|thorough|java-docker) and `arw doctor`.
# It asks before every install (unless --yes) and is safe to run again.
#
#   scripts/setup.sh [--check-only] [--yes] [--with-java] [--with-docker] [--skip-login] [--skip-doctor]
#                    [--preset fast|thorough|java-docker]
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_ONLY=0 YES=0 WITH_JAVA=0 WITH_DOCKER=0 SKIP_LOGIN=0 SKIP_DOCTOR=0 PRESET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    --yes) YES=1 ;;
    --with-java) WITH_JAVA=1 ;;
    --with-docker) WITH_DOCKER=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;
    --skip-doctor) SKIP_DOCTOR=1 ;;
    --preset) shift; PRESET="${1:-}" ;;
    --preset=*) PRESET="${1#--preset=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PRESET" in ""|fast|thorough|java-docker) ;; *) echo "unknown preset: $PRESET (fast, thorough, java-docker)" >&2; exit 2 ;; esac

MISSING=()
has() { command -v "$1" >/dev/null 2>&1; }
ok() { printf '  ok    %-14s %s\n' "$1" "$2"; }
miss() { printf '  MISS  %-14s %s\n' "$1" "$2"; MISSING+=("$1"); }
ask() {
  [ "$CHECK_ONLY" = 1 ] && return 1
  [ "$YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

OS="$(uname -s)"
PM=""
if [ "$OS" = "Darwin" ] && has brew; then PM=brew
elif has apt-get; then PM=apt
elif has dnf; then PM=dnf
fi

# install <brew formula> <apt package> <dnf package> <what>; empty name = not offered there
install() {
  case "$PM" in
    brew) [ -n "$1" ] && brew install $1 && return 0 ;;
    apt) [ -n "$2" ] && sudo apt-get install -y $2 && return 0 ;;
    dnf) [ -n "$3" ] && sudo dnf install -y $3 && return 0 ;;
  esac
  echo "  no package manager step for $4 here: install it yourself, then run this script again."
  return 1
}

node_major() { has node && node -p "process.versions.node.split('.')[0]" || echo 0; }

echo
echo "agent-review-workflows setup ($ROOT)"
[ "$CHECK_ONLY" = 1 ] && echo "(check only: nothing is installed or changed)"
echo
echo "Tools"

# Node 20+: distribution packages are often older, so apt/dnf are not used for it.
if [ "$(node_major)" -lt 20 ]; then
  if [ "$PM" = brew ]; then
    ask "Node 20+ is required. Install it with brew?" && install node "" "" "Node 20+"
  else
    echo "  Node 20+ is required: install it from https://nodejs.org or with nvm/fnm (distribution packages are often older)."
  fi
fi
if [ "$(node_major)" -ge 20 ]; then ok node "$(node --version)"; else miss node "Node 20+ is required: https://nodejs.org"; fi

if ! has git; then ask "git is required. Install it?" && install git git git "git"; fi
if has git; then ok git "$(git --version)"; else miss git "required"; fi

if ! has codex && [ -z "${CODEX_BIN:-}" ]; then
  if has npm && ask "The codex CLI is required. Install it with npm i -g @openai/codex?"; then
    npm i -g @openai/codex || echo "  npm could not install globally; see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  fi
fi
if has codex; then ok codex "$(codex --version | head -n 1)"; elif [ -n "${CODEX_BIN:-}" ]; then ok codex "CODEX_BIN=$CODEX_BIN"; else miss codex "required: npm i -g @openai/codex"; fi

if ! has gh; then ask "GitHub CLI is needed to review GitHub PRs. Install it?" && install gh gh gh "GitHub CLI (https://cli.github.com)"; fi
if has gh; then ok gh "$(gh --version | head -n 1)"; else miss gh "needed for GitHub PRs: https://cli.github.com"; fi

if ! has javac && [ "$WITH_JAVA" = 1 ]; then
  ask "Install a JDK 17?" && install "--cask temurin@17" openjdk-17-jdk java-17-openjdk-devel "a JDK 17"
fi
if has javac; then ok jdk "$(javac -version 2>&1 | head -n 1)"; else echo "  --    jdk            optional (--with-java): without it Java impact uses the structural index; set ARW_JAVA_AST=off to silence doctor"; fi

if ! has docker && [ "$WITH_DOCKER" = 1 ]; then
  if [ "$PM" = brew ]; then ask "Install Docker Desktop with brew?" && install "--cask docker" "" "" "Docker"
  else echo "  install Docker Engine: https://docs.docker.com/engine/install/"; fi
fi
if has docker; then ok docker "$(docker --version)"; else echo "  --    docker         optional (--with-docker): runs PR code in containers (then set ARW_SANDBOX=docker)"; fi

if [ "$SKIP_LOGIN" = 0 ]; then
  echo
  echo "Sign-in"
  if has gh; then
    if gh auth status >/dev/null 2>&1; then ok "gh auth" "signed in"
    elif ask "Sign in to GitHub now (gh auth login)?"; then gh auth login
    else miss "gh auth" "run: gh auth login"; fi
  fi
  if has codex; then
    if codex login status >/dev/null 2>&1; then ok "codex login" "signed in"
    elif ask "Sign in to codex now (codex login)?"; then codex login
    else miss "codex login" "run: codex login"; fi
  fi
fi

# Project files and the preset: the same core as the dashboard's setup wizard.
if [ "$(node_major)" -ge 20 ]; then
  echo
  echo "arw setup"
  if [ "$CHECK_ONLY" = 1 ]; then node "$ROOT/src/cli/arw.js" setup --check
  elif [ -n "$PRESET" ]; then node "$ROOT/src/cli/arw.js" setup --preset "$PRESET"
  else node "$ROOT/src/cli/arw.js" setup; fi
fi

if [ "$SKIP_DOCTOR" = 0 ] && [ "$CHECK_ONLY" = 0 ] && [ "$(node_major)" -ge 20 ]; then
  echo
  echo "arw doctor (one tiny codex call)"
  node "$ROOT/src/cli/arw.js" doctor
fi

echo
if [ "${#MISSING[@]}" -gt 0 ]; then echo "Still missing: ${MISSING[*]}. Install them and run this script again."; else echo "Ready. Next:"; fi
echo "  add a repository   node src/cli/arw.js sandbox setup <folder> --register   (or edit config/repos.json)"
echo "  open the dashboard npm start"
echo "  review a PR        node src/cli/arw.js review --repo owner/name --pr <n>"
[ "${#MISSING[@]}" -eq 0 ]
