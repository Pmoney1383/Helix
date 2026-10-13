# Helix

Follow and steer your **Claude Code** and **Codex** sessions from your phone while you are away from your PC.

Helix is a small always-on gateway that runs on your Windows PC, plus an iPhone app (with CarPlay and Siri) that
talks to it over your private Tailscale network. Your agents keep running on your own machine with your own
logins. Helix lets you chat with them, get pinged when something finishes or breaks, and approve or reject anything
destructive from your phone.

```
iPhone / CarPlay  --HTTPS + WebSocket (Tailscale)-->  PC gateway (Windows service)  -->  Claude Code / Codex sessions
ChatGPT / claude.ai  --hosted MCP (Tailscale Funnel, OAuth)-->  same gateway   (optional)
```

![Home screen design](design/home-screen.png)

## What it does

- **Every session on your PC, from your phone.** Helix indexes the Claude Code and Codex sessions already on the
  machine (terminal, IDE, desktop app) and shows which are busy. It can continue any of them, fork one, or start a new one.
- **Chat and voice.** Text chat over WebSocket, plus phone calls through CallKit: "Call Claude" or "Hey Siri, call Astra".
  A front-door router finds the session you mean and hands the conversation to it.
- **Approvals with one rule.** Normal agent actions run automatically. Deletions and other irreversible actions
  (`rm`, `git reset --hard`, force-push, `DROP TABLE`, ...) pause until you approve on the phone. Approvals fail closed.
  Spoken approvals are matched by keywords on the phone and never interpreted by a model.
- **Watchers.** Cheap, deterministic status checks for any job: processes, logs, files, HTTP, GPU, git and agent
  sessions. Agents can set them up themselves with `watch_job`.
- **Push and calls when you are away.** Presence detection keeps your phone quiet while you are at the PC. Important
  events push; critical ones and long-waiting approvals ring your phone.
- **Hosted access (optional).** Add Helix as a custom connector in ChatGPT or claude.ai to check on your PC from
  anywhere. A strict safe-command policy applies, and credentials are never readable.
- **Optional extras.** A local PC voice (bring your own TTS model), desktop control for hosted chats (opt-in), and
  a Claude Code mod that shows context size and usage left.

## Requirements

| | |
|---|---|
| PC | Windows 10/11, Node.js 24 (tested; 22 is the declared minimum), [Claude Code](https://claude.com/claude-code) logged in; [Codex CLI](https://github.com/openai/codex) optional |
| Network | [Tailscale](https://tailscale.com) on the PC and the phone (the same tailnet) |
| Phone | iPhone on iOS 26+, built yourself from `ios/` with Xcode on a Mac |
| Push and calls | A paid Apple Developer account and your own APNs key ([docs/PUSH-SETUP.md](docs/PUSH-SETUP.md)) |

Without an APNs key, everything still works in the app over the live connection, but you get no push notifications or
incoming calls. An Android app is planned.

## Quick start

```powershell
git clone https://github.com/Pmoney1383/Helix.git
cd Helix\pc-gateway
npm install
copy .env.example .env          # review it; the defaults work for a first run
npm run build
npm test                        # optional, about 20 seconds

# Run it as a Windows service (asks for admin, downloads WinSW, prompts for your Windows account)
powershell -ExecutionPolicy Bypass -File service\install.ps1

# Make it reachable from your phone over Tailscale (HTTPS, tailnet only)
tailscale serve --bg 7777

# Tell new Claude Code / Codex sessions about Helix (MCP server, hooks, instructions); --dry-run first if you like
npm run helix -- connect

# Pair the phone: prints a one-time code to enter in the app
npm run pair
```

Then build the iPhone app ([ios/README.md](ios/README.md)), enter your `https://<pc>.<tailnet>.ts.net` address and
the code, and you are connected. The full walkthrough is [docs/SETUP.md](docs/SETUP.md).

## Documentation

| Doc | What |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Full setup: gateway, service, Tailscale, connecting agents, pairing, updating |
| [ios/README.md](ios/README.md) | Building the iPhone app with your own team and bundle ID |
| [docs/PUSH-SETUP.md](docs/PUSH-SETUP.md) | Push notifications and calls: your own APNs key, step by step |
| [docs/PERSONA.md](docs/PERSONA.md) | Voice personality modes (professional by default) and the safety clamp |
| [docs/LOCAL-TTS.md](docs/LOCAL-TTS.md) | Optional local PC voice: how to plug in your own TTS model |
| [docs/HOSTED.md](docs/HOSTED.md) | ChatGPT / claude.ai access through Tailscale Funnel and OAuth |
| [docs/DEVICE-SIGNING.md](docs/DEVICE-SIGNING.md) | Device-key request signing: enrollment, `HELIX_REQUIRE_DEVICE_SIGNING`, recovery |
| [docs/CARPLAY.md](docs/CARPLAY.md) | CarPlay (needs an entitlement Apple grants per developer) |
| [docs/CALLS.md](docs/CALLS.md) | The push, call and voice contract between gateway and app |
| [pc-gateway/README.md](pc-gateway/README.md) | Gateway internals and the full REST / WebSocket / MCP API |
| [pc-gateway/docs/COMPUTER-USE.md](pc-gateway/docs/COMPUTER-USE.md) | Opt-in desktop control for hosted chats |
| [docs/DESIGN.md](docs/DESIGN.md) | App look and feel |
| [mods/usage-guard](mods/usage-guard/README.md) | Claude Code mod: context size and 5-hour usage above the prompt |
| [AGENTS.md](AGENTS.md) | For AI agents working on this repo |

## Security model, briefly

- The gateway listens on `127.0.0.1` only. Your phone reaches it through `tailscale serve`, which is TLS and tailnet-only.
- Phones pair with a one-time code that only the PC's terminal can create, and get a revocable bearer token.
  The app also signs every request with a key kept in the phone's Secure Enclave, and the gateway can require it
  ([docs/DEVICE-SIGNING.md](docs/DEVICE-SIGNING.md)).
- The destructive-action classifier is a strong guardrail, not a sandbox. Pattern matching cannot catch everything
  (for example, an agent writing a script that deletes files and then running it). Keep backups of anything irreplaceable.
- Hosted access is off unless you set it up, and uses its own narrow scope (`pc.hosted`).

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Status

Helix is a personal project that became open source. The gateway is well tested (700+ tests) and used daily. The
iPhone app works but is still in progress. Windows is the only supported PC platform for now; macOS and Linux
gateways are on the list.

## License

[GNU AGPL-3.0](LICENSE). Contributions need a one-click CLA ([CONTRIBUTING.md](CONTRIBUTING.md)).
The name "Helix" and the logo are not covered by the license.

Helix is not affiliated with Anthropic, OpenAI or Apple. Claude, Codex, ChatGPT, iPhone, CarPlay and Siri are
trademarks of their respective owners.
