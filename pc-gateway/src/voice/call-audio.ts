// When Helix calls the user (an alert, a spoken approval), the words it will say are known the moment the phone starts ringing. The PC
// voice is slower than real time, so the script is recorded WHILE IT RINGS and handed to the phone as one wav when the user answers:
// no waiting for the first sentence. If anything goes wrong the phone simply speaks the script with Apple's voice.
import type { EventBus } from "../sessions/manager.js";
import type { GatewayEvent } from "../types.js";
import { pcmToWav } from "./clip-maker.js";
import { SentenceStream } from "./speech.js";
import type { Synthesizer } from "./tts-pipeline.js";

export type CallAudioState = "rendering" | "ready" | "failed";

export interface CallAudioEntry { state: CallAudioState; wav?: Buffer; seconds?: number; reason?: string }

const KEEP = 8;
const GAP_MS = 250;

export class CallAudio {
  private readonly items = new Map<string, CallAudioEntry>();

  constructor(private readonly bus: EventBus, private readonly tts: Synthesizer, private readonly log?: { warn: (o: object, m: string) => void }) {}

  /** Start listening for calls that ring. Returns the function that stops it. */
  start(): () => void {
    return this.bus.subscribe((e: GatewayEvent) => {
      if (e.type === "call.ringing" && e.call.script) void this.render(e.call.id, e.call.script, e.call.severity === "critical" || e.call.expects === "approval");
    });
  }

  get(callId: string): CallAudioEntry | undefined { return this.items.get(callId); }

  /** Record `script`, sentence by sentence, into one wav. Never throws. */
  async render(callId: string, script: string, serious: boolean): Promise<void> {
    const entry: CallAudioEntry = { state: "rendering" };
    this.items.set(callId, entry);
    while (this.items.size > KEEP) this.items.delete(this.items.keys().next().value as string);
    try {
      const stream = new SentenceStream();
      const sentences = [...stream.push(script), ...stream.flush()];
      const parts: Buffer[] = [];
      let rate = 24000;
      for (const s of sentences) {
        const { pcm, sampleRate } = await this.tts.speak(s, serious ? "serious" : "normal");
        rate = sampleRate;
        parts.push(pcm, Buffer.alloc(Math.round((sampleRate * GAP_MS) / 1000) * 2)); // a short breath between sentences
      }
      if (!parts.length) throw new Error("nothing to say");
      const pcm = Buffer.concat(parts);
      entry.wav = pcmToWav(pcm, rate);
      entry.seconds = Math.round((pcm.length / 2 / rate) * 100) / 100;
      entry.state = "ready";
    } catch (err) {
      entry.state = "failed";
      entry.reason = err instanceof Error ? err.message : String(err);
      this.log?.warn({ callId, reason: entry.reason }, "call audio: the phone will speak this call with its own voice");
    }
  }
}
