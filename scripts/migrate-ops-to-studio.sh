#!/usr/bin/env bash
# Migrate an existing 2200 home's default pub from "ops" to "studio".
#
# v1 invariant (per the 2026-05-12 scope lock): one Studio per home,
# named "studio". New installs already default to "studio"; this
# script brings legacy installs to the v1 shape.
#
# Idempotent: if "studio" already exists or "ops" does not exist,
# the script no-ops with a message and exits 0.
#
# Run: bash scripts/migrate-ops-to-studio.sh
# Requires: the 2200 daemon NOT running (the script stops it if it is).
# Backs up supervisor.json and each agent's pub-watermarks.json before
# touching them.

set -euo pipefail

HOME_2200="${TWENTYTWOHUNDRED_HOME:-${_2200_HOME:-$HOME/.local/share/2200}}"
STATE_DIR="$HOME_2200/state"
SUPERVISOR_JSON="$STATE_DIR/supervisor.json"
OPS_DIR="$STATE_DIR/openpub/ops"
STUDIO_DIR="$STATE_DIR/openpub/studio"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$STATE_DIR/migration-backup-ops-to-studio-$TS"

echo "==> 2200 home: $HOME_2200"

if [[ ! -d "$STATE_DIR" ]]; then
  echo "no $STATE_DIR ... nothing to migrate"
  exit 0
fi

if [[ -d "$STUDIO_DIR" && ! -d "$OPS_DIR" ]]; then
  echo "==> already migrated: studio pub exists, no ops pub. no-op."
  exit 0
fi

if [[ ! -d "$OPS_DIR" ]]; then
  echo "==> no ops pub at $OPS_DIR. nothing to migrate."
  exit 0
fi

if [[ -d "$STUDIO_DIR" ]]; then
  echo "ERROR: both $OPS_DIR and $STUDIO_DIR exist. cannot auto-migrate."
  echo "       resolve manually by removing one or merging state."
  exit 1
fi

# 1. Make sure the daemon is not running. If it is, stop it cleanly.
if command -v 2200 >/dev/null 2>&1; then
  if 2200 daemon status 2>/dev/null | grep -q "running"; then
    echo "==> stopping daemon (was running)"
    2200 daemon stop || true
    sleep 2
  fi
fi

# 2. If the pub-server itself is still running (orphan), kill it.
PUB_PIDS="$(pgrep -f "pub-server/dist/server.js" 2>/dev/null || true)"
if [[ -n "$PUB_PIDS" ]]; then
  echo "==> killing residual pub-server process(es): $PUB_PIDS"
  echo "$PUB_PIDS" | xargs kill -TERM 2>/dev/null || true
  sleep 1
  echo "$PUB_PIDS" | xargs kill -KILL 2>/dev/null || true
fi

# 3. Backups.
mkdir -p "$BACKUP_DIR"
echo "==> backing up state to $BACKUP_DIR"
[[ -f "$SUPERVISOR_JSON" ]] && cp "$SUPERVISOR_JSON" "$BACKUP_DIR/supervisor.json.bak"
for wm in "$HOME_2200"/agents/*/state/pub-watermarks.json; do
  [[ -f "$wm" ]] || continue
  agent="$(basename "$(dirname "$(dirname "$wm")")")"
  cp "$wm" "$BACKUP_DIR/${agent}.pub-watermarks.json.bak"
done

# 4. Rename the on-disk pub directory.
echo "==> mv $OPS_DIR -> $STUDIO_DIR"
mv "$OPS_DIR" "$STUDIO_DIR"

# 5. Rewrite PUB.md inside the renamed dir.
PUB_MD="$STUDIO_DIR/PUB.md"
if [[ -f "$PUB_MD" ]]; then
  echo "==> updating $PUB_MD"
  # Replace `name: ops` with `name: studio` in frontmatter only.
  # macOS sed -i requires '' as the backup-extension arg.
  sed -i.bak 's/^name: ops$/name: studio/' "$PUB_MD"
  sed -i.bak 's/^description: .*$/description: "the Studio"/' "$PUB_MD"
  # Replace the H1 heading "# ops" with "# Studio".
  sed -i.bak 's/^# ops$/# Studio/' "$PUB_MD"
  # Remove the sed backup file.
  rm -f "$PUB_MD.bak"
fi

# 6. Rewrite supervisor.json: rename the pub key + name + pub_md_path.
if [[ -f "$SUPERVISOR_JSON" ]]; then
  echo "==> updating $SUPERVISOR_JSON"
  # Use Node for safe JSON rewriting (avoids sed-on-JSON pitfalls).
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    const path = process.env.SUP_JSON;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s.pubs && s.pubs.ops && !s.pubs.studio) {
      const old = s.pubs.ops;
      delete s.pubs.ops;
      old.name = 'studio';
      if (typeof old.pub_md_path === 'string') {
        old.pub_md_path = old.pub_md_path.replace('/openpub/ops/', '/openpub/studio/');
      }
      s.pubs.studio = old;
    }
    writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
  " SUP_JSON="$SUPERVISOR_JSON"
fi

# 7. Rewrite each agent's pub-watermarks.json: rename pubs.ops -> pubs.studio.
for wm in "$HOME_2200"/agents/*/state/pub-watermarks.json; do
  [[ -f "$wm" ]] || continue
  echo "==> updating $wm"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    const path = process.env.WM_JSON;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s.pubs && s.pubs.ops && !s.pubs.studio) {
      s.pubs.studio = s.pubs.ops;
      delete s.pubs.ops;
    }
    writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
  " WM_JSON="$wm"
done

echo "==> migration complete"
echo "    backups in: $BACKUP_DIR"
echo "    next: 2200 daemon start"
