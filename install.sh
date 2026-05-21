#!/bin/sh
#
# 2200 installer.
#
# Installs the @twentytwohundred/2200 CLI globally via npm. Idempotent:
# re-running upgrades to the latest published version. macOS + Linux,
# both arm64 and x86_64. Requires Node.js 22 or newer.
#
# Usage:
#   curl -fsSL https://2200.ai/install.sh | sh
#   curl -fsSL https://2200.ai/install.sh | sh -s -- --version 0.1.0
#   curl -fsSL https://2200.ai/install.sh | sh -s -- --dry-run
#
# Flags:
#   --version <v>    install a specific version (default: latest)
#   --dry-run        print what would be done and exit
#   --no-banner      skip the post-install banner (for scripted setups)
#
# After install:
#   2200    # bare invocation triggers a guided first-run setup
#
# This script never uses sudo. If the system's npm prefix is not
# writable (the typical case on Ubuntu/Debian where Node was
# installed via apt), the script offers to reconfigure npm to
# install to ~/.npm-global ... the same fix npm itself recommends:
#   https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
# Interactive runs get a confirm prompt; piped runs auto-apply and
# narrate. The change is reversible with `npm config delete prefix`.

set -eu

# -----------------------------------------------------------------------------
# CLI flag parsing.
# -----------------------------------------------------------------------------
PACKAGE_NAME="@twentytwohundred/2200"
PACKAGE_VERSION="latest"
DRY_RUN=0
NO_BANNER=0

while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  case "$arg" in
    --version)
      # Take the next arg as the value only if it exists AND does not
      # itself look like a flag. Without the leading-dash guard,
      # `--version --dry-run` would install version `--dry-run`.
      if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
        PACKAGE_VERSION="$1"
        shift
      else
        PACKAGE_VERSION="latest"
      fi
      ;;
    --version=*)
      PACKAGE_VERSION="${arg#--version=}"
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-banner)
      NO_BANNER=1
      ;;
    -h|--help)
      sed -n '2,/^set -eu/p' "$0" | sed 's/^# *//' | sed '/^set -eu/d'
      exit 0
      ;;
    *)
      printf 'unknown flag: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
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
# writable, we offer to reconfigure npm to use a user-owned prefix
# (the npm-recommended fix). Interactive shells get a confirm prompt;
# piped installers (curl ... | sh) auto-apply with clear narration.
#
# This is the path the typical Ubuntu/Debian user hits: their system
# Node was installed via apt and the prefix is /usr, which is
# root-owned. The user does not want to sudo their CLI tooling and
# does not want to learn what an npm prefix is. We just set it up.
NPM_PREFIX=$(npm config get prefix)
USER_NPM_PREFIX="$HOME/.npm-global"
DID_PREFIX_FIX=0

# Writability check needs nuance: if the prefix dir does not yet exist,
# `[ -w ]` returns false. Try to create it; mkdir fails if the parent
# is not writable, which is the actual "needs admin" signal we care
# about. This makes second-run-after-fix idempotent.
mkdir -p "$NPM_PREFIX" >/dev/null 2>&1 || true

