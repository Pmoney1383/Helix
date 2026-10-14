import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ComputerController } from "../computer/controller.js";
import type { LiveDesktopViewer } from "../computer/live-viewer.js";
import { registerComputerTools } from "../computer/tools.js";
import { registerViewerProbe, type ViewerProbe } from "../computer/viewer-probe.js";
import { RateLimiter, type AuthService } from "../api/auth.js";
import type { ApprovalService } from "../permissions/approvals.js";
import { classify, describeAction } from "../permissions/classifier.js";
import { buildJobWatches, type JobProfile } from "../monitoring/presets.js";
import type { WatcherManager } from "../monitoring/watcher-manager.js";
import { SeveritySchema, WATCH_TYPES, type WatchType } from "../monitoring/watch-types.js";
import type { Escalation } from "../notifications/escalation.js";
import type { RouterService } from "../router/router.js";
import type { PolicyEngine } from "../permissions/policy.js";
import { GatewayError, type EventBus } from "../sessions/manager.js";
import type { MessageStore, SessionRegistry } from "../sessions/registry.js";
import { hostedCommandVerdict, isProtectedPath } from "../permissions/hosted-safety.js";
import { MAX_TRUST_MINUTES, type TrustGrants } from "../permissions/trust-grants.js";
import * as apps from "./app-tools.js";
import * as pc from "./pc-tools.js";
import { type McpContext, type ToolName, scopeAllows } from "./scopes.js";

