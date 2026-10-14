import os from "node:os";
import { ComputerController } from "./computer/controller.js";
import { WindowsComputerBridge } from "./computer/bridge.js";
import { ViewerProbe } from "./computer/viewer-probe.js";
import { LiveDesktopViewer } from "./computer/live-viewer.js";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { Config } from "./config.js";
import { AuthService } from "./api/auth.js";
import { LocalTokenService } from "./auth/local-tokens.js";
import { OAuthService, registerOAuth } from "./oauth/oauth.js";
import { ClipLibrary } from "./voice/clips.js";
import { TtsManager } from "./voice/tts-manager.js";
import { CALL_MAX_SENTENCES, isSeriousSeverity } from "./voice/voice-opts.js";
import { CallAudio } from "./voice/call-audio.js";
import { TtsPipeline } from "./voice/tts-pipeline.js";
import { AwayWarmer } from "./voice/away-warmer.js";
import { nvidiaFreeMb } from "./voice/tts-manager.js";
import { UsageStore } from "./usage/store.js";
import { registerHttp } from "./api/http.js";
import { registerWebSocket } from "./api/websocket.js";
import { CallManager, CallNotifier } from "./calls/call-manager.js";
import { isGoodbye } from "./calls/goodbye.js";
import { AgentEvents } from "./discovery/agent-events.js";
import { ApnsClient, type ApnsConfig } from "./notifications/apns.js";
import { ApprovalEscalator } from "./notifications/approval-escalator.js";
import { DeviceTokens } from "./notifications/devices.js";
import { PushNotifier } from "./notifications/push.js";
import { LiveDevices } from "./notifications/live-devices.js";
import { FanOutNotifier, LivePushNotifier } from "./notifications/live-push.js";
import { SessionIndexer, type AgentHomes } from "./discovery/indexer.js";
import { RouterService } from "./router/router.js";
import { writeToPeer } from "./discovery/peer.js";
import { currentSession, desktop, packageRoot } from "./mcp/desktop.js";
import { registerMcp } from "./mcp/http.js";
import { SessionActivity } from "./monitoring/session-activity.js";
import { WatcherManager } from "./monitoring/watcher-manager.js";
import { Escalation, type EscalationOptions } from "./notifications/escalation.js";
import { MessageNotifier } from "./notifications/messages.js";
import { PresenceService } from "./notifications/presence.js";
import { PersonaService } from "./persona/service.js";
import { AgentTokens } from "./mcp/scopes.js";
import { ApprovalService } from "./permissions/approvals.js";
import { PolicyEngine } from "./permissions/policy.js";
import { TrustGrants } from "./permissions/trust-grants.js";
import { configureSensitivePaths } from "./permissions/sensitive-paths.js";
import type { AgentProvider } from "./providers/provider.js";
import { EventBus, SessionManager } from "./sessions/manager.js";
import { MessageStore, SessionRegistry } from "./sessions/registry.js";
import type { Db } from "./storage/sqlite.js";
import type { ProviderName } from "./types.js";

export interface Gateway {
  app: FastifyInstance;
  auth: AuthService;
  manager: SessionManager;
  approvals: ApprovalService;
  agentTokens: AgentTokens;
  localTokens: LocalTokenService;
  oauth: OAuthService;
  presence: PresenceService;
  router: RouterService;
  devices: DeviceTokens;
  persona: PersonaService;
  tts: TtsManager;
  clips: ClipLibrary;
  calls: CallManager;
  apns?: ApnsClient;
  agentEvents: AgentEvents;
  watchers: WatcherManager;
  escalation: Escalation;
  /** Present when discovery is enabled. */
  indexer?: SessionIndexer;
  /** Call once the server is listening so spawned agents know where to find the MCP endpoint. */
  enableAgentGate(baseUrl: string): void;
}

