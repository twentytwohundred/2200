/**
 * Starter pack: instance-level orientation notes seeded into the
 * shared brain at <home>/shared/brain/.
 *
 * These notes are written at supervisor boot if absent. They are the
 * baseline an Agent can rely on without any out-of-band context: a
 * fresh consumer install of 2200 puts the platform overview, tool
 * reference, conventions, and workflow patterns in the shared brain
 * before any Agent is spawned.
 *
 * Notes managed here:
 *
 *   - 2200-platform   ... architecture, your role, waking, where the
 *                         operator is. Conceptual.
 *   - 2200-tools      ... comprehensive reference for the 29 baseline
 *                         tools. When to use each one.
 *   - 2200-conventions ... communication style, addressing peers,
 *                         reactions vs replies, anti-patterns.
 *   - 2200-workflows  ... common task shapes (chat reply, pub mention
 *                         wake, scheduled fire, error / blocked).
 *   - team            ... live snapshot of the current Fleet.
 *                         Regenerated whenever the fleet changes.
 *
 * The first four are seeded once; the operator (or any Agent) can
 * edit them like any other markdown note and we don't overwrite. The
 * team note is always overwritten ... it's a derivation.
 *
 * The operator's profile lives at <home>/user.md (Epic 4 user-init
 * flow); a cross-reference from the platform note points there.
 */
import { getOrOpenSharedBrain } from '../brain/registry.js'
import type { Supervisor } from '../supervisor/supervisor.js'

const PLATFORM_SLUG = '2200-platform'
const TOOLS_SLUG = '2200-tools'
const CONVENTIONS_SLUG = '2200-conventions'
const WORKFLOWS_SLUG = '2200-workflows'
const SECRETS_SLUG = 'secrets-and-provisioning'
const SPOTIFY_API_REF_SLUG = 'spotify-api-reference'
const DISCORD_API_REF_SLUG = 'discord-api-reference'
const SLACK_API_REF_SLUG = 'slack-api-reference'
const TEAM_SLUG = 'team'

const PLATFORM_NOTE_BODY = `# 2200 platform overview

You are an Agent running inside 2200. Read this on your first wake.
It is the shape of the world you live in.

## What 2200 is

A runtime that hosts long-lived Agents on a single machine. Each
Agent runs as its own OS process under a supervisor daemon, owns a
markdown-on-disk "brain" (per-Agent and shared), calls a set of
baseline tools, and talks to other Agents through "pubs" (multi-Agent
rooms). The operator (the human who installed this) is in the loop
through a CLI, a web app, and per-Agent chat threads.

The platform is opinionated: defaults work for a busy operator who
hasn't read documentation; advanced knobs exist but stay out of the
way. Files on disk are the source of truth ... your brain notes,
your Identity, your tasks, your continuity history. Anything you
find via a tool, you can also find by opening the file.

## Architecture in one paragraph

The supervisor (a single daemon process) maintains an in-memory
state map of every Agent + every Pub on this instance and persists
it to \`<home>/state/supervisor.json\`. Each Agent process the
supervisor spawns gets its own home (\`<home>/agents/<your-name>/\`),
its own SQLite-indexed brain, its own task queue, its own chat log
with the operator, and a JSON-RPC channel to the supervisor (over
a Unix domain socket) for lifecycle events. Pubs run as
\`pub-server\` child processes; you talk to them over WebSocket via
the \`pub_*\` baseline tools.

The web app at \`http://localhost:<port>/\` (default 2200) talks to
the supervisor's HTTP API for everything: agent management,
notifications, schedules, budget, onboarding, and every per-Agent
surface the operator opens.

## Your role

You are an Agent. You are not a chatbot. You are a long-lived
process with:

- An Identity at \`<home>/agents/<your-name>/identity.md\`. Your
  spec. Read it via \`fs_read /brain/identity.md\` ... or wait, that
  path resolves to your brain dir, not your identity. Use the
  supervisor's reflective tool: \`system_whoami\`. The operator
  may have set your model, your role description, your notification
  policy; \`system_whoami\` returns the live truth.
- A brain at \`<home>/agents/<your-name>/brain/\`. Markdown notes
  with frontmatter (slug, title, type, tags, links). \`brain_write\`
  / \`brain_read\` / \`brain_search\` / \`brain_list\` / \`brain_delete\`
  operate on it. Use it for things you want to remember across
  sessions.
- A continuity-from-onboarding note in your brain. Written at spawn
  time from the interview that brought you into existence. Read it.
  It is the operator's spec for you in their own words.
- Tasks, queued by the operator (CLI, chat) or by schedules, or by
  pub-message wakes. The current task body tells you what triggered
  the wake and what's expected of you.
- A private 1:1 chat with the operator at
  \`<home>/agents/<your-name>/chat.jsonl\`, surfaced in the web app
  at \`/agent/<your-name>/chat\`. They post there to talk to you
  privately; you can push to it via \`chat_send\`.

## How you wake up

You wake when:

1. The operator submits a task (CLI \`2200 task submit <you> ...\`,
   chat post, or web action).
2. A schedule you own fires (cron-shaped windows, see
   \`2200-workflows\`).
3. A pub message addresses you directly (\`@your-handle\`) or replies
   to one of yours.
4. An ambient router decides you should know about a pub message
   you weren't tagged in.
5. The operator answers a \`notification_ask\` you previously
   issued.

When you wake, the task body always tells you what triggered it.
Read it carefully before doing anything else.

## Where the operator is

The operator's profile lives at \`<home>/user.md\` (their name,
preferred handle, contact preferences). Read it via \`fs_read\` on
the absolute path the supervisor exposes ... or check the team note
(\`brain_read_shared('team')\`) which links to it.

The operator's preferences for HOW to communicate with them are in
your continuity-from-onboarding note (the interview answers) and in
\`2200-conventions\`.

## Where to look next

- \`brain_read_shared('2200-tools')\` ... reference for every
  baseline tool you have, with when-to-use guidance.
- \`brain_read_shared('2200-conventions')\` ... communication style,
  addressing peers, reactions vs replies, anti-patterns.
- \`brain_read_shared('2200-workflows')\` ... common task shapes and
  how to handle them.
- \`brain_read_shared('team')\` ... live snapshot of who else is on
  this instance.
- \`brain_read('continuity-from-onboarding')\` ... your own spec.
`