export interface McpDeps {
  computer?: ComputerController;
  liveViewer?: LiveDesktopViewer;
  /** Per-call live-desktop cards in chat. Default off: only the Helix Live panel shows the stream. */
  liveViewerCards?: boolean;
  viewerProbe?: ViewerProbe;
  /** Temporary desktop-only approval switch; defaults on for callers not providing it. */
  desktopApprovals?: boolean;
  auth: AuthService;
  policy: PolicyEngine;
  approvals: ApprovalService;
  registry: SessionRegistry;
  messages: MessageStore;
  bus: EventBus;
  watchers: WatcherManager;
  escalation: Escalation;
  router: RouterService;
  /** Helix's own data folder; hosted callers may never read it. */
  dataDir?: string;
  /** Public address of this gateway (HELIX_PUBLIC_URL), used in OAuth discovery. */
  publicUrl?: string;
  /** Owner-granted, time-limited trust for hosted chats messaging agent sessions. */
  trust?: TrustGrants;
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (message: string): Result => ({ content: [{ type: "text", text: message }], isError: true });

/** A hosted chat may push the phone, but not spam it: at most this many pushes per connector per 10 minutes. */
const hostedNotifyLimit = new RateLimiter(10, 10 * 60_000);

/** Builds one MCP server exposing only the tools this context's scope allows. */
export function createMcpServer(ctx: McpContext, deps: McpDeps): McpServer {
  const server = new McpServer({ name: "helix", version: "0.1.0" });
  registerComputerTools(server, ctx, deps);
  registerViewerProbe(server, ctx, deps.viewerProbe, deps.publicUrl);

  /** Registers a tool if the scope allows it; every call is audited and errors become tool errors. */
  function tool<S extends z.ZodRawShape>(
    name: ToolName, description: string, shape: S,
    handler: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<Result> | Result
  ): void {
    if (!scopeAllows(ctx.scope, name)) return;
    const callback = async (args: z.infer<z.ZodObject<S>>, extra: { signal?: AbortSignal }): Promise<Result> => {
      deps.auth.audit(undefined, `mcp.${name}`, { actor: ctx.actor, sessionId: ctx.sessionId, args: summarize(args) });
      try {
        return await handler(args, extra?.signal ?? new AbortController().signal);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };
    // The SDK's generic callback type can't be satisfied through our generic wrapper; the shape is validated by zod.
    server.registerTool(name, { description, inputSchema: shape }, callback as never);
  }

  /** Hosted callers cannot reach credentials or Helix's own state, even through the read-only tools. */
  const hosted = ctx.scope === "pc.hosted";

  /** A failed send as a tool error, with what the model needs to retry correctly. */
  const sendError = (err: unknown): Result => {
    if (!(err instanceof GatewayError)) throw err;
    const d = err.details ?? {};
    return fail(`${err.message}${d.contextTokens ? ` (context ${d.contextTokens} tokens)` : ""}${d.sessionId ? ` [Helix sessionId: ${d.sessionId}]` : ""}`);
  };

  /** send_agent_message for a hosted chat: delivered only with the user's approval or under a live trust grant. */
  async function hostedSend(session: string, message: string, text: string, confirmHeavy?: boolean): Promise<Result> {
    const connectorId = ctx.desktopIdentity ?? ctx.actor;
    const connectorName = ctx.actor.replace(/^local:(hosted:)?(oauth:)?/, "") || "a hosted chat";
    let target: { key: string; title: string };
    try {
      target = deps.router.targetKey(session);
      // Busy, too large, or not a work session: say so now, before the user is asked about a message that could not be delivered.
      deps.router.precheckSend(session, confirmHeavy);
    } catch (err) { return sendError(err); }

    const grant = deps.trust?.active(connectorId, target.key);
    if (grant) {
      deps.auth.audit(undefined, "hosted.message_trusted", { actor: ctx.actor, target: target.key, grantId: grant.id });
      try {
        const r = await deps.router.sendTo(session, message, { confirmHeavy, preApproved: true });
        return ok({ sent: true, trustedUntil: grant.expiresAt, title: target.title, ...("delivered" in r ? { delivered: "terminal", sessionRef: r.sessionRef } : { sessionId: r.session.id }), next: "read_agent_session to see the reply" });
      } catch (err) { return sendError(err); }
    }

    const { approval, outcome } = deps.approvals.request({
      source: "request", tool: "send_agent_message",
      summary: `${connectorName} wants to send a message to the agent session "${target.title}":\n${text.length > 1500 ? text.slice(0, 1500) + "…" : text}`,
      reasons: ["a hosted chat is asking an agent on this PC to act"],
      trustOffer: deps.trust ? { connectorId, connectorName, target: target.key, targetTitle: target.title, maxMinutes: MAX_TRUST_MINUTES } : undefined,
    });
    // The tool returns at once (hosts time out long calls); the message goes out the moment the user approves.
    void outcome.then(async (r) => {
      if (!r.approved) return;
      try { await deps.router.sendTo(session, message, { confirmHeavy, preApproved: true }); }
      catch (err) {
        await deps.escalation.notify({
          severity: "important", title: `Approved message to "${target.title}" was not delivered`,
          body: err instanceof Error ? err.message : String(err), dedupeKey: `hosted-send-failed:${approval.id}`,
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return ok({
      sent: false, pendingApproval: true, approvalId: approval.id, title: target.title, sessionRef: target.key,
      next: "The user was asked to approve this message on their phone; it is delivered the moment they approve. Tell them to check Helix, then use read_agent_session later to see the reply.",
    });
  }
  const guardPath = (p: string): void => {
    if (hosted && isProtectedPath(p, deps.dataDir)) throw new Error("That path holds credentials or Helix's own state and is not available to hosted chats.");
  };

  /* ---------- observe ---------- */
  tool("get_pc_status", "CPU, memory, disk space, uptime of the PC.", {}, async () => ok(await pc.getPcStatus()));
  tool("get_gpu_status", "GPU utilisation, VRAM, temperature and power (NVIDIA).", {}, async () => ok(await pc.getGpuStatus()));
  tool("list_processes", "Running processes, largest memory first. Optional name filter.",
    { filter: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional() },
    async ({ filter, limit }) => ok(await pc.listProcesses(filter, limit)));
  tool("get_process_status", "Is a process running? Look up by pid or by name.",
    { pid: z.number().int().optional(), name: z.string().max(100).optional() },
    async (a) => ok(await pc.getProcessStatus(a)));
  tool("list_directory", "List files in a directory.", { path: z.string().min(1) }, ({ path }) => { guardPath(path); return ok(pc.listDirectory(path)); });
  tool("read_file", "Read a text file (first 100 KB).", { path: z.string().min(1) }, ({ path }) => { guardPath(path); return ok(pc.readFile(path)); });
  tool("tail_file", "Last N lines of a file, e.g. a training log.",
    { path: z.string().min(1), lines: z.number().int().min(1).max(500).optional() },
    ({ path, lines }) => { guardPath(path); return ok(pc.tailFile(path, lines)); });
  tool("git_status", "git status of a repository.", { repo: z.string().min(1) }, async ({ repo }) => ok(await pc.gitStatus(repo)));
  tool("git_log", "Recent commits of a repository.", { repo: z.string().min(1), count: z.number().int().min(1).max(100).optional() },
    async ({ repo, count }) => ok(await pc.gitLog(repo, count)));
  tool("get_service_status", "State of a Windows service.", { name: z.string().min(1).max(80) }, async ({ name }) => ok(await pc.getServiceStatus(name)));
  tool("get_training_status",
    "Summary of a training run: matching processes, GPU, the tail of its log, and the latest step/loss found in it.",
    { logPath: z.string().optional(), processName: z.string().optional(), lines: z.number().int().min(1).max(200).optional() },
    async (a) => { if (a.logPath) guardPath(a.logPath); return ok(await pc.getTrainingStatus(a)); });
  tool("list_agent_sessions", "Agent sessions the gateway manages.", {}, () =>
    ok(deps.registry.list().map((s) => ({ id: s.id, title: s.title, provider: s.provider, status: s.status, project: s.projectPath, lastActivityAt: s.lastActivityAt }))));
  /* ---------- talk to agents (hosted chats and control clients) ---------- */
  tool("read_agent_session",
    "How an agent session is doing: its status (working/idle) and the last few messages of its conversation, including its replies. " +
    "Use it after send_agent_message to see the answer; an agent that is still `working` has not finished replying.",
    { session: z.string().min(1).max(100).describe("a `ref` like claude:<id> or codex:<id> from list_agent_sessions/search, a Helix session id, or an alias") },
    ({ session }) => ok(deps.router.summary(session)));
  tool("send_agent_message",
    "Send a message to a Claude/Codex agent session on this PC, as if the user had typed it, and return right away (read the reply with read_agent_session). " +
    "Only message an agent when the user asked you to. If the session is open in a terminal the message goes straight into that same session (no fork); otherwise it is brought under Helix control and continued. " +
    "If it answers that the session is large/expensive, tell the user the size and ask; retry with confirmHeavy=true ONLY after they say to continue, " +
    "and reuse the Helix `sessionId` from the error so it is not forked again. The agent's own approval rules still apply." +
    (hosted ? " From this chat every message first waits for the user's approval on their phone (unless they trusted this chat with that session for a while); when the result says pendingApproval, tell them to check Helix." : ""),
    {
      session: z.string().min(1).max(100).describe("a `ref` like claude:<id>, a Helix session id, or an alias"),
      text: z.string().min(1).max(20_000),
      confirmHeavy: z.boolean().optional().describe("Only after the user agreed to continue a large session."),
    },
    async ({ session, text, confirmHeavy }) => {
      if (ctx.sessionId && (deps.registry.get(session)?.id === ctx.sessionId)) return fail("An agent cannot message itself.");
      const message = `(Sent from a hosted chat on the user's behalf)\n${text}`;
      // A hosted chat reaches the PC from the internet, and a message makes an agent act as if the user typed it. So the gateway
      // itself asks the user before every one (the model cannot skip or answer this), unless the user trusted this connector
      // with this very session for a while.
      if (hosted) return hostedSend(session, message, text, confirmHeavy);
      try {
        const r = await deps.router.sendTo(session, message, { confirmHeavy });
        if ("delivered" in r && r.delivered === "pending_approval") {
          return ok({ sent: false, pendingApproval: true, title: r.title, sessionRef: r.sessionRef, next: "That terminal runs with permissions bypassed, so the user was asked to approve this message on their phone. It is delivered the moment they approve; tell them to check Helix. read_agent_session with sessionRef later to see the reply." });
        }
        if ("delivered" in r) {
          return ok({ sent: true, delivered: "terminal", title: r.title, name: r.name, sessionRef: r.sessionRef, state: r.status, next: "The message went straight into the open terminal session (no fork). read_agent_session with sessionRef to see the reply." });
        }
        return ok({ sent: true, sessionId: r.session.id, title: r.session.title, mode: r.mode, note: r.note, next: "read_agent_session to see the reply" });
      } catch (err) { return sendError(err); }
    });

  tool("send_user_message", "Send a message to the user's phone (shows in the app).",
    { text: z.string().min(1).max(4000), severity: z.enum(["info", "important", "critical"]).optional() },
    ({ text, severity }) => {
      const conversationId = ctx.sessionId ?? "general";
      const m = deps.messages.add({ conversationId, sessionId: ctx.sessionId, sender: "agent", text, severity: severity ?? "info" });
      deps.bus.publish({ type: "message.created", message: m });
      return ok({ delivered: true, messageId: m.id });
    });

  /* ---------- router (General Claude): find a session and connect the user to it ---------- */
  tool("search_agent_sessions",
    "Find Claude/Codex sessions on this machine by a few distinctive words (title, project, recent text). Live ones first, then most recent. " +
    "Also returns matching favorite aliases. Pass a result's `ref` to handoff_current_conversation.",
    {
      query: z.string().max(200).optional(), provider: z.enum(["claude", "codex"]).optional(),
      project: z.string().max(200).optional(), liveOnly: z.boolean().optional(), limit: z.number().int().min(1).max(30).optional(),
    },
    ({ query, provider, project, liveOnly, limit }) => ok(deps.router.search(query, { provider, project, liveOnly, limit })));
  tool("get_session_summary", "A session's status and the last few messages of its conversation. Use it to answer questions without handing off.",
    { session: z.string().min(1).max(100).describe("a session `ref` like claude:<id>, a Helix session id, or an alias") },
    ({ session }) => ok(deps.router.summary(session)));
  tool("list_projects", "Projects that have sessions, most recent first. Pick one to start new work with handoff_current_conversation(projectPath).", {},
    () => ok(deps.router.projects()));
  tool("start_agent_session", "Start a fresh session in a project without handing the conversation to it (usually handoff_current_conversation(projectPath) is what you want).",
    { projectPath: z.string().min(1).max(1024), title: z.string().max(120).optional(), provider: z.enum(["claude", "codex"]).optional() },
    async ({ projectPath, title, provider }) => {
      const s = await deps.router.startSession(projectPath, title, provider);
      return ok({ sessionId: s.id, title: s.title, projectPath: s.projectPath });
    });
  tool("resume_agent_session", "Bring an existing session under Helix control without handing the conversation to it. Sessions open in a terminal are forked, not taken over.",
    { session: z.string().min(1).max(100), mode: z.enum(["auto", "resume", "fork"]).optional() },
    async ({ session, mode }) => {
      const r = await deps.router.resume(session, mode);
      return ok({ sessionId: r.session.id, title: r.session.title, mode: r.mode, note: r.note });
    });
  tool("handoff_current_conversation",
    "Connect the user to another session, in this same conversation. Give `session` (a ref from search_agent_sessions, a Helix session id, or an alias) " +
    "OR `projectPath` to start fresh work in a project. `message` is delivered to that session immediately as if the user had typed it, and its replies " +
    "reach the user directly, so ONLY include it when the user asked that session to DO or ANSWER something (\"how is the training going\", \"fix the login bug\"). " +
    "If the user only asked to be connected or switched (\"connect me to the helix agent\", \"put me through to Astra\", \"talk to the cat session\"), leave `message` OUT: " +
    "that sentence is for you, not for the session, and the session stays silent until the user speaks to it. " +
    "A session that is open in a terminal is NOT forked: the conversation talks to that very session (mode \"terminal\") and its replies come back here. " +
    "Say one short sentence afterwards about who they are now talking to.",
    {
      session: z.string().min(1).max(100).optional(), projectPath: z.string().min(1).max(1024).optional(),
      message: z.string().max(20_000).optional(), mode: z.enum(["auto", "resume", "fork"]).optional(), title: z.string().max(120).optional(),
      provider: z.enum(["claude", "codex"]).optional().describe("Which agent to start when using projectPath (default claude; use codex if the user asks for Codex)."),
    },
    async (spec) => {
      const route = ctx.sessionId ? deps.router.routeForRouterSession(ctx.sessionId) : undefined;
      if (!route) return fail("This conversation is not routed, so there is nothing to hand off.");
      const r = await deps.router.handoff(route.id, spec);
      return ok({
        connectedTo: r.session.title, mode: r.mode, note: r.note, messageDelivered: r.forwarded,
        ...(r.droppedRoutingMessage ? { messageNotDelivered: "that was a request to connect, not work for the session, so it was not sent. The session is ready and waiting for the user." } : {}),
      });
    });

  tool("end_call",
    "Hang up the user's live phone call. Use it ONLY when the user clearly says goodbye or asks to end the call (\"bye\", \"that's all\", \"hang up\"). " +
    "Say a brief goodbye in your reply as usual and call this tool in the same turn: the call ends once your goodbye has been spoken. " +
    "It does nothing when there is no live call (a text chat), so it is safe to call, but do not use it for anything else.",
    {},
    () => {
      const hang = deps.router.hangUp;
      if (!hang) return fail("calls are not available");
      return hang(ctx.sessionId)
        ? ok({ hangingUp: true, next: "The call ends after your goodbye is spoken. Reply with a short goodbye now." })
        : ok({ hangingUp: false, note: "There is no live phone call to end (this is a text chat), so nothing was done." });
    });
  tool("notify_user",
    "Tell the user something through Helix, who may be away from the PC. severity: " +
    "info = small progress update (in-app only); important = finished, needs their input, or worth knowing (visible push); " +
    "critical = broken or blocked and needs them NOW (rings their phone, so use sparingly). " +
    "The result says which channels actually delivered; only tell the user you notified them if it did.",
    {
      title: z.string().min(1).max(200),
      message: z.string().max(2000).optional(),
      severity: SeveritySchema.default("important"),
      project: z.string().max(100).optional().describe("Project or task name, shown in the notification."),
    },
    async ({ title, message, severity: requested, project }) => {
      // A hosted chat can reach the phone with a push, but never ring it: critical is capped at important, and it is rate limited.
      if (hosted && !hostedNotifyLimit.allow(ctx.actor)) return fail("Too many notifications from this connector (10 per 10 minutes). Tell the user in the chat instead.");
      const severity = hosted && requested === "critical" ? "important" : requested;
      const label = project ? `[${project}] ${title}` : title;
      const sessionId = ctx.sessionId && deps.registry.get(ctx.sessionId) ? ctx.sessionId : undefined;
      const results = await deps.escalation.notify({
        severity, title: label, body: message ?? "", sessionId,
        dedupeKey: `${ctx.actor}:${label.toLowerCase().slice(0, 80)}`,
      });
      const by = (s: string) => results.filter((r) => r.status === s).map((r) => r.channel);
      return ok({
        delivered: by("delivered"), unavailable: by("unavailable"), suppressed: results.filter((r) => r.status === "suppressed").map((r) => `${r.channel}: ${r.reason}`),
        failed: by("failed"),
      });
    });

  tool("list_status_watches", "Active status watches (what is being monitored) and their last status.", {}, () =>
    ok(deps.watchers.list().map((w) => ({
      id: w.id, name: w.name, type: w.type, enabled: w.enabled, intervalSec: w.intervalSec,
      lastStatus: w.lastStatus, lastCheckedAt: w.lastCheckedAt, lastEventAt: w.lastEventAt, lastError: w.lastError,
    }))));

  /* ---------- control (destructive work is gated inside the tool) ---------- */
  tool("run_command", "Run a PowerShell command. Deleting or other irreversible commands pause for the user's approval.",
    { command: z.string().min(1).max(20_000), cwd: z.string().optional(), timeoutSec: z.number().int().min(1).max(600).optional() },
    async ({ command, cwd, timeoutSec }, signal) => {
      const d = await deps.policy.authorize({ tool: "run_command", input: { command } }, { sessionId: ctx.sessionId, source: "tool", signal });
      if (!d.allowed) return fail(d.message);
      return ok(await pc.runCommand(command, cwd, timeoutSec));
    });
  tool("run_safe_command",
    "Run one short PowerShell command, but only if it is marked safe: read-only inspection (dir, Get-Process, Get-Content, git status, nvidia-smi, ...). " +
    "Anything that deletes, writes files, installs, changes services or settings, or touches the network or credentials is refused with the reason, and is never run.",
    { command: z.string().min(1).max(2000), cwd: z.string().optional(), timeoutSec: z.number().int().min(1).max(60).optional() },
    async ({ command, cwd, timeoutSec }) => {
      const v = hostedCommandVerdict(command, deps.dataDir);
      if (!v.allowed) {
        deps.auth.audit(undefined, "hosted.command_refused", { actor: ctx.actor, command: command.slice(0, 300), reason: v.reason });
        return fail(`Refused: ${v.reason}. Nothing was run. Ask the user to run it from the Helix app, or use a read-only alternative.`);
      }
      if (cwd) guardPath(cwd);
      return ok(await pc.runCommand(command, cwd, timeoutSec ?? 30));
    });
  tool("list_apps", "Apps in the Start menu that open_app can launch. Optional filter on the name.",
    { filter: z.string().max(100).optional() },
    async ({ filter }) => {
      const f = filter?.toLowerCase();
      return ok((await apps.listStartApps()).filter((a) => !f || a.name.toLowerCase().includes(f)).map((a) => a.name));
    });
  tool("open_app",
    "Open a desktop app by its Start-menu name (e.g. \"Xbox\", \"Spotify\", \"Calculator\"). Only installed Start-menu apps; shells, terminals and admin tools are refused. " +
    "If the name is ambiguous the matching names are returned so you can ask which one.",
    { name: z.string().min(1).max(100) },
    async ({ name }) => {
      const r = await apps.openApp(name, { dataDir: deps.dataDir });
      return r.error ? fail(`${r.error}${r.candidates ? ` (candidates: ${r.candidates.join(", ")})` : ""}`) : ok(r);
    });
  tool("close_app",
    "Close an open app by name (its app or window title), the polite way: it is asked to close and may still prompt about unsaved work. " +
    "Never force-closes. Shells, terminals, code editors, system processes, Helix and Tailscale are protected and refused.",
    { name: z.string().min(1).max(100) },
    async ({ name }) => {
      const r = await apps.closeApp(name, { dataDir: deps.dataDir });
      return r.error ? fail(`${r.error}${r.candidates ? ` (candidates: ${r.candidates.join(", ")})` : ""}`) : ok(r);
    });
  tool("write_file", "Create or overwrite a text file.",
    { path: z.string().min(1), content: z.string(), createDirs: z.boolean().optional() },
    async ({ path, content, createDirs }, signal) => {
      // Ordinary files are written at once; credentials, security config and startup locations wait for the user.
      const d = await deps.policy.authorize({ tool: "write_file", input: { path } }, { sessionId: ctx.sessionId, source: "tool", signal });
      if (!d.allowed) return fail(d.message);
      return ok(pc.writeFile(path, content, createDirs));
    });
  tool("stop_process", "Stop a process (and its children) by pid.", { pid: z.number().int() }, async ({ pid }) => ok(await pc.stopProcess(pid)));

  tool("create_status_watch",
    "Start monitoring something cheaply (no model polling) and notify the user's phone when it changes. " +
    "Types: process (pid/name running or not), log (regex patterns on new lines, stale log), file (exists/missing/modified/stale), " +
    "command (non-destructive PowerShell check), http (URL health), gpu (temp/VRAM/idle), git (new commits), " +
    "session (agent task finished/failed/stalled). Works for any work, not just training.",
    {
      name: z.string().min(1).max(120),
      type: z.enum(WATCH_TYPES as [WatchType, ...WatchType[]]),
      config: z.record(z.string(), z.unknown()),
      intervalSec: z.number().int().min(1).max(86_400).optional(),
      severity: SeveritySchema.optional(),
      wakeMe: z.boolean().optional().describe("When it fires, send the event to this session so you can investigate."),
    },
    async ({ name, type, config, intervalSec, severity, wakeMe }, signal) => {
      // A command watch keeps running a command on a timer, unattended and after the session ends. Terminal agents
      // get no command tool from Helix otherwise, so the user approves each one once, when it is created.
      if (type === "command" && ctx.scope === "pc.agent.local") {
        const command = typeof config.command === "string" ? config.command : "";
        const c = classify({ tool: "run_command", input: { command } });
        if (!command || c.destructive) return fail(`watch commands must be a non-destructive command${c.reasons.length ? ` (${c.reasons.join("; ")})` : ""}`);
        const { outcome } = deps.approvals.request({
          sessionId: ctx.sessionId, source: "tool", tool: "create_status_watch",
          summary: `A terminal agent wants a status watch "${name}" that runs this command every ${intervalSec ?? "default"} s until removed:\n${command.slice(0, 500)}`,
          reasons: ["command watches run unattended on a timer"], signal,
        });
        const r = await outcome;
        if (!r.approved) return fail(`The user did not approve the command watch (${r.status}).`);
      }
      const w = deps.watchers.create({
        name, type, config, intervalSec, severity, sessionId: ctx.sessionId,
        wake: wakeMe && ctx.sessionId ? { sessionId: ctx.sessionId, cooldownMin: 30 } : undefined,
      });
      return ok({ created: { id: w.id, name: w.name, type: w.type } });
    });
  tool("watch_job",
    "Watch a long-running job (build, tests, deploy, download, training, anything) by process and/or log file. " +
    "Notifies on crash, error lines, completion and a silent/stale log. Profiles only tune the default patterns.",
    {
      name: z.string().min(1).max(100),
      profile: z.enum(["generic", "training", "build", "tests", "deploy", "download"]).optional(),
      pid: z.number().int().positive().optional(),
      processName: z.string().max(100).optional(),
      logPath: z.string().max(1024).optional(),
      errorPatterns: z.array(z.string().max(300)).max(20).optional(),
      donePatterns: z.array(z.string().max(300)).max(20).optional(),
      staleAfterMin: z.number().min(0).max(1440).optional(),
      watchGpu: z.boolean().optional(),
      intervalSec: z.number().int().min(1).max(3600).optional(),
      wakeMe: z.boolean().optional().describe("When something important fires, send it to this session so you can investigate."),
    },
    ({ wakeMe, ...job }) => {
      const inputs = buildJobWatches({ ...job, profile: job.profile as JobProfile | undefined, sessionId: ctx.sessionId, wakeSessionId: wakeMe ? ctx.sessionId : undefined });
      const created = inputs.map((i) => deps.watchers.create(i));
      return ok({ created: created.map((w) => ({ id: w.id, name: w.name, type: w.type })) });
    });
  tool("remove_status_watch", "Stop and delete a status watch by id.", { id: z.string().min(1) },
    ({ id }) => ok({ removed: deps.watchers.remove(id) }));

  /* ---------- agent-only ---------- */
  tool("request_user_approval", "Ask the user to approve something before you do it. Blocks until they answer.",
    { summary: z.string().min(1).max(500), details: z.string().max(2000).optional() },
    async ({ summary, details }, signal) => {
      const { outcome } = deps.approvals.request({
        sessionId: ctx.sessionId, source: "request", tool: "request_user_approval",
        summary: details ? `${summary}\n${details}` : summary, signal,
      });
      const r = await outcome;
      return ok({ approved: r.approved, status: r.status, note: r.note });
    });

  // Claude Code calls this (via --permission-prompt-tool) whenever it wants to run something that isn't pre-approved.
  tool("permission_prompt", "Internal: decides whether Claude may run a tool.",
    { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    async ({ tool_name, input }, signal) => {
      const d = await deps.policy.authorize({ tool: tool_name, input }, { sessionId: ctx.sessionId, source: "agent", signal });
      deps.auth.audit(undefined, "permission.decision", {
        sessionId: ctx.sessionId, tool: tool_name, allowed: d.allowed, approvalId: d.approvalId, action: describeAction({ tool: tool_name, input }),
        destructive: classify({ tool: tool_name, input }).destructive,
      });
      return ok(d.allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.message });
    });

  return server;
}

/** Keep audit entries small: long strings are clipped. */
function summarize(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  return Object.fromEntries(Object.entries(args as Record<string, unknown>).map(([k, v]) =>
    [k, typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v]));
}
