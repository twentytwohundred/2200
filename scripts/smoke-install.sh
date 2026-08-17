#!/usr/bin/env bash
#
# End-to-end install smoke: prove what a REAL user gets from a published
# install. Runs the packed (or published) tarball in a clean node:22 container
# and asserts the regression classes that have bitten before:
#
#   1. `2200 setup` succeeds keyless and the web app is served.
#   2. The pub-server patch overlay actually APPLIES on an npm install
#      (the "no shipped patch" / wrong-bundle-depth bug, twice in prod).
#   3. The Studio auto-provisions and enrolls Agents ONCE, by real name,
#      with no "(agent)" shadow (the dedup bug).
#   4. The pub-server runs with NO LLM credential (Bartender stays off).
#   5. Studio chat PERSISTS across a daemon restart (served from messages.jsonl).
#   6. The pub survives a daemon restart without an EADDRINUSE collision
#      (the orphan-port adopt fix).
#
# These assertions are KEYLESS by design ... they exercise the install +
# overlay + pub/Studio lifecycle, which is where the breakage has been. The
# agent-process-survival + ambient-routing path needs a real model and is
# covered by the chaos unit test + a separate credentialed run; this smoke
# deliberately does not require an LLM key so it can run in CI.
#
# Usage:
#   scripts/smoke-install.sh                 # npm pack this repo, smoke it
#   scripts/smoke-install.sh @latest         # smoke the published @latest
#   scripts/smoke-install.sh /path/to.tgz    # smoke a specific tarball
#
# Requires: docker, node, npm. Not part of `pnpm verify` (needs Docker, ~2 min).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARG="${1:-pack}"
IMAGE="node:22-bookworm-slim"
CTN="2200-smoke-$$"
PASS=0
FAIL=0

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
dex() { docker exec "$CTN" "$@"; }

cleanup() { docker rm -f "$CTN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- resolve the tarball -----------------------------------------------------
INSTALL_SPEC=""
HOST_TARBALL=""
case "$ARG" in
  @latest)
    INSTALL_SPEC="@twentytwohundred/2200-cli@latest"
    ;;
  *.tgz)
    HOST_TARBALL="$ARG"
    ;;
  pack)
    say "npm pack"
    (cd "$REPO_ROOT" && npm pack >/tmp/2200-smoke-pack.log 2>&1)
    HOST_TARBALL="$REPO_ROOT/$(cd "$REPO_ROOT" && ls -t twentytwohundred-2200-cli-*.tgz | head -1)"
    echo "  packed: $HOST_TARBALL"
    ;;
  *)
    echo "unknown arg: $ARG (use: pack | @latest | /path/to.tgz)"; exit 2;;
esac

# --- clean container ---------------------------------------------------------
say "launch clean $IMAGE container"
docker rm -f "$CTN" >/dev/null 2>&1 || true
docker run -d --name "$CTN" "$IMAGE" sleep infinity >/dev/null
dex node --version

say "install 2200"
if [ -n "$HOST_TARBALL" ]; then
  docker cp "$HOST_TARBALL" "$CTN:/tmp/2200.tgz"
  dex npm install -g /tmp/2200.tgz >/tmp/2200-smoke-install.log 2>&1
else
  dex npm install -g "$INSTALL_SPEC" >/tmp/2200-smoke-install.log 2>&1
fi
VER="$(dex 2200 --version 2>&1 | tail -1)"
echo "  installed: $VER"

# --- 1. setup + web served ---------------------------------------------------
say "1. setup (keyless, non-interactive) + web served"
dex 2200 setup >/tmp/2200-smoke-setup.log 2>&1 && ok "setup exit 0" || bad "setup nonzero"
HOME2200=/root/.local/share/2200
if dex sh -c "test -d $HOME2200/state"; then ok "state dir created"; else bad "no state dir"; fi
TOKEN="$(grep -o 'token=[a-f0-9]*' /tmp/2200-smoke-setup.log | head -1 | cut -d= -f2 || true)"
# serve check: the web root returns the built app, not the "not built" stub
if dex sh -c "node -e 'fetch(\"http://localhost:2200/?token=$TOKEN\").then(r=>r.text()).then(t=>{if(t.includes(\"<title>2200</title>\"))process.exit(0);process.exit(3)}).catch(()=>process.exit(4))'"; then
  ok "web app served (real app HTML)"
else
  bad "web app not served as the real app"
fi

# --- create two Agents enrolled in the studio --------------------------------
say "create two Agents (keyless; member_of: studio)"
dex mkdir -p /tmp/ids
for n in skippy jodin; do
  dex sh -c "cat > /tmp/ids/$n.identity.md <<'EOF'
---
schema_version: 1
agent_name: $n
agent_role: 'Smoke-test Agent'
model:
  tier: frontier
  provider: xai
  model_id: grok-4.3
