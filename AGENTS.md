# AGENTS.md: Helix

Read this first if you are an AI agent (Claude Code, Codex, Cursor, ...) working in this repo.

## What Helix is

Helix lets a developer follow and steer the Claude Code and Codex sessions on their Windows PC from an iPhone (and CarPlay):
chat, push notifications, approvals, calls, Siri, status watchers, and an optional voice persona. An always-on gateway on
the PC does the work; the phone talks to it over Tailscale.

```
iPhone / CarPlay  --HTTPS + WebSocket (Tailscale)-->  PC gateway (Windows service)  -->  Claude Code / Codex sessions
ChatGPT / claude.ai  --hosted MCP (Tailscale Funnel, OAuth)-->  same gateway   (optional)
```

Rule zero: **normal agent actions are allowed automatically; deletions and other irreversible actions need the
user's approval** (on the phone when they are away).

## Repo layout

| Path | What |
|---|---|
| `pc-gateway/` | The gateway: Node 24 (tested; `engines` says `>=22`), TypeScript (ESM), Fastify, better-sqlite3, MCP SDK, zod. Runs on Windows. |
| `ios/` | The SwiftUI app (`ios/Helix/`), Siri extension, token generator (`ios/scripts/`). Built on a Mac. |
| `mods/usage-guard/` | Claude Code mod: live context size and 5-hour usage left above the prompt. |
| `design/` | `home-screen.png` and `tokens.json` (black/gold palette, the source of the Swift colour tokens). |
| `docs/` | Setup and design docs (see below). |

### Docs

- `docs/SETUP.md`: full install. `docs/PUSH-SETUP.md`: bring-your-own APNs key.
- `docs/CALLS.md`: the **contract** for push, PushKit, calls and spoken replies between gateway and app.
- `docs/PERSONA.md`, `docs/LOCAL-TTS.md`, `docs/HOSTED.md`, `docs/CARPLAY.md`, `docs/DESIGN.md`.
- `pc-gateway/README.md`: gateway internals and the full REST/WebSocket/MCP API.

## The gateway (`pc-gateway/src/`)

