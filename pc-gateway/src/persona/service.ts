import { z } from "zod";
import type { Db } from "../storage/sqlite.js";
import { effectivePersona, voiceSeverityFor } from "./clamp.js";
import { CLOSERS, DIGEST, FILLERS, GREETINGS, OPENERS, type Rng, pick } from "./lines.js";
import { DEFAULT_PET_NAMES, MAX_PET_NAMES, PET_NAME_PATTERN, PET_TOKEN, fillPet } from "./pet-names.js";
import { voiceStylePrompt } from "./prompt.js";
import {
  DEFAULT_SETTINGS, MODE_PRESETS, PERSONA_MODES, type EffectivePersona, type PersonaMode, type PersonaSettings,
  VOICE_SEVERITIES, type VoiceSeverity,
} from "./types.js";

const unit = z.number().min(0).max(1);

export const PersonaPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(PERSONA_MODES as [PersonaMode, ...PersonaMode[]]).optional(),
  teasing: unit.optional(),
  flirtiness: unit.optional(),
  sarcasm: unit.optional(),
  verbosity: unit.optional(),
  speech: z.object({
    rate: z.number().min(0).max(1).optional(),
    pitch: z.number().min(0.5).max(2).optional(),
    voiceId: z.string().max(200).optional(),
  }).optional(),
  // Names go into the model's instructions, so only plain short words are accepted.
  petNames: z.array(z.string().trim().regex(PET_NAME_PATTERN, "a pet name is 2 to 20 letters (spaces, hyphens and apostrophes allowed)")).min(1).max(MAX_PET_NAMES).optional(),
}).strict();
export type PersonaPatch = z.infer<typeof PersonaPatchSchema>;

const KEY = "persona";
const GOOD_NEWS = /\b(finished|complete[d]?|done|succe(ss|eded)|passed|ready|built|deployed)\b/i;

/**
 * The user's voice personality: stored settings, the severity clamp, and the pieces that use them
 * (the style instruction for spoken replies, greetings, and light flavouring of routine call scripts).
 */
export class PersonaService {
  constructor(private readonly db: Db, private readonly rng: Rng = Math.random) {}

  get(): PersonaSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = PersonaPatchSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? { ...structuredClone(DEFAULT_SETTINGS), ...parsed.data, speech: parsed.data.speech ?? {} } : structuredClone(DEFAULT_SETTINGS);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  /** Switching mode without touching the sliders applies that mode's preset sliders; explicit sliders always win. */
  update(patch: PersonaPatch): PersonaSettings {
    const current = this.get();
    const next: PersonaSettings = { ...current, ...stripUndefined(patch), speech: { ...current.speech, ...(patch.speech ?? {}) } };
    if (patch.mode && patch.mode !== current.mode) {
      const preset = MODE_PRESETS[patch.mode];
      for (const k of ["teasing", "flirtiness", "sarcasm", "verbosity"] as const) if (patch[k] === undefined) next[k] = preset[k];
    }
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    return next;
  }

  effective(severity: VoiceSeverity, settings = this.get()): EffectivePersona {
    return effectivePersona(settings, severity);
  }

  /** What the app's settings screen shows: how the character fades as things get serious. */
  allEffective(settings = this.get()): Record<VoiceSeverity, EffectivePersona> {
    return Object.fromEntries(VOICE_SEVERITIES.map((s) => [s, effectivePersona(settings, s)])) as Record<VoiceSeverity, EffectivePersona>;
  }

  /** The instruction appended to a reply that will be spoken. */
  voiceStyle(severity: VoiceSeverity = "normal", settings = this.get()): string {
    return voiceStylePrompt(effectivePersona(settings, severity));
  }

