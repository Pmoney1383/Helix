# Hosted ChatGPT / Claude access

A normal hosted ChatGPT or Claude chat can ask the PC for status and run small **safe** commands through the same MCP
tool implementation Helix uses locally. It uses its own scope, `pc.hosted`, and its own credential.

## What a hosted chat can do

| Allowed | Never (refused, nothing runs) |
|---|---|
| All observe tools: PC/GPU status, processes, services, `read_file`, `tail_file`, `list_directory`, git status/log, training status, agent sessions, `send_user_message` | Deleting anything, writing files, redirecting output into a file |
| `run_safe_command`: one short, single-line PowerShell command that passes the safety rules | Installs, `git push/commit/...`, network fetches, starting/stopping processes or services, registry/system changes, other interpreters, encoded or dynamic commands |
| `list_apps`, `open_app`: launch a Start-menu app by name ("Xbox", "Discord", "Calculator"); the name is matched against the installed list in code and never reaches a shell | Opening shells and admin tools (PowerShell, cmd, Terminal, Registry Editor, Task Manager, Services, ...) or anything not in the Start menu |
| `search_agent_sessions`, `read_agent_session`, `send_agent_message`: find any Claude/Codex session on the PC, read how it is going, and send it a message as if you typed it (returns at once; read the reply with `read_agent_session`). **Every message waits for your approval on the phone**: the gateway asks, showing the full text and the target session, and delivers only once you approve (the model cannot skip or answer this). Approving with "trust for 30 min / 2 h / 8 h" (`trustForMin`) lets that one chat message that one session without asking until then; see "Trusting a chat with a session" below. A session open in a terminal gets the message directly in that same session (its own Claude reads it at the next tool round, or starts a turn if idle), with no fork; for a bypass-permissions terminal your approval also covers the terminal's own hold (the message is marked as approved). Sessions not open anywhere are resumed. A session over ~150k tokens, or one whose cache went cold, is refused until the user confirms (`confirmHeavy`); that check happens before you are asked | Messaging a session that is mid-task, or the General Claude itself. Delivering anything without your approval or a live trust grant. The agent still asks you on your phone before anything destructive. Messages are labelled as sent from a hosted chat and audited |
| `notify_user`: push a notification to your phone ("training finished", "your build failed"). `info` stays in the app, `important` pushes; `critical` is capped at a push and never rings. At most 10 per connector per 10 minutes | Ringing the phone, approval requests |
| `close_app`: ask an open app to close (the same as clicking its X, so unsaved-work prompts still appear) | Force-killing anything. Never closed: shells and terminals, editors that host agent sessions (Cursor, VS Code, ...), system processes, the Helix gateway, Tailscale, `node`, `claude`, `codex`. Lists live in `src/mcp/app-tools.ts` |
| | Reading credentials: `.env`, keys (`.p8`, `.pem`, `.ssh`), tokens, `~/.helix`, Helix's data folder and database, environment secrets |

**Why the app tools use a desktop helper.** The gateway is a Windows *service*, which runs in session 0 with no
desktop: an app it launched would open on a screen nobody sees, and it could not see or close your windows. So
`open_app`/`close_app` hand a small job to `hooks/desktop-runner.ps1`, which runs inside your logged-in session through
a one-shot scheduled task (created and removed per call, as you, no admin needed, hidden console). It only works while
you are logged in to Windows; otherwise the tool says the helper did not answer. The helper re-checks that an app id is
one Windows lists before launching it. `HELIX_DESKTOP_BRIDGE=task` forces this path when testing from a normal terminal.

"Safe" is decided in `src/permissions/hosted-safety.ts`: the destructive/opaque classifier first, then extra hosted-only
rules. Hosted commands get **no approval prompts**; a refusal explains why and the chat is told to ask you to do it from
the Helix app. Every call (and every refusal) is audited. To widen what is allowed, edit that one file and its tests.
The one exception is `send_agent_message`, which always asks you first (below).

## Trusting a chat with a session

A message from a hosted chat makes an agent act as if you typed it, and the chat itself can be steered by whatever it
reads (a web page, a file it was shown). So the gateway asks you about every such message; it does not depend on the
model asking. To save the taps during real back-and-forth work, approve with trust:

- **On the phone:** `POST /v1/approvals/:id/approve {"trustForMin": 30 | 120 | 480}` on an approval that has a `trust`
  field (only hosted chat messages offer it). That chat may then message that one session without asking until the time
  runs out (8 hours at most). A different chat, or a different session, still asks. The Android app shows
  **Approve & trust** buttons for these.
- **On the PC:** `npm run hosted -- trust <approval-id> [--min 120]` does the same from an approval the chat already asked
  for. `npm run hosted -- trust list`, `trust revoke <grant-id>`, `trust revoke --all`.
