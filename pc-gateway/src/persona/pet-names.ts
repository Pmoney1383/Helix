// Pet names for the flirty mode. The user's list is stored in the persona settings and is the pool the model picks from
// ("pick one, now and then") and the canned lines rotate through. Because they end up inside the model's instructions,
// they are validated strictly: letters, spaces, hyphens and apostrophes only, short, never anything that could carry an instruction.

export const DEFAULT_PET_NAMES: readonly string[] = ["gorgeous", "handsome", "babe", "sweetheart", "darling", "trouble"];

export const PET_NAME_PATTERN = /^[A-Za-z][A-Za-z '-]{1,19}$/;
export const MAX_PET_NAMES = 12;

/** In canned lines, this token is replaced by one of the user's pet names (see PersonaService). */
export const PET_TOKEN = "{pet}";

export const fillPet = (line: string, pet: string): string => line.split(PET_TOKEN).join(pet);

/**
 * Words that are used as pet names. A comma in front of one ("what do you need, gorgeous") makes a text-to-speech voice
 * pause as if it were a new clause; spoken, it should flow ("what do you need gorgeous"). Broader than the default list
 * so a name the model improvises, or one the user added, is covered too.
 */
export const COMMON_PET_NAMES: readonly string[] = [
  ...DEFAULT_PET_NAMES, "beautiful", "baby", "honey", "cutie", "love", "handsome stranger", "sunshine", "stranger",
];
