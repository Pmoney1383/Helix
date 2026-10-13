// Turning an agent's written reply into something worth reading aloud, and cutting a streaming reply into sentences the
// phone can start speaking before the model has finished. Pure functions: no I/O, fully testable.
//
// The persona prompt already asks the model for plain spoken sentences, but models slip (a bullet list, a path, an emoji),
// and a text-to-speech engine reads every stray symbol out loud. This is the safety net on the gateway side so every
// client (phone, CarPlay, anything else) gets clean text.

import { COMMON_PET_NAMES } from "../persona/pet-names.js";

const FENCE = "```";

/** A comma right before a pet name. A voice engine treats it as a clause break and pauses; spoken, the name flows on. */
const PET_COMMA = new RegExp(`\\s*,\\s+(${[...COMMON_PET_NAMES].sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");

/** Characters TTS engines read badly or not at all: emoji, pictographs, variation selectors, joiners. */
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;

const lastSegment = (p: string): string => {
  const trimmed = p.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
};

/** "C:\Users\me\proj\train.log" becomes "train.log"; a folder keeps just its own name. Long paths are noise when spoken. */
function simplifyPaths(s: string): string {
  return s
    .replace(/\b[A-Za-z]:\\[^\s"'<>|*?`]+/g, (m) => stripTrailing(m, lastSegment))
    .replace(/(?<![\w:/.])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, (m) => stripTrailing(m, lastSegment));
}

/** Keep sentence punctuation that happened to be glued to a match. */
function stripTrailing(m: string, f: (x: string) => string): string {
  const tail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? "";
  const body = tail ? m.slice(0, -tail.length) : m;
  return f(body) + tail;
}

/**
 * Plain, speakable text from markdown-ish model output. Idempotent: running it twice changes nothing more.
 * Code blocks are not read out (they are in the chat); links and paths are shortened; markup and emoji are dropped.
 */
export function toSpeech(input: string): string {
  let s = input.replace(/\r\n?/g, "\n").replace(EMOJI, "");

  // Fenced code: never read it aloud. An unclosed fence (a reply cut off mid-block) drops the rest.
  s = s.replace(/```[^\n]*\n?[\s\S]*?```/g, "\nThere is some code in the chat.\n");
  const open = s.indexOf(FENCE);
  if (open >= 0) s = s.slice(0, open) + "\nThere is some code in the chat.\n";

  s = s
    .replace(/<[^>\n]{1,200}>/g, " ")                       // html tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")               // images keep their alt text
    .replace(/\[([^\]]+)\]\((?:[^)\s]+)(?:\s+"[^"]*")?\)/g, "$1") // [label](url) keeps the label
    .replace(/\bhttps?:\/\/[^\s)>\]]+/gi, "a link")         // bare urls
    .replace(/\bwww\.[^\s)>\]]+/gi, "a link");

  s = simplifyPaths(s);

  const lines = s.split("\n").map((raw) => {
    let line = raw.trim();
    if (!line || !/[\p{L}\p{N}]/u.test(line)) return ""; // blank, or nothing but symbols (rules, separators, table dividers)
    line = line
      .replace(/^#{1,6}\s+/, "")                            // headings
      .replace(/^>+\s?/, "")                                // quotes
      .replace(/^[-*+•]\s+/, "")                            // bullets
      .replace(/^\d{1,3}[.)]\s+/, "")                       // numbered items
      .replace(/^\[[ xX]\]\s+/, "");                        // task boxes
    if (line.includes("|") && /^\|.*\|$/.test(raw.trim())) line = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    return line;
  });

  s = lines.filter((l) => l !== "").map((l) => (/[.!?:;,)]["')\]]?$/.test(l) ? l : `${l}.`)).join(" ");

  s = s
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")                  // bold, strike
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1") // emphasis
    .replace(/(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1")
    .replace(/`([^`]*)`/g, "$1")                            // inline code keeps its content
    .replace(/[*_~`#]+(?=\s|$)/g, "")                       // leftover markers
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(PET_COMMA, " $1")                              // "need, gorgeous" is spoken "need gorgeous": no pause before a pet name
    .replace(/([!?])\s*\.(?=\s|$)/g, "$1")                  // "done!." from adding a full stop after one. Never touches "...": an ellipsis is a pause the voice uses
    .replace(/\s{2,}/g, " ")
    .trim();
  return s;
}

/** The first `max` spoken sentences of a finished reply (what a phone call actually says; the chat keeps the whole text). */
export function limitSpoken(text: string, max: number): string {
  const s = new SentenceStream();
  const all = [...s.push(text), ...s.flush()];
  return all.slice(0, max).join(" ");
}

/** Abbreviations whose full stop does not end a sentence. */
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|st|no|approx|fig|inc|ltd)\.$/i;

/**
 * Cuts a streaming reply into sentences. Feed it text as it arrives; it hands back each sentence as soon as it is
 * complete, already cleaned for speech. A sentence ends at . ! ? followed by whitespace, or at a line break, but never
 * inside a code block, a decimal number, a file name, or after an abbreviation.
 */
export class SentenceStream {
  private buffer = "";
  /** A very short fragment ("OK.") is held and joined to the next one so the voice does not stutter. */
  private held = "";

  constructor(private readonly minChars = 12) {}

  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** The turn paused (a tool call) or ended: whatever is buffered is complete now. */
  flush(): string[] {
    const out = this.drain(true);
    if (this.held) { out.push(this.held); this.held = ""; }
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const end = this.nextBoundary(final);
      if (end < 0) break;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      this.emit(raw, out);
    }
    if (final && this.buffer.trim()) { this.emit(this.buffer, out); this.buffer = ""; }
    else if (final) this.buffer = "";
    return out;
  }

  private emit(raw: string, out: string[]): void {
    const spoken = toSpeech(raw);
    if (!spoken) return;
    const joined = this.held ? `${this.held} ${spoken}` : spoken;
    if (joined.length < this.minChars) { this.held = joined; return; }
    this.held = "";
    out.push(joined);
  }

  /** Index just past the end of the first complete sentence in the buffer, or -1 if there is none yet. */
  private nextBoundary(final: boolean): number {
    const b = this.buffer;
    for (let i = 0; i < b.length; i++) {
      const c = b[i]!;
      if (b.startsWith(FENCE, i)) {
        // A fenced code block is one unit. Text before it is complete as soon as the fence starts; the block itself
        // is complete only once it closes (until then nothing in it is ever released).
        if (b.slice(0, i).trim() !== "") return i;
        const close = b.indexOf(FENCE, i + FENCE.length);
        if (close < 0) return -1;
        let end = close + FENCE.length;
        if (b[end] === "\n") end++;
        return end;
      }
      if (c === "\n") {
        if (b.slice(0, i).trim() === "") continue;           // leading blank lines
        return i + 1;
      }
      if (c === "." || c === "!" || c === "?") {
        let j = i + 1;
        while (j < b.length && /["')\]]/.test(b[j]!)) j++;     // closing quote/bracket belongs to the sentence
        if (j >= b.length) { if (final) return b.length; return -1; } // need the next character to know it ended
        if (!/\s/.test(b[j]!)) { i = j - 1; continue; }        // "3.5", "app.py", "a.b": not an end
        if (c === "." && ABBREV.test(b.slice(0, i + 1))) continue;
        if (c === "." && /\b[A-Z]$/.test(b.slice(Math.max(0, i - 1), i))) continue; // an initial: "J. Smith"
        return j;
      }
    }
    return -1;
  }
}