if [ ! -w "$NPM_PREFIX" ]; then
  info ""
  info "${BOLD}npm is installed in a place that needs admin access:${RESET}"
  info "  current prefix:  $NPM_PREFIX"
  info ""
  info "2200 does not need admin access. I will configure npm to install to"
  info "your home directory instead. This is the standard npm-recommended fix"
  info "and is fully reversible (\`npm config delete prefix\` undoes it)."
  info ""
  info "What I will do:"
  info "  1. Set npm prefix to $USER_NPM_PREFIX"
  info "  2. Add $USER_NPM_PREFIX/bin to your PATH (via your shell init file)"
  info "  3. Export it for this session so 2200 is on PATH immediately"
  info ""

  # Prompt only when stdin is a TTY. Piped installs (curl ... | sh)
  # auto-apply, since prompting against a closed stdin would just
  # default to "no" and dump the user back at a dead-end shell.
  if [ -t 0 ]; then
    printf 'Set up? [Y/n]: '
    read -r reply
    case "$reply" in
      n|N|no|No|NO)
        err ""
        err "Skipped. To do it yourself later:"
        err "  npm config set prefix \"\$HOME/.npm-global\""
        err "  echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.profile"
        err "  source ~/.profile"
        err "  curl -fsSL https://2200.ai/install.sh | sh"
        exit 1
        ;;
    esac
  else
    info "${DIM}(non-interactive install; applying automatically)${RESET}"
  fi

  # Detect the user's shell to pick the right init file. Fish has
  # different export syntax; everything else uses the POSIX form.
  USER_SHELL=$(basename "${SHELL:-}")
  case "$USER_SHELL" in
    bash)
      # bash reads .bashrc for interactive non-login shells and
      # .profile (or .bash_profile) for login. Writing to both
      # covers terminal-on-Linux and ssh-into-host alike.
      SHELL_INIT_FILES="$HOME/.bashrc $HOME/.profile"
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      ;;
    zsh)
      SHELL_INIT_FILES="$HOME/.zshrc"
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      ;;
    fish)
      SHELL_INIT_FILES="$HOME/.config/fish/config.fish"
      PATH_LINE='set -gx PATH $HOME/.npm-global/bin $PATH'
      mkdir -p "$HOME/.config/fish"
      ;;
    *)
      # Unknown shell: write to .profile (sourced by most POSIX
      # login shells) and warn the user.
      SHELL_INIT_FILES="$HOME/.profile"
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      warn ""
      warn "Could not detect your shell from \$SHELL ($USER_SHELL)."
      warn "Writing PATH to ~/.profile. If your shell does not source"
      warn "~/.profile, add this line to your shell init file manually:"
      warn "  $PATH_LINE"
      warn ""
      ;;
  esac

  # 1. Set the prefix.
  if ! npm config set prefix "$USER_NPM_PREFIX"; then
    err "Failed to set npm prefix. Falling back to manual instructions."
    err "  npm config set prefix \"\$HOME/.npm-global\""
    exit 1
  fi
  ok "Configured npm prefix to $USER_NPM_PREFIX"

  # 2. Add the PATH line to each shell init file (idempotent: skip if
  # it is already present from a previous run).
  for init_file in $SHELL_INIT_FILES; do
    if [ -f "$init_file" ] && grep -Fq '.npm-global/bin' "$init_file" 2>/dev/null; then
      info "  ${DIM}PATH already present in $init_file${RESET}"
      continue
    fi
    {
      printf '\n'
      printf '# Added by 2200 installer: user-owned npm prefix (no sudo needed).\n'
      printf '# Remove if you ever run `npm config delete prefix`.\n'
      printf '%s\n' "$PATH_LINE"
    } >> "$init_file"
    ok "Added PATH to $init_file"
  done

  # 3. Export for the current session so the install + verify steps
  # below pick up the new prefix without the user starting a new shell.
  export PATH="$USER_NPM_PREFIX/bin:$PATH"
  DID_PREFIX_FIX=1
  info ""
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
  if [ "$DID_PREFIX_FIX" -eq 1 ]; then
    # We modified the user's shell init file. In the current shell
    # (the one that ran `curl ... | sh`), the new PATH was only set
    # inside this script's process; the parent shell still has the
    # old PATH. Tell the user how to use 2200 right now without
    # opening a new terminal.
    info "${BOLD}One small step before you can use \`2200\`:${RESET}"
    info "  • Open a new terminal, OR"
    info "  • Run: ${BOLD}source $SHELL_INIT_FILES${RESET}"
    info "    (this picks up the PATH change we made; new terminals do it automatically)"
    info ""
  fi
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
  if [ "$DID_PREFIX_FIX" -eq 1 ]; then
    info "${DIM}To undo the npm-prefix change: \`npm config delete prefix\` and remove"
    info "the PATH line from your shell init file.${RESET}"
    info ""
  fi
  info "Documentation:"
  info "  https://github.com/twentytwohundred/2200"
  info "  https://github.com/twentytwohundred/wiki"
  info ""
fi
