import fs from "node:fs";

/**
 * A message dropped into a terminal session's inbox is answered in that terminal, so the reply has to be read back from the
 * session's own transcript. This follows the file from the point the message was delivered and reports the agent's final
 * words once its turn ends (a reply with stop_reason "end_turn", or a quiet spell after text with no tool still pending).
 * Read-only: it never writes to the transcript and never throws.
 */

export interface TerminalReplyOpts {
  file: string;
  /** Size of the transcript when the message was delivered: only what comes after counts. */
  fromOffset: number;
  pollMs?: number;
  /** Quiet time after the last text (with no tool pending) that counts as the end of the turn. */
  quietMs?: number;
  /** Give up after this long. */
  maxMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export type TerminalReply = { kind: "final"; text: string } | { kind: "timeout" } | { kind: "aborted" };

interface Block { type?: string; text?: string }

/** Pure parser: feed it transcript lines, it tracks the agent's latest reply. */
export class ReplyTracker {
  /** Text blocks said since the last tool call: what the agent ended on. */
  private texts: string[] = [];
  toolPending = false;
  ended = false;
  sawAssistant = false;

  push(line: string): void {
    if (!line.includes('"assistant"') && !line.includes('"user"')) return;
    let j: any;
    try { j = JSON.parse(line); } catch { return; } // a half-written line is picked up whole next poll
    if (j.isSidechain === true) return; // a sub-agent's chatter is not the session's reply
    if (j.type === "user") {
      // A tool result means the agent is mid-turn; a real new user message would start another turn.
      const c = j.message?.content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) this.toolPending = false;
      return;
    }
    if (j.type !== "assistant") return;
    this.sawAssistant = true;
    const content: Block[] = Array.isArray(j.message?.content) ? j.message.content : [];
    for (const b of content) {
      if (b.type === "tool_use") { this.toolPending = true; this.texts = []; }
      else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) { this.texts.push(b.text.trim()); this.toolPending = false; }
    }
    if (j.message?.stop_reason === "end_turn") this.ended = true;
    else if (j.message?.stop_reason === "tool_use") this.toolPending = true;
  }

  get text(): string { return this.texts.join("\n\n"); }
}

/** Resolves with the agent's reply to a message that was just delivered to its terminal. */
export async function followTerminalReply(opts: TerminalReplyOpts): Promise<TerminalReply> {
  const now = opts.now ?? Date.now;
  const poll = opts.pollMs ?? 700, quiet = opts.quietMs ?? 9000, maxMs = opts.maxMs ?? 15 * 60_000;
  const tracker = new ReplyTracker();
  const started = now();
  let offset = opts.fromOffset, carry = "", lastGrowth = now();
  for (;;) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    try {
      const size = fs.statSync(opts.file).size;
      if (size < offset) { offset = 0; carry = ""; } // rewritten (compaction): start over, nothing is lost by re-reading
      if (size > offset) {
        const fd = fs.openSync(opts.file, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          const parts = (carry + buf.toString("utf8")).split("\n");
          carry = parts.pop() ?? ""; // the last piece may be cut mid-line
          for (const l of parts) tracker.push(l);
          lastGrowth = now();
        } finally { fs.closeSync(fd); }
      }
    } catch { /* the file is briefly unavailable: try again */ }
    if (tracker.ended && !tracker.text) return { kind: "timeout" }; // it finished without saying anything
    if (tracker.text && (tracker.ended ||(!tracker.toolPending && now() - lastGrowth >= quiet))) return { kind: "final", text: tracker.text };
    if (now() - started >= maxMs) return tracker.text ? { kind: "final", text: tracker.text } : { kind: "timeout" };
    await new Promise<void>((r) => setTimeout(r, poll));
  }
}
