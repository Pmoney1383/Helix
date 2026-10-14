# Helix PC gateway

Always-on process that owns agent sessions and talks to the phone: SQLite state, device pairing and auth, an HTTP + WebSocket API, the Claude Code and Codex providers, MCP tools with scope profiles, an audit log, the destructive-action approval gate, status watchers, push notifications and calls. Installing it: [docs/SETUP.md](../docs/SETUP.md).

## Run

```
npm install
copy .env.example .env      # then edit
npm run dev                 # or: npm run build && npm start
npm test
```

## Try it without a phone

```
npm run pair                                   # prints a one-time code (5 min)
npm run client -- pair <CODE>
npm run client -- new "my session" --project C:\path\to\repo
npm run client -- chat <sessionId> "hello"     # streams the reply
npm run client -- sessions
```
Restart the gateway and `chat` again: the session resumes by its stored Claude session ID. To adopt a session started in a terminal: `npm run client -- import <claude-session-uuid> "title" --project <that cwd>`.

## Reaching it from the phone (Tailscale)

The gateway binds to `127.0.0.1` only. Expose it to your tailnet with TLS (iOS needs HTTPS):

```
tailscale serve --bg 7777
tailscale serve status     # shows https://<pc>.<tailnet>.ts.net
```
Do not use `tailscale funnel` (that is public internet). Install Tailscale on the iPhone, sign in to the same account, and the app talks to that `https://...ts.net` URL. Pair by running `npm run pair` on the PC and entering the code in the app.

## API

All routes except `/health` and `/v1/pair/complete` need `Authorization: Bearer <device token>`.

| | |
|---|---|
| `GET /health` | liveness |
| `POST /v1/pair/complete` | `{code, deviceName, platform?}` -> `{deviceId, token}` (rate limited, code is single use) |
| `GET /v1/sessions` | list |
| `POST /v1/sessions` | `{title, projectPath?, provider?, providerSessionId?}`; `providerSessionId` imports an existing session |
| `GET /v1/sessions/:id` | one session |
| `POST /v1/sessions/:id/resume` | confirms session exists (resume is implicit on next message) |
| `POST /v1/sessions/:id/message` | `{text}` -> 202; output arrives on the WebSocket. 409 if mid-turn |
| `POST /v1/sessions/:id/interrupt` | kills the running turn |
| `GET /v1/conversations/:id/messages?after=<seq>&limit=` | history, for sync after reconnect |
| `WS /v1/ws` | server pushes events; client sends `{type:"send",sessionId,text}`, `{type:"interrupt",sessionId}`, `{type:"ping"}` |

WebSocket events: `session.state`, `message.created`, `agent.output.delta`, `agent.output.final`, `agent.tool`, plus `hello`, `send.accepted`, `error`, `pong`.

## Approval gate

Normal actions run without asking. Deleting or other irreversible actions pause until you approve on the phone.

- Each Claude turn gets a short-lived token and an MCP connection back to the gateway (`/mcp`, loopback, `Authorization: Bearer hxa_...`). Claude runs with `--permission-prompt-tool mcp__helix__permission_prompt`, so every action Claude would normally ask permission for is sent to the gateway.
- `permissions/classifier.ts` decides: deletion verbs (`rm`, `del`, `Remove-Item`, ...) including inside `cmd /c` / `bash -c` wrappers, interpreter APIs (`os.remove`, `fs.rmSync`, ...), `git clean` / `reset --hard` / force-push, SQL `DROP`/`DELETE`, disk formatting, docker/registry/service removal, tools *named* like delete/remove/purge/wipe, and commands it cannot inspect (encoded PowerShell, download piped to a shell).
- A destructive action creates an approval (`approval.requested` over the WebSocket and a message in the conversation) and blocks. `GET /v1/approvals?status=pending`, then `POST /v1/approvals/:id/approve|reject` (optional `{note}`). An approval with a `trust` field (a hosted chat messaging an agent) may be approved with `{trustForMin}` (1-480) to trust that chat with that session for a while; `GET /v1/trust-grants`, `DELETE /v1/trust-grants/:id` (see `docs/HOSTED.md`).
- Fails closed: reject, expiry (`HELIX_APPROVAL_TTL_MIN`, default 30), interrupt, or a gateway restart all mean "not approved". An approval resolves once; replaying or flipping a settled one changes nothing.
- The MCP control tools (`run_command`, ...) apply the same policy internally, so a hosted ChatGPT/Claude client gets the same protection.

