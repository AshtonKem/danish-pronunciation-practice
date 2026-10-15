/** A token as written, next to the form used for comparison. */
export interface Token {
  raw: string;
  norm: string;
}

/**
 * Whisper happily writes "15" where the prompt says "femten", and vice versa.
 * Folding both to one form keeps that from being reported as a mispronunciation.
 */
const NUMBERS: Record<string, string> = {
  '0': 'nul',
  '1': 'en',
  '2': 'to',
  '3': 'tre',
  '4': 'fire',
  '5': 'fem',
  '6': 'seks',
  '7': 'syv',
  '8': 'otte',
  '9': 'ni',
  '10': 'ti',
  '11': 'elleve',
  '12': 'tolv',
  '13': 'tretten',
  '14': 'fjorten',
  '15': 'femten',
  '16': 'seksten',
  '17': 'sytten',
  '18': 'atten',
  '19': 'nitten',
  '20': 'tyve',
  '30': 'tredive',
  '40': 'fyrre',
  '50': 'halvtreds',
  '60': 'tres',
  '70': 'halvfjerds',
  '80': 'firs',
  '90': 'halvfems',
  '100': 'hundrede',
  '1000': 'tusind',
};

/** "ét"/"én" carry a stress accent that is orthographic, not phonemic here. */
const ACCENT_FOLD: Record<string, string> = { é: 'e', è: 'e', ê: 'e', ü: 'u', ä: 'æ', ö: 'ø' };

export function normalizeWord(word: string): string {
  const lowered = word
    .toLowerCase()
    .normalize('NFC')
    // Strip anything that is not a letter or digit: ASCII and Danish quotes,
    // dashes, and the sentence punctuation Whisper adds on its own.
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/[éèêüäö]/g, (c) => ACCENT_FOLD[c] ?? c);
  return NUMBERS[lowered] ?? lowered;
}

export function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter((t) => t.norm.length > 0);
}

/** espeak-ng marks primary/secondary stress; stress is not what we grade. */
const STRESS = /[ˈˌ]/g;

export function stripStress(phoneme: string): string {
  return phoneme.replace(STRESS, '');
}
