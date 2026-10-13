import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentProvider, SendOptions } from "./provider.js";

/** Deterministic provider for tests: echoes the prompt in word-sized deltas. */
export class FakeProvider implements AgentProvider {
  readonly name = "claude" as const;
  readonly calls: SendOptions[] = [];

  constructor(private readonly delayMs = 0) {}

  async createSession(): Promise<{ providerSessionId: string }> {
    return { providerSessionId: randomUUID() };
  }

  async *send(o: SendOptions): AsyncGenerator<AgentEvent> {
    this.calls.push(o);
    const words = `echo(${o.resume ? "resume" : "start"}): ${o.text}`.split(" ");
    let full = "";
    for (const [i, w] of words.entries()) {
      if (o.signal.aborted) return;
      const piece = (i === 0 ? "" : " ") + w;
      full += piece;
      yield { type: "delta", text: piece };
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    yield { type: "final", text: full };
  }
}
