// Minimal terminal client standing in for the phone (Phase 1 success criterion).
//
//   npm run client -- pair <CODE> [--url http://127.0.0.1:7777]
//   npm run client -- sessions
//   npm run client -- new "title" [--project C:\path]
//   npm run client -- chat <sessionId> "message"
//   npm run client -- import <providerSessionId> "title" [--project C:\path]
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const stateFile = path.resolve("data", "client.json");
interface State { url: string; token: string }

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const urlFlag = flag("url");
const project = flag("project");
const [cmd, ...rest] = argv;

const loadState = (): State => {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")) as State; }
  catch { throw new Error("not paired: run `npm run client -- pair <CODE>` first"); }
};

async function api(state: State, method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(state.url + p, {
    method,
    headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function chat(state: State, sessionId: string, text: string): Promise<void> {
  const wsUrl = state.url.replace(/^http/, "ws") + "/v1/ws";
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${state.token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)));
  });

  await new Promise<void>((resolve, reject) => {
    ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.sessionId && ev.sessionId !== sessionId) return;
      switch (ev.type) {
        case "agent.output.delta": process.stdout.write(ev.text); break;
        case "agent.tool": process.stdout.write(`\n[tool: ${ev.name}]\n`); break;
        case "agent.output.final": process.stdout.write("\n"); resolve(); break;
        case "message.created":
          if (ev.message.sender === "system") { console.log(`\n[${ev.message.severity}] ${ev.message.text}`); }
          break;
        case "session.state":
          if (ev.session.id === sessionId && ev.session.status === "error") reject(new Error("session error"));
          if (ev.session.id === sessionId && ev.session.status === "idle" && ev.session.turnCount > 0) {
            setTimeout(resolve, 50);
          }
          break;
        case "error": reject(new Error(`${ev.status ?? ""} ${ev.error}`)); break;
      }
    });
    ws.send(JSON.stringify({ type: "send", sessionId, text }));
  });
  ws.close();
}

try {
  if (cmd === "pair") {
    const [code] = rest;
    if (!code) throw new Error("usage: pair <CODE> [--url ...]");
    const url = urlFlag ?? "http://127.0.0.1:7777";
    const res = await fetch(`${url}/v1/pair/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "test-client", platform: "terminal" }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ url, token: json.token }, null, 2));
    console.log(`paired as device ${json.deviceId}`);
  } else if (cmd === "sessions") {
    const { sessions } = await api(loadState(), "GET", "/v1/sessions");
    for (const s of sessions) console.log(`${s.id}  ${s.status.padEnd(7)} ${s.provider}  ${s.title}  ${s.projectPath ?? ""}`);
    if (!sessions.length) console.log("(no sessions)");
  } else if (cmd === "new") {
    const [title] = rest;
    if (!title) throw new Error('usage: new "title" [--project path]');
    const s = await api(loadState(), "POST", "/v1/sessions", { provider: "claude", title, projectPath: project });
    console.log(s.id);
  } else if (cmd === "import") {
    const [providerSessionId, title] = rest;
    if (!providerSessionId || !title) throw new Error('usage: import <providerSessionId> "title" [--project path]');
    const s = await api(loadState(), "POST", "/v1/sessions", { provider: "claude", title, providerSessionId, projectPath: project });
    console.log(s.id);
  } else if (cmd === "chat") {
    const [sessionId, ...words] = rest;
    if (!sessionId || !words.length) throw new Error('usage: chat <sessionId> "message"');
    await chat(loadState(), sessionId, words.join(" "));
  } else {
    console.log("commands: pair | sessions | new | import | chat   (see header of this file)");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
