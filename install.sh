#!/bin/sh
#
# 2200 installer.
#
# Installs the @twentytwohundred/2200-cli CLI globally via npm. Idempotent:
# re-running upgrades to the latest published version. macOS + Linux,
# both arm64 and x86_64. Requires Node.js 22 or newer.
#
# Usage:
#   curl -fsSL https://2200.ai/install.sh | sh
#   curl -fsSL https://2200.ai/install.sh | sh -s -- --version 2026.617.121
#   curl -fsSL https://2200.ai/install.sh | sh -s -- --yes
#   curl -fsSL https://2200.ai/install.sh | sh -s -- --dry-run
#
# By default this is one fluid path: install, set up, and print a web
# URL to open ... no "now run this" stops. `--no-setup` installs the CLI
# only.
#
# This script never uses sudo. If the system's npm prefix is not
# writable (the typical case on Ubuntu/Debian where Node was installed
# via apt), it reconfigures npm to install to ~/.npm-global (the same
# fix npm itself recommends), narrating exactly what changes. That keeps
# the one-line install from stopping for a yes/no; it is reversible with
# `npm config delete prefix`, and `--no-prefix-fix` opts out entirely.

set -eu

# -----------------------------------------------------------------------------
# Config + flag parsing.
# -----------------------------------------------------------------------------
PACKAGE_NAME="@twentytwohundred/2200-cli"
PACKAGE_VERSION="latest"
DRY_RUN=0
NO_BANNER=0
ASSUME_YES=0
NO_PREFIX_FIX=0
NO_SETUP=0

usage() {
  printf '%s\n' \
    "2200 installer" \
    "" \
    "Installs $PACKAGE_NAME globally via npm. Idempotent: re-running" \
    "upgrades to the latest published version. macOS + Linux, arm64 and" \
    "x86_64. Requires Node.js 22 or newer." \
    "" \
    "Usage:" \
    "  curl -fsSL https://2200.ai/install.sh | sh" \
    "  curl -fsSL https://2200.ai/install.sh | sh -s -- [options]" \
    "" \
    "Options:" \
    "  --version <v>     install a specific version (default: latest)" \
    "  --no-setup        install only; do not run setup or print the web URL" \
    "  --no-prefix-fix   never reconfigure the npm prefix (fail instead)" \
    "  --yes, -y         assume yes (reserved; setup is already non-interactive)" \
    "  --dry-run         print what would be done and exit" \
    "  --no-banner       skip banners" \
    "  -h, --help        show this help" \
    "" \
    "By default this installs, sets up, and prints a web URL to open ... one" \
    "fluid path, no stops. Use --no-setup to install the CLI only."
}

while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  case "$arg" in
    --version)
      # Take the next arg as the value only if it exists AND does not
      # itself look like a flag, so `--version --dry-run` does not try
      # to install a version literally named "--dry-run".
      if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
        PACKAGE_VERSION="$1"
        shift
      else
        PACKAGE_VERSION="latest"
      fi
      ;;
    --version=*)
      PACKAGE_VERSION="${arg#--version=}"
      # `--version=` with no value would build a trailing bare `@`.
      [ -n "$PACKAGE_VERSION" ] || PACKAGE_VERSION="latest"
      ;;
    --yes|-y)
      ASSUME_YES=1
      ;;
    --no-prefix-fix)
      NO_PREFIX_FIX=1
      ;;
    --no-setup)
      NO_SETUP=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-banner)
      NO_BANNER=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown flag: %s\n' "$arg" >&2
      printf 'run with --help for usage.\n' >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Color + glyph setup.
#
# Colors default to empty strings; they are populated only when we have
# decided to use color, so a piped / CI log never contains stray escape
# sequences. We honor the cross-tool NO_COLOR / FORCE_COLOR contract and
# otherwise gate on stdout being a TTY. The accent is the 2200 brand
# green (#22c97a, "green for alive") as 24-bit truecolor, with a
# 256-color fallback for the rare terminal without truecolor.
# -----------------------------------------------------------------------------
ACCENT='' ; AMBER='' ; REDC='' ; GRAY='' ; BOLD='' ; DIM='' ; RESET=''

