/** Phonemes grouped per word, as espeak-ng split them. */
export type PhonemeGroups = string[][];

export interface PhonemizeItem {
  phoneme_ids?: number[];
  phonemes?: string[] | string;
}

/** Markers Piper interleaves into id sequences; never part of a pronunciation. */
const NON_PHONEMES = new Set(['_', '^', '$']);
const PUNCTUATION = /^[.,!?;:()"'«»„“”\-–—…]+$/u;
/** Primary and secondary stress arrive as their own array entries. */
const STRESS = /^[ˈˌ]+$/u;
/** Combining diacritics likewise: "ɐ̯" shows up as "ɐ" followed by U+032F. */
const COMBINING = /^\p{M}+$/u;

export function toPhonemeStrings(
  item: PhonemizeItem,
  idToPhoneme: Map<number, string>,
): string[] {
  if (Array.isArray(item.phonemes)) return item.phonemes.map(String);
  if (typeof item.phonemes === 'string') return [...item.phonemes];
  return (item.phoneme_ids ?? [])
    .map((id) => idToPhoneme.get(id))
    .filter((phoneme): phoneme is string => phoneme !== undefined);
}

/**
 * Turn espeak's raw symbol stream into one entry per pronounced sound, grouped
 * by word.
 *
 * espeak emits a space phoneme between words, which gives us the grouping. It
 * also emits stress and combining marks as standalone symbols: stress is
 * dropped (we grade sounds, not emphasis) and a combining mark is folded into
 * the sound it modifies, so "ɐ" + U+032F compares and renders as one unit.
 */
export function splitWords(phonemes: string[]): PhonemeGroups {
  const groups: PhonemeGroups = [];
  let current: string[] = [];

  for (const phoneme of phonemes) {
    if (phoneme === '' || phoneme.trim() === '') {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    if (NON_PHONEMES.has(phoneme) || PUNCTUATION.test(phoneme) || STRESS.test(phoneme)) continue;
    if (COMBINING.test(phoneme) && current.length > 0) {
      current[current.length - 1] += phoneme;
      continue;
    }
    current.push(phoneme);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}