| Folder | Role |
|---|---|
| `app.ts`, `index.ts`, `config.ts` | Wiring (`buildGateway`), entry point, env config (every setting is in `.env.example`). |
| `api/` | REST (`http.ts`), WebSocket (`websocket.ts`), device auth and optional request signing. |
| `providers/` | `claude.ts` (`claude -p --resume` per turn), `codex.ts` (`codex app-server --stdio` JSON-RPC), `fake.ts` for tests. |
| `sessions/` | Registry, `manager.ts` (send, heavy-session guard), `adopt.ts` (adopt/resume/fork sessions found on disk). |
| `discovery/` | Indexes every Claude/Codex session on the machine, live status, `peer.ts` (message a terminal session through its inbox pipe). |
| `router/` | The front doors: "General Claude" and "Astra" (Codex) route a conversation to the right session. |
| `permissions/` | Destructive-action `classifier.ts`, `approvals.ts`, `policy.ts`, `hosted-safety.ts`. |
| `mcp/` | MCP server and tools, `scopes.ts` (`pc.observe`, `pc.control`, `pc.agent.full`, `pc.agent.local`, `pc.router`, `pc.hosted`), `desktop.ts` (hop into the user's desktop session). |
| `monitoring/` | Generic status watchers (`watch_job`, job presets), agent process tracking, Funnel watchdog. |
| `notifications/` | APNs push, presence (auto/away/home), escalation (push, then call), approval escalator. |
| `calls/` | Call lifecycle and scripts. |
| `oauth/` | Own OAuth 2.1 server for hosted connectors (DCR, PKCE, rotating refresh). |
| `persona/`, `voice/` | Persona modes and the safety clamp, speech streaming, on-demand local TTS (`tts/helix_tts_server.py`). |
| `computer/` | Opt-in desktop control for hosted chats and the live desktop viewer. |
| `usage/` | Token usage store, transcript context-size reading (aware of `/compact`). |
| `connect/` | `npm run helix -- connect`: wires new Claude/Codex sessions to Helix (MCP server, CLAUDE.md/AGENTS.md block, hooks). |
| `cli/` | `pair`, `client`, `sessions`, `helix`, `hosted`, `push`, `voice`, `desktop`, `proctree`. |
| `storage/` | SQLite + migrations. |
| `hooks/` (outside src) | `helix-hook.mjs` (Claude hooks), `desktop-runner.ps1`, `presence-agent.ps1`. |
| `service/` (outside src) | WinSW service template and `install.ps1` / `update.ps1`. |

### Commands (run in `pc-gateway/`)

```
npm install
npm run typecheck
npm test                # node --test via tsx, 700+ tests, about 20 seconds
npm run build && npm start
npm run pair            # one-time pairing code for the phone
npm run hosted -- code  # one-time code to approve a ChatGPT/claude.ai connector
npm run helix -- connect|disconnect|status
npm run push -- check   # check APNs credentials against Apple
```

## Rules for agents

1. **Approval:** normal work is auto-allowed. Before anything irreversible (deleting data, force-push, dropping tables), ask.
2. **Watchers stay generic.** They cover any job (builds, tests, downloads, training), not one kind of work.
3. **Prefer automatic over manual** in anything you design for the user.
4. **Hooks never disturb a session:** silent, exit 0, fail open. Helix being down must never block work.
5. **The local TTS service starts only when needed** and stops itself when idle. Never leave it running, and never
   commit models, weights or voice recordings.
6. **Nothing personal in the repo.** No real names, hostnames, tailnet names, Team IDs, bundle IDs or user paths in code,
   docs or tests. Use `com.example.helix`, `my-pc.my-tailnet.ts.net`, `C:\Users\alice\...`.
7. **Long jobs:** if Helix is connected in your session, call `watch_job` right after starting anything over about 2 minutes.

### Git

- Small, focused commits, with typecheck and tests passing. Sign the CLA on your first pull request (`CONTRIBUTING.md`).
- Never commit secrets: `.env`, `.p8`/`.pem`/`.key`, tokens, provisioning files, `data/`, databases,
  `ios/Config/Helix.local.xcconfig`.

### Windows gotchas

- Git Bash mangles `/path` arguments (for example `tailscale serve --set-path /mcp`): use PowerShell or `MSYS_NO_PATHCONV=1`.
- Shell heredocs and `node -e` mangle backslashes: write code with backslashes (pipe names, Windows paths, PowerShell)
  through file-writing tools.
- The service has no desktop (session 0). Anything that must happen on the user's screen goes through
  `src/mcp/desktop.ts` and `hooks/desktop-runner.ps1`.
- Never run two `npm test` runs at once (they starve each other and look like hangs). Never kill processes with a broad
  pattern that could match your own shell.
- Windows can't delete a temp dir while SQLite or a child process still holds it: close gateways in tests.
- Code that is serialised into a web page (`fn.toString()`) runs through esbuild under tsx, which adds `__name(...)` calls
  and rewrites literals (`120_000` becomes `12e4`). Define a no-op `__name` in the page and don't assert on literal spelling.

## Key design decisions (don't undo without discussion)

- The gateway, not Claude Code, is the always-on process; it runs `claude -p --resume` per turn.
- Text over WebSocket is the live transport; voice is text-to-speech on top.
- Approvals go through `--permission-prompt-tool` to the gateway's MCP plus the pattern classifier, and fail closed.
  Spoken approvals are interpreted by the phone with keywords, never by an LLM.
- Live terminal sessions are never interleaved by a Helix turn: a message goes into the terminal's own inbox (with phone
  approval if it runs in bypass mode) or the session is forked.
- Heavy-session guard: messages to a session over about 150k tokens with a cold cache are refused until confirmed
  (`HELIX_HEAVY_SESSION_TOKENS`, `HELIX_CACHE_COLD_SEC`).
- Hosted chats get no approval prompts: unsafe things are simply refused (`hosted-safety.ts`), and credentials are never readable.
- Persona: professional by default. Other modes (casual, playful, flirty, unhinged) apply only to Helix's own front doors,
  never flirty in a work session. Critical alerts and approvals have zero character. On a live call every reply is two or
  three short sentences, enforced by the gateway.
- Bring-your-own credentials: push needs the user's own APNs key and app build; no shared keys or relays.