use_color=0
[ -t 1 ] && use_color=1
[ -n "${FORCE_COLOR:-}" ] && use_color=1
# NO_COLOR is presence-based per the no-color.org contract: set to ANY
# value (including empty) disables color, and it wins over FORCE_COLOR.
[ "${NO_COLOR+x}" = x ] && use_color=0

if [ "$use_color" -eq 1 ]; then
  case "${COLORTERM:-}" in
    truecolor|24bit)
      ACCENT=$(printf '\033[38;2;34;201;122m')   # #22c97a brand green
      AMBER=$(printf '\033[38;2;227;168;71m')     # #e3a847
      REDC=$(printf '\033[38;2;227;93;77m')       # #e35d4d
      GRAY=$(printf '\033[38;2;122;128;137m')     # #7a8089
      ;;
    *)
      ACCENT=$(printf '\033[38;5;42m')
      AMBER=$(printf '\033[38;5;179m')
      REDC=$(printf '\033[38;5;167m')
      GRAY=$(printf '\033[38;5;245m')
      ;;
  esac
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RESET=$(printf '\033[0m')
fi

# Unicode glyphs only under a UTF-8 locale; otherwise ASCII fallbacks,
# so a `LANG=C` SSH session sees clean text instead of mojibake. The
# ok / err / warn triad mirrors the app's fleet-state palette.
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*) UNICODE=1 ;;
  *) UNICODE=0 ;;
esac
if [ "$UNICODE" -eq 1 ]; then
  G_OK='✓' ; G_ERR='✗' ; G_DOT='●'
else
  G_OK='ok' ; G_ERR='x' ; G_DOT='*'
fi

# Output grammar: a tidy glyph column that reads as a checklist.
ok()   { printf '%s%s%s %s\n' "$ACCENT" "$G_OK" "$RESET" "$*"; }
step() { printf '%s>%s %s\n' "$GRAY" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$AMBER" "$RESET" "$*" >&2; }
err()  { printf '%s%s%s %s\n' "$REDC" "$G_ERR" "$RESET" "$*" >&2; }
dim()  { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }

# -----------------------------------------------------------------------------
# Wordmark. Shown once at the top: the first impression.
# -----------------------------------------------------------------------------
wordmark() {
  [ "$NO_BANNER" -eq 1 ] && return 0
  printf '\n'
  # Full block art only on an interactive, UTF-8 terminal. Piped output
  # (CI, `| tee`, a redirect) and C-locale shells get the clean
  # one-liner instead, so logs never fill with block-character noise.
  if [ "$use_color" -eq 1 ] && [ "$UNICODE" -eq 1 ]; then
    printf '%s\n' "${ACCENT}   ██████   ██████   ██████   ██████ ${RESET}"
    printf '%s\n' "${ACCENT}  ██    ██ ██    ██ ██    ██ ██    ██${RESET}"
    printf '%s\n' "${ACCENT}       ██       ██  ██    ██ ██    ██${RESET}"
    printf '%s\n' "${ACCENT}     ██       ██    ██    ██ ██    ██${RESET}"
    printf '%s\n' "${ACCENT}   ██       ██      ██    ██ ██    ██${RESET}"
    printf '%s\n' "${ACCENT}  ███████  ███████   ██████   ██████ ${RESET}"
    printf '%s\n' "  ${DIM}your always-on team of Agents ${RESET}${ACCENT}${G_DOT}${RESET}${DIM} green for alive${RESET}"
  else
    printf '%s\n' "  ${ACCENT}${G_DOT} 2200${RESET}  ${DIM}your always-on team of Agents${RESET}"
  fi
  printf '\n'
}

# -----------------------------------------------------------------------------
# A clean install spinner: npm's own chatter is captured to a log and a
# single braille line breathes while it works (green, of course). On a
# non-TTY we print one static line and stay silent unless it fails.
# -----------------------------------------------------------------------------
# A predictable /tmp name is a symlink-clobber hazard on a shared host, so
# create the fallback under a private umask and prefer mktemp.
INSTALL_LOG=$(mktemp 2>/dev/null || { f="${TMPDIR:-/tmp}/2200-install.$$.log"; (umask 077; : > "$f") && printf '%s' "$f"; })
cleanup() { rm -f "$INSTALL_LOG" 2>/dev/null || true; }
show_cursor() { printf '\033[?25h' 2>/dev/null || true; }
trap cleanup EXIT

braille_frame() {
  case "$1" in
    0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;;
    4) printf '⠼' ;; 5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;;
    8) printf '⠇' ;; *) printf '⠏' ;;
  esac
}

