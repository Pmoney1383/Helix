import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionIndexer } from "../discovery/indexer.js";
import { findPeer, peerLines, permissionModeOf, writeToPeer } from "../discovery/peer.js";
import { adoptSession, type AdoptMode } from "../sessions/adopt.js";
import { GatewayError, type EventBus, type SessionManager } from "../sessions/manager.js";
import type { Db } from "../storage/sqlite.js";
import type { VoiceSeverity } from "../persona/types.js";
import type { VoiceOpts } from "../voice/voice-opts.js";
import { isRoutingOnly } from "./routing-only.js";
import { followTerminalReply } from "./terminal-relay.js";
import { findClaudeTranscript } from "../usage/context.js";
import { SentenceStream, limitSpoken, toSpeech } from "../voice/speech.js";
import type { AgentMessage, AgentSession, AgentSessionInfo, ProviderName } from "../types.js";

export interface Route {
  id: string;
  title: string;
  /** Which agent is the front door: "claude" = General Claude, "codex" = Astra. The conversation works the same either way. */
  frontDoor: ProviderName;
  routerSessionId: string;
  /** The session currently answering, once the router has handed the conversation over. */
  targetSessionId?: string;
  /** Where the next message goes: the target if there is one, otherwise the router. */
  currentSessionId: string;
  /** Every session this conversation has touched, in order (the history view spans all of them). */
  visited: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoffSpec {
  /** A Helix session id, or "<provider>:<providerSessionId>" for any session on the machine, or an alias name. */
  session?: string;
  /** Start a fresh session in this project instead. */
  projectPath?: string;
  /** Which agent starts it (default claude). */
  provider?: ProviderName;
  /** What to tell the target, in the user's voice. Delivered immediately, in the same conversation. */
  message?: string;
  mode?: AdoptMode;
  title?: string;
}

export interface HandoffResult {
  route: Route;
  session: AgentSession;
  /** "terminal": the session is open in a terminal, so the conversation talks to that very session through its inbox (never a fork). */
  mode: "resume" | "fork" | "new" | "terminal";
  note?: string;
  forwarded: boolean;
  /** The message was only a request to be connected (not work for the target), so it was not delivered: the target stays silent. */
  droppedRoutingMessage?: boolean;
}

interface RouteRow {
  id: string; title: string; router_session_id: string; target_session_id: string | null;
  visited: string; created_at: string; updated_at: string;
}

const toRoute = (r: RouteRow, frontDoor: ProviderName): Route => ({
  id: r.id, title: r.title, frontDoor, routerSessionId: r.router_session_id, targetSessionId: r.target_session_id ?? undefined,
  currentSessionId: r.target_session_id ?? r.router_session_id, visited: JSON.parse(r.visited) as string[],
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionHit {
  /** "<provider>:<providerSessionId>": pass this back to handoff/resume. */
  ref: string;
  helixSessionId?: string;
  title: string;
  project?: string;
  provider: ProviderName;
  live: boolean;
  liveStatus?: string;
  lastActivityAt?: string;
  preview?: string;
}

/**
 * The General Claude's machinery. A route is one phone conversation: it starts talking to a router
 * session, and when the router decides who the user really wants, the *same* conversation is pointed
 * at that session (no new call, no new chat). Only who answers changes.
 */
export class RouterService {
  constructor(
    private readonly db: Db,
    private readonly manager: SessionManager,
    private readonly indexer: SessionIndexer | undefined,
    private readonly bus: EventBus,
    private readonly routerHome: string
  ) {}

  /* ---------------- routes ---------------- */

  /** `provider` picks the front door: claude = General Claude, codex = Astra. */
  async createRoute(title?: string, provider: ProviderName = "claude"): Promise<Route> {
    title ??= provider === "codex" ? "Astra" : "General Claude";
    fs.mkdirSync(this.routerHome, { recursive: true });
    const router = await this.manager.createSession({ provider, title, projectPath: this.routerHome, role: "router" });
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare("INSERT INTO routes (id, title, router_session_id, visited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, title, router.id, JSON.stringify([router.id]), now, now);
    this.bus.publish({ type: "route.created", routeId: id, routerSessionId: router.id });
    return this.mustGet(id);
  }

  private route(r: RouteRow): Route {
    return toRoute(r, this.manager.registry.get(r.router_session_id)?.provider ?? "claude");
  }

  get(id: string): Route | undefined {
    const r = this.db.prepare("SELECT * FROM routes WHERE id = ?").get(id) as RouteRow | undefined;
    return r && this.route(r);
  }

  mustGet(id: string): Route {
    const r = this.get(id);
    if (!r) throw new GatewayError(404, "route not found");
    return r;
  }

  list(limit = 50): Route[] {
    return (this.db.prepare("SELECT * FROM routes ORDER BY updated_at DESC LIMIT ?").all(limit) as RouteRow[]).map((r) => this.route(r));
  }

  /** Which route a router session belongs to (a router tool call only knows its own session). */
  routeForRouterSession(routerSessionId: string): Route | undefined {
    const r = this.db.prepare("SELECT * FROM routes WHERE router_session_id = ?").get(routerSessionId) as RouteRow | undefined;
    return r && this.route(r);
  }

  /**
   * Give the router background for the user's next message (used when Helix phones them: the phone speaks the
   * explanation instantly, and the router learns what was said alongside whatever they answer).
   */
  setContext(routeId: string, context: string): void {
    this.db.prepare("UPDATE routes SET pending_context = ? WHERE id = ?").run(context, routeId);
  }

  /** How serious the moment is on this route (set when a call is answered): keeps the personality dialled down all call long. */
  setVoiceSeverity(routeId: string, severity: VoiceSeverity): void {
    this.db.prepare("UPDATE routes SET voice_severity = ? WHERE id = ?").run(severity, routeId);
  }

  voiceSeverity(routeId: string): VoiceSeverity {
    const r = this.db.prepare("SELECT voice_severity AS s FROM routes WHERE id = ?").get(routeId) as { s: VoiceSeverity | null } | undefined;
    return r?.s ?? "normal";
  }

  /** Send the user's message to whoever is currently answering this conversation. */
  send(routeId: string, text: string, opts: VoiceOpts = {}): { sessionId: string; messageId: string; turnId: string } {
    const route = this.mustGet(routeId);
    const pending = this.db.prepare("SELECT pending_context AS c FROM routes WHERE id = ?").get(routeId) as { c: string | null };
    // Context only ever rides along with a message to the router itself; once handed off, it is spent.
    const withContext = pending.c && route.currentSessionId === route.routerSessionId ? `${pending.c}\n\nThe user says: ${text}` : text;
    // On a live call the gateway decides how the reply sounds: Helix's own voice and character, a few sentences at most, whoever answers.
    const callOpts = this.callVoice && this.inCall?.(routeId) ? this.callVoice(routeId, route.currentSessionId === route.routerSessionId ? "front" : "session", opts.severity) : undefined;
    const accepted = this.sendToSession(route.currentSessionId, withContext, callOpts ?? opts, true, routeId);
    if (pending.c) this.db.prepare("UPDATE routes SET pending_context = NULL WHERE id = ?").run(routeId);
    this.touch(routeId);
    this.onUserMessage?.(routeId, text); // a clear goodbye on a call hangs up after the reply
    return { sessionId: route.currentSessionId, ...accepted };
  }

  interrupt(routeId: string): boolean {
    return this.manager.interrupt(this.mustGet(routeId).currentSessionId);
  }

  /** Back to the General Claude (the user said "go back"). */
  reset(routeId: string): Route {
    const route = this.mustGet(routeId);
    this.db.prepare("UPDATE routes SET target_session_id = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), routeId);
    this.bus.publish({
      type: "route.handoff", routeId, fromSessionId: route.currentSessionId, toSessionId: route.routerSessionId, toTitle: route.title, mode: "reset",
    });
    return this.mustGet(routeId);
  }

  /**
   * Point the conversation at another session, optionally delivering the user's request to it right away.
   * Existing sessions are adopted (resumed, or forked if open in a terminal); a project path starts a new one.
   */
  async handoff(routeId: string, spec: HandoffSpec): Promise<HandoffResult> {
    const route = this.mustGet(routeId);
    const given = [spec.session, spec.projectPath].filter(Boolean).length;
    if (given !== 1) throw new GatewayError(400, "give exactly one of: session, projectPath");

    const { session, mode, note } = await this.resolveTarget(spec, true);
    if (session.role === "router") throw new GatewayError(400, "cannot hand a conversation to a router session");
    // "connect me to the agent working on Helix" is an instruction to the router. Delivering it to the target makes the target
    // answer a question that was never meant for it, so a pure connection request connects silently instead.
    const droppedRoutingMessage = isRoutingOnly(spec.message);
    if (droppedRoutingMessage) spec = { ...spec, message: undefined };
    if (spec.message && this.manager.isRunning(session.id)) {
      throw new GatewayError(409, `"${session.title}" is in the middle of a task. Wait for it to finish, or interrupt it first.`);
    }

    const previous = route.targetSessionId;
    this.setTarget(route, session.id);
    let forwarded = false;
    if (spec.message) {
      try {
        this.sendToSession(session.id, spec.message);
        forwarded = true;
      } catch (err) {
        this.db.prepare("UPDATE routes SET target_session_id = ? WHERE id = ?").run(previous ?? null, routeId); // do not strand the user
        throw err;
      }
    }
    this.bus.publish({ type: "route.handoff", routeId, fromSessionId: route.currentSessionId, toSessionId: session.id, toTitle: session.title, mode });
    return { route: this.mustGet(routeId), session, mode, note, forwarded, droppedRoutingMessage: droppedRoutingMessage || undefined };
  }

  private async resolveTarget(spec: HandoffSpec, forConversation = false): Promise<{ session: AgentSession; mode: "resume" | "fork" | "new" | "terminal"; note?: string }> {
    if (spec.projectPath) {
      const session = await this.manager.createSession({
        provider: spec.provider ?? "claude", title: spec.title ?? path.basename(spec.projectPath), projectPath: spec.projectPath,
      });
      return { session, mode: "new" };
    }
    const ref = this.resolveRef(spec.session!);
    const helix = UUID.test(ref) ? this.manager.registry.get(ref) : undefined;
    if (helix) return { session: helix, mode: "resume" };

    const [provider, id] = splitKey(ref);
    if (!provider || !id) throw new GatewayError(404, `no session matches "${spec.session}"`);
    if (!this.indexer) throw new GatewayError(501, "session discovery is disabled");
    // A session open in a terminal is never forked for a conversation: the conversation talks to that same session through its
    // inbox. Only an explicit mode of "fork" (or "resume") asks for anything else.
    if (forConversation && (spec.mode ?? "auto") === "auto" && provider === "claude") {
      const live = this.terminalOf(provider, id);
      if (live) {
        const session = await this.manager.createSession({ provider, title: spec.title ?? live.info.title, projectPath: live.info.projectPath, providerSessionId: live.info.id });
        return { session, mode: "terminal", note: "open in a terminal: messages go straight into that session, no fork" };
      }
    }
    const adopted = await adoptSession(this.manager, this.indexer, provider, id, spec.mode ?? "auto", spec.title);
    return { session: adopted.session, mode: adopted.mode, note: adopted.note };
  }

  /** An alias name resolves to its session; anything else is returned unchanged. */
  private resolveRef(ref: string): string {
    const a = this.alias(ref);
    return a?.sessionKey ?? ref;
  }

  messages(routeId: string, afterSeq = 0, limit = 200): AgentMessage[] {
    return this.manager.messages.listMany(this.mustGet(routeId).visited, afterSeq, limit);
  }

  private setTarget(route: Route, sessionId: string): void {
    const visited = route.visited.includes(sessionId) ? route.visited : [...route.visited, sessionId];
    this.db.prepare("UPDATE routes SET target_session_id = ?, visited = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, JSON.stringify(visited), new Date().toISOString(), route.id);
  }

  private touch(routeId: string): void {
    this.db.prepare("UPDATE routes SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), routeId);
  }

  /* ---------------- finding things ---------------- */

  search(query: string | undefined, opts: { provider?: ProviderName; project?: string; liveOnly?: boolean; limit?: number } = {}):
    { aliases: { name: string; sessionKey?: string; projectPath?: string }[]; sessions: SessionHit[] } {
    const q = (query ?? "").trim();
    const aliases = q ? this.listAliases().filter((a) => a.name.toLowerCase().includes(q.toLowerCase()) || q.toLowerCase().includes(a.name.toLowerCase())) : [];
    const sessions = (this.indexer?.list({
      q: q || undefined, provider: opts.provider, project: opts.project, live: opts.liveOnly ? true : undefined, limit: Math.min(opts.limit ?? 8, 30),
    }) ?? []).map(toHit);
    return { aliases, sessions };
  }

  /** A session by Helix id or "<provider>:<id>" key, with the end of its conversation. */
  summary(ref: string): { session: SessionHit; helixStatus?: string; recent: { role: string; text: string }[] } {
    const resolved = this.resolveRef(ref);
    let info: AgentSessionInfo | undefined;
    let helix: AgentSession | undefined;
    if (UUID.test(resolved)) {
      helix = this.manager.registry.get(resolved);
      if (helix) info = this.indexer?.get(helix.provider, helix.providerSessionId);
    } else {
      const [provider, id] = splitKey(resolved);
      if (provider && id) info = this.indexer?.get(provider, id);
    }
    if (!info && !helix) throw new GatewayError(404, `no session matches "${ref}"`);
    const hit: SessionHit = info ? toHit(info) : {
      ref: `${helix!.provider}:${helix!.providerSessionId}`, helixSessionId: helix!.id, title: helix!.title, project: helix!.projectName,
      provider: helix!.provider, live: false, lastActivityAt: helix!.lastActivityAt,
    };
    const t = info ? this.indexer?.transcript(info.provider, info.id, { limit: 6 }) : undefined;
    return {
      session: hit,
      helixStatus: helix ? (this.manager.isRunning(helix.id) ? "working" : helix.status) : undefined,
      recent: (t?.messages ?? []).filter((m) => m.role !== "tool").map((m) => ({ role: m.role, text: m.text.slice(0, 400) })),
    };
  }

  projects() {
    return this.indexer?.projects() ?? [];
  }

  /** Start a brand-new session in a project (the router tool; does not change the route). */
  async startSession(projectPath: string, title?: string, provider: ProviderName = "claude"): Promise<AgentSession> {
    return this.manager.createSession({ provider, title: title ?? path.basename(projectPath), projectPath });
  }

  /** How a line reaches a terminal session's inbox from here. The gateway replaces it where the pipe is out of reach (session 0). */
  deliverToPeer: (socketPath: string, lines: string[]) => Promise<{ ok: boolean; error?: string }> = (p, l) => writeToPeer(p, l);

  /** A Claude session that is open in a terminal with a reachable inbox, if this is one. */
  private terminalOf(provider: ProviderName, id: string) {
    if (!this.indexer || provider !== "claude") return undefined;
    const info = this.indexer.get("claude", id);
    if (!info?.live) return undefined;
    const peer = findPeer(this.indexer.homes().claudeHome, info.id);
    return peer ? { info, peer } : undefined;
  }

  private readonly relays = new Map<string, Promise<void>>();

  /** A message the user typed in the Chats tab to one session: into the terminal's own inbox when it is open there, else a normal turn. */
  sendMessage(sessionId: string, text: string, opts: VoiceOpts = {}, confirmHeavy = false): { messageId: string; turnId: string } {
    return this.sendToSession(sessionId, text, opts, true, undefined, confirmHeavy);
  }

  /** Open a session from the phone. One that is open in a terminal is not forked (messages go to its inbox); "fork" or "resume" still ask for those. */
  async adopt(provider: ProviderName, id: string, mode: AdoptMode = "auto", title?: string): Promise<{ session: AgentSession; mode: "resume" | "fork" | "terminal"; note?: string }> {
    if (!this.indexer) throw new GatewayError(501, "session discovery is disabled");
    if (mode === "auto" && provider === "claude") {
      const live = this.terminalOf(provider, id);
      if (live) {
        const session = this.manager.registry.findByProviderId(provider, live.info.id)
          ?? await this.manager.createSession({ provider, title: title ?? live.info.title, projectPath: live.info.projectPath, providerSessionId: live.info.id });
        return { session, mode: "terminal", note: "open in a terminal: messages go straight into that session, no fork" };
      }
    }
    return adoptSession(this.manager, this.indexer, provider, id, mode, title);
  }

  /** Set by the gateway: told about every message the user sends in a conversation (to hang up on a goodbye). */
  onUserMessage?: (routeId: string, text: string) => void;
  /** Set by the gateway: is this conversation on a live call right now? */
  inCall?: (routeId: string) => boolean;
  /** Set by the gateway: how replies on a live call are spoken (voice, character, length), for the front door or a handed session. */
  callVoice?: (routeId: string, who: "front" | "session", severity?: VoiceSeverity) => VoiceOpts;
  /** Set by the gateway: hang up the live call the given session is speaking on (no session = the user's current call). False when there is none. */
  hangUp?: (sessionId?: string) => boolean;

  /**
   * One message from the conversation to its current session. A session that is open in a terminal gets it in its own inbox
   * (never a fork, never a second process on the same transcript) and its reply is read back from that transcript; anything
   * else runs a normal Helix turn.
   */
  private sendToSession(sessionId: string, text: string, opts: VoiceOpts = {}, typedByUser = false, routeId?: string, confirmHeavy = false): { messageId: string; turnId: string } {
    const session = this.manager.registry.get(sessionId);
    const live = session && session.role !== "router" && !this.manager.isRunning(sessionId) ? this.terminalOf(session.provider, session.providerSessionId) : undefined;
    if (!session || !live) return this.manager.send(sessionId, text, opts, confirmHeavy);

    const heavy = confirmHeavy ? undefined : this.manager.heavyCheckTranscript(live.info.id);
    if (heavy) {
      throw new GatewayError(409, `That terminal session holds about ${Math.round(heavy.contextTokens / 1000)}k tokens and its cache has expired, so a message re-reads all of that at full price against your usage. ` +
        `Ask the user first.`, { code: "heavy_session", contextTokens: heavy.contextTokens, reason: heavy.reason });
    }
    const userMessage = this.manager.messages.add({ conversationId: sessionId, sessionId, provider: session.provider, sender: "user", text });
    this.bus.publish({ type: "message.created", message: userMessage });
    const turnId = randomUUID();
    this.bus.publish({ type: "session.state", session: this.manager.registry.setStatus(sessionId, "running") });
    const previous = this.relays.get(sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.deliverAndRelay(session, live.info, live.peer, text, turnId, opts, typedByUser, !!routeId && this.inCall?.(routeId) === true)).catch(() => undefined)
      .finally(() => { if (this.relays.get(sessionId) === run) this.relays.delete(sessionId); });
    this.relays.set(sessionId, run);
    return { messageId: userMessage.id, turnId };
  }

  private async deliverAndRelay(session: AgentSession, info: AgentSessionInfo, peer: NonNullable<ReturnType<typeof findPeer>>, text: string, turnId: string, voice: VoiceOpts, typedByUser: boolean, onCall: boolean): Promise<void> {
    const sessionId = session.id;
    const say = (body: string, severity: "info" | "important") => {
      const m = this.manager.messages.add({ conversationId: sessionId, sessionId, provider: session.provider, sender: "system", type: "status", severity, text: body });
      this.bus.publish({ type: "message.created", message: m });
    };
    const idle = () => this.bus.publish({ type: "session.state", session: this.manager.registry.setStatus(sessionId, "idle") });
    try {
      const claudeHome = this.indexer!.homes().claudeHome;
      const file = findClaudeTranscript(claudeHome, info.id);
      const fromOffset = file ? fs.statSync(file).size : 0;
      // A terminal in bypass-permissions mode holds outside messages for approval there, which is no use when the user is away.
      // What the user themselves said or typed on their paired phone needs no second approval: they are the approval. Anything
      // else (text a model composed, such as the handoff's first message) still asks on the phone.
      const bypass = permissionModeOf(claudeHome, info.id) === "bypassPermissions";
      if (bypass && !typedByUser && this.approveTerminalSend) {
        const approved = await this.approveTerminalSend(`Send a message to the open terminal session "${info.title}" (it runs with permissions bypassed):\n${text.slice(0, 600)}`);
        if (!approved) { say("The message to the terminal session was not approved, so nothing was sent.", "important"); return idle(); }
      }
      const sent = await this.deliverToPeer(peer.socketPath, peerLines(peer, text, "Helix", { ...(bypass ? { bypass: true } : {}), ...(onCall ? { call: true } : {}) }));
      if (!sent.ok) { say(`Could not reach the open terminal session "${info.title}" (${sent.error ?? "no answer"}). Nothing was sent, and it was not forked.`, "important"); return idle(); }
      if (!file) { say("Delivered to the terminal session, but its transcript could not be found, so its reply cannot be read back here.", "important"); return idle(); }

      const reply = await followTerminalReply({ file, fromOffset });
      if (reply.kind !== "final") { say(`"${info.title}" did not answer in time. Its reply stays in the terminal.`, "info"); return idle(); }
      const msg = this.manager.messages.add({ conversationId: sessionId, sessionId, provider: session.provider, sender: "agent", text: reply.text });
      this.bus.publish({ type: "message.created", message: msg });
      if (voice.voiceStyle !== undefined) {
        const sentences = new SentenceStream();
        let seq = 0;
        for (const s of [...sentences.push(reply.text), ...sentences.flush()].slice(0, voice.maxSpokenSentences ?? Infinity)) {
          this.bus.publish({ type: "agent.speech", sessionId, turnId, seq: seq++, text: s, ...(voice.voiceEngine ? { engine: voice.voiceEngine, style: voice.voiceSerious ? ("serious" as const) : ("normal" as const) } : {}) });
        }
        this.bus.publish({ type: "agent.speech.end", sessionId, turnId, cancelled: false });
      }
      this.bus.publish({ type: "agent.output.final", sessionId, turnId, text: reply.text, messageId: msg.id, spoken: voice.voiceStyle !== undefined ? (voice.maxSpokenSentences ? limitSpoken(reply.text, voice.maxSpokenSentences) : toSpeech(reply.text)) : undefined });
      idle();
    } catch (err) {
      say(`Could not talk to the terminal session: ${err instanceof Error ? err.message : String(err)}`, "important");
      idle();
    }
  }

  /** Deliver straight into a Claude session that is open in a terminal. Undefined when there is none, so the caller can fall back. */
  private async sendToTerminal(ref: string, text: string, confirmHeavy = false) {
    if (!this.indexer) return undefined;
    const [provider, id] = splitKey(this.resolveRef(ref));
    if (provider !== "claude" || !id) return undefined;
    const info = this.indexer.get("claude", id);
    if (!info?.live) return undefined;
    const target = findPeer(this.indexer.homes().claudeHome, info.id);
    if (!target) return undefined;
    // A message to an idle, huge session starts a turn that re-reads the whole thing, same as sending from the phone.
    const heavy = confirmHeavy ? undefined : this.manager.heavyCheckTranscript(info.id);
    if (heavy) {
      throw new GatewayError(
        409,
        `That terminal session holds about ${Math.round(heavy.contextTokens / 1000)}k tokens and its cache has expired, so a message re-reads all of that at full price against your usage. ` +
          `Ask the user first, or send again with confirmHeavy to continue anyway.`,
        { code: "heavy_session", contextTokens: heavy.contextTokens, reason: heavy.reason, sessionRef: `claude:${info.id}` }
      );
    }
    const base = { delivered: "terminal" as const, title: info.title, name: target.name, status: target.status, sessionRef: `claude:${info.id}` };
    // A terminal in bypass-permissions mode holds outside messages for approval in that terminal, which is no use when the
    // user is away. Ask on their phone instead, and only then deliver as an approved sender.
    const bypass = permissionModeOf(this.indexer.homes().claudeHome, info.id) === "bypassPermissions";
    if (bypass && this.approveTerminalSend) {
      const summary = `Send a message to the open terminal session "${info.title}" (it runs with permissions bypassed):\n${text.slice(0, 600)}`;
      void this.approveTerminalSend(summary).then(async (approved) => {
        if (approved) await this.deliverToPeer(target.socketPath, peerLines(target, text, "Helix", { bypass: true }));
      }).catch(() => undefined);
      return { ...base, delivered: "pending_approval" as const };
    }
    const sent = await this.deliverToPeer(target.socketPath, peerLines(target, text));
    if (!sent.ok) return undefined; // fall back to the normal path rather than failing a send that could still work
    return base;
  }

  /** Set by the gateway: asks the user (on their phone) to approve a message into a bypass-mode terminal. True when approved. */
  approveTerminalSend?: (summary: string) => Promise<boolean>;

  /** Bring an existing session under Helix control without handing the conversation to it. */
  async resume(ref: string, mode?: AdoptMode) {
    return this.resolveTarget({ session: ref, mode });
  }

  /**
   * Send one message to an agent session on behalf of a caller that has no conversation of its own here (a hosted chat).
   * Adopts the session if needed, refuses a busy one, and goes through the same heavy-session guard as the phone.
   * The reply is not awaited: read it with `summary`.
   */
  async sendTo(ref: string, text: string, opts: { mode?: AdoptMode; confirmHeavy?: boolean } = {}) {
    // A session that is open in a terminal has an inbox: talk to the very same session instead of forking a copy of it.
    const live = await this.sendToTerminal(ref, text, opts.confirmHeavy === true);
    if (live) return live;
    const { session, mode, note } = await this.resolveTarget({ session: ref, mode: opts.mode });
    if (session.role === "router") throw new GatewayError(400, "that is the General Claude, not a work session; connect with start/resume tools instead");
    if (this.manager.isRunning(session.id)) {
      throw new GatewayError(409, `"${session.title}" is in the middle of a task. Wait for it to finish, or ask the user to interrupt it first.`, { sessionId: session.id });
    }
    try {
      const sent = this.manager.send(session.id, text, {}, opts.confirmHeavy === true);
      return { session, mode, note, messageId: sent.messageId, turnId: sent.turnId };
    } catch (err) {
      // The session is adopted already; tell the caller its Helix id so a retry reuses it instead of forking again.
      if (err instanceof GatewayError) throw new GatewayError(err.statusCode, err.message, { ...err.details, sessionId: session.id });
      throw err;
    }
  }

  /* ---------------- aliases ---------------- */

  listAliases(): { name: string; sessionKey?: string; projectPath?: string }[] {
    return (this.db.prepare("SELECT * FROM aliases ORDER BY name").all() as any[]).map((r) => ({
      name: r.name, sessionKey: r.session_key ?? undefined, projectPath: r.project_path ?? undefined,
    }));
  }

  alias(name: string): { name: string; sessionKey?: string; projectPath?: string } | undefined {
    return this.listAliases().find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
  }

  setAlias(name: string, target: { sessionKey?: string; projectPath?: string }): void {
    if ([target.sessionKey, target.projectPath].filter(Boolean).length !== 1) throw new GatewayError(400, "give exactly one of: sessionKey, projectPath");
    this.db.prepare(
      "INSERT INTO aliases (name, session_key, project_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET session_key = excluded.session_key, project_path = excluded.project_path"
    ).run(name.trim(), target.sessionKey ?? null, target.projectPath ?? null, new Date().toISOString());
  }

  deleteAlias(name: string): boolean {
    return this.db.prepare("DELETE FROM aliases WHERE name = ?").run(name.trim()).changes === 1;
  }
}

function splitKey(ref: string): [ProviderName | undefined, string | undefined] {
  const i = ref.indexOf(":");
  if (i < 0) return [undefined, undefined];
  const provider = ref.slice(0, i);
  return provider === "claude" || provider === "codex" ? [provider, ref.slice(i + 1)] : [undefined, undefined];
}

function toHit(s: AgentSessionInfo): SessionHit {
  return {
    ref: s.key, helixSessionId: s.helixSessionId, title: s.title, project: s.projectName, provider: s.provider, live: s.live,
    liveStatus: s.liveStatus, lastActivityAt: s.lastActivityAt, preview: s.preview?.slice(0, 160),
  };
}
