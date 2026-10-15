import type { Evaluation, PhonemeOp, WordResult } from '../types';
import { align, normalizedDistance } from './align';
import { stripStress, tokenize, type Token } from './danish';
import type { PhonemeGroups } from './phonemes';

export type { PhonemeGroups };

/**
 * A substitution needs this share of its phonemes to survive to count as the
 * intended word pronounced badly rather than a different word entirely.
 */
const MISPRONOUNCED_FLOOR = 0.4;

function phonemeDiff(target: string[], spoken: string[]): PhonemeOp[] {
  const ops = align(
    target.map(stripStress),
    spoken.map(stripStress),
    (x, y) => (x === y ? 0 : 1),
    0.9,
  );
  return ops.map((op) => {
    switch (op.type) {
      case 'match':
        return { type: 'match', target: op.a, spoken: op.b };
      case 'sub':
        return { type: 'sub', target: op.a, spoken: op.b };
      case 'del':
        return { type: 'del', target: op.a };
      case 'ins':
        return { type: 'ins', spoken: op.b };
    }
  });
}

/**
 * espeak-ng splits on its own idea of word boundaries — numbers and compounds
 * can yield a different count than the orthographic tokens. Only trust the
 * pairing when the counts line up; a wrong pairing would blame the wrong word.
 */
function pairPhonemes(tokens: Token[], groups: PhonemeGroups | null): (string[] | undefined)[] {
  if (!groups || groups.length !== tokens.length) return tokens.map(() => undefined);
  return groups;
}

function classifySubstitution(
  targetPhonemes: string[] | undefined,
  spokenPhonemes: string[] | undefined,
  textDistance: number,
): { status: WordResult['status']; phonemes?: PhonemeOp[] } {
  if (!targetPhonemes || !spokenPhonemes) {
    // No phonemes to go on; fall back to how close the spellings are.
    return { status: textDistance < 0.5 ? 'mispronounced' : 'wrong' };
  }

  const phonemes = phonemeDiff(targetPhonemes, spokenPhonemes);
  const matched = phonemes.filter((p) => p.type === 'match').length;
  const total = Math.max(targetPhonemes.length, spokenPhonemes.length);

  // Different spelling, identical phonemes: the speaker said the right sounds.
  if (matched === total) return { status: 'correct', phonemes };

  const kept = total === 0 ? 0 : matched / total;
  return { status: kept >= MISPRONOUNCED_FLOOR ? 'mispronounced' : 'wrong', phonemes };
}

/**
 * Score a single retried word directly, rather than through `evaluate()`'s
 * sentence-level alignment. That alignment deliberately turns a target word
 * matched against a completely different spoken word into a separate
 * extra+missing pair — the right call for a full sentence (see `evaluate`),
 * but wrong here: reading just one of that pair back out would misreport a
 * "wrong word" retry as merely "extra" or "missing".
 */
export function evaluateWord(
  target: string,
  transcript: string,
  targetGroups: PhonemeGroups | null,
  spokenGroups: PhonemeGroups | null,
): WordResult {
  const targetWord = tokenize(target)[0];
  const spokenWord = tokenize(transcript)[0];

  if (!targetWord) return { status: 'missing' };
  if (!spokenWord) return { status: 'missing', target: targetWord.raw, targetPhonemes: targetGroups?.[0] };

  const targetPhonemes = targetGroups?.[0];
  const spokenPhonemes = spokenGroups?.[0];
  const distance = normalizedDistance(targetWord.norm, spokenWord.norm);

  // classifySubstitution assumes its caller already ruled out an exact text
  // match (true of its only other caller, align()'s 'sub' step) — rule it
  // out here too, rather than let a real match read as "mispronounced".
  const { status, phonemes } =
    distance === 0 ? { status: 'correct' as const, phonemes: undefined } : classifySubstitution(targetPhonemes, spokenPhonemes, distance);

  return {
    status,
    target: targetWord.raw,
    // The full transcript, not just its first word — if more came out than
    // the one word asked for, that's worth showing even though only the
    // first word's phonemes factor into the verdict above.
    spoken: transcript.trim(),
    targetPhonemes,
    spokenPhonemes,
    phonemes,
  };
}

export function evaluate(
  targetText: string,
  transcript: string,
  targetGroups: PhonemeGroups | null,
  spokenGroups: PhonemeGroups | null,
  durationMs: number,
): Evaluation {
  const targetTokens = tokenize(targetText);
  const spokenTokens = tokenize(transcript);
  const targetPhonemes = pairPhonemes(targetTokens, targetGroups);
  const spokenPhonemes = pairPhonemes(spokenTokens, spokenGroups);

  const ops = align(targetTokens, spokenTokens, (x, y) => normalizedDistance(x.norm, y.norm));

  const words: WordResult[] = ops.map((op) => {
    switch (op.type) {
      case 'match':
        return {
          status: 'correct',
          target: op.a.raw,
          spoken: op.b.raw,
          targetPhonemes: targetPhonemes[op.ai],
          spokenPhonemes: spokenPhonemes[op.bi],
        };
      case 'sub': {
        const { status, phonemes } = classifySubstitution(
          targetPhonemes[op.ai],
          spokenPhonemes[op.bi],
          normalizedDistance(op.a.norm, op.b.norm),
        );
        return {
          status,
          target: op.a.raw,
          spoken: op.b.raw,
          targetPhonemes: targetPhonemes[op.ai],
          spokenPhonemes: spokenPhonemes[op.bi],
          phonemes,
        };
      }
      case 'del':
        return { status: 'missing', target: op.a.raw, targetPhonemes: targetPhonemes[op.ai] };
      case 'ins':
        return { status: 'extra', spoken: op.b.raw, spokenPhonemes: spokenPhonemes[op.bi] };
    }
  });

  const correct = words.filter((w) => w.status === 'correct').length;
  const mispronounced = words.filter((w) => w.status === 'mispronounced').length;
  const extra = words.filter((w) => w.status === 'extra').length;
  const denominator = targetTokens.length;

  // Extra words cannot push the numerator up, so dilute the score by them
  // instead — otherwise reciting the sentence twice would score perfectly.
  const raw = denominator === 0 ? 0 : (correct + 0.5 * mispronounced) / denominator;
  const score = denominator === 0 ? 0 : raw * (denominator / (denominator + extra));

  return { words, transcript, score, durationMs };
}