spin() {
  # $1 = pid to watch, $2 = message. Returns when the pid exits.
  pid="$1"
  msg="$2"
  if [ "$use_color" -eq 1 ] && [ -t 1 ] && [ "$UNICODE" -eq 1 ]; then
    # While the cursor is hidden, EVERY exit path must restore it ...
    # including a SIGHUP from a closing terminal/multiplexer, otherwise
    # the user is left with an invisible cursor. Cover EXIT + the signals.
    trap 'show_cursor; cleanup' EXIT
    trap 'show_cursor; cleanup; exit 130' INT TERM HUP
    printf '\033[?25l'                                  # hide cursor
    i=0
    elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
      hint=''
      [ "$elapsed" -ge 600 ] && hint=" ${DIM}(still working ... network may be slow)${RESET}"
      printf '\r\033[K%s%s%s %s%s' "$ACCENT" "$(braille_frame "$i")" "$RESET" "$msg" "$hint"
      i=$(( (i + 1) % 10 ))
      elapsed=$(( elapsed + 1 ))
      sleep 0.08 2>/dev/null || sleep 1
    done
    printf '\r\033[K'                                   # clear the line
    show_cursor                                         # restore cursor
    trap cleanup EXIT                                   # drop the cursor guard
    trap - INT TERM HUP
  else
    step "$msg"
  fi
}

# -----------------------------------------------------------------------------
# Banner, then preflight.
# -----------------------------------------------------------------------------
wordmark

if [ "$DRY_RUN" -eq 1 ]; then
  dim "(dry run; no changes will be made)"
fi

# Platform sanity. macOS arm64/x86_64 + Linux arm64/x86_64 are supported.
UNAME_S=$(uname -s 2>/dev/null) || { err "could not determine platform (uname failed)."; exit 1; }
case "$UNAME_S" in
  Darwin|Linux) ;;
  *)
    err "Unsupported platform: $UNAME_S. 2200 supports macOS and Linux."
    err "Windows users: install inside WSL2."
    exit 1
    ;;
esac

# Print the most relevant "how to upgrade Node to 22+" command(s) for THIS
# machine: prefer a version manager the user already has (nvm/fnm/asdf), else
# the OS package manager, else a sane fallback. POSIX sh; each line via err().
print_node_upgrade() {
  _np=0
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    err "  nvm:       nvm install 22 && nvm alias default 22 && nvm use 22"
    _np=1
  fi
  if command -v fnm >/dev/null 2>&1; then
    err "  fnm:       fnm install 22 && fnm default 22 && fnm use 22"
    _np=1
  fi
  if command -v asdf >/dev/null 2>&1 || [ -d "$HOME/.asdf" ]; then
    err "  asdf:      asdf install nodejs latest:22 && asdf global nodejs latest:22"
    _np=1
  fi
  case "$UNAME_S" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        err "  Homebrew:  brew install node@22 && brew link --overwrite --force node@22"
        _np=1
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        err "  apt (Debian/Ubuntu):"
        err "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
        _np=1
      elif command -v dnf >/dev/null 2>&1; then
        err "  dnf (Fedora/RHEL):"
        err "    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs"
        _np=1
      fi
      ;;
  esac
  if [ "$_np" -eq 0 ]; then
    err "  Install nvm, then Node 22:"
    err "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    err "    nvm install 22 && nvm alias default 22"
    err "  Or download Node 22+ from https://nodejs.org/"
  fi
}

