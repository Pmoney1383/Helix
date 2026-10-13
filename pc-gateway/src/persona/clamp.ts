import type { EffectivePersona, PersonaMode, PersonaSettings, VoiceSeverity } from "./types.js";

/**
 * The safety rule of the personality layer, in one place: the more serious the moment, the less character.
 * Multipliers apply to the user's slider values. Ordinary conversation and routine events keep the full personality; an
 * event that needs attention ("warning") keeps a light touch of it, flirting included; anything serious ("high" and above,
 * critical alerts, approvals) has no flirting, and critical alerts and approvals have no character at all.
 */
const SCALE: Record<VoiceSeverity, { teasing: number; flirtiness: number; sarcasm: number; maxVerbosity: number; maxMode: PersonaMode }> = {
  info:     { teasing: 1,    flirtiness: 1, sarcasm: 1,    maxVerbosity: 1,   maxMode: "unhinged" },
  normal:   { teasing: 1,    flirtiness: 1, sarcasm: 1,    maxVerbosity: 1,   maxMode: "unhinged" },
  warning:  { teasing: 0.35, flirtiness: 0.4, sarcasm: 0.35, maxVerbosity: 0.7, maxMode: "playful" },
  high:     { teasing: 0.1,  flirtiness: 0, sarcasm: 0.1,  maxVerbosity: 0.5, maxMode: "casual" },
  critical: { teasing: 0,    flirtiness: 0, sarcasm: 0,    maxVerbosity: 0.3, maxMode: "professional" },
  approval: { teasing: 0,    flirtiness: 0, sarcasm: 0,    maxVerbosity: 0.3, maxMode: "professional" },
};

// flirty sits level with playful: a mode is only held back when it outranks what the moment allows.
const MODE_RANK: Record<PersonaMode, number> = { professional: 0, casual: 1, playful: 2, flirty: 2, unhinged: 3 };
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function effectivePersona(s: PersonaSettings, severity: VoiceSeverity): EffectivePersona {
  const k = SCALE[severity];
  if (!s.enabled) {
    return { severity, mode: "professional", teasing: 0, flirtiness: 0, sarcasm: 0, verbosity: Math.min(clamp01(s.verbosity), k.maxVerbosity), petNames: [] };
  }
  const mode = MODE_RANK[s.mode] > MODE_RANK[k.maxMode] ? k.maxMode : s.mode;
  return {
    severity, mode,
    teasing: round(clamp01(s.teasing) * k.teasing),
    flirtiness: round(clamp01(s.flirtiness) * k.flirtiness),
    sarcasm: round(clamp01(s.sarcasm) * k.sarcasm),
    verbosity: round(Math.min(clamp01(s.verbosity), k.maxVerbosity)),
    petNames: s.petNames ?? [],
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The voice severity for a call or alert, from the gateway's own severity and what it is asking for. */
export function voiceSeverityFor(c: { severity: "info" | "important" | "critical"; approval?: boolean }): VoiceSeverity {
  if (c.approval) return "approval";
  return c.severity === "critical" ? "critical" : c.severity === "important" ? "warning" : "info";
}