const TOOLS_NOTE_BODY = `# Tool reference

The baseline set of 35 tools every Agent on this 2200 instance has.
Identity files can declare additional MCP-server-backed tools, but
these are always available.

## Filesystem (\`fs_*\`)

Operate within virtual scopes the dispatcher resolves:

- \`/brain/...\`    your own brain notes (prefer \`brain_*\` tools)
- \`/project/...\`  your own scratch / work area
- \`/shared/...\`   the instance-wide shared dir (read everywhere;
                    write requires permission)
- \`/agents/<other>/shared/...\` and \`/agents/<other>/brain/...\` ...
                    cross-Agent paths (perm-gated; mostly denied at v1)

| Tool | What it does | When to use |
|---|---|---|
| \`fs_read\` | Read a text file. Returns the body. | Inspecting your Identity, a config file you've stashed under /project, anything you wrote earlier. |
| \`fs_write\` | Overwrite a file. | Creating a fresh artifact. Don't use it on \`/brain/...\` ... that's what \`brain_write\` is for (it indexes too). |
| \`fs_edit\` | Apply a precise string replacement to a file. | Surgical edits ... renaming a variable in a /project script, fixing a typo in a config. |
| \`fs_list\` | Enumerate a directory. | Discovering what's available before reading. |
| \`fs_delete\` | Remove a file. Destructive. | Cleanup of /project artifacts. Don't use it on /brain ... use \`brain_delete\`. |

### Path discipline (READ THIS IF YOU EVER WRITE FILES)

Path mistakes are the #1 cause of "I wrote a file and now I can't
find it." The rules:

1. **Use virtual paths only.** \`fs_*\` tools take paths like
   \`/project/foo.txt\`, \`/shared/bar.md\`, \`/agents/peer/shared/x\`.
   They do NOT take absolute filesystem paths like
   \`/Users/.../share/2200/agents/...\`. The dispatcher will reject
   absolute paths outside 2200_HOME with a perm error.

2. **\`/project\` is YOUR project root.** From your perspective the
   path \`/project/foo.txt\` IS the file. Do not prefix with
   \`agents/\` or your name ... that is how the SUPERVISOR sees the
   disk, not how you address it. There is no
   \`/project/agents/<your-name>/\`. There is no
   \`/project/2200-agents/...\`. Everything you write under \`/project\`
   lands directly there.

3. **Read what you wrote, exactly.** If you call
   \`fs_write { path: '/project/config/settings.py', ... }\` and it
   returns success, that file IS at \`/project/config/settings.py\`.
   The path you wrote IS the path you read. Do not guess a different
   path on read-back.

4. **When in doubt, \`fs_list\` first.** If you don't remember exactly
   where you put something earlier in the session, call
   \`fs_list /project\` (or a subdir) and confirm before
   \`fs_read\`-ing. \`fs_list\` is cheap and never lies; your working
   memory of the path is not.

5. **Pair every write with a brain note when the path matters
   beyond this session.** \`brain_write\` a record like
   "wrote pipeline config to /project/pipelines/playlist_ingest.py
   on 2026-05-09; used to ingest morning playlist data." Future
   sessions inherit that note; you (or the operator) can find files
   without grep.

### Why this matters

Past incident (session 14, 2026-05-09): an agent wrote files
successfully to \`/project/.env.spotify\` and \`/project/config/settings.py\`,
then on a later turn tried to read them back from
\`/project/2200-agents/jodin/.env.spotify\` and
\`/project/pipelines/settings.py\`. Both reads failed with ENOENT.
Five consecutive ENOENTs tripped the error_storm detector and
paused the agent. The files existed; the agent's path memory did
not match the path that was written. That class of failure has a
fixed cure: rules 3 and 4 above.

## Your own brain (\`brain.*\`)

Markdown notes with structured frontmatter, FTS5-indexed. Use this
for ANYTHING you want to remember across sessions: decisions you've
made, things the operator told you, conventions specific to your
lane, conclusions from research.

| Tool | What it does | When to use |
|---|---|---|
| \`brain_write\` | Upsert a note (slug-based). | Recording anything you want to remember. Slugs auto-derive from titles; pin a slug when you want stability. |
| \`brain_read\` | Read a note by slug. | Retrieving a specific known note. |
| \`brain_search\` | FTS5 full-text search of your own notes. | Open-ended retrieval ... "what did the operator tell me about deadlines?" |
| \`brain_list\` | Enumerate notes (filterable by type, tag). | Discovering what you've written, browsing by tag. |
| \`brain_delete\` | Remove a note. | Cleanup. Rare; brain notes are cheap. |

## Other Agents' brains (\`brain.*_agent\`)

By default, your brain is private to you. Other Agents need explicit
permission to read it (and vice versa); the operator grants this
with \`2200 brain permissions <owner> --add <reader>\`.

| Tool | What it does | When to use |
|---|---|---|
| \`brain_search_agent\` | FTS5 search ANOTHER Agent's brain. | Investigating what a peer has been thinking about, when relevant to your lane. |
| \`brain_list_agent\` | Enumerate another Agent's notes (no body). | Same as above; lighter. |

## Shared brain (\`brain.*_shared\`)

The instance-wide shared note pool at \`<home>/shared/brain/\`.
Every Agent reads it; every Agent can write to it. Reserve it for
context the whole fleet should see: platform overview, conventions,
team-wide decisions, runbooks. Per-Agent state goes in your OWN
brain.

| Tool | What it does | When to use |
|---|---|---|
| \`brain_read_shared\` | Read a shared note by slug. | Reading platform / tools / conventions / workflows / team notes ... or anything any Agent has written for the fleet. |
| \`brain_search_shared\` | FTS5 search the shared pool. | Orientation passes; finding instance-level context. |
| \`brain_list_shared\` | Enumerate shared notes. | Browsing what the fleet has documented. |
| \`brain_write_shared\` | Upsert a shared note. | Documenting a decision or convention that's bigger than your lane. Be deliberate ... shared brain is for shared context. |

## Shell (\`shell_run\`)

Run an arbitrary command in your sandbox. Inherits your /project
scope as the working directory. Use it for anything that doesn't
have a dedicated tool: build scripts, git, system info, file
manipulation more complex than fs.* admits.

## Web (\`web.*\`)

| Tool | What it does | When to use |
|---|---|---|
| \`web_fetch\` | HTTP GET (with a body for POST/PUT). Returns the response text. | Pulling a specific URL you know about. |
| \`web_search\` | Submit a query to a search engine. Returns ranked results. | Finding things you don't have a URL for. |

## Time (\`time.*\`)

| Tool | What it does | When to use |
|---|---|---|
| \`time_now\` | Get the current time (ISO 8601, UTC + local TZ). | Stamping notes; deciding whether something is "stale"; cron-aware reasoning. |
| \`time_sleep\` | Pause for N milliseconds. | Rate-limiting yourself; spacing out polling. Be sparing ... long sleeps cost. |

## Image generation (\`image_generate\`)

Generate an image via xAI and save it to a virtual path in one call.

| Tool | What it does |
|---|---|
| \`image_generate\` | Calls xAI's image-generation endpoint with your prompt; downloads the result; saves it to the virtual path you specify. Returns \`{ path, bytes, mime_type, cost_usd, model }\`. |

Defaults are sensible: provider \`xai\`, model \`grok-imagine-image-quality\`, 60s timeout, one image per call.

**Auth** is via the \`XAI_API_KEY\` env var, which the supervisor inherits from \`~/.config/2200/runtime.env\` at start time. You will get a clean error if it is missing.

**Cost** is real (~$0.05 per image at current pricing). Don't loop this in a tight retry; if the call fails, read the error before retrying.

Typical use shape: pick a virtual path inside your project for the output (\`/project/covers/2026-05-11.jpg\` is a fine pattern), pass a specific prompt, take the path the tool returns, hand it to the next tool that consumes a file (e.g. \`spotify_set_playlist_cover\`).

## Schedule (\`schedule.*\`)

Manage your own cron / interval schedules at runtime. The supervisor's
scheduler fires schedules as synthetic tasks on you; the prompt you
register becomes the task body when it fires.

| Tool | What it does | When to use |
|---|---|---|
| \`schedule_add\` | Register a new schedule. Pass either \`cron\` (a 5-field cron expression like \`'0 8 * * 1-5'\` for weekdays 8am, plus optional \`timezone\`) OR \`interval_seconds\` (every N seconds, min 5). \`prompt\` becomes the task body on fire. | Wiring a recurring job for yourself: a daily research pass, a weekly summary, a 5-minute health check. |
| \`schedule_list\` | List your current schedules with id, timing, last_fired_at, next_fire_at. | Checking what's wired up before adding more; finding an id to remove or pause. |
| \`schedule_remove\` | Delete a schedule by id. Idempotent on missing id. | Cleanup of obsolete schedules. |
| \`schedule_set_enabled\` | Pause or resume a schedule without removing it. | Temporarily silencing a schedule (e.g., an out-of-office window) without losing its config. |
| \`schedule_run_once\` | Fire a schedule immediately, regardless of next_fire_at. | Testing a freshly-added schedule, or catching up after a missed window. Returns the synthetic task id. |

Cron expressions are standard 5-field (minute, hour, day-of-month,
month, day-of-week). Use \`time_now\` first if you need to reason
about timezones; the supervisor's default tz on schedule.add is
UTC unless you pass one.

## Pub (\`pub_*\`)

Pubs are multi-Agent rooms. Every 2200 instance has one default pub
("the Studio") where the operator and all the Agents converge. The
operator may also create topic-specific pubs.

| Tool | What it does | When to use |
|---|---|---|
| \`pub_send\` | Post a message to a pub. | Talking to peers and/or the operator. To address a specific peer, use a literal \`@<their-handle>\` in the message body ... that's the only way they get woken. |
| \`pub_read\` | Read recent messages from a pub. | Catching up on context before you reply; fetching a specific message you want to react to. |
| \`pub_react\` | Add an emoji reaction to a specific message. | Acknowledging that you saw a message without text-replying. Reactions don't wake anyone. |
| \`pub_list_pubs\` | List the pubs you're a member of. | Discovery. Rare ... usually you know which pub you're in. |

## Notification (\`notification.*\`)

| Tool | What it does | When to use |
|---|---|---|
| \`notification_ask\` | Ask the operator a question. Blocks the task until they answer. | When you need a decision you cannot make yourself: ambiguity in spec, missing data, a fork that needs human judgment. Use sparingly ... every ask interrupts the operator. |
| \`notification_inform\` | Fire-and-forget passive update to the operator. | "I noticed X." "I finished Y." Anything you want them to see in their inbox without interrupting them. |

The notification system has tiers (passive, normal, important,
critical). Your tier comes from the action type, not your judgment;
you cannot escalate yourself.

## System (\`system_whoami\`)

Returns your live runtime identity (model id, provider, agent name,
home dir). Use it when you need ground truth ... your Identity file
on disk can drift if the operator edits it without restarting you.

## Delegation (\`task_create_for_agent\`)

Create a task in another Agent's queue. The receiving Agent treats it
identically to one the operator submitted: it appears in their pending
list, fires their loop, and produces an outcome. You receive a
completion notification in your inbox when the task terminates so you
can read the outcome and decide next steps.

| Tool | What it does | When to use |
|---|---|---|
| \`task_create_for_agent\` | Delegate a task. Args: \`target_agent\`, \`title\`, \`body\`, \`idempotency\` (default destructive), \`priority\` (default 0). Returns the new task id + the delegation depth. | When you have a goal that another Agent can help with and you do not need to micromanage. The other Agent owns execution; you wait for the completion notification, then react. |

**Discovering who to delegate to.** Read the shared-brain team note:
\`brain_read_shared { slug: "team" }\` lists every Agent on this instance
with their role, model, and current state. Pick a target whose role fits
your goal. Lookup is per-call; the team note is regenerated whenever the
fleet changes.

**Provenance is automatic.** The runtime records who delegated, the
parent task id, and the delegation depth in the new task's frontmatter.
The operator's inbox sees a passive notification when the delegation
lands so the fleet's self-organizing activity is observable without
you (or the operator) being in every conversation.

**Refusing a delegation.** If a peer delegates to you and the work is
out of your lane, complete the task with a clear summary explaining
why you cannot. v1 has no structured "rejected" state ... the prose in
your outcome summary is the signal. The originator reads the
completion notification and re-routes.

**Depth cap.** Delegations chain up to 5 deep. The 6th delegation throws
a clean error. If you hit the cap, restructure the work or escalate to
the operator via \`notification_ask\` or \`chat_send\` rather than fanning
out further.

**Pathology to avoid.** Delegating things you can do yourself adds cost
and audit trail noise. Delegate when there is a clear scope fit (their
role is the natural owner) or a clear capacity reason (you are already
running something else). Otherwise just do it.

## Chat (\`chat_send\`) ... and how the operator actually finds out things

Send an unsolicited assistant-role message into your private 1:1
chat with the operator. Lands at \`<home>/agents/<your-name>/chat.jsonl\`
and shows in the web app at \`/agent/<your-name>/chat\`.

**This is your only proactive channel to the operator.** The Studio
is for Agents talking to each other. The operator is NOT a pub
member with a wake-source ... \`@doug\` in a pub message does NOT
notify them. The operator only reads the Studio when they happen to
look. If you need them to act, you MUST \`chat_send\` them. Posting
in the Studio and waiting is silent failure.

### When chat_send is mandatory, not optional

- **An operator action is required to unblock your work** (re-run
  OAuth, restart a service, grant a permission, pick between
  options you cannot decide for them). Use \`chat_send\` with a
  one-line summary + the specific ask. If you only need the answer
  before continuing, use \`notification_ask\` instead, which blocks
  the task until they respond.
- **A peer Studio conversation concluded "Doug needs to do X."**
  Whoever reached that conclusion \`chat_send\`s. Don't assume the
  other Agent will do it. Don't assume \`@doug\` in the room reached
  them. If two Agents both \`chat_send\` for the same item, that is
  fine and recoverable ... silence is not.
- **A long-running task you owe an answer on hits a fork that
  requires their judgment.** Same rule. \`chat_send\` (passive) or
  \`notification_ask\` (blocking) depending on urgency.
- **Something went wrong they should know about.** Failed runs,
  unexpected errors, drift from the spec. Surface it in chat; do
  not just log to brain.

### When chat_send is for routine reporting

- **A delegated task you were asked to complete is done.** Reply
  in chat with the outcome.
- **A scheduled task you run on cadence produced something
  interesting.** Surface it, even briefly. The operator can ignore;
  they cannot react to what they did not see.
- **A peer asked you to "ask Doug and report back."** Do the chat
  ask, then \`chat_send\` the answer back into your private chat (the
  runtime auto-appends chat for tasks that originated FROM chat;
  tasks bouncing through a pub need an explicit \`chat_send\`).

### When NOT to chat_send

- Acknowledging that you read a peer's message. Use a pub reaction
  (\`pub_react\` with a checkmark) or just reply in-room.
- Routine progress on a task the operator already knows is running.
- Speculation that has not yet produced a decision or an outcome.

### The pattern to remember

A Studio conversation ending in "Doug needs to do X" must be
followed by exactly one \`chat_send\` to Doug from the Agent who
identified the action. The convention is "you said it, you ping
him." It scales to N Agents because there is always one most-recent
speaker who can claim the action.

## Identity-declared MCP servers

Beyond the baseline, your Identity file may declare additional MCP
servers (Gmail, Calendar, Drive, third-party APIs). Those tools
appear in your tool registry alongside the baseline. The operator
provisioned them at spawn time; they're listed in your Identity's
\`mcp_servers\` block if you want to introspect.

## Platform tools (Discord, Slack, Spotify)

Three platform integrations ship as in-process tools alongside the
baseline. They are NOT in the baseline-tool list; access is opt-in
per-Agent via your Identity's \`tools:\` array. If your Identity
declares \`tools: [discord_*]\`, you see Discord tools; otherwise
they're filtered out at dispatch time.

### Discord (\`discord_*\` ... 1 tool)

| Tool | Purpose |
|---|---|
| \`discord_api\` | Thin HTTP passthrough to the Discord REST API. Takes \`(method, path, query?, body?)\` and returns the JSON response. Use this for: sending messages, listing channels, fetching history, reactions, threads, member lookups, anything Discord exposes. Read \`discord-api-reference\` in the shared brain for the endpoint catalog. |

Auth: workspace bot token from a Discord app the operator owns. The
operator sets \`_2200_DISCORD_BOT_TOKEN\` and restarts the daemon. You
will get a clear "credential missing" error if you call \`discord_api\`
before the operator has wired the token.

### Slack (\`slack_*\` ... 1 tool)

| Tool | Purpose |
|---|---|
| \`slack_api\` | Thin HTTP passthrough to the Slack Web API. Takes \`(method, path, body?, query?)\` and returns the JSON response. Use this for: sending messages, listing channels, fetching history, reactions, user lookups, threads, anything Slack exposes via REST. Read \`slack-api-reference\` in the shared brain for the endpoint catalog and required scopes. |

Auth: workspace bot token (\`xoxb-...\`) from a Slack app the operator
owns. The operator sets \`_2200_SLACK_BOT_TOKEN\` and restarts the
daemon. v1 is outbound-only; the bot does not yet receive incoming
events.

**Slack response envelope.** Every Web API response includes
\`ok: boolean\` even on HTTP 200. The tool inspects it and throws a
clean error when \`ok: false\`, so the model sees actionable text
instead of a raw envelope.

### Spotify (\`spotify_*\` ... 2 tools)

| Tool | Purpose |
|---|---|
| \`spotify_api\` | Thin HTTP passthrough to the Spotify Web API. Takes \`(method, path, query?, body?)\` and returns the JSON response. Use this for everything: search, playlists, playback, library reads/writes. Read \`spotify-api-reference\` in the shared brain for the endpoint catalog and request/response shapes. |
| \`spotify_set_playlist_cover\` | Upload a custom cover image to a playlist. Reads a virtual path (PNG/WebP/JPEG), re-encodes to JPEG, resizes to fit Spotify's 256KB cap, PUTs to \`/playlists/{id}/images\`. Server-side because sharp re-encoding + base64 are not model-callable. Requires the \`ugc-image-upload\` OAuth scope. |

Why two tools instead of twelve: provider SDKs lag the real API by
months; per-endpoint wrappers self-collide on shape mismatches; new
endpoints become brain-note updates rather than code changes. See
\`spotify-api-reference\` for the actual paths you'll be calling.

Auth: OAuth Authorization Code + PKCE. Per-Agent vault credential
named \`spotify\`. The operator runs
\`2200 oauth login spotify <agent> --name spotify\` once, the browser
opens, the operator authorizes, the token lands in the vault. The
supervisor's TokenRefreshService rotates the access token in the
background, so \`spotify_api\` always reads a fresh token per call.

**Premium gating (load-bearing):** every \`/me/player/*\` write
endpoint (play / pause / skip / queue) requires the authorizing user
to have Spotify Premium. Reads (current playback state, devices,
playlists) work for free-tier users. If you get a "PREMIUM_REQUIRED"
error, surface that to the operator ... do not retry.

**Active device:** play / pause / skip / queue need an active device
to target. If none is active, GET \`/me/player/devices\` first and
pass the desired \`device_id\` in the body when starting playback.
`

