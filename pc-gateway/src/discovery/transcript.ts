import fs from "node:fs";
import type { ProviderName } from "../types.js";

export interface TranscriptMessage {
  /** Stable ordinal within the transcript; new messages only ever append. */
  index: number;
  role: "user" | "assistant" | "tool";
  text: string;
  ts?: string;
  /** Tool name for role "tool". */
  tool?: string;
}

const MAX_TEXT = 8000;
const MAX_READ_BYTES = 24 * 1024 * 1024; // very large transcripts: only the most recent part is rendered
const INJECTED = /^\s*(<(local-command|command-name|command-message|system-reminder|environment_context|user_instructions|user-prompt-submit-hook)|# AGENTS\.md|Caveat:)/i;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) + "…" : s);

function toolSummary(input: unknown): string {
  if (typeof input === "string") return clip(input, 300);
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"].find((k) => typeof o[k] === "string");
  return clip(key ? String(o[key]) : JSON.stringify(o), 300);
}

/** Reads the readable conversation (prompts, replies, tool calls) out of a transcript file. */
export function readTranscript(provider: ProviderName, file: string): TranscriptMessage[] {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const fd = fs.openSync(file, "r");
  let raw: string;
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    raw = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = raw.split("\n");
  if (start > 0) lines.shift(); // first line is probably cut

  const out: TranscriptMessage[] = [];
  const push = (m: Omit<TranscriptMessage, "index">) => out.push({ index: out.length, ...m });

  for (const l of lines) {
    if (!l) continue;
    let j: any;
    try { j = JSON.parse(l); } catch { continue; }
    if (provider === "claude") claudeLine(j, push);
    else codexLine(j, push);
  }
  return out;
}

function claudeLine(j: any, push: (m: Omit<TranscriptMessage, "index">) => void): void {
  if (j.isSidechain) return;
  const ts = typeof j.timestamp === "string" ? j.timestamp : undefined;
  if (j.type === "user") {
    const c = j.message?.content;
    if (typeof c === "string") { if (!INJECTED.test(c)) push({ role: "user", text: clip(c), ts }); return; }
    if (Array.isArray(c) && !c.some((b: any) => b?.type === "tool_result")) {
      const t = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      if (t && !INJECTED.test(t)) push({ role: "user", text: clip(t), ts });
    }
  } else if (j.type === "assistant" && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) push({ role: "assistant", text: clip(b.text), ts });
      else if (b?.type === "tool_use") push({ role: "tool", tool: String(b.name ?? "tool"), text: toolSummary(b.input), ts });
    }
  }
}

function codexLine(j: any, push: (m: Omit<TranscriptMessage, "index">) => void): void {
  if (j.type !== "response_item") return;
  const p = j.payload;
  const ts = typeof j.timestamp === "string" ? j.timestamp : undefined;
  if (p?.type === "message") {
    const text = Array.isArray(p.content)
      ? p.content.filter((b: any) => typeof b?.text === "string").map((b: any) => b.text).join("\n")
      : typeof p.content === "string" ? p.content : "";
    if (!text.trim() || INJECTED.test(text)) return;
    if (p.role === "user") push({ role: "user", text: clip(text), ts });
    else if (p.role === "assistant") push({ role: "assistant", text: clip(text), ts });
  } else if (p?.type === "function_call" || p?.type === "custom_tool_call") {
    push({ role: "tool", tool: String(p.name ?? "tool"), text: toolSummary(p.arguments ?? p.input), ts });
  }
}
