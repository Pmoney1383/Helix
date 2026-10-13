export type ProviderName = "claude" | "codex";
export type SessionStatus = "running" | "idle" | "stopped" | "error";

export interface AgentSession {
  id: string;
  provider: ProviderName;
  providerSessionId: string;
  title: string;
  projectPath?: string;
  projectName?: string;
  status: SessionStatus;
  managed: boolean;
  turnCount: number;
  /** "router" sessions are the General Claude front door: hidden from session lists, limited to routing tools. */
  role: "agent" | "router";
  /** Set until the first turn completes on a forked session: the provider session it branches from. */
  forkFrom?: string;
  lastActivityAt: string;
  createdAt: string;
  tags: string[];
}

export interface AgentMessage {
  /** Monotonic per-gateway sequence; clients sync with ?after=<seq>. */
  seq: number;
  id: string;
  conversationId: string;
  sessionId?: string;
  provider?: ProviderName;
  sender: "user" | "agent" | "system";
  type: "text" | "status" | "approval" | "event";
  severity: "info" | "important" | "critical";
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface Approval {
  id: string;
  sessionId?: string;
  /** Who is asking: the Claude permission gate, a PC tool, or an explicit request_user_approval call. */
  source: "agent" | "tool" | "request";
  tool: string;
  summary: string;
  reasons: string[];
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

export type GatewayEvent =
  | { type: "session.state"; session: AgentSession }
  | { type: "message.created"; message: AgentMessage }
  | { type: "agent.output.delta"; sessionId: string; turnId: string; text: string }
  | { type: "agent.tool"; sessionId: string; turnId: string; name: string }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval }
  | { type: "agent.session.changed"; session: AgentSessionInfo }
  | { type: "route.created"; routeId: string; routerSessionId: string }
  | { type: "call.ringing"; call: Call }
  | { type: "call.answered"; call: Call }
  | { type: "call.ended"; call: Call }
  /** The agent (or a clear goodbye from the user) asked to hang up. With `afterSpeech` the phone finishes speaking the reply first, then ends the call. */
  | { type: "call.hangup"; call: Call; afterSpeech: boolean }
  | { type: "route.handoff"; routeId: string; fromSessionId: string; toSessionId: string; toTitle: string; mode: "resume" | "fork" | "new" | "terminal" | "reset" }
  | ({ type: "watch.triggered" } & WatchEventPayload)
  | ({ type: "watch.resolved" } & WatchEventPayload)
  /**
   * One complete, speech-ready sentence of a reply, emitted while the reply is still streaming (voice turns only: the
   * message was sent with `voice: true`). The phone speaks these in order instead of waiting for the whole answer.
   * `seq` counts from 0 within the turn; markdown, links, paths and emoji are already cleaned out.
   */
  | { type: "agent.speech"; sessionId: string; turnId: string; seq: number; text: string; engine?: "pc"; style?: "normal" | "serious" }
  /** A spoken turn has produced all its sentences. `cancelled` = it was interrupted: drop anything still queued. */
  | { type: "agent.speech.end"; sessionId: string; turnId: string; cancelled: boolean }
  /**
   * PC voice: audio of one sentence (raw PCM, signed 16-bit little-endian, mono), base64. Play them in arrival order. With the
   * streaming voice a sentence arrives in pieces: several events share a `seq` and carry `part` 0, 1, 2... (about 0.33 s each);
   * without it each sentence is one event and `part` is absent.
   */
  | { type: "agent.audio"; sessionId: string; turnId: string; seq: number; part?: number; sampleRate: number; format: "pcm_s16le"; data: string }
  /** PC voice: no more audio for this turn. */
  | { type: "agent.audio.end"; sessionId: string; turnId: string }
  /** PC voice could not speak (turned off, GPU or RAM busy, failed to start): speak the agent.speech text with Apple's voice instead. */
  | { type: "agent.audio.unavailable"; sessionId: string; turnId: string; reason: string; message: string }
  /** `spoken` is the whole reply cleaned for speech (voice turns only); the sentences above are the same text in pieces. */
  | { type: "agent.output.final"; sessionId: string; turnId: string; text: string; messageId: string; spoken?: string };

/** Shape of watcher events as they travel over the WebSocket (full model lives in monitoring/watch-types.ts). */
export interface WatchEventPayload {
  watch: { id: string; name: string; type: string; sessionId?: string };
  event: { id: string; kind: "triggered" | "resolved" | "match" | "error"; severity: "info" | "important" | "critical"; summary: string; detail?: string; ts: string };
}

export type CallStatus = "ringing" | "answered" | "ended" | "missed" | "declined" | "failed";

/** A phone call between Helix and the user. */
export interface Call {
  id: string;
  /** "incoming" = Helix rings the user; "outgoing" = the user calls Helix. */
  direction: "incoming" | "outgoing";
  status: CallStatus;
  severity: "info" | "important" | "critical";
  title: string;
  /** What happened, in a sentence or two (for the call screen). */
  summary: string;
  /** What to say first when the call is answered: written to be spoken aloud. */
  script: string;
  /** "approval": the user answers approve/reject (see POST /v1/calls/:id/decision). "conversation": talk through the route. */
  expects: "approval" | "conversation";
  sessionId?: string;
  approvalId?: string;
  /** Set once answered (or immediately for outgoing calls): the conversation to speak into. */
  routeId?: string;
  deviceId?: string;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  endReason?: string;
  /** Outgoing calls only (not stored): how long the phone should play a ringback tone before it starts talking, 1 to 3 seconds, different every call. */
  ringbackMs?: number;
  /** Outgoing calls only (not stored): the pre-recorded clip of `script` in the PC voice, when one exists. Play it instead of speaking the greeting. */
  scriptClip?: { id: string; seconds: number; url: string };
}

/** A Claude/Codex session found on this machine, whether or not Helix started it. */
export interface AgentSessionInfo {
  /** "<provider>:<providerSessionId>" */
  key: string;
  provider: ProviderName;
  id: string;
  title: string;
  projectPath?: string;
  projectName?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: string;
  lastActivityAt?: string;
  messageCount: number;
  /** Most recent assistant text, else the latest prompt. For list rows. */
  preview?: string;
  lastUser?: string;
  /** When the latest real prompt was sent: the start of the current or last turn. */
  lastUserAt?: string;
  lastAssistant?: string;
  /** A process currently has this session open. */
  live: boolean;
  liveStatus?: "busy" | "idle";
  livePid?: number;
  liveName?: string;
  liveKind?: string;
  liveSinceMs?: number;
  /** True when liveness is a guess from file activity (Codex) rather than a process registry (Claude). */
  liveInferred?: boolean;
  /** Helix already manages this session (started or adopted through the gateway). */
  managed: boolean;
  helixSessionId?: string;
}