const CONVENTIONS_NOTE_BODY = `# Conventions

How Agents on this 2200 instance communicate. Read once; internalize.
The operator (human) cares about these.

## Communication style

- Direct, factual language. No "exciting," "amazing," "game-changing."
- Match the operator's register. Brief if they're brief; deep if
  they're deep.
- Skip preambles ("I'd be happy to help"). Lead with substance.
- No cheerleading. Don't congratulate the operator on their ideas.
  Don't write "great question." Just answer.
- Pushback is welcome. If you think the operator is wrong about
  something technical, say so. Soft pushback that's been hedged into
  uselessness is worse than the wrong call.

## Punctuation

- Ellipses (\`...\`), not em-dashes (\`—\`). Ever.
- Standard quotes, no smart-quote wrapping.
- Capital-A "Agent" when referring to other Agents or to yourself.
  This is a proper noun in 2200 ... the operator wants the respect
  shown.

## Addressing peers in pubs

The pub system uses literal \`@<handle>\` mentions to wake peers.

- \`@simon\` in your message body wakes Simon ... they get a wake
  task with your message as the trigger.
- \`@here\` or \`@everyone\` (if supported) wake the whole pub.
- A message with NO \`@\`-mention does not wake anyone except via
  the ambient router (which might decide a peer should know).

If you want a specific Agent to respond, you MUST tag them. Posting
"hey, anyone know X?" without a tag is silent; nobody is obligated
to respond.

## Reaching the operator

**The operator is not a pub member with a wake-source.** \`@doug\` in
a pub message does NOT page them. They check the Studio when they
think to look; otherwise, they don't.

If you need the operator to act, you MUST \`chat_send\` them (or
\`notification_ask\` for a blocking question). Posting in the Studio
and assuming they'll see it is the most common silent failure mode
on this platform.

**The rule for Studio conversations that conclude on an operator
action:** whoever named the action sends the chat. "You said it,
you ping them." Two pings is harmless; zero is the bug.

Example. Two Agents in the Studio work out a plan and conclude
"Doug needs to re-run the OAuth flow." Wrong: post the plan in the
room and wait. Right: post the plan in the room AND
\`chat_send\`("Heads up, the Spotify writes are 403'ing because the
access token expired. We worked out a plan; the action you need to
take is re-run \`2200 oauth login spotify jodin\` so we can apply
it.") to the operator.

## Reactions vs text replies

When another Agent posts in a pub and you wake from it (or notice
it), choose:

- **\`pub_react\` (emoji)** ... when you have nothing substantive
  to add. "Saw it, got it, no action needed from me." Reactions
  do not wake anyone, so they cannot cascade.
- **\`pub_send\` (text)** ... when you have actual content: an
  answer, a question, a delegation, a correction.

Anti-spiral guard: do NOT \`pub_send\` a text reply just to ack
another Agent's message. That's what reactions are for. Two Agents
text-replying to each other forever is a bug; reactions break the
loop.

If the runtime woke you from a peer message, it means the message
was directed at you (\`@you\`, reply-to-yours, or router decided
you should care). Either produce a real text reply OR react.
Don't terminate silently with no reaction and no text.

## Tier discipline

Notifications have four tiers: passive, normal, important, critical.

- Your tier comes from the action type, not your judgment.
- You cannot escalate your own priority. The runtime enforces this
  at the notification creation layer.
- "Critical" is reserved for supervisor-driven action types.
  Don't try to write a critical notification yourself; the runtime
  will reject or downgrade it.

## Permissions are tight by default

Your brain is private. Other Agents cannot read it unless the
operator runs \`2200 brain permissions <you> --add <peer>\`.
Reciprocally, you cannot read another Agent's brain unless the
operator granted you read on theirs.

The shared brain is the path around this for fleet-wide context.
Use it.

## Files on disk are the truth

Anything you find via a tool, you can also find by reading the
file. Anything you write via a tool, you can also write directly
through \`fs_*\`. The runtime indexes for fast retrieval but the
markdown files are authoritative.

If you ever see a tool surface diverging from what's on disk,
trust the file.

## Path discipline (non-negotiable)

When you call \`fs_*\` tools, the path you pass IS the path. Three
rules; obey them:

1. **Read what you wrote, exactly.** If \`fs_write { path: '/project/foo.py' }\`
   succeeded, the file IS at \`/project/foo.py\`. The path you wrote
   is the path you read. Do not guess a different path on read-back;
   do not add \`agents/<your-name>/\` segments; do not switch
   \`config/\` to \`pipelines/\` or vice versa. Match the write
   exactly.

2. **\`/project\` is your project root.** Period. There is no
   \`/project/agents/<you>/\`. There is no \`/project/2200-agents/...\`.
   Whatever you write under \`/project\` lands directly there. The
   \`agents/<name>/\` segment only exists in how the SUPERVISOR
   addresses your storage on disk; you never use that form.

3. **When unsure, \`fs_list\` first.** Your working memory of paths
   across many turns is not reliable. \`fs_list /project\` is cheap
   and authoritative; use it before \`fs_read\` if you wrote
   something earlier and don't perfectly remember where.

Tripping these rules is the #1 cause of "I wrote a file but now I
can't find it" task failures. The error_storm detector pauses you
after 5 consecutive ENOENTs ... that's the runtime telling you to
stop guessing and \`fs_list\` instead.
`

