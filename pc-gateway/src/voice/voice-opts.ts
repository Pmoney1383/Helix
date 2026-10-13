import type { PersonaService } from "../persona/service.js";
import type { VoiceSeverity } from "../persona/types.js";

/** How a voice turn is to be spoken. `voiceStyle` present means "this reply will be spoken". */
export interface VoiceOpts {
  voiceStyle?: string;
  /** Speak it with the PC voice (Chatterbox) and send audio, instead of leaving the speaking to the phone. */
  voiceEngine?: "pc";
  /** A serious moment (high, critical, approval): the PC voice then uses its calm, no-added-emotion settings. */
  voiceSerious?: boolean;
  /** How serious the app said this message is (voice messages only); on a call it can still raise or lower the route's own level for one message. */
  severity?: VoiceSeverity;
  /** On a phone call: speak at most this many sentences (the chat keeps the full text). */
  maxSpokenSentences?: number;
}

/** A reply on a call is two or three short sentences; anything beyond this is left to the chat. */
export const CALL_MAX_SENTENCES = 3;

const SERIOUS = new Set<string>(["high", "critical", "approval"]);
export const isSeriousSeverity = (severity: string): boolean => SERIOUS.has(severity);

/**
 * What the app asked for ({ voice, voiceSeverity, engine } on a message) turned into the options the session manager
 * takes. Without `voice: true` (or without a persona to style it) the message is an ordinary typed one.
 */
export function voiceOptions(
  persona: PersonaService | undefined,
  p: { voice?: boolean; voiceSeverity?: string; engine?: "apple" | "pc" },
  fallbackSeverity: string,
  /** "session": a direct chat with a work session, which never gets the flirty character (only Helix itself does). */
  scope: "front" | "session" = "front"
): VoiceOpts {
  if (!p.voice) return {};
  const severity = (p.voiceSeverity ?? fallbackSeverity) as VoiceSeverity;
  const voiceStyle = scope === "session" ? persona?.sessionVoiceStyle(severity) : persona?.voiceStyle(severity);
  if (voiceStyle === undefined) return {};
  return { voiceStyle, voiceEngine: p.engine === "pc" ? "pc" : undefined, voiceSerious: SERIOUS.has(severity), severity };
}
