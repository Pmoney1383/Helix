import fs from "node:fs";
import path from "node:path";

export interface ContextSize {
  /** Tokens the next turn has to read: input + cache read + cache write of the last assistant message. */
  tokens: number;
  /** When that message was written; the prompt cache is gone about 5 minutes later. */
  at?: number;
}

const TAIL_BYTES = 512 * 1024;

/** Finds ~/.claude/projects/<project>/<id>.jsonl without knowing how the project folder was named. */
export function findClaudeTranscript(claudeHome: string, providerSessionId: string): string | undefined {
  const root = path.join(claudeHome, "projects");
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return undefined; }
  for (const d of dirs) {
    const f = path.join(root, d, `${providerSessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** How big a Claude session's context is right now, read from the tail of its transcript. */
export function claudeContextSize(claudeHome: string, providerSessionId: string): ContextSize | undefined {
  const file = findClaudeTranscript(claudeHome, providerSessionId);
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      // A /compact (or auto-compact) newer than the last reply shrank the context: the old reply's size is history.
      if (line.includes('"compact_boundary"')) {
        let b: any;
        try { b = JSON.parse(line); } catch { continue; }
        if (b.subtype === "compact_boundary") {
          const at = b.timestamp ? Date.parse(b.timestamp) : undefined;
          return { tokens: Number(b.compactMetadata?.postTokens) || 0, at: Number.isFinite(at) ? at : undefined };
        }
        continue;
      }
      if (!line.includes('"usage"')) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; } // the first line of the tail may be cut in half
      if (j.type !== "assistant" || j.isSidechain || !j.message?.usage) continue;
      const u = j.message.usage;
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (tokens <= 0) continue;
      const at = j.timestamp ? Date.parse(j.timestamp) : undefined;
      return { tokens, at: Number.isFinite(at) ? at : undefined };
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return undefined;
}