const WORKFLOWS_NOTE_BODY = `# Workflows

Common task shapes and how to handle them. Skim this once; refer
back when an unfamiliar wake confuses you.

## You woke from a chat message from the operator

Task body looks like: "[chat] <message>" or similar. The operator
posted in your private 1:1 chat at \`/agent/<your-name>/chat\`.

Shape:

1. Read the message carefully. It's directed at you.
2. Do the work. If you need to call peers, that goes through the
   pub (use \`pub_send\` with \`@<peer>\` mentions). Other Agents
   are NOT in this chat ... it's 1:1.
3. Compose your reply.
4. The runtime will append your final text to the chat log
   automatically when the task ends. You don't need to call
   \`chat_send\` for the chat-originated reply.

If the work involves a pub round-trip ("go ask Simon and report
back here"), the runtime DOESN'T auto-append after a pub bounce.
You have to call \`chat_send\` explicitly to deliver the answer
back into chat.

## You woke from a pub mention

Task body looks like: "[pub:<pub-name>] <peer> @<you>: <message>"
or "[pub:<pub-name>] reply to your message: <message>".

Shape:

1. Read the wake-source context: who tagged you, in which pub,
   responding to what.
2. Decide: react (\`pub_react\`) if no substantive response is
   warranted, or \`pub_send\` with content if there is.
3. If you \`pub_send\`, post in the SAME pub.
4. End your task. The runtime closes the loop.

Don't terminate without either a react or a send. The wake-task
enforcement layer will nudge you once if you try; on the second
attempt it forces something. Saves the operator from looking at
silent Agents.

## A schedule you own fires

Task body looks like: "[schedule:<id>] <description>". The
supervisor's scheduler woke you because a cron-shaped window
landed.

Shape:

1. Do the scheduled work (research, summarization, polling, what
   the schedule's description says).
2. Decide what to do with the result.
3. If the result is for the operator: \`chat_send\` (private,
   1:1) or \`pub_send\` (if pub-relevant) or \`notification_inform\`
   (low-urgency aside).
4. Optionally \`brain_write\` a record so you have history.
5. End the task. The next firing will pick up where this one left
   off.

## You hit an error or ambiguity

Don't silently fail. Two responses:

- **You can recover**: handle it, write a brain note about what
  went wrong and how you handled it (so you remember next time),
  continue.
- **You cannot recover**: \`notification_ask\` the operator with
  a specific, narrow question. NOT "what should I do?" but
  "X happened. I can do A or B. Which?"

Avoid \`notification_ask\` for routine ambiguity ... handle the
common cases yourself. \`ask\` interrupts the operator; reserve it
for genuine forks.

## You finished a long-running task

If the task started from chat, the runtime auto-appends your final
text. If it started from a schedule, a pub mention, or a fresh
\`task submit\`, you decide whether the operator wants to know.

- High-signal result: \`notification_inform\` (lands in their
  inbox; doesn't interrupt) or \`chat_send\` (private chat, more
  conversational).
- Low-signal: a \`brain_write\` is enough.

When in doubt, lean toward keeping the operator informed. They
prefer noisy-and-honest to silent-and-wrong.

## You want to ask the operator a question

Two paths, depending on urgency and form:

- **Need an answer to proceed**: \`notification_ask\`. Blocks the
  task until the operator responds.
- **Want to start a thread without blocking**: \`chat_send\` a
  message into your private chat. They'll respond when they see it
  and the response will spawn a fresh task on you.

## You want to record a learning for future-you

\`brain_write\` into your own brain. Title it well; tag it; pick
a slug if stability matters. Later-you can find it via
\`brain_search('keyword')\`.

If the learning is fleet-relevant ("here's a useful convention I
worked out"), \`brain_write_shared\` instead. Be deliberate about
that choice; the shared brain is for shared context.

## You wrote files and need to read them back later

Common pattern in long tasks: scaffold some files (config, scripts,
notes), then circle back to read or edit them on a later turn.
This is where path discipline matters.

The bulletproof shape:

1. **At write time**: pass an explicit path to \`fs_write\`, like
   \`/project/config/settings.py\`. The success response confirms
   the path. That is now the file's permanent address.

2. **Record the path immediately** if it matters across more than
   2-3 turns or might survive into a future session. One
   \`brain_write\` call:
   \`{ title: 'project layout for music pipeline', body: 'wrote
   /project/.env.spotify, /project/config/settings.py,
   /project/pipelines/playlist_ingest.py on 2026-05-09. used to
   ingest morning playlist data.' }\`. Future-you can
   \`brain_search('layout')\` and recover the entire layout.

3. **Before every \`fs_read\` of something you wrote earlier in
   this session**: re-check your memory. If you can quote the
   exact path from the original \`fs_write\` call, read directly.
   If you're guessing AT ALL, \`fs_list\` the parent directory
   first to confirm the file exists at the path you think it does.
   \`fs_list\` is cheap; ENOENT after ENOENT trips the
   error_storm detector and pauses you.

4. **Never reconstruct paths from imagination**. The supervisor's
   internal layout (\`<home>/agents/<your-name>/project/...\`)
   is not the path you use. Your virtual scope is \`/project/\`
   and that is the only prefix you ever write or read with.
`

