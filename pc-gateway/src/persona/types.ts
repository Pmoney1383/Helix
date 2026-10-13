/**
 * Helix's voice personality: how replies are WORDED when they are spoken to the user. It never changes
 * what is decided, which tools run, or whether information is accurate. See docs/PERSONA.md.
 */
import { DEFAULT_PET_NAMES } from "./pet-names.js";

export type PersonaMode = "professional" | "casual" | "playful" | "flirty" | "unhinged";

/**
 * How serious the moment is. Personality is dialled down as this rises, and important information
 * always wins over character.
 *   info / normal  full personality
 *   warning        say the problem first; only a light touch
 *   high           direct; almost no humour
 *   critical       no jokes, teasing or flirting
 *   approval       asking permission for something destructive: plain and exact
 */
export type VoiceSeverity = "info" | "normal" | "warning" | "high" | "critical" | "approval";

export interface Sliders {
  /** 0..1 each. */
  teasing: number;
  flirtiness: number;
  sarcasm: number;
  /** 0 = as terse as possible, 1 = chatty. */
  verbosity: number;
}

export interface PersonaSettings extends Sliders {
  /** Off = still spoken-style replies, but no personality at all. */
  enabled: boolean;
  mode: PersonaMode;
  /** Preferences only the phone uses (speech rate, pitch, voice). Stored so they follow the user across devices. */
  speech: { rate?: number; pitch?: number; voiceId?: string };
  /** The pet names the flirty mode may use: the model picks one now and then, and the canned lines rotate through them. */
  petNames: string[];
}

export const PERSONA_MODES: readonly PersonaMode[] = ["professional", "casual", "playful", "flirty", "unhinged"];
export const VOICE_SEVERITIES: readonly VoiceSeverity[] = ["info", "normal", "warning", "high", "critical", "approval"];

/** Slider values that go with each mode until the user moves them. */
export const MODE_PRESETS: Record<PersonaMode, Sliders> = {
  professional: { teasing: 0, flirtiness: 0, sarcasm: 0, verbosity: 0.2 },
  casual: { teasing: 0.2, flirtiness: 0, sarcasm: 0.1, verbosity: 0.35 },
  playful: { teasing: 0.6, flirtiness: 0.1, sarcasm: 0.5, verbosity: 0.4 },
  flirty: { teasing: 0.6, flirtiness: 0.85, sarcasm: 0.2, verbosity: 0.4 },
  unhinged: { teasing: 0.8, flirtiness: 0.5, sarcasm: 0.7, verbosity: 0.5 },
};

/** Helix starts professional; the user can pick another mode (casual, playful, flirty, unhinged), and the clamp still strips character from anything serious. */
export const DEFAULT_SETTINGS: PersonaSettings = { enabled: true, mode: "professional", ...MODE_PRESETS.professional, speech: {}, petNames: [...DEFAULT_PET_NAMES] };

/** What actually applies at a given severity, after the safety clamp. */
export interface EffectivePersona extends Sliders {
  mode: PersonaMode;
  severity: VoiceSeverity;
  /** The pool the model may pick a pet name from (only mentioned in the instruction while flirting is allowed). */
  petNames: string[];
}
