/**
 * Did the user just say goodbye? Used on a live call only, so the call can end by itself after the reply.
 *
 * Deliberately loose (the phone's speech recognition drops and adds words), but only for SHORT utterances: a goodbye is a
 * few words, and "can you say bye to the cat session and then check the logs" is work, not a farewell. Anything negated
 * ("don't hang up", "not yet, bye is not what I meant") is left alone.
 */

const FAREWELL = [
  /\bgood ?bye\b/, /\bbye( ?bye)?\b/, /\bsee (you|ya)\b/, /\btalk (to you )?(later|soon|tomorrow)\b/, /\bspeak (to you )?(later|soon)\b/,
  /\bcatch (you|ya) later\b/, /\bthat('?s| is| was) (all|it)( for now| for today)?\b/, /\bthat will be all\b/, /\bhang up\b/, /\bend (the|this) (call|conversation)\b/,
  /\bgotta go\b/, /\bi (have|got) to go\b/, /\bi'?m (done|off)\b/, /\btake care\b/, /\bgood ?night\b/, /\bcheers\b/, /\bthanks? (for now|that'?s all)\b/,
];
const NEGATION = /\b(don'?t|do not|dont|not|never|without|wait|hold on|before)\b/;
const MAX_WORDS = 9;

export function isGoodbye(text: string): boolean {
  const t = text.toLowerCase().replace(/[“”"]/g, "").replace(/[^a-z0-9' ?]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.includes("?")) return false;
  const words = t.split(" ");
  if (words.length > MAX_WORDS || NEGATION.test(t)) return false;
  if (words.length <= 2 && ["later", "laters", "ciao", "peace", "adios", "cya"].includes(words[0]!)) return true;
  return FAREWELL.some((re) => re.test(t));
}