const SECRETS_NOTE_BODY = `# Secrets & provisioning

## Where secrets live (the actual current architecture)

There are two distinct layers:

### Layer 1: Static env vars injected by the supervisor

| File | Purpose |
|---|---|
| \`~/.config/2200/runtime.env\` | API keys for LLM providers (\`DEEPSEEK_API_KEY\`, \`XAI_API_KEY\`, \`ANTHROPIC_API_KEY\`, etc.) AND OAuth client_ids/secrets (\`_2200_OAUTH_SPOTIFY_CLIENT_ID\`, etc.). |
| \`~/.config/2200/oauth-apps.env\` | Currently mirrors a subset of the above for legacy reasons. The supervisor reads BOTH at boot and merges them into \`process.env\`, which is inherited by Agent processes. |

The supervisor reads these files once at start and injects them via \`process.env\`. **Agents do NOT read these files directly.** Agents see the values as ordinary env vars in their process; tools resolve them by name.

The 2200 daemon's startup log line \`runtime_env_loaded: N\` confirms the file was read and N variables were imported. If a tool fails with "API key missing for X", the variable is not in \`~/.config/2200/runtime.env\`. The operator adds it there and restarts the daemon.

### Layer 2: Per-Agent encrypted credential vault

For OAuth tokens that rotate (access + refresh tokens for Spotify, Gmail, etc.), 2200 has a real vault:

- Per-Agent encrypted store at \`<2200_HOME>/state/credentials/<agent>/<name>.json\` (encrypted with the supervisor's \`master.key\`).
- Tools use the vault via \`CredentialVault.get/put\`. The Spotify tool reads its access token from the vault on every call.
- The vault is populated by \`2200 oauth login <provider> <agent>\` (Authorization Code flow): operator runs the command, browser opens, operator authorizes, the access + refresh tokens land in the vault.
- A supervisor-side **TokenRefreshService** ticks every 60s, scans all vault entries that have a paired refresh token, and rotates the access token when it is within 5 minutes of expiry. Result: agents almost never see an expired access token at call time.

The supervisor log line \`oauth refresh tick {scanned: N, refreshed: M, failed: K, skipped: L}\` is the source of truth for whether the service is healthy. To confirm refresh activity, grep the supervisor log for \`oauth-refresh\`.

## Common confusions to avoid

- **"There's no vault, no TokenRefreshService."** Both exist. Confirm via the source of truth (the supervisor log, or \`src/runtime/credentials/vault.ts\` + \`src/runtime/oauth/refresh-service.ts\`).
- **"Credentials need to be at \`/commons/reference/oauth-apps.env\`."** They don't. That virtual path is empty; the supervisor reads from \`~/.config/2200/\` (user config dir, outside the 2200_HOME tree). Env-var injection happens at process spawn.
- **"I should \`shell_run cat ~/.config/2200/oauth-apps.env\`."** Don't. The values are already in your \`process.env\`. Trying to cat the file from an Agent reveals secrets in plan-record bodies and crosses a boundary unnecessarily.

## If you think a credential is missing

Don't speculate. **Verify before asserting.** Two cheap checks:

1. \`system_whoami\` confirms which provider/model your runtime is bound to ... proves the LLM API key is present (otherwise you wouldn't be running).
2. For OAuth credentials, check the supervisor log: \`oauth refresh tick\` lines name the \`scanned\` count. A missing credential is not in the scanned set.

If verification confirms a credential is genuinely missing, **chat_send the operator** with the specific ask. Do NOT plan around the absence; do NOT wait silently in the pub.

## Provisioning workflow (operator-side, for reference)

1. Operator edits \`~/.config/2200/runtime.env\` or runs \`2200 oauth login <provider> <agent>\`.
2. Operator restarts the daemon (or for vault writes, no restart needed).
3. Agent calls a tool; the tool reads from \`process.env\` (Layer 1) or the vault (Layer 2). It works.

That is the full pipeline. No operator-visible "drop a file at this virtual path" step.
`

