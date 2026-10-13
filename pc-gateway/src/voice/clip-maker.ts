// Which canned lines get a pre-recorded clip, and how a clip file is written. The lines are Helix's own (persona/lines.ts): a greeting,
// the filler said the instant the user stops talking, digest and opener lines. Recording them once means they play with no GPU and no
// waiting, which matters most in the first seconds of a call while the voice model is still loading.
import { CLOSERS, DIGEST, FILLERS, GREETINGS, OPENERS } from "../persona/lines.js";
import { DEFAULT_PET_NAMES, PET_TOKEN, fillPet } from "../persona/pet-names.js";

export interface ClipPlanItem {
  id: string;
  kind: string;
  /** "flirty" = Helix's normal voice, "plain" = the line for a serious moment. */
  voice: "flirty" | "plain";
  text: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Every line the flirty persona can say plus the plain fillers, one clip per pet name where a name goes. Same text is never planned twice. */
export function clipPlan(petNames: readonly string[] = DEFAULT_PET_NAMES): ClipPlanItem[] {
  const out: ClipPlanItem[] = [];
  const seen = new Set<string>();
  const add = (kind: string, voice: "flirty" | "plain", lines: readonly string[]) => {
    lines.forEach((line, i) => {
      const variants = line.includes(PET_TOKEN) ? petNames.map((p) => ({ text: fillPet(line, p), suffix: `-${slug(p)}` })) : [{ text: line, suffix: "" }];
      for (const v of variants) {
        const key = v.text.replace(/\s+/g, " ").trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: `${voice}-${kind}-${i + 1}${v.suffix}`, kind, voice, text: v.text });
      }
    });
  };
  add("greeting", "flirty", GREETINGS.flirty);
  add("filler", "flirty", FILLERS.flirty);
  add("opener-good", "flirty", OPENERS.flirty.good);
  add("opener-problem", "flirty", OPENERS.flirty.problem);
  add("closer", "flirty", CLOSERS.flirty);
  add("digest-quiet", "flirty", DIGEST.flirty.quiet);
  add("digest-busy", "flirty", DIGEST.flirty.busy);
  add("digest-attention", "flirty", DIGEST.flirty.attention);
  add("filler", "plain", FILLERS.professional);
  return out;
}

/** Raw 16-bit mono PCM as a wav file. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
