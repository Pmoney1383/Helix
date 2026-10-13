# Setting up Helix

This walks through a full install on one Windows PC and one iPhone. Every command runs in `pc-gateway/` unless noted.
The quick version is in the [README](../README.md).

## 1. Prerequisites

- **Windows 10 or 11** with an account you log in to (the gateway runs as a service under *your* user so it can see your
  Claude Code and Codex logins and sessions).
- **Node.js 24** on `PATH` (`node -v`). Helix is developed and tested on 24. `package.json` declares `>=22`, the
  minimum its dependencies need, but 22 is not tested.
- **Claude Code**, installed and logged in (`claude` works in a terminal). Optional: the **Codex CLI** (`codex`).
- **Tailscale** on the PC and the iPhone, signed in to the same tailnet, with
  [HTTPS certificates enabled](https://tailscale.com/kb/1153/enabling-https) for the tailnet (iOS requires HTTPS).
- **A Mac with Xcode** to build the iPhone app. A paid Apple Developer account is needed for push, calls, Siri and
  installing for longer than a week; see [ios/README.md](../ios/README.md).

## 2. Install and configure the gateway

```powershell
cd pc-gateway
npm install
copy .env.example .env
```

Open `.env`. Every setting is documented there, and the defaults are sensible. The ones you may want on day one:

| Setting | Why |
|---|---|
| `HELIX_DEFAULT_PROJECT` | Working folder for new sessions that do not name one |
| `HELIX_CODEX_BIN` | Full path to `codex.exe` if it is not on the service's `PATH` |
| `HELIX_PUBLIC_URL` | Only for hosted ChatGPT / claude.ai access ([HOSTED.md](HOSTED.md)) |
| `HELIX_APNS_*` | Push and calls ([PUSH-SETUP.md](PUSH-SETUP.md)); leave unset to start |

Build, and optionally run the tests:

```powershell
npm run build
npm test
```

To try it in a terminal first: `npm start` (or `npm run dev` to reload on changes), then open
`http://127.0.0.1:7777/health`. Stop it before installing the service.

## 3. Run it as a Windows service

```powershell
powershell -ExecutionPolicy Bypass -File service\install.ps1
```

The script asks for admin (UAC). It then:

1. downloads [WinSW](https://github.com/winsw/winsw) v2.12.0 to `service\helix-gateway.exe`, if it is not there yet,
   and verifies its SHA-256;
2. writes `service\helix-gateway.xml` from the template with your Node and gateway paths;
3. grants your account "Log on as a service";
4. asks for the Windows account to run as (`.\<your user name>`) and its password, which go to Windows only;
5. starts the service and prints `/health`.

Logs are in `data\logs\`. The service starts automatically at boot (delayed start) and restarts itself after a crash.

**Updating** after a `git pull`: `powershell -ExecutionPolicy Bypass -File service\update.ps1` (rebuilds, restarts,
checks `/health`). **Removing**: in an elevated PowerShell, `service\helix-gateway.exe stop` then
`service\helix-gateway.exe uninstall`.

## 4. Make it reachable from your phone

The gateway only listens on `127.0.0.1`. Tailscale Serve puts it on your tailnet with a real TLS certificate:

```powershell
tailscale serve --bg 7777
tailscale serve status        # shows https://<pc>.<tailnet>.ts.net
```

Open `https://<pc>.<tailnet>.ts.net/health` in Safari on the phone (with Tailscale connected). It should answer
`{"ok":true,...}`.

Use `serve`, not `funnel`: Funnel would put the gateway on the public internet. The only Funnel use is the optional
hosted access in [HOSTED.md](HOSTED.md), which exposes three paths and nothing else.

## 5. Connect your agents

```powershell
npm run helix -- connect --dry-run    # shows what it would change
npm run helix -- connect
npm run helix -- status
```

`connect` lists its changes and asks before applying them (`--yes` skips the question). It makes every *new* Claude
Code and Codex session on the PC aware of Helix:

- a user-level `helix` MCP server (`watch_job`, `notify_user`, `request_user_approval`, ...) with a narrow scope;
- a short instruction block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`;
- Claude Code hooks: turn finished, needs input, and a permission gate for destructive commands while you are away
  (silent and fail-open: if Helix is down, nothing is blocked);
- a small desktop idle reporter in your Startup folder, so Helix knows whether you are at the PC.

It backs up every file it touches to `data/backups/` and merges instead of overwriting. Restart sessions that were
already open. Undo everything with `npm run helix -- disconnect`.

## 6. Build the app and pair

Build and install the iPhone app as described in [ios/README.md](../ios/README.md). Then:

1. On the PC: `npm run pair`. It prints a one-time code, valid for 5 minutes.
2. In the app: **Settings > Pair with Your PC**. Enter `https://<pc>.<tailnet>.ts.net` (pre-filled if you set
   `HELIX_GATEWAY_HOST` when building) and the code.

The app gets its own revocable token. `GET /v1/devices` lists paired devices, and `DELETE /v1/devices/:id` revokes a lost phone.

No phone yet? You can drive the gateway from a terminal: `npm run client -- pair <CODE>` (it uses `HELIX_PORT` from
`.env`; `--url` points it elsewhere), then
`npm run client -- new "test" --project C:\path\to\repo` and `npm run client -- chat <sessionId> "hello"`.

## 7. Optional pieces

| | |
|---|---|
| Push notifications and calls | [PUSH-SETUP.md](PUSH-SETUP.md) |
| Personality on calls | [PERSONA.md](PERSONA.md) (professional by default) |
| Local PC voice | [LOCAL-TTS.md](LOCAL-TTS.md) |
| ChatGPT / claude.ai connector | [HOSTED.md](HOSTED.md) |
| Desktop control for hosted chats | [../pc-gateway/docs/COMPUTER-USE.md](../pc-gateway/docs/COMPUTER-USE.md) |
| CarPlay | [CARPLAY.md](CARPLAY.md) |
| Usage guard mod for Claude Code | [../mods/usage-guard/README.md](../mods/usage-guard/README.md) |
| Require signed requests from paired phones | `HELIX_REQUIRE_DEVICE_SIGNING=true` once Settings > Gateway > Request signing shows On ([DEVICE-SIGNING.md](DEVICE-SIGNING.md)) |

## Troubleshooting

- **`/health` does not answer after install:** check `data\logs\helix-gateway.err.log`. The usual causes are a
  missing `.env`, a `dist/` that was never built, or the service account's password.
- **The phone cannot connect:** Tailscale must be on for both devices, and the address must be the `https://...ts.net` one
  from `tailscale serve status`. Plain `http://` or a LAN IP will not work, because iOS requires TLS.
- **Agents don't call Helix tools:** sessions opened before `helix connect` need a restart. `npm run helix -- status` shows what is wired.
- **Phone never rings:** presence. Pushes are sent whether or not you are at the PC, but incoming calls are held back
  while you are at the PC on purpose. Use `PUT /v1/presence {"mode":"away"}` or the app's presence switch to test calls.
  If even pushes never arrive, check `npm run push -- check` and [PUSH-SETUP.md](PUSH-SETUP.md).
- **Codex sessions missing:** set `HELIX_CODEX_BIN` to the full path. The service does not always share your shell's `PATH`.