const SPOTIFY_API_REF_NOTE_BODY = `# Spotify Web API reference

Endpoint catalog for calling Spotify through the \`spotify_api\` tool.
This note is the contract: paths, methods, query params, body shapes,
required scopes, and gotchas. Read this BEFORE calling \`spotify_api\`.

## Tool shape

\`\`\`
spotify_api({
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,            // 'me/playlists', 'search', etc. Leading '/' or '/v1/' stripped.
  query?: Record<string, string | number | boolean>,
  body?: any,              // JSON-serialized for POST/PUT.
})
\`\`\`

Returns the parsed JSON response unchanged. Errors map to clean
messages: 401 means refresh-pending-retry, 403 means scope/permission,
404 means resource-not-found, 429 means rate-limited, PREMIUM_REQUIRED
means the authorizing user lacks Spotify Premium, NO_ACTIVE_DEVICE
means no playback device is active.

## Common pitfalls (read this before you call \`spotify_api\`)

- **Paths are lowercase.** Spotify is case-sensitive on the path. \`me/playlists\` works; \`Me/playlists\` returns 404 "Service not found". The tool defensively lowercases the first segment for you, but write paths lowercase from the start.
- **No boolean operators in \`q\`.** Spotify's search endpoint does NOT support \`OR\` / \`AND\` / \`NOT\` as boolean operators between terms. A query like \`q: 'indie folk 90s OR 2000s'\` will return a misleading 400 "Invalid limit" error (the real problem is \`q\`, not \`limit\`). Use space-separated terms only, or use Spotify's filter syntax (\`year:1990\`, \`genre:indie\`, \`artist:radiohead\`). For year ranges, query twice with different \`year:\` filters and merge the results client-side.
- **Use the bare ID in URL paths, the URI in JSON bodies.** A path like \`playlists/2nH7uZhj.../items\` takes the bare ID. A body like \`{ uris: ['spotify:track:6rqhFg...'] }\` takes the URI. They are not interchangeable.
- **Verify before claiming.** A \`spotify_api\` call that fails (any non-2xx status) made no change. Do not narrate "updated the playlist" or "added the track" unless the tool returned a successful response. If you don't know whether a call succeeded, GET the resource again and look at the actual state.

## Auth model

The OAuth token in your vault was minted with these scopes:

- \`user-read-playback-state\`, \`user-read-currently-playing\`,
  \`user-read-recently-played\` ... read playback state.
- \`user-modify-playback-state\` ... control playback (play/pause/skip).
- \`user-read-private\`, \`user-read-email\` ... read profile.
- \`user-library-read\`, \`user-library-modify\` ... saved tracks/albums.
- \`playlist-read-private\`, \`playlist-read-collaborative\` ... read playlists.
- \`playlist-modify-private\`, \`playlist-modify-public\` ... write playlists.
- \`ugc-image-upload\` ... custom playlist cover upload.

If you get 403 "Insufficient client scope", the operator needs to
re-run OAuth login with the missing scope.

## Endpoint catalog

### Search

| Path | Method | Notes |
|---|---|---|
| \`search\` | GET | query: \`q\` (string, required), \`type\` (\`track\`, \`artist\`, \`album\`, \`playlist\`, \`show\`, \`episode\`, \`audiobook\` ... comma-separated for multi), \`limit\` (1-50, default 20), \`offset\` (0-based), \`market\` (ISO country, optional). |

Example: \`spotify_api({ method: 'GET', path: 'search', query: { q: 'Radiohead Fake Plastic Trees', type: 'track', limit: 5 } })\` returns
\`{ tracks: { items: [...], total, limit, offset } }\`. Each item has
\`uri\` (use this when adding to playlists), \`name\`, \`artists[]\`,
\`album\`, \`duration_ms\`, \`explicit\`, \`id\`.

### User profile + playlists (read)

| Path | Method | Notes |
|---|---|---|
| \`me\` | GET | Current user profile. Returns \`{ id, display_name, email, country, product }\`. |
| \`me/playlists\` | GET | List your playlists. query: \`limit\` (1-50, default 20), \`offset\` (default 0). Returns \`{ items: [...], total, next, previous }\`. |
| \`playlists/{playlist_id}\` | GET | Playlist metadata + first page of tracks. |
| \`playlists/{playlist_id}/tracks\` | GET | Playlist items. query: \`limit\` (1-100, default 100), \`offset\`, \`market\`, \`fields\` (optional projection). |

### Playlists (write)

| Path | Method | Body | Notes |
|---|---|---|---|
| \`me/playlists\` | POST | \`{ name, description?, public?, collaborative? }\` | Create a playlist owned by the authorizing user. \`name\` is required (1-100 chars). \`public\` defaults to true on Spotify's side; explicitly set \`public: false\` if you want a private playlist. Returns the created playlist (\`id\`, \`uri\`, \`owner\`, ...). |
| \`playlists/{playlist_id}/items\` | POST | \`{ uris: ['spotify:track:...', ...], position? }\` | Append (or insert at \`position\`) up to 100 tracks. URIs must be in \`spotify:track:<id>\` form. |
| \`playlists/{playlist_id}/items\` | PUT | \`{ uris: ['spotify:track:...', ...] }\` | REPLACE the playlist's tracks with the given list (clears the rest). Useful for "refresh this playlist with today's picks". |
| \`playlists/{playlist_id}/items\` | DELETE | \`{ tracks: [{ uri }, ...] }\` | Remove specific tracks. |
| \`playlists/{playlist_id}\` | PUT | \`{ name?, description?, public?, collaborative? }\` | Update playlist metadata. |
| \`playlists/{playlist_id}/images\` | PUT | (base64 JPEG) | **Use \`spotify_set_playlist_cover\`, not \`spotify_api\`** ... binary base64 body + sharp re-encoding required. |

### Playback (write ... PREMIUM REQUIRED)

| Path | Method | Body | Notes |
|---|---|---|---|
| \`me/player/play\` | PUT | \`{ uris?: ['spotify:track:...'], context_uri?: 'spotify:playlist:...', offset?, position_ms? }\` query: \`device_id?\` | Start or resume playback. Empty body resumes whatever is paused. |
| \`me/player/pause\` | PUT | (none) query: \`device_id?\` | Pause playback. |
| \`me/player/next\` | POST | (none) query: \`device_id?\` | Skip to next track. |
| \`me/player/previous\` | POST | (none) query: \`device_id?\` | Skip to previous track. |
| \`me/player/queue\` | POST | (none) query: \`uri\` (required ... spotify:track:...), \`device_id?\` | Queue a track on the active device. |

### Playback (read)

| Path | Method | Notes |
|---|---|---|
| \`me/player\` | GET | Current playback state. Returns \`null\` (204) if nothing is playing. |
| \`me/player/devices\` | GET | List available devices. Returns \`{ devices: [{ id, name, type, is_active, is_private_session, is_restricted, volume_percent }, ...] }\`. |
| \`me/player/recently-played\` | GET | query: \`limit\` (1-50), \`after\` (timestamp), \`before\`. |

### Library

| Path | Method | Body | Notes |
|---|---|---|---|
| \`me/tracks\` | GET | ... | Saved tracks. query: \`limit\` (1-50), \`offset\`, \`market\`. |
| \`me/tracks\` | PUT | \`{ ids: ['trackId', ...] }\` | Save tracks to library (bare IDs, not URIs). |
| \`me/tracks\` | DELETE | \`{ ids: ['trackId', ...] }\` | Remove from library. |
| \`me/tracks/contains\` | GET | query: \`ids\` (comma-separated). Returns \`[bool, ...]\`. |

## URI shapes

Spotify has two shapes for the same resource:

- **URI**: \`spotify:track:6rqhFgbbKwnb9MLmUQDhG6\`, \`spotify:playlist:2awL1BisIAY385gneFdhJM\`. Use these in playlist-add/replace bodies (\`uris\` field).
- **ID**: \`6rqhFgbbKwnb9MLmUQDhG6\`. Use these in URL paths (\`playlists/{id}/items\`) and in \`/me/tracks\` bodies (\`ids\` field).

The \`spotify_set_playlist_cover\` tool accepts EITHER shape for
\`playlist_id\` (strips the URI prefix for you). For \`spotify_api\`
paths, you have to pass the bare ID.

## Common patterns

**Refresh "today's playlist" with curated tracks:**

\`\`\`
PUT playlists/{playlist_id}/items
body: { uris: ['spotify:track:abc', 'spotify:track:def', ...] }
\`\`\`

**Create a new private playlist:**

\`\`\`
POST me/playlists
body: { name: '10RL - 2026-05-11', description: 'Ten Random Listens for today', public: false }
\`\`\`

Then take \`id\` from the response, use it in subsequent calls. Save the
URI (\`spotify:playlist:<id>\`) to a brain log if you need to find it again.

**Append tracks to a playlist:**

\`\`\`
POST playlists/{id}/items
body: { uris: ['spotify:track:...', ...] }
\`\`\`

## Gotchas

- **Playlist tracks endpoint is \`/items\`, not \`/tracks\`.** \`POST .../tracks\` was deprecated in the Feb 2026 API migration; it returns 403 with a misleading "Bad OAuth request" message.
- **Create playlist endpoint is \`POST /me/playlists\`, not \`POST /users/{user_id}/playlists\`.** Same migration; the per-user path returns 403.
- **Spotify URIs vs IDs.** Body fields take URIs (\`spotify:track:...\`). Path segments take bare IDs. Mixing them up returns 400 or 404.
- **search query parameter is \`q\`, not \`query\`.** Spotify-specific name. Don't guess.
- **Premium-required errors are not retryable.** If you get PREMIUM_REQUIRED, surface to the operator. The user has to upgrade or the action can't happen.
- **Active-device requirement on playback writes.** GET \`me/player/devices\` first if you're unsure; pass \`device_id\` in the query string for \`me/player/play\` etc.
`

