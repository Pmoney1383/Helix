// Turns the sentences of a spoken reply (agent.speech) into audio (agent.audio), in order, while the reply is still streaming,
// for turns that asked for the PC voice. Anything that goes wrong becomes an agent.audio.unavailable event so the phone can
// fall back to speaking the same text with Apple's voice. Does nothing at all for turns that did not ask for the PC voice.
import type { EventBus } from "../sessions/manager.js";
import type { GatewayEvent } from "../types.js";
import { TtsUnavailable, type TtsStyle } from "./tts-manager.js";

export interface Synthesizer {
  speak(text: string, style: TtsStyle): Promise<{ pcm: Buffer; sampleRate: number }>;
  /** Present when the voice can send audio while it is still being generated. */
  stream?(text: string, style: TtsStyle, onChunk: (pcm: Buffer, sampleRate: number) => void): Promise<void>;
}

/** Smooth playback: the voice generates slower than it plays, so audio is held back until the rest can keep up with it. */
export interface SmoothOpts {
  /** Never hold the first audio longer than this (ms) from the first sentence; 0 turns holding off. */
  maxHoldMs: number;
  /** Speech rate used to estimate how long sentences still being generated will play. */
  charsPerSec?: number;
}
const DEFAULT_CHARS_PER_SEC = 14;
const DEFAULT_RATIO = 1.5; // seconds to generate one second of speech, until a real measurement replaces it

type AudioEvent = Extract<GatewayEvent, { type: "agent.audio" }>;

interface TurnState {
  held: AudioEvent[];
  heldSec: number;
  released: boolean;
  startedAt: number;
  pendingChars: number;
  ratio: number;
  chain: Promise<void>;
  pending: number;
  ended: boolean;
  cancelled: boolean;
  unavailable: boolean;
}

export class TtsPipeline {
  private readonly turns = new Map<string, TurnState>();

  constructor(private readonly bus: EventBus, private readonly tts: Synthesizer, private readonly log?: { warn: (o: object, m: string) => void }, private readonly smooth?: SmoothOpts, private readonly streaming = false) {}

  /** Start listening. Returns the function that stops it. */
  start(): () => void {
    return this.bus.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: GatewayEvent): void {
    if (e.type === "agent.speech" && e.engine === "pc") this.enqueue(e);
    else if (e.type === "agent.speech.end") this.end(e.sessionId, e.turnId, e.cancelled);
  }

  private key(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  private enqueue(e: Extract<GatewayEvent, { type: "agent.speech" }>): void {
    const k = this.key(e.sessionId, e.turnId);
    let t = this.turns.get(k);
    if (!t) { t = { held: [], heldSec: 0, released: this.streaming || !(this.smooth && this.smooth.maxHoldMs > 0), startedAt: Date.now(), pendingChars: 0, ratio: DEFAULT_RATIO, chain: Promise.resolve(), pending: 0, ended: false, cancelled: false, unavailable: false }; this.turns.set(k, t); }
    const turn = t;
    turn.pending++;
    turn.pendingChars += e.text.length;
    // One sentence after another: audio must reach the phone in the order it is to be spoken.
    turn.chain = turn.chain.then(async () => {
      try {
        if (turn.cancelled || turn.unavailable) return;
        if (this.streaming && this.tts.stream) {
          // Streaming voice: forward each ~0.33 s piece the moment it exists. It generates faster than it plays, so nothing is held.
          let part = 0;
          await this.tts.stream(e.text, e.style ?? "normal", (pcm, sampleRate) => {
            if (turn.cancelled) return;
            this.bus.publish({ type: "agent.audio", sessionId: e.sessionId, turnId: e.turnId, seq: e.seq, part: part++, sampleRate, format: "pcm_s16le", data: pcm.toString("base64") });
          });
          turn.pendingChars -= e.text.length;
          return;
        }
        const began = Date.now();
        const { pcm, sampleRate } = await this.tts.speak(e.text, e.style ?? "normal");
        if (turn.cancelled) return;
        const audioSec = pcm.length / (sampleRate * 2);
        turn.pendingChars -= e.text.length;
        if (audioSec > 0.5) turn.ratio = (turn.ratio + (Date.now() - began) / 1000 / audioSec) / 2;
        const audio: AudioEvent = { type: "agent.audio", sessionId: e.sessionId, turnId: e.turnId, seq: e.seq, sampleRate, format: "pcm_s16le", data: pcm.toString("base64") };
        if (turn.released) this.bus.publish(audio);
        else {
          turn.held.push(audio);
          turn.heldSec += audioSec;
          // Safe to start once what is already generated plays at least as long as the rest still takes to generate.
          const restSec = (turn.pendingChars / (this.smooth?.charsPerSec ?? DEFAULT_CHARS_PER_SEC)) * turn.ratio;
          if (turn.heldSec >= restSec || Date.now() - turn.startedAt >= (this.smooth?.maxHoldMs ?? 0)) this.release(turn);
        }
      } catch (err) {
        if (!turn.unavailable && !turn.cancelled) {
          turn.unavailable = true;
          const reason = err instanceof TtsUnavailable ? err.reason : "speech_failed";
          const message = err instanceof Error ? err.message : String(err);
          this.log?.warn({ reason, message }, "tts: falling back to the phone's voice");
          this.bus.publish({ type: "agent.audio.unavailable", sessionId: e.sessionId, turnId: e.turnId, reason, message });
        }
      } finally {
        turn.pending--;
        this.finishIfDone(k, e.sessionId, e.turnId);
      }
    });
  }

  private release(t: TurnState): void {
    t.released = true;
    for (const a of t.held.splice(0)) this.bus.publish(a);
  }

  private end(sessionId: string, turnId: string, cancelled: boolean): void {
    const k = this.key(sessionId, turnId);
    const t = this.turns.get(k);
    if (!t) return; // this turn never asked for the PC voice
    t.ended = true;
    if (cancelled) t.cancelled = true; // whatever is still queued is dropped
    this.finishIfDone(k, sessionId, turnId);
  }

  private finishIfDone(k: string, sessionId: string, turnId: string): void {
    const t = this.turns.get(k);
    if (!t || !t.ended || t.pending > 0) return;
    this.turns.delete(k);
    if (!t.cancelled && !t.unavailable) this.release(t);
    if (!t.cancelled && !t.unavailable) this.bus.publish({ type: "agent.audio.end", sessionId, turnId });
  }
}