# Node.js: required, >= 22.
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed (or not on \$PATH)."
  err "Install Node.js 22+ first:"
  err "  macOS:  brew install node"
  err "  Linux:  https://nodejs.org/  (or your distro's package manager)"
  err "Then re-run this installer."
  exit 1
fi

NODE_VERSION=$(node -e 'process.stdout.write(process.versions.node)' 2>/dev/null) \
  || { err "Failed to query the Node.js version (is your node binary working?)."; exit 1; }
NODE_MAJOR=${NODE_VERSION%%.*}
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    err "Could not parse the Node.js version: '$NODE_VERSION'."
    err "Reinstall Node.js 22+ and try again."
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Your Node.js is out of date: you have $NODE_VERSION, and 2200 needs version 22 or newer."
  err "Update Node with the command below that matches how it's installed on your machine:"
  print_node_upgrade
  err "Then come back here and run this installer again:"
  err "  curl -fsSL https://2200.ai/install.sh | sh"
  exit 1
fi
ok "Node.js ${BOLD}${NODE_VERSION}${RESET}"

# npm: ships with Node, but check explicitly.
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed (or not on \$PATH)."
  err "It normally ships with Node.js. Reinstall Node.js and try again."
  exit 1
fi
NPM_VERSION=$(npm --version 2>/dev/null) \
  || { err "Failed to query the npm version (is npm working?)."; exit 1; }
ok "npm ${BOLD}${NPM_VERSION}${RESET}"

# -----------------------------------------------------------------------------
# npm prefix: never sudo. If the global prefix is not writable (the apt
# Node case), offer to reconfigure to a user-owned prefix. We prompt via
# /dev/tty so the confirm works even under `curl | sh` (where fd 0 is the
# pipe carrying this script, not the keyboard); genuinely headless runs
# (no /dev/tty, no --yes) auto-apply with full narration.
# -----------------------------------------------------------------------------
NPM_PREFIX=$(npm config get prefix 2>/dev/null) \
  || { err "Failed to read the npm prefix (\`npm config get prefix\`)."; exit 1; }