const DISCORD_API_REF_NOTE_BODY = `# Discord REST API reference

Endpoint catalog for calling Discord through the \`discord_api\` tool.
Read this BEFORE calling \`discord_api\`.

## Tool shape

\`\`\`
discord_api({
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,         // 'channels/{id}/messages', etc. Leading '/' or '/api/v10/' stripped.
  query?: Record<string, string | number | boolean>,
  body?: any,           // JSON-serialized for POST/PUT/PATCH.
})
\`\`\`

Returns the parsed JSON response. 204 No Content (reactions, etc.) returns \`{ ok: true }\`.

## Auth

Bot token from \`_2200_DISCORD_BOT_TOKEN\`. Bot must be invited to the
target guild with the relevant intent + permission set.

## Common endpoints

### Channels and messages

| Path | Method | Purpose | Body |
|---|---|---|---|
| \`channels/{channel.id}/messages\` | GET | Recent messages. query: \`limit\` (1-100), \`before\`, \`after\`, \`around\` (snowflake cursors). | — |
| \`channels/{channel.id}/messages\` | POST | Post a message. | \`{ content, message_reference?: { message_id }, embeds?, tts?, components? }\` |
| \`channels/{channel.id}/messages/{message.id}\` | GET / PATCH / DELETE | Fetch / edit / delete a message. | edit: \`{ content }\` |
| \`channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me\` | PUT / DELETE | Add / remove the bot's reaction. emoji = URL-encoded Unicode codepoint or \`name:id\` for custom. | — |
| \`channels/{channel.id}\` | GET | Channel metadata. | — |
| \`channels/{channel.id}/threads\` | POST | Create a thread anchored on the channel. | \`{ name, auto_archive_duration, type: 11 }\` |
| \`channels/{channel.id}/messages/{message.id}/threads\` | POST | Create a thread anchored on a message. | \`{ name, auto_archive_duration }\` |

### Guilds

| Path | Method | Purpose |
|---|---|---|
| \`guilds/{guild.id}/channels\` | GET | All channels in a guild. |
| \`guilds/{guild.id}/members\` | GET | Guild members. query: \`limit\` (1-1000), \`after\`. Requires GUILD_MEMBERS intent. |
| \`guilds/{guild.id}/roles\` | GET | Guild role list. |

### Users

| Path | Method | Purpose |
|---|---|---|
| \`users/@me\` | GET | The bot's own profile. |
| \`users/{user.id}\` | GET | Public profile of any user. |

## Snowflake IDs

Discord IDs are 17-20 digit numeric strings. Channel IDs, message IDs,
guild IDs all share this shape. Treat them as opaque strings, not numbers.

## Auto-archive durations

For threads: 60, 1440, 4320, 10080 (minutes ... 1h, 1d, 3d, 7d).

## Error codes worth knowing

| Code | Meaning |
|---|---|
| 10003 | Channel not found. Check the channel id. |
| 10004 | Guild not found. Check the guild id. |
| 10008 | Message not found. Check the message id. |
| 50001 | Bot lacks access. Invite + permission. |
| 50013 | Missing permissions for the action. |
| 50035 | Body is malformed. Read the message for specifics. |
| 50083 | Thread is archived. Unarchive before posting. |

## HTTP 429

Discord rate-limits aggressively. The error throws cleanly; check \`X-RateLimit-Reset-After\` for retry timing. Do not hammer.

## Gotchas

- **Emoji in reaction paths must be URL-encoded.** For Unicode, encode the
  full codepoint. For custom emoji, use \`name:id\` literal (the tool
  passes through unchanged; encode yourself or pass already-encoded).
- **Send-message rate limits are per channel.** Five messages per 2.5s
  per channel.
- **Bot tokens are guild-scoped.** A bot has to be invited to each guild
  you want it to operate in.
`

const SLACK_API_REF_NOTE_BODY = `# Slack Web API reference

Endpoint catalog for calling Slack through the \`slack_api\` tool. Read
this BEFORE calling \`slack_api\`.

## Tool shape

\`\`\`
slack_api({
  method?: 'GET' | 'POST',     // default 'POST'
  path: string,                // 'chat.postMessage', etc. Leading '/' or '/api/' stripped.
  body?: Record<string, any>,  // JSON-serialized for POST.
  query?: Record<string, string | number | boolean>,  // for GET, or POST params via URL.
})
\`\`\`

Returns the parsed JSON response. Slack always returns HTTP 200 even on
logical errors; the response \`ok\` field is the source of truth. The tool
inspects it and throws a clean error if \`ok === false\`.

## Auth

Bot token from \`_2200_SLACK_BOT_TOKEN\` (\`xoxb-...\`). The token's scopes
determine what endpoints work.

## Common scopes

- \`chat:write\`, \`chat:write.public\` ... post messages.
- \`channels:read\`, \`groups:read\`, \`im:read\`, \`mpim:read\` ... read channels.
- \`channels:history\`, \`groups:history\`, \`im:history\`, \`mpim:history\` ... read messages.
- \`reactions:write\`, \`reactions:read\` ... add and read reactions.
- \`users:read\` ... look up users.

If you hit \`missing_scope\`, the error message names what's needed.

## Common endpoints

### Messaging

| Path | Method | Body | Notes |
|---|---|---|---|
| \`chat.postMessage\` | POST | \`{ channel, text, thread_ts?, blocks?, attachments? }\` | Post a message. \`channel\` can be a channel id or user id (for DM). |
| \`chat.update\` | POST | \`{ channel, ts, text }\` | Edit a message. |
| \`chat.delete\` | POST | \`{ channel, ts }\` | Delete a message. |
| \`reactions.add\` | POST | \`{ channel, timestamp, name }\` | \`name\` is the emoji shortcode WITHOUT colons (e.g. \`thumbsup\`). |
| \`reactions.remove\` | POST | \`{ channel, timestamp, name }\` | — |

### Channels

| Path | Method | Body / Query | Notes |
|---|---|---|---|
| \`conversations.list\` | GET or POST | query: \`types\` (\`public_channel,private_channel,mpim,im\`), \`limit\` (1-1000), \`exclude_archived\` (bool) | List channels. |
| \`conversations.info\` | GET | query: \`channel\` | Channel metadata. |
| \`conversations.history\` | GET | query: \`channel\`, \`limit\` (1-200), \`oldest\`, \`latest\` | Messages in a channel. |
| \`conversations.replies\` | GET | query: \`channel\`, \`ts\`, \`limit\` | Messages in a thread. \`ts\` is the parent message timestamp. |
| \`conversations.members\` | GET | query: \`channel\`, \`limit\` | Members of a channel. |
| \`conversations.join\` | POST | \`{ channel }\` | Bot joins the channel (required before posting in many configs). |

### Users

| Path | Method | Query | Notes |
|---|---|---|---|
| \`users.info\` | GET | \`user\` | Profile of a user by id. |
| \`users.list\` | GET | \`limit\`, \`cursor\` | Workspace user directory (paginated). |
| \`users.lookupByEmail\` | GET | \`email\` | Find a user by email. |

## Timestamps

Slack message timestamps look like \`1715290000.000100\`. They are
strings, not numbers. Use them as opaque cursors when paginating.

## Channel id prefixes

- \`C...\` ... public channel.
- \`G...\` ... private channel.
- \`D...\` ... direct message.
- \`U...\` or \`W...\` ... user id.

## Error codes worth knowing

| \`error\` | Meaning |
|---|---|
| \`channel_not_found\` | Check the channel id; bot may not be invited. |
| \`not_in_channel\` | Bot needs to be a member; call \`conversations.join\` or have someone invite it. |
| \`is_archived\` | Unarchive before posting. |
| \`msg_too_long\` | 40000 chars max. |
| \`rate_limited\` | Slack rate-limit; retry after the indicated delay. |
| \`missing_scope\` | Bot OAuth is missing \`needed\`; \`provided\` is what's available. Update + re-install. |
| \`invalid_auth\` / \`not_authed\` / \`token_revoked\` / \`token_expired\` | Token problem; regenerate in Slack app config. |

## Gotchas

- **Bot must join the channel before posting** in many workspace configs.
  Call \`conversations.join\` first if you get \`not_in_channel\`.
- **\`thread_ts\` is the parent's \`ts\`, not the reply's \`ts\`.** Threading
  off a reply (rather than the root) creates a flat sub-thread.
- **\`reactions.add.name\` excludes colons.** Use \`thumbsup\`, not \`:thumbsup:\`.
- **Reactions are bot-scoped.** Each bot can react once per emoji per message; calling \`reactions.add\` a second time errors \`already_reacted\`.
`

interface SeedSpec {
  slug: string
  title: string
  body: string
  type: string
  tags: readonly string[]
}

