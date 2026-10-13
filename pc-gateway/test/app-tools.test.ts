import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedToOpen, isProtectedProcess, resolveApp, resolveWindows, type StartApp, type WindowedProcess } from "../src/mcp/app-tools.js";
import { scopeAllows } from "../src/mcp/scopes.js";

const apps: StartApp[] = [
  { name: "Xbox", appId: "Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App" },
  { name: "Xbox Game Bar", appId: "Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App" },
  { name: "Discord", appId: "com.squirrel.Discord.Discord" },
  { name: "Calculator", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "Windows PowerShell", appId: "{1AC14E77}\WindowsPowerShell\v1.0\powershell.exe" },
  { name: "Command Prompt", appId: "{1AC14E77}\cmd.exe" },
];

describe("resolveApp", () => {
  it("an exact name wins over longer names that contain it", () => {
    const r = resolveApp(apps, "xbox");
    assert.ok(r.ok && r.match.name === "Xbox");
  });
  it("a unique partial match works, case-insensitively", () => {
    const r = resolveApp(apps, "CALC");
    assert.ok(r.ok && r.match.name === "Calculator");
  });
  it("ambiguous names ask which one", () => {
    const r = resolveApp(apps, "x");
    assert.ok(!r.ok && r.candidates && r.candidates.length > 1);
  });
  it("unknown names say so and offer near matches", () => {
    const r = resolveApp(apps, "disc app");
    assert.ok(!r.ok && /no app named/.test(r.reason));
  });
  it("never treats caller text as anything but a search string", () => {
    const r = resolveApp(apps, "calc; Remove-Item C:\ -Recurse");
    assert.ok(!r.ok);
  });
});

describe("what may be opened", () => {
  for (const [name, appId] of [["Windows PowerShell", ""], ["Command Prompt", ""], ["Windows Terminal", ""], ["Registry Editor", ""], ["Task Manager", ""], ["Anything", "{X}\cmd.exe"]]) {
    it(`refuses ${name} ${appId}`, () => assert.equal(isBlockedToOpen(name!, appId), true));
  }
  for (const name of ["Xbox", "Discord", "Calculator", "Spotify", "Google Chrome"]) {
    it(`allows ${name}`, () => assert.equal(isBlockedToOpen(name), false));
  }
});

describe("what may be closed", () => {
  const procs: WindowedProcess[] = [
    { id: 1, processName: "XboxPcAppFT", title: "Xbox" },
    { id: 2, processName: "Discord", title: "Royal Room - Discord" },
    { id: 3, processName: "chrome", title: "Connect Claude - Google Chrome" },
    { id: 4, processName: "chrome", title: "Gmail - Google Chrome" },
    { id: 5, processName: "powershell", title: "Administrator: Windows PowerShell" },
    { id: 6, processName: "Cursor", title: ".env - Helix - Cursor" },
    { id: 7, processName: "explorer", title: "" },
    { id: 8, processName: "node", title: "helix" },
  ];
  it("finds an app by process name or window title", () => {
    const r = resolveWindows(procs, "xbox");
    assert.ok(r.ok && r.match[0]!.id === 1);
    const d = resolveWindows(procs, "royal room");
    assert.ok(d.ok && d.match[0]!.processName === "Discord");
  });
  it("closes every window of one app together", () => {
    const r = resolveWindows(procs, "chrome");
    assert.ok(r.ok && r.match.length === 2);
  });
  for (const q of ["powershell", "cursor", "explorer", "node"]) {
    it(`protects ${q}`, () => {
      const r = resolveWindows(procs, q);
      assert.ok(!r.ok && /protected/.test(r.reason));
    });
  }
  it("protects shells, editors, system, Helix and Tailscale by process name", () => {
    for (const n of ["powershell", "cmd", "WindowsTerminal", "Cursor", "code", "svchost", "node", "claude", "codex", "tailscaled", "helix-gateway"]) assert.equal(isProtectedProcess(n), true, n);
    for (const n of ["chrome", "Discord", "Spotify", "XboxPcAppFT"]) assert.equal(isProtectedProcess(n), false, n);
  });
  it("asks when a query means several different apps", () => {
    const r = resolveWindows(procs, "o");
    assert.ok(!r.ok);
  });
  it("says so when nothing matches", () => {
    const r = resolveWindows(procs, "photoshop");
    assert.ok(!r.ok && /no open window/.test(r.reason));
  });
});

describe("scopes", () => {
  it("hosted and control scopes get the app tools; the router and local agents do not", () => {
    for (const t of ["list_apps", "open_app", "close_app"] as const) {
      assert.equal(scopeAllows("pc.hosted", t), true);
      assert.equal(scopeAllows("pc.control", t), true);
      assert.equal(scopeAllows("pc.observe", t), false);
      assert.equal(scopeAllows("pc.router", t), false);
      assert.equal(scopeAllows("pc.agent.local", t), false);
    }
  });
});

describe("modern (UWP) apps share ApplicationFrameHost", () => {
  const procs: WindowedProcess[] = [
    { id: 10, processName: "ApplicationFrameHost", title: "Calculator" },
    { id: 10, processName: "ApplicationFrameHost", title: "Settings" },
    { id: 11, processName: "Discord", title: "Discord" },
  ];
  it("identifies them by window title, so Calculator does not also mean Settings", () => {
    const r = resolveWindows(procs, "calculator");
    assert.ok(r.ok && r.match.length === 1 && r.match[0]!.title === "Calculator");
  });
  it("asks when a query would hit two different frame-hosted windows", () => {
    const r = resolveWindows(procs, "s");
    assert.ok(!r.ok);
  });
});

describe("desktop bridge (real PowerShell)", () => {
  it("lists the windows on the desktop in both the direct and scheduled-task modes, and cleans up after itself", async () => {
    const { desktop } = await import("../src/mcp/desktop.js");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helix-desktop-"));
    try {
      for (const mode of [undefined, "task"]) {
        if (mode) process.env.HELIX_DESKTOP_BRIDGE = mode; else delete process.env.HELIX_DESKTOP_BRIDGE;
        const r = await desktop({ op: "windows" }, { dataDir: dir });
        assert.equal(r.ok, true, `${mode ?? "direct"}: ${r.error}`);
        assert.ok(Array.isArray(r.windows));
        assert.deepEqual(fs.readdirSync(path.join(dir, "desktop")), [], "job and result files are removed");
      }
      const bad = await desktop({ op: "open", appId: "definitely-not-a-start-menu-app" }, { dataDir: dir });
      assert.equal(bad.ok, false, "the helper refuses ids Windows does not list");
    } finally {
      delete process.env.HELIX_DESKTOP_BRIDGE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