MCP scopes: `pc.observe` (read-only PC status, GPU, processes, files, logs, git, training status), `pc.control` (+ `run_command`, `write_file`, `stop_process`), `pc.agent.full` (+ `request_user_approval`, `permission_prompt`; only issued to the agents the gateway spawns). Phone device tokens are not MCP credentials.

**Known limits** (also see the classifier header):
- Pattern matching cannot be complete. Indirect deletion is the main gap: an agent can write a script that deletes files (allowed, writing is a normal action) and then run `python script.py` (looks harmless). Keep backups of anything irreplaceable (checkpoints!) and treat this as a strong guardrail, not a sandbox.
- Overwriting a file with `write_file`/`Write` is not gated.
- Without Apple push configured, approvals reach the phone over the WebSocket only, so the app has to be connected to see them.

## Status watchers

Cheap deterministic checks on timers. They watch *anything*: your own jobs, a build an agent started, a Claude or Codex task, a service, a repo. No model is involved unless a watch is explicitly told to wake an agent.

| type | fires when |
|---|---|
| `process` | a pid/name stops running (or, with `expect: "stopped"`, when it finishes: quiet while it runs, loud when it ends) |
| `log` | a regex matches a *new* line (per-pattern severity), or the log goes quiet (`staleAfterSec`) |
| `file` | exists / missing / modified / stale |
| `command` | a non-destructive PowerShell check stops matching its expected exit code / output |
| `http` | a URL fails `failAfter` times in a row |
| `gpu` | too hot, VRAM nearly full, or idle for a while (stalled run) |
| `git` | HEAD moves (a commit) or the branch changes |
| `session` | **any gateway agent session** (Claude now, Codex later): task finished, failed, silent for too long, or an approval has waited too long |

- **Zero setup for agent work:** a default "Agent tasks" session watch is created on first start. Any agent task that runs 2+ minutes tells you when it finishes (with the result), fails, stalls, or waits on an approval. Edit or delete it like any watch.
- **One call for a job:** `POST /v1/watches/job` (or the `watch_job` MCP tool, which agents can call themselves) expands `{name, profile, pid?, processName?, logPath?}` into process + log (+ GPU) watches. Profiles (`generic`, `training`, `build`, `tests`, `deploy`, `download`) only tune default patterns; `errorPatterns` / `donePatterns` extend them.
- **Edge-triggered, not chatty:** a condition fires when it *becomes* true and again (info) when it recovers. Identical log lines collapse for 5 min, floods are capped (critical lines always get through), and a watch that cannot run says so once after 3 failures.
- **Survives restarts:** log offsets and "already reported" state are stored in SQLite, so a restart neither repeats old alerts nor misses lines written while the gateway was down.
- **Wake an agent (optional):** `wake: {sessionId, instruction?, cooldownMin}` hands important events to that session so it can investigate (that is the only thing that spends tokens; once per cooldown, skipped if the session is busy). The wake prompt arrives as a user-side message starting `[Helix watcher ...]`; the app should render it as system-triggered.
- **Safety:** `command` watches run unattended, so destructive or opaque commands are refused at creation. Regexes are compiled and bounded at creation.

