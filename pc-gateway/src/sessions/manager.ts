import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AgentProvider } from "../providers/provider.js";
import type { AgentSession, GatewayEvent, ProviderName } from "../types.js";
import type { AgentTokens } from "../mcp/scopes.js";
import type { PolicyEngine } from "../permissions/policy.js";
import { routerPrompt } from "../router/prompt.js";
import { SentenceStream, limitSpoken, toSpeech } from "../voice/speech.js";
import type { VoiceOpts } from "../voice/voice-opts.js";
import { claudeContextSize } from "../usage/context.js";
import type { UsageStore } from "../usage/store.js";
import type { MessageStore, SessionRegistry } from "./registry.js";

export class EventBus extends EventEmitter {
  publish(event: GatewayEvent): void {
    this.emit("event", event);
  }
  subscribe(fn: (e: GatewayEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export class GatewayError extends Error {
  constructor(readonly statusCode: number, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface CreateSessionInput {
  provider: ProviderName;
  title: string;
  projectPath?: string;
  /** Import an existing provider session (e.g. a Claude session started in a terminal). */
  providerSessionId?: string;
  /** Branch from an existing provider session instead of continuing it (safe while it is open elsewhere). */
  forkFrom?: string;
  role?: "agent" | "router";
}

export class SessionManager {
  private readonly turns = new Map<string, AbortController>();
  private gate?: { tokens: AgentTokens; baseUrl: () => string | undefined };
  private policy?: PolicyEngine;
  private usage?: UsageStore;
  private guard?: { claudeHome: string; maxTokens: number; coldMs: number };
  /**
   * Codex configures its tools per thread, not per turn, so a Codex router needs one credential that lasts as long as
   * the session (it dies with the gateway process; a restarted thread gets a fresh one). Claude routers use per-turn tokens.
   */
  private readonly routerTokens = new Map<string, string>();

  constructor(
    readonly registry: SessionRegistry,
    readonly messages: MessageStore,
    private readonly providers: Partial<Record<ProviderName, AgentProvider>>,
    readonly bus: EventBus,
    private readonly defaultProjectPath: string,
    private readonly log: { error: (o: object, m: string) => void; info?: (o: object, m: string) => void }
  ) {}

  /** Lets agents that ask for approval over their own protocol (Codex) be gated by the same policy as everything else. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
  }

  /** Records what each turn consumed (see usage/store.ts). */
  setUsage(usage: UsageStore): void {
    this.usage = usage;
  }

  /**
   * Stops a message from silently re-reading a huge Claude context: a turn on a session above `maxTokens` whose prompt
   * cache has expired (or that is a fresh fork) rewrites the whole thing at full price. The client must confirm.
   */
  setHeavyGuard(g: { claudeHome: string; maxTokens: number; coldMs: number }): void {
    this.guard = g.maxTokens > 0 ? g : undefined;
  }

  usageSummary(hours: number) {
    return this.usage?.summary(hours) ?? [];
  }

  /** What the next turn on this session would cost to start, or undefined when it is not heavy. */
  heavyCheck(session: AgentSession): { contextTokens: number; reason: "cold" | "fork" } | undefined {
    if (!this.guard || session.provider !== "claude" || session.role === "router") return undefined;
    const fork = session.turnCount === 0 && !!session.forkFrom;
    const source = fork ? session.forkFrom! : session.providerSessionId;
    const size = claudeContextSize(this.guard.claudeHome, source);
    if (!size || size.tokens < this.guard.maxTokens) return undefined;
    if (fork) return { contextTokens: size.tokens, reason: "fork" };
    const cold = size.at === undefined || Date.now() - size.at > this.guard.coldMs;
    return cold ? { contextTokens: size.tokens, reason: "cold" } : undefined;
  }

  /** The same check for a Claude session Helix does not run (open in a terminal): waking it with a cold cache re-reads everything. */
  heavyCheckTranscript(providerSessionId: string): { contextTokens: number; reason: "cold" } | undefined {
    if (!this.guard) return undefined;
    const size = claudeContextSize(this.guard.claudeHome, providerSessionId);
    if (!size || size.tokens < this.guard.maxTokens) return undefined;
    const cold = size.at === undefined || Date.now() - size.at > this.guard.coldMs;
    return cold ? { contextTokens: size.tokens, reason: "cold" } : undefined;
  }

  /** Routes agent permission prompts through the gateway's MCP endpoint (see mcp/). */
  enableAgentGate(tokens: AgentTokens, baseUrl: () => string | undefined): void {
    this.gate = { tokens, baseUrl };
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    const provider = this.providerFor(input.provider);
    const projectPath = input.projectPath ?? this.defaultProjectPath;
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new GatewayError(400, `projectPath is not a directory: ${projectPath}`);
    }

    if (input.providerSessionId) {
      const existing = this.registry.findByProviderId(input.provider, input.providerSessionId);
      if (existing) return existing;
      return this.registry.create({
        provider: input.provider, providerSessionId: input.providerSessionId,
        title: input.title, projectPath, imported: true,
      });
    }
    if (input.forkFrom && provider.forkSession) {
      // This provider needs the branch to exist (and have an id) before the first message.
      const forked = await provider.forkSession(input.forkFrom, { projectPath });
      return this.registry.create({
        provider: input.provider, providerSessionId: forked.providerSessionId, title: input.title, projectPath, imported: true, role: input.role,
      });
    }
    // A Codex router is configured when its thread is created, with a credential that names the session: allocate the id first.
    const url = this.gate?.baseUrl();
    const id = input.role === "router" && input.provider === "codex" && url && this.gate ? randomUUID() : undefined;
    const routerToken = id && this.gate ? this.gate.tokens.issue({ scope: "pc.router", sessionId: id, actor: `router:${id}` }) : undefined;
    const routing = id && url && routerToken ? { mcp: { url, token: routerToken }, instructions: routerPrompt("Astra") } : undefined;
    let providerSessionId: string;
    try {
      ({ providerSessionId } = await provider.createSession({ projectPath, routing }));
    } catch (err) {
      if (routerToken) this.gate?.tokens.revoke(routerToken);
      throw err;
    }
    if (id && routerToken) this.routerTokens.set(id, routerToken);
    return this.registry.create({
      id, provider: input.provider, providerSessionId, title: input.title, projectPath, forkFrom: input.forkFrom, role: input.role,
    });
  }

  /**
   * Accepts the message and runs the turn in the background; output is delivered
   * through the event bus. Throws 409 if the session is mid-turn.
   */
  send(sessionId: string, text: string, opts: VoiceOpts = {}, confirmHeavy = false): { messageId: string; turnId: string } {
    const session = this.registry.get(sessionId);
    if (!session) throw new GatewayError(404, "session not found");
    if (this.turns.has(sessionId)) throw new GatewayError(409, "session is already running a turn");
    const heavy = confirmHeavy ? undefined : this.heavyCheck(session);
    if (heavy) {
      const k = Math.round(heavy.contextTokens / 1000);
      throw new GatewayError(
        409,
        `This session holds about ${k}k tokens and ${heavy.reason === "fork" ? "branching it" : "its cache has expired, so continuing it"} re-reads all of that at full price against your usage. ` +
          `Start a fresh session instead, or send again with confirmHeavy to continue anyway.`,
        { code: "heavy_session", contextTokens: heavy.contextTokens, reason: heavy.reason }
      );
    }
    const provider = this.providerFor(session.provider);

    const userMessage = this.messages.add({
      conversationId: sessionId, sessionId, provider: session.provider, sender: "user", text,
    });
    this.bus.publish({ type: "message.created", message: userMessage });

    const turnId = randomUUID();
    const controller = new AbortController();
    this.turns.set(sessionId, controller);
    this.bus.publish({ type: "session.state", session: this.registry.setStatus(sessionId, "running") });

    const url = this.gate?.baseUrl();
    // A Codex router keeps one credential for as long as this process lives, also when the session predates it
    // (the gateway was restarted): Codex bakes the credential into the thread when it loads it, so a per-turn token
    // revoked at the end of the first turn would leave the router's tools unusable from the second turn on.
    const lastingKind = session.role === "router" && session.provider === "codex";
    let lasting = this.routerTokens.get(sessionId);
    if (!lasting && lastingKind && url && this.gate) {
      lasting = this.gate.tokens.issue({ scope: "pc.router", sessionId, actor: `router:${sessionId}` });
      this.routerTokens.set(sessionId, lasting);
    }
    const token = lasting ?? (url && this.gate
      ? this.gate.tokens.issue({ scope: session.role === "router" ? "pc.router" : "pc.agent.full", sessionId, actor: `${session.role}:${sessionId}` })
      : undefined);
    const mcp = url && token ? { url, token } : undefined;

    void this.runTurn(session, provider, text, turnId, controller, mcp, opts).finally(() => {
      this.turns.delete(sessionId);
      if (token && !lasting) this.gate?.tokens.revoke(token);
    });
    return { messageId: userMessage.id, turnId };
  }

  interrupt(sessionId: string): boolean {
    const c = this.turns.get(sessionId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  private async runTurn(
    session: AgentSession, provider: AgentProvider, text: string, turnId: string, controller: AbortController,
    mcp?: { url: string; token: string },
    voice: VoiceOpts = {}
  ): Promise<void> {
    const voiceStyle = voice.voiceStyle;
    const sessionId = session.id;
    let finalText: string | undefined;
    let failure: string | undefined;
    // A reply that will be spoken (the message was sent with voice: true) is also delivered as speech-ready sentences.
    const sentences = voiceStyle !== undefined ? new SentenceStream() : undefined;
    let speechSeq = 0;
    const speak = (text: string) => speechSeq >= (voice.maxSpokenSentences ?? Infinity) ? undefined : this.bus.publish({
      type: "agent.speech", sessionId, turnId, seq: speechSeq++, text,
      ...(voice.voiceEngine ? { engine: voice.voiceEngine, style: voice.voiceSerious ? ("serious" as const) : ("normal" as const) } : {}),
    });
    // The end of a spoken turn is announced either way, so a listener (the PC voice) knows when to stop and whether to drop what is queued.
    const endSpeech = (cancelled: boolean) => { if (sentences) this.bus.publish({ type: "agent.speech.end", sessionId, turnId, cancelled }); };

    try {
      const events = provider.send({
        providerSessionId: session.providerSessionId,
        forkFrom: session.turnCount === 0 ? session.forkFrom : undefined,
        approve: this.policy
          ? async (ask) => {
              const d = await this.policy!.authorize({ tool: ask.tool, input: ask.input }, { sessionId, source: "agent", signal: controller.signal });
              return { allow: d.allowed, reason: d.message };
            }
          : undefined,
        voiceStyle,
        appendSystemPrompt: session.role === "router" ? routerPrompt(session.provider === "codex" ? "Astra" : "General Claude") : undefined,
        routingOnly: session.role === "router",
        sessionId,
        projectPath: session.projectPath,
        mcp,
        text,
        resume: session.turnCount > 0,
        signal: controller.signal,
      });
      for await (const ev of events) {
        if (ev.type === "delta") {
          this.bus.publish({ type: "agent.output.delta", sessionId, turnId, text: ev.text });
          for (const s of sentences?.push(ev.text) ?? []) speak(s);
        } else if (ev.type === "tool") {
          // A tool call ends whatever the agent was saying: speak it now rather than gluing it to the next message.
          for (const s of sentences?.flush() ?? []) speak(s);
          this.bus.publish({ type: "agent.tool", sessionId, turnId, name: ev.name });
        } else if (ev.type === "final") {
          finalText = ev.text;
          if (ev.usage) {
            try { this.usage?.record(sessionId, session.provider, { ...ev.usage, costUsd: ev.costUsd }); } catch { /* telemetry must never fail a turn */ }
            this.log.info?.({ sessionId, ...ev.usage }, "turn usage");
          }
        }
        else failure = ev.message;
      }
      if (!controller.signal.aborted) for (const s of sentences?.flush() ?? []) speak(s);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      this.log.error({ err, sessionId }, "turn failed");
    }

    endSpeech(controller.signal.aborted);
    if (controller.signal.aborted) {
      this.postSystem(sessionId, session.provider, "Interrupted.", "info");
      this.finish(sessionId, "idle", false);
      return;
    }
    if (failure !== undefined || finalText === undefined) {
      this.postSystem(sessionId, session.provider, failure ?? "Agent returned no response.", "important");
      this.finish(sessionId, "error", false);
      return;
    }

    const msg = this.messages.add({
      conversationId: sessionId, sessionId, provider: session.provider, sender: "agent", text: finalText,
    });
    this.bus.publish({ type: "message.created", message: msg });
    this.bus.publish({ type: "agent.output.final", sessionId, turnId, text: finalText, messageId: msg.id, spoken: sentences ? (voice.maxSpokenSentences ? limitSpoken(finalText, voice.maxSpokenSentences) : toSpeech(finalText)) : undefined });
    this.finish(sessionId, "idle", true);
  }

  /** A turn only counts toward "resume next time" if the provider actually saw the session. */
  private finish(sessionId: string, status: "idle" | "error", completed: boolean): void {
    const s = completed ? this.registry.completeTurn(sessionId, status) : this.registry.setStatus(sessionId, status);
    this.bus.publish({ type: "session.state", session: s });
  }

  private postSystem(sessionId: string, provider: ProviderName, text: string, severity: "info" | "important"): void {
    const m = this.messages.add({
      conversationId: sessionId, sessionId, provider, sender: "system", type: "status", severity, text,
    });
    this.bus.publish({ type: "message.created", message: m });
  }

  private providerFor(name: ProviderName): AgentProvider {
    const p = this.providers[name];
    if (!p) throw new GatewayError(400, `provider "${name}" is not available`);
    return p;
  }
}