tools: []
project_dir: $HOME2200/agents/$n/project
brain_dir: $HOME2200/agents/$n/brain
created: 2026-06-23
provider_secret:
  source: env
  id: XAI_API_KEY
pub:
  identity: ''
  display_name: $n
  handle: '@$n'
  credentials:
    source: file
    id: /placeholder
  key_version: 1
  issuer_url: ''
  domains: []
  member_of: ['studio']
---
# ${n}
Smoke-test Agent.
EOF"
  dex 2200 agent create "$n" --identity /tmp/ids/$n.identity.md --skip-provision >/dev/null 2>&1 \
    && ok "created $n" || bad "create $n failed"
done

# --- 2 + 6. daemon restart applies overlay + studio comes up (no collision) --
say "2 + 6. daemon restart: overlay applies, studio comes up cleanly"
dex 2200 daemon stop >/dev/null 2>&1 || true
dex 2200 daemon start >/dev/null 2>&1 || true
sleep 5
LOG="$HOME2200/state/supervisor.log"
if dex sh -c "grep -q 'applied 2200 pub-server patch' $LOG"; then
  ok "pub-server overlay applied on this install"
else
  bad "overlay NOT applied (the 'no shipped patch' regression)"
fi
if dex sh -c "grep -q 'studio pub ensured' $LOG"; then ok "studio auto-provisioned"; else bad "studio not ensured"; fi
# the EADDRINUSE/errored collision would show as a pub exit right after start
if dex sh -c "2200 pub list 2>/dev/null | grep -q 'studio .*running'"; then
  ok "studio is running (no port-collision errored state)"
else
  bad "studio not running (possible port collision)"
fi

# --- 3. dedup: one row per Agent by real name, no "(agent)" shadow -----------
say "3. Studio dedup (one row per name, no '(agent)' shadow)"
AJ="$HOME2200/state/openpub/studio/data/agents.json"
dex sh -c "cat $AJ" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const d=JSON.parse(s);const a=Array.isArray(d)?d:(d.agents||Object.values(d));
  const names=a.map(x=>x.display_name||"");
  const shadow=names.some(n=>/\(agent\)/.test(n));
  const dupes=names.length!==new Set(names).size;
  if(shadow){console.error("  shadow names present: "+JSON.stringify(names));process.exit(5)}
  if(dupes){console.error("  duplicate names: "+JSON.stringify(names));process.exit(6)}
  console.log("  display_names: "+JSON.stringify(names));
})' && ok "no shadows, no duplicates" || bad "dedup violated"

# --- 4. bartender off: pub-server has no LLM_* env ---------------------------
say "4. Bartender off (pub-server has no LLM credential)"
if dex sh -c '
for p in /proc/[0-9]*; do
  cl=$(tr "\0" " " < "$p/cmdline" 2>/dev/null)
  case "$cl" in *openpub-server*)
    if tr "\0" "\n" < "$p/environ" 2>/dev/null | grep -qiE "^LLM_(API_KEY|PROVIDER|BASE_URL|MODEL)="; then exit 7; fi
  ;; esac
done; exit 0'; then
  ok "no LLM_* in pub-server env"
else
  bad "pub-server has an LLM credential (Bartender would activate)"
fi

# --- 5. persistence: post -> restart -> history still served -----------------
say "5. Studio chat persists across a daemon restart"
dex sh -c "node -e '
const T=\"$TOKEN\",B=\"http://localhost:2200\",H={authorization:\"Bearer \"+T,\"content-type\":\"application/json\"};
(async()=>{
  await fetch(B+\"/api/v1/pubs/studio/messages\",{method:\"POST\",headers:H,body:JSON.stringify({content:\"smoke-persist-probe\"})});
  await fetch(B+\"/api/v1/pubs/studio/messages\",{headers:H}); // GET flushes live window to the log
})()'" >/dev/null 2>&1
dex 2200 daemon stop >/dev/null 2>&1 || true
dex 2200 daemon start >/dev/null 2>&1 || true
sleep 5
SERVED="$(dex sh -c "node -e '
const T=\"$TOKEN\",B=\"http://localhost:2200\",H={authorization:\"Bearer \"+T};
fetch(B+\"/api/v1/pubs/studio/messages\",{headers:H}).then(r=>r.json()).then(j=>{
  const m=j.items||j.messages||[];
  console.log(m.some(x=>(x.content||\"\").includes(\"smoke-persist-probe\"))?\"FOUND\":\"MISSING\");
}).catch(()=>console.log(\"ERR\"))'")"
if [ "$SERVED" = "FOUND" ]; then ok "message served from the log after restart"; else bad "history lost across restart ($SERVED)"; fi

# --- verdict -----------------------------------------------------------------
say "RESULT: $PASS passed, $FAIL failed (version $VER)"
[ "$FAIL" -eq 0 ]