API: `GET/POST /v1/watches`, `POST /v1/watches/job`, `PATCH/DELETE /v1/watches/:id`, `GET /v1/watches/:id/events`, `POST /v1/watches/:id/check`. WebSocket: `watch.triggered`, `watch.resolved`. MCP: `create_status_watch`, `watch_job`, `remove_status_watch` (control), `list_status_watches` (observe).

### Severity and escalation
`info` -> in-app message only. `important` -> message + push. `critical` -> message + push + call. A given problem rings at most once per 15 min, and at most 3 calls/hour overall. Without Apple push configured ([docs/PUSH-SETUP.md](../docs/PUSH-SETUP.md)), push and call are recorded as `unavailable` in the `notifications` table and everything still lands in the app.

## Every session on this machine, and awareness everywhere

Helix does not only know about sessions it started. It reads the transcripts Claude Code and Codex already write, so a session started in a terminal, an IDE or the Codex app is visible, and (for Claude) can be continued from the phone.

**See everything.** `GET /v1/agent-sessions` (filters: `provider`, `live`, `q`, `project`, `limit`), `/:provider/:id`, `/:provider/:id/transcript?before=&limit=` (newest page first), `POST /rescan`. Claude sessions come from `~/.claude/projects/*/*.jsonl`, with live busy/idle status from `~/.claude/sessions/<pid>.json`. Codex sessions come from `~/.codex/sessions/**/rollout-*.jsonl` and `session_index.jsonl` (titles); Codex liveness is inferred from recent transcript activity and flagged `liveInferred`. These file formats belong to the tools and are not a stable API: parsers are defensive, so a format change degrades metadata rather than hiding sessions. `npm run sessions` prints the index.

**Continue any of them.** `POST /v1/agent-sessions/claude/:id/adopt {mode: "auto"|"resume"|"fork"}`. `resume` continues the same conversation and is refused (409) while a terminal has it open, because two processes writing one transcript would corrupt it. `fork` branches into a new session and leaves the original untouched (`--resume X --fork-session --session-id NEW`). `auto` forks if it is open elsewhere, otherwise resumes. Codex sessions are adopted the same way (see Codex below).

**Awareness without being told.** `npm run helix -- connect` (dry run first with `--dry-run`; undo with `disconnect`; `status` to check) links every *new* Claude Code / Codex session on this PC to Helix:

| piece | what it does | needs the model to cooperate? |
|---|---|---|
| user-level MCP server `helix` | `watch_job`, `create_status_watch`, `notify_user`, `request_user_approval` in every session (limited `pc.agent.local` scope: no shell, no file writes) | yes (it decides to call them) |
| `~/.claude/CLAUDE.md` + `~/.codex/AGENTS.md` block | tells agents Helix exists and when to use it | yes |
| `Stop` / `Notification` hooks | a turn ended / Claude needs you, reported straight to the gateway | **no** |
| live-status tracking | busy to idle = finished (with the final reply), vanished while busy = died, busy but silent = stalled | **no** |
| `Agent processes` watch | long jobs an agent started (training, builds, downloads) are reported when they end | **no** |
| `PreToolUse` hook | while you are away, a destructive command in any terminal session waits for approval from your phone | **no** |
| desktop idle helper (Startup item) | tells Helix whether you are at the PC | n/a |

`connect` edits files in your home folder, backs the originals up to `data/backups/` first, merges rather than overwrites, and refuses to touch a `settings.json` it cannot parse. Sessions that are already open must be restarted to pick it up.

**Presence.** `GET/PUT /v1/presence {mode: "auto"|"away"|"home"}`. In `auto`, you count as away after `HELIX_PRESENCE_AWAY_MIN` (default 5) minutes without keyboard or mouse input. When you are at the PC, calls are suppressed but pushes (including approval requests) are still sent, and everything lands in the app; the gate above stays out of the way. If the idle helper is not running, Helix cannot know and assumes you are away. The helper exists because the gateway is a Windows service and cannot see your input.