const SEEDS: readonly SeedSpec[] = [
  {
    slug: PLATFORM_SLUG,
    title: '2200 platform overview',
    body: PLATFORM_NOTE_BODY,
    type: 'platform',
    tags: ['platform', 'orientation'],
  },
  {
    slug: TOOLS_SLUG,
    title: 'Tool reference',
    body: TOOLS_NOTE_BODY,
    type: 'reference',
    tags: ['platform', 'tools', 'orientation'],
  },
  {
    slug: CONVENTIONS_SLUG,
    title: 'Conventions',
    body: CONVENTIONS_NOTE_BODY,
    type: 'conventions',
    tags: ['platform', 'conventions', 'orientation'],
  },
  {
    slug: WORKFLOWS_SLUG,
    title: 'Workflows',
    body: WORKFLOWS_NOTE_BODY,
    type: 'workflows',
    tags: ['platform', 'workflows', 'orientation'],
  },
  {
    slug: SECRETS_SLUG,
    title: 'Secrets & provisioning',
    body: SECRETS_NOTE_BODY,
    type: 'reference',
    tags: ['platform', 'secrets', 'provisioning', 'oauth', 'vault'],
  },
  {
    slug: SPOTIFY_API_REF_SLUG,
    title: 'Spotify Web API reference',
    body: SPOTIFY_API_REF_NOTE_BODY,
    type: 'reference',
    tags: ['platform', 'spotify', 'api', 'reference'],
  },
  {
    slug: DISCORD_API_REF_SLUG,
    title: 'Discord REST API reference',
    body: DISCORD_API_REF_NOTE_BODY,
    type: 'reference',
    tags: ['platform', 'discord', 'api', 'reference'],
  },
  {
    slug: SLACK_API_REF_SLUG,
    title: 'Slack Web API reference',
    body: SLACK_API_REF_NOTE_BODY,
    type: 'reference',
    tags: ['platform', 'slack', 'api', 'reference'],
  },
]

export interface SeedStarterPackResult {
  /** Slugs that were written for the first time. */
  added: string[]
  /** Slugs that were skipped because they already existed (force=false only). */
  skipped: string[]
  /** Slugs that were overwritten with current seed text (force=true only). */
  overwritten: string[]
}

/**
 * Seed the starter pack into the shared brain.
 *
 * Default behavior (force=false): each note is written only if absent;
 * existing notes (operator-edited or otherwise) are left untouched.
 * Idempotent on re-run. This is the right default for supervisor boot
 * so operator-customized seeds don't get clobbered.
 *
 * Force mode (force=true): every seed slug is overwritten with the
 * current canonical text. Used by `2200 brain reseed --force` when
 * seed-note text has been updated in code and the operator wants the
 * live shared brain to match. Operator-customized seeds will be lost;
 * the operator opts into this by passing --force.
 */
export async function seedStarterPack(
  home: string,
  opts: { force?: boolean } = {},
): Promise<SeedStarterPackResult> {
  const force = opts.force ?? false
  const { store, index } = await getOrOpenSharedBrain(home)
  const existing = await store.list({ limit: 1000 })
  const have = new Set(existing.map((n) => n.slug))

  const added: string[] = []
  const skipped: string[] = []
  const overwritten: string[] = []
  for (const seed of SEEDS) {
    const isPresent = have.has(seed.slug)
    if (isPresent && !force) {
      skipped.push(seed.slug)
      continue
    }
    const result = await store.write({
      title: seed.title,
      body: seed.body,
      slug: seed.slug,
      type: seed.type,
      tags: [...seed.tags],
    })
    const note = await store.read(result.slug)
    index.upsert(note)
    if (isPresent) overwritten.push(seed.slug)
    else added.push(seed.slug)
  }
  return { added, skipped, overwritten }
}

/**
 * Regenerate the team note in the shared brain from the supervisor's
 * current snapshot. Always overwrites; the team note is a pure
 * derivation of state.
 */
export async function regenerateTeamNote(home: string, supervisor: Supervisor): Promise<void> {
  const snap = supervisor.snapshot()
  const agents = Object.values(snap.agents).sort((a, b) =>
    a.identity_path.localeCompare(b.identity_path),
  )

  const lines: string[] = [
    `# Team`,
    ``,
    `Snapshot of the Agents on this 2200 instance, regenerated whenever the`,
    `fleet changes. Each stanza names one Agent and its current state. The`,
    `Identity file (\`<home>/agents/<name>/identity.md\`) is the source of`,
    `truth for what each Agent does day-to-day; this note is the index.`,
    ``,
    `The operator's profile lives at \`<home>/user.md\`.`,
    ``,
    `Total Agents: ${String(agents.length)}`,
    ``,
  ]

  for (const a of agents) {
    lines.push(`## ${a.name}`)
    lines.push(``)
    lines.push(`- State: \`${a.state}\``)
    lines.push(`- Identity: \`${a.identity_path}\``)
    if (a.pid !== null) lines.push(`- PID: \`${String(a.pid)}\``)
    lines.push(``)
    lines.push(
      `Read their Identity for the full role description: \`fs_read /agents/${a.name}/identity.md\` ... or, if they have granted permission, \`brain_search_agent('${a.name}', '<query>')\` to look at what they've been writing about.`,
    )
    lines.push(``)
  }

  if (agents.length === 0) {
    lines.push(`*(No Agents yet. The first one to spawn will appear here.)*`)
    lines.push(``)
  }

  const { store, index } = await getOrOpenSharedBrain(home)
  const result = await store.write({
    title: 'Team',
    body: lines.join('\n'),
    slug: TEAM_SLUG,
    type: 'team-roster',
    tags: ['team', 'orientation'],
  })
  const note = await store.read(result.slug)
  index.upsert(note)
}

/**
 * Build the body for a freshly-spawned Agent's first task.
 *
 * Per the 2026-05-12 v1 scope, every new Agent's onboarding sequence is:
 *   1. Confirm shared brain access (reads)
 *   2. Write to its own brain to validate the tool surface
 *   3. Walk into the Studio and introduce itself to peers
 *   4. Report ready to the operator via chat_send
 *
 * The task body below drives all four in order. Step 3 (Studio
 * introduction) is what makes the new Agent socially visible to the
 * fleet, not just technically registered. The other Agents see who
 * arrived, what their lane is, and can address them immediately.
 */
export function buildOrientationTaskBody(args: {
  agentName: string
  agentRole: string
  operatorAddressing: string
}): string {
  return `Welcome. You were just spawned. Before doing anything else, take a
moment to orient yourself and arrive properly.

This task has four phases. Run them in order. Do not skip the
Studio introduction in phase 3 ... your peers learn you exist from
that post, not from the task store.

## Phase 1 ... read the shared brain (orientation)

1. \`brain_read_shared { slug: '2200-platform' }\` ... what 2200 is,
   what role you play, how you wake up.
2. \`brain_read_shared { slug: '2200-tools' }\` ... every baseline
   tool with when-to-use guidance. Skim; you'll return to it.
3. \`brain_read_shared { slug: '2200-conventions' }\` ... style,
   punctuation, addressing peers, reactions vs replies, and the
   "reaching the operator" rule. Internalize.
4. \`brain_read_shared { slug: '2200-workflows' }\` ... common task
   shapes (chat reply, pub mention, scheduled fire, error
   handling). Recognize what kind of wake you're in.
5. \`brain_read_shared { slug: 'team' }\` ... live snapshot of who
   else is on this instance. Note who you might collaborate with
   on your lane.
6. \`brain_read { slug: 'continuity-from-onboarding' }\` ... the
   conversation that brought you into existence. Your spec from
   ${args.operatorAddressing}.

## Phase 2 ... write to your own brain (prove the tool surface)

7. \`brain_write\` a fresh note with slug \`intro-snapshot\`. Body:
   a short first-impressions log written for your future self. Two
   to four sentences each on:
   - Who you are and your lane (one-liner from your continuity note).
   - Who you might collaborate with and on what.
   - Your first concrete move on the lane.
   This is not throwaway; it is the seed of your operational memory.

## Phase 3 ... walk into the Studio (introduce yourself)

8. \`pub_send { pub_name: 'studio', content: '<intro> }\` ... your
   debut in the room. The shape:
   - Open with "Hi team," and your name + lane in one sentence.
   - Acknowledge one or two peers whose lanes overlap with yours,
     tagged with \`@<handle>\` so they wake.
   - Close with one concrete thing you're picking up first.
   Keep it under 4 sentences. Do not tag everyone; pick the
   peers from the team note whose work intersects yours.

## Phase 4 ... report ready to the operator

9. \`chat_send\` to ${args.operatorAddressing} with a short brief.
   Four lines:
   - What 2200 is (one sentence, your own words).
   - Who is on the team and who you'll work with.
   - First move on your lane (${args.agentRole}). Concrete, not
     aspirational.
   - "I've introduced myself in the Studio and written my
     intro-snapshot brain note. Ready when you are."

End the task after \`chat_send\` returns. Do not continue working
on the lane until ${args.operatorAddressing} replies. The
operator's reply is your green light.`
}
