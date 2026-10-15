export type Device = 'webgpu' | 'wasm';

/** Quantisations we expose; every Whisper repo in the catalog ships all four. */
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4';

export interface AsrModelSpec {
  id: string;
  label: string;
  repo: string;
  /** Approximate download size in bytes, keyed by quantisation. */
  sizes: Record<Dtype, number>;
  note: string;
}

export interface TtsModelSpec {
  id: string;
  label: string;
  /** `piper` downloads a VITS voice; `system` uses the OS voices via Web Speech. */
  engine: 'piper' | 'system';
  note: string;
  /** Present for `piper` voices only. */
  voice?: {
    /** espeak-ng voice code, also used to phonemise for pronunciation scoring. */
    language: string;
    model: string;
    config: string;
    bytes: number;
  };
}

export type WordStatus =
  | 'correct'
  /** Right word, but the phonemes came out wrong. */
  | 'mispronounced'
  /** A different word was said in this slot. */
  | 'wrong'
  /** In the target, never spoken. */
  | 'missing'
  /** Spoken, but not in the target. */
  | 'extra';

export interface PhonemeOp {
  type: 'match' | 'sub' | 'del' | 'ins';
  target?: string;
  spoken?: string;
}

export interface WordResult {
  status: WordStatus;
  /** Target word as written, with original casing and punctuation. */
  target?: string;
  spoken?: string;
  targetPhonemes?: string[];
  spokenPhonemes?: string[];
  phonemes?: PhonemeOp[];
}

export interface Evaluation {
  words: WordResult[];
  transcript: string;
  /** 0–1, weighting a mispronounced word as a half credit. */
  score: number;
  durationMs: number;
}
