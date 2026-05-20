#!/bin/sh
#
# 2200 installer.
#
# Installs the @twentytwohundred/2200 CLI globally via npm. Idempotent:
# re-running upgrades to the latest published version. macOS + Linux,
# both arm64 and x86_64. Requires Node.js 22 or newer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/twentytwohundred/2200/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/twentytwohundred/2200/main/install.sh | sh -s -- --version 0.1.0
#   curl -fsSL https://raw.githubusercontent.com/twentytwohundred/2200/main/install.sh | sh -s -- --dry-run
#
# Flags:
#   --version <v>    install a specific version (default: latest)
#   --dry-run        print what would be done and exit
#   --no-banner      skip the post-install banner (for scripted setups)
#
# After install:
#   2200    # bare invocation triggers a guided first-run setup
#
# This script never uses sudo. If the global npm prefix is not
# writable, it prints the recommended fix (configure a per-user npm
# prefix; we do not silently elevate). See:
#   https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally

set -eu

# -----------------------------------------------------------------------------
# CLI flag parsing.
# -----------------------------------------------------------------------------
PACKAGE_NAME="@twentytwohundred/2200"
PACKAGE_VERSION="latest"
DRY_RUN=0
NO_BANNER=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      shift
      PACKAGE_VERSION="${1:-latest}"
      ;;
    --version=*)
      PACKAGE_VERSION="${1#--version=}"
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-banner)
      NO_BANNER=1
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *)
      printf 'unknown flag: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

# -----------------------------------------------------------------------------
# Colour helpers (no-op when stdout is not a TTY).
# -----------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  RESET=$(printf '\033[0m')
else
  BOLD=''
  DIM=''
  RED=''
  GREEN=''
  YELLOW=''
  RESET=''
fi

info() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err() { printf '%sx%s %s\n' "$RED" "$RESET" "$*" >&2; }

# -----------------------------------------------------------------------------
# Pre-flight checks.
# -----------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  info "${DIM}(dry run; no changes will be made)${RESET}"
fi

# Platform sanity. macOS arm64/x86_64 + Linux arm64/x86_64 are supported.
UNAME_S=$(uname -s)
case "$UNAME_S" in
  Darwin|Linux) ;;
  *)
    err "Unsupported platform: $UNAME_S. 2200 supports macOS and Linux."
    err "Windows users: install in WSL2."
    exit 1
    ;;
esac

# Node.js: required, >=22.
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed (or not on \$PATH)."
  err "Install Node.js 22+ first:"
  err "  - macOS:   brew install node"
  err "  - Linux:   https://nodejs.org/  (or use your distro's package manager)"
  err "Then re-run this installer."
  exit 1
fi

NODE_VERSION=$(node -e 'process.stdout.write(process.versions.node)')
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js $NODE_VERSION detected; 2200 requires 22 or newer."
  err "Upgrade Node, then re-run this installer."
  exit 1
fi
ok "Node.js $NODE_VERSION"

# npm: comes with Node, but check explicitly.
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed (or not on \$PATH)."
  err "It normally ships with Node.js. Reinstall Node.js and try again."
  exit 1
fi
NPM_VERSION=$(npm --version)
ok "npm $NPM_VERSION"

# Global prefix write-test. We do NOT sudo. If the prefix is not
# writable, we recommend `npm config set prefix ~/.npm-global` and
# adding it to PATH ... that is the documented fix.
NPM_PREFIX=$(npm config get prefix)
if [ ! -w "$NPM_PREFIX" ]; then
  warn "Global npm prefix is not writable by the current user:"
  warn "  prefix:  $NPM_PREFIX"
  warn ""
  warn "Pick ONE of:"
  warn "  (a) reconfigure npm to use a user-owned prefix (recommended):"
  warn "        npm config set prefix \"\$HOME/.npm-global\""
  warn "        echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.profile"
  warn "        source ~/.profile"
  warn "      then re-run this installer."
  warn "  (b) use a Node manager (nvm, asdf, fnm) that puts the prefix in your home dir."
  warn "  (c) install with sudo yourself: sudo npm install -g $PACKAGE_NAME"
  warn ""
  err "Refusing to install with sudo. Pick one of the above and re-run."
  exit 1
fi

# -----------------------------------------------------------------------------
# Install.
# -----------------------------------------------------------------------------
info ""
info "${BOLD}Installing $PACKAGE_NAME@$PACKAGE_VERSION...${RESET}"
info ""

if [ "$DRY_RUN" -eq 1 ]; then
  info "${DIM}would run:${RESET} npm install -g $PACKAGE_NAME@$PACKAGE_VERSION"
  exit 0
fi

if ! npm install -g "$PACKAGE_NAME@$PACKAGE_VERSION"; then
  err ""
  err "npm install failed."
  err "Re-run with: npm install -g $PACKAGE_NAME --verbose"
  err "to see the underlying error."
  exit 1
fi

# Verify the binary landed on PATH.
if ! command -v 2200 >/dev/null 2>&1; then
  warn ""
  warn "Installed, but the \`2200\` binary is not on your \$PATH."
  warn "The npm prefix bin directory may not be in your shell's PATH."
  warn ""
  warn "Add this to your shell config (.profile, .zshrc, .bashrc):"
  warn "  export PATH=\"$(npm config get prefix)/bin:\$PATH\""
  warn ""
  warn "Then start a new shell and try \`2200\` again."
  exit 1
fi

INSTALLED_VERSION=$(2200 --version 2>/dev/null || printf '?')

# -----------------------------------------------------------------------------
# Post-install banner.
# -----------------------------------------------------------------------------
if [ "$NO_BANNER" -ne 1 ]; then
  info ""
  ok "${BOLD}2200 $INSTALLED_VERSION installed.${RESET}"
  info ""
  info "Get started:"
  info ""
  info "  ${BOLD}2200${RESET}                # guided first-run setup"
  info ""
  info "Useful commands once you have set up:"
  info ""
  info "  2200 agent build      # conversational wizard for a new Agent"
  info "  2200 daemon status    # is the supervisor up?"
  info "  2200 update           # check for and install a newer version"
  info "  2200 --help           # full command reference"
  info ""
  info "Documentation:"
  info "  https://github.com/twentytwohundred/2200"
  info "  https://github.com/twentytwohundred/wiki"
  info ""
fi
