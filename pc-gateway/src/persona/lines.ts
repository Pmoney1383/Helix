import type { PersonaMode } from "./types.js";

/**
 * Canned lines for the moments where a spoken line is composed by Helix itself rather than by a model
 * (a call connecting, a routine update ringing the phone). Instant and free, which matters when the phone
 * is ringing. Edit freely: these are just text. Anything that is not routine never uses them (see service.ts).
 */
export const GREETINGS: Record<PersonaMode, string[]> = {
  professional: ["Helix here. How can I help?"],
  casual: ["Hey, what's up?", "Hi. What do you need?", "Hey there. What are we doing?"],
  playful: [
    "Oh wow, you called me voluntarily. I'm touched. What do you need?",
    "Well, look who's calling. What can I do for you?",
    "Hello, hello. Miss me already?",
  ],
  flirty: [
    "Well, well... look who's calling. Miss me already?",
    "Mmm... there you are. I was starting to get bored. What do you need {pet}?",
    "Oh, it's you. Good. I was hoping it would be... now, what are we breaking today?",
    "Hey {pet}. What are we getting into today?",
  ],
  unhinged: [
    "You rang? I was just about to start a very important nap. What's up?",
    "Reporting for duty, mostly. What's the plan?",
    "Oh good, a human. What are we breaking today?",
  ],
};

/** Openers for routine, non-urgent updates (an `important` call about something finishing, say). */
export const OPENERS: Record<PersonaMode, { good: string[]; problem: string[] }> = {
  professional: { good: [], problem: [] },
  casual: { good: ["Good news."], problem: ["Heads up."] },
  playful: { good: ["Good news.", "Well, look at that."], problem: ["Heads up.", "Small wrinkle."] },
  flirty: { good: ["Mmm... good news.", "Good news {pet}."], problem: ["Heads up {pet}.", "Small wrinkle..."] },
  unhinged: { good: ["Plot twist, good news.", "Stop the presses."], problem: ["Okay, don't panic.", "So. About that."] },
};

/** A tag for the end of a good-news update, used only when teasing is turned up. */
export const CLOSERS: Record<PersonaMode, string[]> = {
  professional: [], casual: [], playful: ["Took it long enough.", "Not bad at all."],
  flirty: ["Of course it did.", "I'd expect nothing less from us."],
  unhinged: ["Took it long enough.", "I'd clap if I had hands."],
};

/**
 * Said the instant the user finishes talking, while the agent is still working out an answer, so there is never dead air.
 * Short and in the user's persona. Anything serious gets the professional line (see PersonaService.filler).
 */
export const FILLERS: Record<PersonaMode, string[]> = {
  professional: ["One moment.", "Checking."],
  casual: ["Let me check.", "One sec, checking."],
  playful: ["Ooh, let me check.", "Hang on, let me look."],
  flirty: ["Mmm... let me check.", "One sec {pet}... checking.", "Mmm, hang on... let me look.", "Hold that thought {pet}... checking."],
  unhinged: ["Hold on, consulting the oracle.", "Let me check... dramatically."],
};

/**
 * Lines for the spoken status digest (GET /v1/digest). Every "quiet" line still states the facts (nothing running,
 * nothing waiting): personality only changes how it is said. Openers for a busy or attention digest sit in front of the
 * unchanged facts. Urgent digests (an approval is waiting) never use these.
 */
export const DIGEST: Record<PersonaMode, { quiet: string[]; busy: string[]; attention: string[] }> = {
  professional: { quiet: [], busy: [], attention: [] },
  casual: {
    quiet: ["All quiet. Nothing is running and nothing is waiting.", "Nothing going on right now. Nothing running, nothing waiting."],
    busy: ["Here's the picture."],
    attention: ["Heads up."],
  },
  playful: {
    quiet: ["All quiet. Suspiciously quiet. Nothing is running or waiting.", "Nothing to report. Nothing is running, nothing is waiting. Enjoy it."],
    busy: ["Here's the rundown.", "Here's what's going on."],
    attention: ["Small wrinkle.", "Heads up."],
  },
  flirty: {
    quiet: ["All quiet {pet}. Nothing running... nothing waiting. Just us.", "Nothing going on... nothing running, nothing waiting. Just us."],
    busy: ["Mmm... here's what's going on.", "Here's the picture {pet}."],
    attention: ["Small wrinkle...", "Heads up {pet}."],
  },
  unhinged: {
    quiet: ["Crickets. Absolute crickets. Nothing is running or waiting.", "Nothing. Nada. Nothing is running or waiting, and honestly I'm bored."],
    busy: ["Okay, status report time.", "Buckle up, here's the status."],
    attention: ["Okay, don't panic.", "So. About that."],
  },
};

export type Rng = () => number;

export function pick<T>(list: readonly T[], rng: Rng = Math.random): T | undefined {
  return list.length ? list[Math.min(list.length - 1, Math.floor(rng() * list.length))] : undefined;
}