export async function buildGateway(
  config: Pick<Config, "defaultProjectPath" | "logLevel"> & Partial<Pick<Config, "approvalTtlMs" | "desktopApprovals" | "viewerIceServers" | "viewerCards">> & { requireDeviceSigning?: boolean; dataDir?: string; publicUrl?: string; tts?: Config["tts"]; escalation?: EscalationOptions; apns?: ApnsConfig; ringTimeoutMs?: number; approvalCallAfterMs?: number; presenceAwayMin?: number; routerHome?: string; discovery?: { homes: AgentHomes; codexLiveSec?: number } },
  db: Db,
  providers: Partial<Record<ProviderName, AgentProvider>>
): Promise<Gateway> {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ["req.headers.authorization"] },
    bodyLimit: 1024 * 1024,
  });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Clients (URLSession in particular) often send action endpoints like /interrupt or /reject with a
  // JSON content-type and no body. Fastify's default parser answers 400 to that; treat it as {}.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || (typeof body === "string" && body.trim() === "")) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { (e as Error & { statusCode?: number }).statusCode = 400; done(e as Error); }
  });

  const registry = new SessionRegistry(db);
  const recovered = registry.recoverInterrupted();
  if (recovered > 0) app.log.warn({ recovered }, "marked interrupted sessions idle after restart");

  const manager = new SessionManager(
    registry, new MessageStore(db), providers, new EventBus(), config.defaultProjectPath, app.log
  );
  const auth = new AuthService(db, { requireSigning: config.requireDeviceSigning });
  const approvals = new ApprovalService(db, manager.bus, manager.messages, config.approvalTtlMs);
  const policy = new PolicyEngine(approvals);
  const trust = new TrustGrants(db);
  // Helix's own data and its hooks/service scripts count as sensitive files wherever they are installed.
  configureSensitivePaths({ dataDir: config.dataDir, gatewayRoot: packageRoot() });
  manager.setPolicy(policy);
  manager.setUsage(new UsageStore(db));
  if (config.discovery) {
    // 0 turns the guard off. Default: a Claude session above 150k tokens needs a confirmation once its prompt cache (5 min) has gone.
    manager.setHeavyGuard({
      claudeHome: config.discovery.homes.claudeHome,
      maxTokens: Number(process.env.HELIX_HEAVY_SESSION_TOKENS ?? 150_000),
      coldMs: Number(process.env.HELIX_CACHE_COLD_SEC ?? 270) * 1000,
    });
  }
  app.addHook("onClose", async () => { for (const p of Object.values(providers)) p?.close?.(); });
  const agentTokens = new AgentTokens();
  const localTokens = new LocalTokenService(db);
  const viewerProbe = new ViewerProbe((identity) => localTokens.desktopAllowed(identity));
  viewerProbe.registerRoutes(app);
  const computer = new ComputerController((identity) => localTokens.desktopAllowed(identity), () => new WindowsComputerBridge(config.dataDir));
  const liveViewer = new LiveDesktopViewer(computer, config.viewerIceServers);
  liveViewer.registerRoutes(app);
  app.addHook("onClose", async () => liveViewer.close());
  app.addHook("onClose", async () => computer.close());

  // Every Claude/Codex session on this machine, whether or not Helix started it.
  const indexer = config.discovery
    ? new SessionIndexer(db, manager.bus, { homes: config.discovery.homes, codexLiveSec: config.discovery.codexLiveSec, log: app.log })
    : undefined;
  app.addHook("onClose", async () => indexer?.stop());

  // Watchers: cheap deterministic checks -> events -> escalation policy. The message channel works now;
  // push and call channels are plugged into `escalation` when APNs exists (Phases 3 and 6).
  const presence = new PresenceService(db, { awayAfterMin: config.presenceAwayMin });
  // Push and call channels exist only when Apple push is configured; until then they are recorded as "unavailable".
  const devices = new DeviceTokens(db);
  let apns: ApnsClient | undefined;
  if (config.apns) {
    try { apns = new ApnsClient(config.apns); }
    catch (err) { app.log.error({ err }, "APNs is configured but the key could not be used: push and calls are disabled"); }
  }
  // An Android phone has no Apple push: while its app holds the live connection, pushes and rings travel over it.
  const live = new LiveDevices();
  const applePush = apns ? new PushNotifier(apns, devices, app.log) : undefined;
  const livePush = new LivePushNotifier(manager.bus, live);
  const push = new FanOutNotifier(applePush ? [applePush, livePush] : [livePush]);
  const escalationChannels: ConstructorParameters<typeof Escalation>[1] = { message: new MessageNotifier(manager.messages, manager.bus), push };
  const escalation = new Escalation(db, escalationChannels, { presence, ...config.escalation });
  const activity = new SessionActivity(manager.bus, approvals);
  const watchers = new WatcherManager({
    db, bus: manager.bus, escalation, activity, log: app.log,
    sessionExists: (id) => !!registry.get(id),
    checkDeps: { agentPidTitles: () => indexer?.livePidTitles() ?? new Map() },
    wake: (sessionId, text) => {
      try { manager.send(sessionId, text); return true; } catch { return false; } // busy or gone: skip, don't queue
    },
  });
  app.addHook("onClose", async () => watchers.stop());

  // Sessions Helix does not run (terminal, IDE): their turns ending/dying and being mid-turn come from the indexer.
  if (indexer) {
    indexer.onTransition((e) => activity.emitExternal(e));
    activity.setExternalRunning(() => indexer.externalRunning());
  }

  const router = new RouterService(db, manager, indexer, manager.bus, config.routerHome ?? path.join(os.tmpdir(), "helix-router"));
  // Terminal sessions listen on per-session pipes the service (session 0) cannot see, so from there the write hops into the user's session.
  router.deliverToPeer = async (socketPath, lines) => {
    if ((await currentSession()) !== 0 && process.env.HELIX_DESKTOP_BRIDGE !== "task") return writeToPeer(socketPath, lines);
    const r = await desktop({ op: "peer", pipe: socketPath, lines }, { dataDir: config.dataDir });
    return { ok: r.ok, error: r.error };
  };
  router.approveTerminalSend = async (summary) => (await approvals.request({ source: "request", tool: "send_agent_message", summary }).outcome).approved;
  const persona = new PersonaService(db);
  // The PC voice: off unless enabled, started only when a spoken turn asks for it, stopped when idle (see voice/tts-manager.ts).
  const tts = new TtsManager(config.tts ?? { enabled: false, engine: "qwen3", port: 7791, idleSec: 180, minFreeVramMb: 6000, minFreeRamMb: 4000 }, { log: app.log });
  const clips = new ClipLibrary(config.tts?.clipsDir);
  // While the user is away from the PC the voice is kept loaded (if the GPU is free), so a call from the phone does not wait for it.
  const stopWarmer = config.tts?.enabled && config.tts.warmWhenAway
    ? new AwayWarmer(tts, { isAway: () => presence.isAway(), gpuFreeMb: nvidiaFreeMb, log: app.log }).start()
    : () => undefined;
  const stopTtsPipeline = new TtsPipeline(manager.bus, tts, app.log, { maxHoldMs: Math.round((config.tts?.smoothHoldSec ?? 0) * 1000) }, tts.streams).start();
  // A call that rings is recorded in the PC voice while it rings (only when the PC voice is on), so the phone has it ready on answer.
  const callAudio = new CallAudio(manager.bus, tts, app.log);
  const stopCallAudio = config.tts?.enabled ? callAudio.start() : () => undefined;
  app.addHook("onClose", async () => { stopWarmer(); stopTtsPipeline(); stopCallAudio(); await tts.stop("gateway closing"); });
  const calls = new CallManager(db, manager.bus, { devices, apns, live, router, manager, approvals, push, persona }, { ringTimeoutMs: config.ringTimeoutMs });
  escalationChannels.call = new CallNotifier(calls); // same object the escalation already holds; unavailable when no phone can ring
  // Ending a call: a clear goodbye from the user, or the agent (front door or handed session) calling end_call.
  router.inCall = (routeId) => !!calls.activeCallForRoute(routeId);
  router.hangUp = (sessionId) => { const c = calls.activeCallForSession(sessionId); return c ? calls.hangUpAfterReply(c.id) : false; };
  router.onUserMessage = (routeId, text) => {
    const call = calls.activeCallForRoute(routeId);
    if (call && isGoodbye(text)) calls.hangUpAfterReply(call.id);
  };
  // On a live call, Helix's own voice (the PC voice, when it is on) and character answer, in two or three sentences, whoever is behind the
  // front door. The character is the persona (professional unless the user changed it) and fades with the call's severity as everywhere else;
  // a session the call was handed to keeps its own tone (never flirty) and gets the same length limit. Text chat is not touched.
  router.callVoice = (routeId, who, asked) => {
    const severity = asked ?? router.voiceSeverity(routeId); // the app may raise or lower it for one message
    const voiceStyle = who === "front" ? persona.callVoiceStyle(severity) : persona.sessionVoiceStyle(severity, undefined, { call: true });
    return { voiceStyle, voiceEngine: tts.status().enabled ? "pc" : undefined, voiceSerious: isSeriousSeverity(severity), maxSpokenSentences: CALL_MAX_SENTENCES };
  };
  // The voice model takes a while to load: start it as soon as a call rings or is placed, so it is ready by the first reply.
  if (config.tts?.enabled) {
    manager.bus.subscribe((e) => {
      if (e.type === "call.ringing" || (e.type === "call.answered" && e.call.direction === "outgoing")) tts.warm().catch(() => undefined);
    });
  }
  const approvalEscalator = new ApprovalEscalator(manager.bus, escalation, { callAfterMs: config.approvalCallAfterMs });
  app.addHook("onClose", async () => { approvalEscalator.stop(); calls.stop(); apns?.close(); });
  const agentEvents = new AgentEvents(db, activity, registry, indexer, { approvals, presence, escalation });
  registerHttp(app, auth, manager, approvals, watchers, indexer, { localTokens, agentEvents, presence }, router, { devices, calls, push, apns, live, persona, tts, clips, callAudio }, trust);
  registerWebSocket(app, auth, manager, router, persona, live);
  const oauth = new OAuthService(db, localTokens);
  registerOAuth(app, oauth, config.publicUrl);
  registerMcp(app, (token) => agentTokens.lookup(token) ?? localTokens.lookup(token), {
    auth, policy, approvals, trust, registry: manager.registry, messages: manager.messages, bus: manager.bus, watchers, escalation, router, dataDir: config.dataDir, publicUrl: config.publicUrl, computer, viewerProbe, liveViewer, liveViewerCards: config.viewerCards ?? false, desktopApprovals: config.desktopApprovals ?? true,
  });

  return {
    app, auth, manager, approvals, agentTokens, localTokens, oauth, presence, router, devices, persona, calls, apns, agentEvents, watchers, escalation, indexer, tts, clips,
    enableAgentGate: (baseUrl) => manager.enableAgentGate(agentTokens, () => `${baseUrl}/mcp`),
  };
}
