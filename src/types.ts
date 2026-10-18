export type Device = 'webgpu' | 'wasm';

/** Quantisations we expose. Not every repo ships (or correctly supports) all four. */
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4';

export interface AsrModelSpec {
  id: string;
  label: string;
  repo: string;
  /**
   * `seq2seq` (Whisper's encoder/decoder) accepts a source `language` and
   * `task`; `ctc` (wav2vec2's single acoustic model + greedy decode) doesn't
   * and logs a warning if given one, so the worker needs to know which this
   * is to build the right transcribe() options.
   */
  kind: 'seq2seq' | 'ctc';
  /**
   * Approximate download size in bytes, keyed by quantisation. Partial: a
   * model only offers the dtypes it actually has working files for (see
   * `note` for why one might be missing — a bad quantisation, or a real
   * conversion bug rather than a deliberate omission).
   */
  sizes: Partial<Record<Dtype, number>>;
  note: string;
  /** Default quantisation for this model; some don't hold up well below q8. */
  defaultDtype: Dtype;
  /**
   * Danish WER/CER this model has actually been measured at — not by this
   * app, see `source`. Numbers from different entries aren't always the same
   * evaluation (leaderboard vs. a model's own card); `source` says which.
   */
  benchmark?: { wer: number; cer: number; source: { label: string; url: string } };
}

export interface TtsModelSpec {
  id: string;
  label: string;
  /**
   * `piper` downloads a VITS voice; `system` uses the OS voices via Web
   * Speech; `supertonic` downloads Supertone's flow-matching TTS (4 ONNX
   * models run directly, not through transformers.js — its own exported
   * graphs don't match that library's `supertonic` module, which was built
   * against an earlier, differently-shaped release).
   */
  engine: 'piper' | 'system' | 'supertonic';
  note: string;
  /** Present for `piper` voices only. */
  voice?: {
    /** espeak-ng voice code, also used to phonemise for pronunciation scoring. */
    language: string;
    model: string;
    config: string;
    bytes: number;
  };
  /** Present for `supertonic` voices only. */
  supertonic?: {
    textEncoder: string;
    durationPredictor: string;
    vectorEstimator: string;
    vocoder: string;
    /** Model hyperparameters (sample rate, latent sizing) — not a standard HF config.json. */
    config: string;
    /** Flat codepoint→id lookup table (65536 entries) — not a standard tokenizer.json. */
    tokenizer: string;
    /** One precomputed voice preset; picked once, not user-selectable yet. */
    voiceStyle: string;
    /** Denoising steps and speed the reference implementation defaults to. */
    totalStep: number;
    speed: number;
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

/**
 * Result of re-recording a single word from the sentence result, keyed by
 * that word's index so it only renders while the matching word is selected.
 * Kept entirely separate from `Evaluation` — retrying one word must never
 * touch, let alone clear, the full-sentence result it was retried from.
 */
export interface WordCheck {
  index: number;
  result: WordResult;
}