# Reject a non-path value (npm can emit the literal 'null'/'undefined'),
# which would otherwise send us editing dotfiles against a phantom path.
case "$NPM_PREFIX" in
  /*) ;;
  *)
    err "npm reported a non-path prefix: '$NPM_PREFIX'."
    err "Fix your npm config and re-run:  npm config set prefix \"\$HOME/.npm-global\""
    exit 1
    ;;
esac

USER_NPM_PREFIX="$HOME/.npm-global"
DID_PREFIX_FIX=0
SOURCE_HINT_FILES=""

# If the prefix dir does not exist yet, try to create it; mkdir fails
# when the parent is not writable, which is the real "needs admin"
# signal. Keeps a second run (after the fix) idempotent.
mkdir -p "$NPM_PREFIX" >/dev/null 2>&1 || true

if [ ! -w "$NPM_PREFIX" ]; then
  printf '\n'
  printf '%snpm is installed somewhere that needs admin access:%s\n' "$BOLD" "$RESET"
  printf '  current prefix:  %s\n' "$NPM_PREFIX"
  printf '\n'
  printf '2200 does not need admin access, so I am pointing npm at your home\n'
  printf 'directory instead (the standard npm-recommended fix). This is fully\n'
  printf 'reversible ... %snpm config delete prefix%s undoes it. What changes:\n' "$DIM" "$RESET"
  printf '  1. npm prefix  ->  %s\n' "$USER_NPM_PREFIX"
  printf '  2. add %s/bin to your PATH (one line, in your shell init file)\n' "$USER_NPM_PREFIX"
  printf '  3. export it for this session so 2200 works immediately\n'
  printf '\n'
  # Apply it automatically (narrated above, reversible) ... a yes/no stop
  # here is friction on the one-line install path, and this is install
  # plumbing, not a product choice. `--no-prefix-fix` opts out.
  if [ "$NO_PREFIX_FIX" -eq 1 ]; then
    err "Refusing to reconfigure the npm prefix (--no-prefix-fix). Do it yourself:"
    err "  npm config set prefix \"\$HOME/.npm-global\""
    err "  echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.profile"
    err "  exec \$SHELL   # or open a new terminal, then re-run the installer"
    exit 1
  fi

  # Pick the right init file(s) for the user's shell. Fish uses a
  # different export syntax. For bash we prefer the login file that the
  # platform actually sources (.bash_profile on macOS, else .profile)
  # plus .bashrc for non-login terminals.
  USER_SHELL=$(basename "${SHELL:-sh}")
  case "$USER_SHELL" in
    bash)
      if [ -f "$HOME/.bash_profile" ]; then
        SHELL_INIT_FILES="$HOME/.bash_profile $HOME/.bashrc"
      else
        SHELL_INIT_FILES="$HOME/.profile $HOME/.bashrc"
      fi
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      ;;
    zsh)
      SHELL_INIT_FILES="$HOME/.zshrc"
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      ;;
    fish)
      SHELL_INIT_FILES="$HOME/.config/fish/config.fish"
      PATH_LINE='set -gx PATH $HOME/.npm-global/bin $PATH'
      mkdir -p "$HOME/.config/fish" 2>/dev/null || true
      ;;
    *)
      SHELL_INIT_FILES="$HOME/.profile"
      PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
      warn "Could not detect your shell (\$SHELL='$USER_SHELL'); writing PATH to ~/.profile."
      warn "If your shell does not read ~/.profile, add this line by hand:"
      warn "  $PATH_LINE"
      ;;
  esac

  if ! npm config set prefix "$USER_NPM_PREFIX" >/dev/null 2>&1; then
    err "Failed to set the npm prefix. Do it manually and re-run:"
    err "  npm config set prefix \"\$HOME/.npm-global\""
    exit 1
  fi
  ok "npm prefix set to $USER_NPM_PREFIX"

  # Append the PATH line to each init file, exact-line idempotent so a
  # re-run never duplicates it.
  for init_file in $SHELL_INIT_FILES; do
    if [ -f "$init_file" ] && grep -Fqx "$PATH_LINE" "$init_file" 2>/dev/null; then
      dim "  PATH already present in $init_file"
    else
      {
        printf '\n'
        printf '# Added by the 2200 installer: user-owned npm prefix (no sudo needed).\n'
        printf '# Safe to remove if you run `npm config delete prefix`.\n'
        printf '%s\n' "$PATH_LINE"
      } >> "$init_file"
      ok "added PATH to $init_file"
    fi
    SOURCE_HINT_FILES="$SOURCE_HINT_FILES $init_file"
  done

  # Make 2200 work in THIS session without a new shell.
  export PATH="$USER_NPM_PREFIX/bin:$PATH"
  DID_PREFIX_FIX=1
fi

# -----------------------------------------------------------------------------
# Install.
# -----------------------------------------------------------------------------
printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
  step "would run: npm install -g $PACKAGE_NAME@$PACKAGE_VERSION"
  exit 0
fi

npm install -g "$PACKAGE_NAME@$PACKAGE_VERSION" >"$INSTALL_LOG" 2>&1 &
npm_pid=$!
spin "$npm_pid" "Installing ${PACKAGE_NAME}@${PACKAGE_VERSION}"
if wait "$npm_pid"; then
  install_rc=0
else
  install_rc=$?
fi

if [ "$install_rc" -ne 0 ]; then
  err "npm install failed (exit $install_rc). Output:"
  printf '\n'
  sed 's/^/    /' "$INSTALL_LOG" 2>/dev/null | tail -n 30
  printf '\n'
  err "Re-run with --verbose for more:  npm install -g $PACKAGE_NAME --verbose"
  exit 1
fi

# Verify the binary landed on PATH.
if ! command -v 2200 >/dev/null 2>&1; then
  warn "Installed, but the \`2200\` binary is not on your \$PATH yet."
  warn "Add this to your shell init file, then open a new terminal:"
  warn "  export PATH=\"$(npm config get prefix 2>/dev/null)/bin:\$PATH\""
  exit 1
fi

INSTALLED_VERSION=$(2200 --version 2>/dev/null || printf '?')
ok "Installed ${BOLD}2200 ${INSTALLED_VERSION}${RESET}"
dim "  $(command -v 2200)"

# -----------------------------------------------------------------------------
# Setup: keep going to a running 2200 + a web URL. One fluid path, no
# "now run this" stop. `--no-setup` installs the CLI only.
# -----------------------------------------------------------------------------
if [ "$NO_SETUP" -eq 1 ]; then
  if [ "$NO_BANNER" -ne 1 ]; then
    printf '\n'
    printf 'Installed (setup skipped). When ready:\n'
    printf '  %s2200 setup%s     %sset up and print your web URL%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
    printf '  %s2200 --help%s    %sall commands%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
    printf '\n'
  fi
  exit 0
fi

printf '\n'
step "Setting up 2200..."
printf '\n'

# `2200 setup` inits, starts the daemon, migrates OpenClaw if present,
# and prints the web URL + token as its final output ... which becomes
# the end of this installer. It is non-interactive EXCEPT for one
# question (whether to disable a migrated OpenClaw instance), which it
# only asks when a terminal is attached. Under `curl | sh`, fd 0 is the
# pipe carrying this script, so we reattach /dev/tty to let that one
# question reach the user; without a tty it stays fully non-interactive.
# The PATH was exported above (prefix-fix path) so the binary resolves
# here before the user opens a new shell.
#
# We must ACTUALLY open /dev/tty to decide, not just test `-r`: on a
# session with no controlling terminal (headless SSH `ssh host '...'`,
# CI, cron) the device node exists and passes the `-r` permission test,
# but open(2) returns ENXIO ("No such device or address") ... which would
# abort the whole install right before setup.
#
# The probe runs in a SUBSHELL `( ... )` on purpose. A redirection error
# on a POSIX special built-in (`exec`) makes a non-interactive shell exit
# outright ... in dash (Ubuntu's /bin/sh) that exit is NOT caught by the
# enclosing `if`/`||`, so a bare `exec < /dev/tty` would kill the whole
# installer with status 2. The subshell contains that exit: the child
# dies, the `if` simply sees a non-zero status, and we fall back to a
# fully non-interactive `2200 setup`.
setup_rc=0
if (exec < /dev/tty) 2>/dev/null; then
  2200 setup < /dev/tty || setup_rc=$?
else
  2200 setup || setup_rc=$?
fi
if [ "$setup_rc" -ne 0 ]; then
  err ""
  err "Setup did not complete. Your install is fine; finish it with:"
  err "  2200 setup        # retry"
  err "  2200              # or the guided wizard"
  exit 1
fi

if [ "$NO_BANNER" -ne 1 ] && [ "$DID_PREFIX_FIX" -eq 1 ]; then
  printf '%sNote:%s new terminals will have %s2200%s on PATH automatically.\n' \
    "$DIM" "$RESET" "$BOLD" "$RESET"
  printf '%s(to undo the npm-prefix change: npm config delete prefix)%s\n' "$DIM" "$RESET"
  printf '\n'
fi