**Terminal permission gate.** Claude Code sessions started with `--dangerously-skip-permissions` have nothing between the model and `rm`. While you are away, the `PreToolUse` hook (shell and MCP tools only) sends destructive commands through the same classifier and approval flow as Helix's own sessions, and returns allow/deny to Claude. It fails open: if Helix is down the agent proceeds, because Helix must never be the reason work is blocked. The same limits as the classifier apply (see below).

**Known limits.** Sessions open before `connect` need a restart. Ending-of-job detection for processes needs them to be descendants of an agent and gives no exit code; pair with `watch_job` when success vs failure matters. Codex gets awareness (instructions, MCP, transcript-based status) but not control or the permission gate yet.

## General Claude: one conversation, handed to the right session

"Call Claude" should not need you to name a session. A **route** is one phone conversation. It starts at a hidden *router* session (the General Claude) and, once the router works out what you mean, the **same conversation is pointed at that session**: no new call, no new chat. Only who answers changes.

- The router is a Claude process with **no built-in tools at all** (`--tools ""`, only Helix's MCP server, scope `pc.router`). It can search sessions, read a short summary of one, list projects, start or resume a session, and hand the conversation over. It cannot run commands or touch files. Its prompt (`src/router/prompt.ts`) keeps replies to a sentence or two (it is spoken aloud), tells it to ask one short question when two sessions plausibly match, and never to do the task itself.
- `handoff_current_conversation(session | projectPath, message)` adopts the target (resume, or fork if it is open in a terminal, or a fresh session for a project), delivers `message` (the user's request, in their voice) to it immediately, and flips the route. The target's replies stream to the same socket. A busy target is not interrupted: the router is told and the route stays put.
- API: `POST /v1/routes`, `POST /v1/routes/:id/message` (goes to whoever is current), `/interrupt`, `/reset` (back to the General Claude), `/handoff` (a manual pick from the app), `GET /v1/routes/:id/messages` (one merged history across every session the chat visited). WebSocket: `{type:"route.send", routeId, text}`; the phone is told with `route.handoff {toTitle, mode}`.
- Finding things: `GET /v1/search/sessions?q=` (every word must match title, project or recent text; live sessions first), `GET /v1/projects`. **Aliases** (`PUT /v1/aliases/:name {sessionKey|projectPath}`) name favourites for Siri, CarPlay and the router ("cat training"), case-insensitive.
- Router sessions are plumbing: hidden from `/v1/sessions` and from the machine-wide index.
- The in-call part (speaking, barge-in, CallKit) lives in the phone app; this is the gateway half it plugs into.

## Handoffs connect silently

A handoff delivers `message` to the target only when it is real work for that session. A message that is just a request to be connected ("connect me to the helix agent", "put me through to Astra") is for the router: it is dropped by a deterministic guard (`router/routing-only.ts`, conservative: anything that also asks for something is delivered), and the router's prompt and tool description tell it to leave `message` out in that case. The target then stays silent until the user's own next message. The router tool result reports `messageNotDelivered`; the HTTP handoff returns `messageDelivered` and `routingMessageDropped`.

## Codex

Codex sessions are first-class: create them (`POST /v1/sessions {provider:"codex", projectPath}`), message them, interrupt them, adopt ones that already exist (`/v1/agent-sessions/codex/:id/adopt`, resume or fork), and let the General Claude start or hand a conversation to one (`provider:"codex"`). They are ordinary Codex threads stored in `~/.codex`, so they also appear in the Codex app.

- **How:** the gateway owns one private `codex app-server --stdio` child (JSON-RPC, newline-delimited; the protocol schema comes from `codex app-server generate-json-schema`) shared by every Codex session, routed by thread id, restarted automatically if it dies. It is separate from the Codex desktop app's own daemon. If `codex` is not installed the provider is simply not offered (`HELIX_CODEX_BIN`, `HELIX_CODEX_ENABLED`).
- **Approvals use the same gate as Claude.** Threads start with `approvalPolicy: untrusted`, so Codex asks about anything not known-safe, and every request (`item/commandExecution/requestApproval`, file changes, permission widening, MCP tool calls) is answered by Helix's policy: normal actions are accepted instantly, destructive ones (`rm`, `Remove-Item`, deleting patches, delete-named MCP tools, ...) wait for your phone. A rejection reaches Codex as a decline and it reports that back. Verified live on a real Codex: reject keeps the file; approve deletes it.
- **Helix tools inside Codex.** Helix-run Codex sessions get the `helix` MCP server from your Codex config (set up by `helix connect`); the token is a static `http_headers` entry in `~/.codex/config.toml` (an environment variable never reached editors and apps that were already open, so their Codex failed with "HELIX_AGENT_TOKEN ... is not set"). Older setups that still use `HELIX_AGENT_TOKEN` get it from the gateway (`codex-env.ts`). A real Codex session calling `list_status_watches` was verified.
- **Sandbox trade-off (your call).** Default `HELIX_CODEX_SANDBOX=workspace-write` keeps Codex confined to the project, which is also the backstop for destructive actions Codex does not ask about. The catch: that sandbox can block a deletion even after you approve it, and Codex then has to retry with escalated permission (a second approval). In testing `rm`, `Remove-Item`, `cmd del` and `node -e unlinkSync` all completed after approval, but not every time on the first attempt. `HELIX_CODEX_SANDBOX=danger-full-access` makes "approve" mean "done" (one approval, deleted) at the cost of that containment; the Helix gate and Codex's `untrusted` policy then carry the safety, as they do for Claude. `HELIX_CODEX_APPROVAL` can be `on-request`/`never` but those make Codex ask less, which weakens the gate.
- **Astra (the Codex front door).** `POST /v1/routes {provider:"codex"}` (or `POST /v1/calls/start {provider:"codex"}` for "Call Astra") opens a router backed by Codex instead of Claude, with the identical route API, handoff (to either kind of session), voice flag and history; routes report `frontDoor`. The Codex thread is configured at creation with its own MCP entry `helix_router` (a router-scoped credential naming that session, kept for the life of the gateway process, re-issued when the thread is loaded again after a restart), the router prompt as developer instructions, and a read-only sandbox whatever the gateway default is. Codex cannot be started without its built-in shell and editor, so the guarantee that it only routes is enforced by the gateway: every approval request except a call to `helix_router` is declined without prompting anyone. Verified live with real Codex: it introduces itself, refuses shell/file/patch requests (no tool even starts), searches, hands the conversation to a new session with the message delivered, and keeps its memory and tools across a gateway restart.
- **Limits.** A question Codex asks the user (`item/tool/requestUserInput`, or an MCP form) cannot be answered from the phone yet: Helix says so in the reply and cancels rather than inventing an answer. Codex sessions run in a *terminal* are watched (finished / stalled alerts from their transcripts) but not gated, because the permission hook only exists for Claude Code.

## Push notifications and calls

Tested against a mock Apple server; the preflight below talks to Apple's real servers. Each user brings their own key: [docs/PUSH-SETUP.md](../docs/PUSH-SETUP.md). The app contract is [docs/CALLS.md](../docs/CALLS.md).

- **Apple push client** (`notifications/apns.ts`): HTTP/2 with an ES256 JWT signed from your `.p8` key (cached 40 min, Apple rejects tokens over an hour old). Alerts retry on 429/5xx; calls never retry (a late ring is worse than none) and always use `apns-expiration: 0`. Dead tokens (410, `BadDeviceToken`, ...) are marked invalid and never used again.
- **Registering the phone:** `PUT /v1/devices/me/push-token` for an `alert` token and a PushKit `voip` token (with `sandbox`/`production`). `GET /v1/devices`, `DELETE /v1/devices/:id` (revoke a lost phone), `GET /v1/push/status`, `POST /v1/push/test`. An Android phone registers nothing: while its app holds the WebSocket open it gets `device.notification` events and `call.ringing`, and `GET /v1/push/status` counts it in `androidConnected` (see docs/CALLS.md).
- **The alert policy is now real:** `important` = message + push, `critical` = message + push + a call. The push is never gated by presence; the call is (at the PC: nothing rings), and it also follows the 15-minute per-problem ring cooldown and 3 calls/hour. Pushes carry only a short preview; the detail stays on the PC.
- **Calls** (`calls/call-manager.ts`): `ringing` then `answered` / `declined` / `missed`. First device to answer wins. Unanswered after `HELIX_RING_TIMEOUT_SEC` (30) becomes a missed call and a normal push says so. A call whose approval gets answered from the app while it rings ends quietly. Ringing calls do not survive a restart. Outgoing: `POST /v1/calls/start`.
- **Approvals reach you wherever you are:** every approval request pushes at once; if unanswered after `HELIX_APPROVAL_CALL_AFTER_MIN` (5, 0 = never) the phone rings. On an approval call the *phone* interprets "approve"/"reject" by keywords and posts `POST /v1/calls/:id/decision`. A language model deliberately does not: anything an agent writes could otherwise try to talk its way into an approval.
- **Call wording** (`calls/composer.ts`) is deterministic: "Claude needs your approval to run the command rm -rf checkpoints, in atlas. Say approve to allow it, or reject to stop it." For event calls the router gets the context alongside the user's first reply, so it does not repeat what the phone already said.
- **Preflight without a phone:** `npm run push -- check` verifies the settings, that the `.p8` is a usable EC P-256 key outside any git repo, that Apple's push servers are reachable from this PC, and then asks Apple's real servers (sandbox and production, alerts and calls) whether they accept the key, team and bundle id, using a fake device token (Apple answers `BadDeviceToken` exactly when the rest is right; `InvalidProviderToken` or `TopicDisallowed` otherwise). Verified against real Apple: reachable from this PC, and a throwaway key is rejected with `InvalidProviderToken` and a clear explanation. The success path needs your real credentials.
- **Rehearsing calls:** `POST /v1/calls/simulate {severity, title?, summary?, approval?}` rings the phone through the real VoIP path with a critical or approval scenario (the approval is real but labelled "Test only, nothing will run"; nothing is left pending if delivery fails), rate limited to 6/min. For testing PushKit and the call flow end to end.
- **Configuration** (`.env`): `HELIX_APNS_KEY_PATH`, `HELIX_APNS_KEY_ID`, `HELIX_APNS_TEAM_ID`, `HELIX_APNS_BUNDLE_ID` (all four, or push stays off), plus `HELIX_RING_TIMEOUT_SEC` and `HELIX_APPROVAL_CALL_AFTER_MIN`. Keep the `.p8` outside the repo.

## Voice personality

How Helix *sounds* when it speaks. Wording only: it never changes what is decided, which tools run, or whether information is accurate. (*The speaking itself, speech recognition and barge-in are the iPhone's half.)

- **Settings:** `GET/PUT /v1/persona`: `enabled`, `mode` (`professional | casual | playful | flirty | unhinged`, default `professional`; [docs/PERSONA.md](../docs/PERSONA.md)), sliders `teasing`, `flirtiness`, `sarcasm`, `verbosity` (0..1), and `speech {rate, pitch, voiceId}` (stored for the app, unused by the gateway). Switching mode applies that mode's preset sliders unless you also send sliders. `POST /v1/persona/preview {mode?, sliders?, severity?}` returns the exact instruction and a sample greeting without saving. `GET` also returns `effective`, how each severity is clamped, for a settings screen.
- **The safety clamp** (`persona/clamp.ts`): the more serious the moment, the less character. `info/normal` full; `warning` ×0.35 with flirting at ×0.4 of the slider, at most playful or flirty; `high` ×0.1, no flirting, at most casual; `critical` and `approval` zero character, professional tone, terse. Flirting is off from `high` upward at every slider value (nothing serious flirts). Turned off, replies are still spoken-style with no personality.
- **Spoken replies:** send a message with `voice: true` (and optionally `voiceSeverity`) on `POST /v1/sessions/:id/message`, `POST /v1/routes/:id/message`, or the WebSocket `send` / `route.send`. The gateway adds a style instruction to that one turn (Claude: appended to the system prompt; Codex: a marked note ahead of the message): short plain sentences, no markdown/lists/code/emoji, no reading out URLs, exact facts, length from `verbosity`, tone from the clamped sliders, and a severity-specific directive ("urgent: no jokes, lead with what is wrong, then the impact, then the decision needed"). Typed messages are untouched.
- **A call stays serious for its whole length:** answering a `critical` call sets the route's voice severity, so every reply on it is clamped, whatever the setting. The app can override per message with `voiceSeverity`.
- **Lines Helix writes itself** (`persona/lines.ts`, plain text you can edit): the greeting when you call Helix (`script` of an outgoing call, in your mode: "Oh wow, you called me voluntarily. I'm touched. What do you need?"), and a light opener on routine call scripts. Critical calls and approvals are **never** flavoured: their wording is deterministic and model-free, so that guarantee is absolute.
- **The PC voice, off until needed (bring your own model):** `tts/helix_tts_server.py` is a child process the gateway starts only when a spoken turn sends `engine: "pc"` (or on `POST /v1/voice/tts/warm`, or when a call rings), only if `HELIX_TTS_ENABLED=true`, only if enough GPU memory and RAM are free (so it never competes with other GPU work), and stops itself after `HELIX_TTS_IDLE_SEC` idle (also when the gateway dies or closes, and on shutdown). Each spoken sentence becomes `agent.audio` events (raw PCM, in order); if it cannot speak the phone gets one `agent.audio.unavailable` and uses Apple's voice. `GET/POST /v1/voice/tts/*`, `POST /v1/voice/speak`, and pre-recorded canned lines at `/v1/voice/clips`. No model or voice ships with Helix; tests use the server's fake engine (no GPU). See [docs/LOCAL-TTS.md](../docs/LOCAL-TTS.md).
- **Pet names and Astra:** `petNames` (persona setting, default gorgeous, handsome, babe, sweetheart, darling, trouble) are what the flirty mode picks from, and the canned lines rotate through them; no comma is ever left before a pet name in spoken text (it made the voice pause). The Codex front door is named **Astra** (`Call Astra`).
- **Flirty mode and the filler:** `flirty` is a fifth mode (preset teasing 0.6, flirtiness 0.85), adjustable with the sliders, and it colours the agent's *answers* in conversation, not just greetings. The safety clamp now keeps a light touch (flirtiness x0.4) for an event that needs attention (`warning`), none from `high` upward, and no persona at all for critical alerts and approvals. `GET /v1/voice/filler?severity=` returns the line to say while the agent thinks ("Mmm... let me check."; the plain "One moment." when serious). The optional PC-side voice is documented in [docs/LOCAL-TTS.md](../docs/LOCAL-TTS.md).
- **Speech-ready streaming** (`voice/speech.ts`): for a `voice: true` turn the gateway also emits `agent.speech` events, one complete cleaned sentence each (markdown, links, long paths, emoji and code blocks removed; never splits decimals, file names or abbreviations; a tool call ends the sentence in progress), plus `spoken` on `agent.output.final`. The phone speaks sentences as they arrive instead of waiting for the whole reply, and no longer needs to strip markdown itself. No speech events after an interrupt. Typed messages are unchanged.
- **`GET /v1/voice/hints`** (names for the recognizer's `contextualStrings`: aliases, projects as written and as spoken, session and watch titles, plus Helix/Claude/Codex/approve/reject) and **`GET /v1/digest`** (an instant, model-free spoken status: approvals waiting, watches firing or failing, what is working or open; "All quiet." otherwise). The digest speaks in the user's persona through the same severity dial: quiet or busy = full character, a watch firing or failing = a light touch (held to "playful"), an approval waiting = none; the facts never change, `kind` says which it was, and `?plain=true` forces neutral wording.
- **Honest limit:** for model-written replies the clamp shapes the *instruction*; the model almost always complies (verified live on the most extreme setting: goofy when all is well, plain and direct on a crash, exact on an approval), but it is not a filter on the output. The app should still strip stray markdown/emoji before text-to-speech.

## Hosted ChatGPT / Claude access

A hosted chat gets its own `pc.hosted` credential: all read-only observe tools plus `run_safe_command` (a short single-line PowerShell command, only if marked safe) and `open_app` / `close_app` / `list_apps` (Start-menu apps by name; polite close only; shells, editors hosting agents and system processes are protected). `run_safe_command` runs a short single-line PowerShell command only if it is marked safe (nothing that deletes, writes, installs, touches the network, services, settings or credentials; refusals say why and run nothing). Credentials, `.env`, keys and Helix's own data are unreadable to it. `npm run hosted -- create|list|revoke` manages expiring tokens; the endpoint is `/mcp` (bearer) or `/mcp/t/<token>` (URL-only connectors). Through Tailscale Funnel only `/mcp` is reachable and only `pc.hosted` tokens work. ChatGPT and Claude sign in with OAuth 2.1 (PKCE): you approve a connector with a one-time code from `npm run hosted -- code`. Setup and the full allow/deny table: [docs/HOSTED.md](../docs/HOSTED.md). The phone app is not involved.

## Design notes

- **Per-turn processes.** Each message runs `claude -p --resume <id>` and exits; there is no long-lived Claude process. This makes "resume a stopped session" the normal path and survives gateway restarts. Cost: about 3 s startup per turn. If that hurts voice calls, switch the provider to a persistent `--input-format stream-json` process behind the same interface.
- **Provider interface** collapsed to `createSession()` + `send()` with an `AbortSignal` for interrupt (see `providers/provider.ts`).
- **Permissions.** `bypassPermissions` is intentionally not selectable. Claude runs in its normal permission mode and every prompt is answered by the approval gate above.
- **Auth.** Pairing issues a random bearer token (stored hashed). Pairing codes are created only by the local `npm run pair` CLI; there is no network endpoint to mint one. Optional device-key request signing (`HELIX_REQUIRE_DEVICE_SIGNING`, `api/device-signing.ts`) adds a per-request signature from a key held on the phone (Secure Enclave or Android Keystore); see [../docs/DEVICE-SIGNING.md](../docs/DEVICE-SIGNING.md).
- **Messages** carry a monotonic `seq` so clients can sync with `?after=`.

## Desktop computer use (opt-in)

Screenshot/image MCP results, mouse/keyboard tools, dual-monitor coordinates, and a click-through Helix gold edge aura
are available behind an explicit per-credential/connector grant. See [desktop setup, tools, lifecycle and verification](docs/COMPUTER-USE.md).
Run `npm run desktop -- list`, then `npm run desktop -- enable <client-or-token-id>` after deploying. Existing connectors do
not gain desktop access automatically. Physical mouse/keyboard input or Ctrl+Alt+Shift+F12 stops control.

## Windows service

```
npm run build
powershell -ExecutionPolicy Bypass -File service\install.ps1   # UAC prompt, then enter .\<your user> and password
```
The script downloads WinSW v2.12.0 to `service/helix-gateway.exe` if it is missing (SHA-256 verified), writes `service/helix-gateway.xml` from `helix-gateway.xml.template` with your paths, grants your account "Log on as a service", installs and starts the service, and checks `/health`. Logs go to `data/logs`. After code changes: `powershell -ExecutionPolicy Bypass -File service\update.ps1` (rebuilds and restarts, asks for admin).