  /**
   * The style for a work session the user is talking to (a direct chat, or a session a call was handed to): the same spoken-reply
   * rules, but never the flirty character. That belongs to Helix itself, the front door. Another mode the user picked still applies.
   */
  sessionVoiceStyle(severity: VoiceSeverity = "normal", settings = this.get(), opts: { call?: boolean } = {}): string {
    const s = settings.mode === "flirty" ? { ...settings, mode: "casual" as const, ...MODE_PRESETS.casual } : settings;
    return voiceStylePrompt(effectivePersona(s, severity), opts);
  }

  /** The style for the front door on a live call: the user's persona (professional unless changed), kept to a few sentences. */
  callVoiceStyle(severity: VoiceSeverity = "normal", settings = this.get()): string {
    return voiceStylePrompt(effectivePersona(settings, severity), { call: true });
  }

  /** A canned line may contain {pet}: it becomes one of the user's pet names, a different one each time. */
  private fill(line: string, settings: PersonaSettings): string {
    if (!line.includes(PET_TOKEN)) return line;
    const pool = settings.petNames?.length ? settings.petNames : DEFAULT_PET_NAMES;
    return fillPet(line, pick(pool, this.rng) ?? DEFAULT_PET_NAMES[0]!);
  }

  /** First thing said when the user calls Helix. */
  greeting(settings = this.get()): string {
    const e = effectivePersona(settings, "normal");
    return this.fill(pick(GREETINGS[e.mode], this.rng) ?? GREETINGS.professional[0]!, settings);
  }

  /**
   * A short line to say the moment the user stops talking, while the agent works out its answer ("Mmm... let me check.").
   * In the user's persona, but a serious moment (high, critical, approval) always gets the plain professional line.
   */
  filler(severity: VoiceSeverity = "normal", settings = this.get()): string {
    const e = effectivePersona(settings, severity);
    return this.fill(pick(FILLERS[e.mode], this.rng) ?? FILLERS.professional[0]!, settings);
  }

  /**
   * Personality for the spoken status digest. How serious the digest is decides how much character it gets, through the
   * same dial as everything else: quiet or merely busy = full (info), a watch firing or failing = a light touch
   * (warning), an approval waiting = none (approval). Professional mode and a disabled persona get nothing.
   * The facts are never changed: only an opener, or a different way of saying "nothing is going on".
   */
  digestFlavor(kind: "quiet" | "busy" | "attention" | "urgent", settings = this.get()): { opener?: string; quiet?: string } {
    const severity: VoiceSeverity = kind === "urgent" ? "approval" : kind === "attention" ? "warning" : "info";
    const e = effectivePersona(settings, severity);
    if (severity === "approval" || e.mode === "professional") return {};
    const lines = DIGEST[e.mode];
    if (kind === "quiet") return { quiet: this.fillMaybe(pick(lines.quiet, this.rng), settings) };
    return { opener: this.fillMaybe(pick(kind === "attention" ? lines.attention : lines.busy, this.rng), settings) };
  }

  /**
   * A light touch for routine call scripts. Returns nothing at all for anything urgent (critical, approvals) and in
   * professional mode, so those stay exactly as the neutral wording.
   */
  flavor(c: { severity: "info" | "important" | "critical"; title: string; approval?: boolean }, settings = this.get()): { opener?: string; closer?: string } {
    const vs = voiceSeverityFor(c);
    const e = effectivePersona(settings, vs);
    if (vs === "critical" || vs === "approval" || vs === "high" || e.mode === "professional") return {};
    const good = GOOD_NEWS.test(c.title);
    const opener = this.fillMaybe(pick(good ? OPENERS[e.mode].good : OPENERS[e.mode].problem, this.rng), settings);
    // A teasing tag only on good news, and only when there is room for it (not at "warning").
    const closer = good && vs !== "warning" && e.teasing >= 0.5 ? this.fillMaybe(pick(CLOSERS[e.mode], this.rng), settings) : undefined;
    return { opener, closer };
  }

  private fillMaybe(line: string | undefined, settings: PersonaSettings): string | undefined {
    return line === undefined ? undefined : this.fill(line, settings);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