- `GET /v1/trust-grants` lists live grants and `DELETE /v1/trust-grants/:id` ends one. Revoking a chat's credentials
  (`npm run hosted -- revoke`) ends its grants too. A replayed approval never creates a grant.

## Credentials

```powershell
cd pc-gateway
npm run hosted -- create --name chatgpt --days 30   # prints the connector URL once
npm run hosted -- list
npm run hosted -- revoke <id>                        # or: revoke --all
```

The URL form `https://<host>/mcp/t/<token>` is for connectors that only accept a URL; `Authorization: Bearer <token>`
on `/mcp` works too. Tokens expire (default 30 days) and are stored hashed. Treat the URL like a password.

## Reaching the PC from the internet (Tailscale Funnel)

Hosted chats cannot join your tailnet, so `/mcp` is published with Funnel. Use **port 443**: ChatGPT's connector
setup was not seen to reach the PC on 8443 at all, and many hosted fetchers only call 443.
Funnel works per port, so turning it on for 443 makes everything on that port public, including the private
Serve `/` that the iPhone uses. That is safe only because the gateway answers 404 to anything from the internet
other than the three paths below (tested, see the safeguards). If you ever must undo it: `tailscale funnel --https=443 off`.

```powershell
tailscale funnel --bg --https=443 --set-path=/mcp http://127.0.0.1:7777/mcp
tailscale funnel --bg --https=443 --set-path=/oauth http://127.0.0.1:7777/oauth
tailscale funnel --bg --https=443 --set-path=/.well-known http://127.0.0.1:7777/.well-known
tailscale funnel status
```

Your tailnet policy must allow Funnel for this device (admin console, Access controls: `nodeAttrs` with `funnel`).
Set `HELIX_PUBLIC_URL=https://<pc>.<tailnet>.ts.net` in `pc-gateway/.env` so `npm run hosted -- create` prints
a ready URL. Stop sharing any time with `tailscale funnel --https=443 off`, or `npm run hosted -- revoke --all`.

**Watchdog (automatic).** When `HELIX_PUBLIC_URL` is set, the gateway checks every 2 minutes (first check 45 s after start) that
the public address really answers (`/.well-known/oauth-protected-resource/mcp`, a full trip through the internet). If it does not,
it finds out why (Tailscale stopped or offline, Funnel off, a path missing), puts the three Funnel paths above back when they are
what is missing (at most once per 10 minutes), and sends an `important` push if it is still down after two checks: "ChatGPT / claude.ai
cannot reach your PC" with the reason, repeated every 6 hours at most, and another push when it is back. A repair that worked sends
only an in-app `info` message. It never touches anything else. Turn it off with `HELIX_FUNNEL_WATCHDOG=false`; `HELIX_TAILSCALE_BIN`
overrides the `tailscale` path (default `C:\Program Files\Tailscale\tailscale.exe`). The phone app is not affected by a Funnel outage.

Safeguards that do not depend on the funnel being configured correctly:

- Requests that arrive through Funnel (Tailscale marks them) can reach **only `/mcp`, `/oauth/*` and `/.well-known/*`**; every other path returns 404. (In Git Bash set `MSYS_NO_PATHCONV=1` before the funnel commands, or `/oauth` is rewritten into a Windows path.)
- Through Funnel only `pc.hosted` credentials are accepted. Device tokens and local agent tokens are refused.
- Repeated bad credentials from the internet are rate limited (429).

## OAuth (what ChatGPT and Claude actually use)

Both apps expect OAuth for custom connectors, so Helix is its own small OAuth 2.1 server (discovery, dynamic client
registration, PKCE S256, refresh tokens). Add the connector with just the server URL and **no token**:

```
https://<pc>.<tailnet>.ts.net/mcp
```

1. The app discovers sign-in from the `401` on `/mcp` and opens the Helix consent page.
2. On the PC run `npm run hosted -- code`. It prints a one-time code (valid 10 minutes, one use).
3. Type that code on the consent page and press Approve. Only someone who can read the PC's terminal can approve, so a stranger who finds the URL cannot connect.
4. The app gets a 1-hour access token plus a rotating refresh token (60 days) and renews silently. The scope is still only `pc.hosted`.

Cut everything off with `npm run hosted -- revoke --all` (access and refresh tokens). Wrong codes are rate limited, and
after 10 wrong codes in 10 minutes approval is locked for everyone until they age out.

The static URL/bearer tokens above still work for tools that do not need OAuth. Never paste them into screenshots.

## Connecting the apps

- **ChatGPT**: Settings, Developer mode, add an MCP connector, paste `.../mcp`, choose OAuth. Custom MCP connectors depend on your ChatGPT plan; check that yours includes developer mode.
- **Claude (claude.ai)**: Settings, Connectors, Add custom connector, paste `.../mcp`, then sign in.

You don't need the phone app for any of this. A future app screen could approve connectors from the phone instead of
typing a code.
