import type { AsrModelSpec, Dtype, TtsModelSpec } from './types';

const RYEAI_LEADERBOARD = {
  label: 'the CoRaL community leaderboard',
  url: 'https://huggingface.co/spaces/RyeAI/danish-asr-leaderboard',
};

/**
 * Whisper is multilingual and handles Danish, but isn't Danish-specific.
 * `benchmark` scores for the whisper-* entries are mean WER/CER across CoRaL
 * conversation + read-aloud, FTSpeech, Common Voice 17 da, and FLEURS da,
 * from RYEAI_LEADERBOARD (dated 2026-10-15). They are a much harder, more
 * realistic test than a single clean sentence; take the gap between
 * whisper-small and whisper-large-v3-turbo here as a warning against judging
 * a model by how well it handles one recording.
 *
 * `edda-v0.2` and `roest-wav2vec2-315m` are actual Danish-specific models
 * from that ecosystem: see each one's own `note` and `benchmark.source` for
 * how it differs from everything else here (edda is this app's own ONNX
 * conversion, unlike every other entry; roest's architecture, evaluation,
 * and a bug in its published conversion are all specific to it) — none of
 * that applies to the whisper-* entries.
 */
export const ASR_MODELS: AsrModelSpec[] = [
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny',
    repo: 'onnx-community/whisper-tiny',
    kind: 'seq2seq',
    sizes: { fp32: 151_500_000, fp16: 76_100_000, q8: 40_800_000, q4: 95_700_000 },
    defaultDtype: 'q8',
    benchmark: { wer: 132.69, cer: 88.29, source: RYEAI_LEADERBOARD },
    note: 'Fastest, but effectively unusable on Danish: more errors than words.',
  },
  {
    id: 'whisper-base',
    label: 'Whisper base',
    repo: 'onnx-community/whisper-base',
    kind: 'seq2seq',
    sizes: { fp32: 291_000_000, fp16: 146_100_000, q8: 76_900_000, q4: 142_400_000 },
    defaultDtype: 'q8',
    benchmark: { wer: 96.67, cer: 61.27, source: RYEAI_LEADERBOARD },
    note: 'Still close to unusable on real Danish speech. Rough checks only.',
  },
  {
    id: 'whisper-small',
    label: 'Whisper small',
    repo: 'onnx-community/whisper-small',
    kind: 'seq2seq',
    sizes: { fp32: 968_200_000, fp16: 485_200_000, q8: 249_100_000, q4: 299_300_000 },
    defaultDtype: 'q4',
    benchmark: { wer: 46.9, cer: 25.41, source: RYEAI_LEADERBOARD },
    note: 'Handles clean, simple sentences; still misses roughly every other word on harder speech.',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    kind: 'seq2seq',
    sizes: { fp32: 1_700_000_000, fp16: 1_618_600_000, q8: 1_084_800_000, q4: 759_100_000 },
    defaultDtype: 'q4',
    benchmark: { wer: 28.43, cer: 16.35, source: RYEAI_LEADERBOARD },
    note: 'The most accurate stock Whisper size that stays practical in-browser; q4 on WebGPU is the best balance of size and speed.',
  },
  {
    id: 'edda-v0.2',
    label: 'Edda v0.2 (Danish, beam search)',
    repo: 'AshtonKem/edda-v0.2-ONNX',
    kind: 'seq2seq',
    sizes: { fp32: 3_501_721_752, q8: 883_945_327 },
    defaultDtype: 'q8',
    benchmark: {
      wer: 8.79,
      cer: 4.1,
      source: {
        label: "the model's own card (mean of CoRaL conversation + read-aloud, Common Voice 17, FLEURS, FTSpeech)",
        url: 'https://huggingface.co/danish-foundation-models/edda-v0.2',
      },
    },
    note:
      'Recommended. A Danish fine-tune of whisper-large-v3-turbo, converted to ONNX for this ' +
      "app specifically (no community conversion existed) — see the README for how. Half Røst's " +
      "WER, and open: Apache-2.0, not gated. fp16 and q4 aren't offered: fp16 hit a genuine " +
      "ONNX bug in the merged decoder's control-flow graph (a type mismatch that survived " +
      'converting before *and* after merging), and no reliable 4-bit tool was available during ' +
      'conversion. q8 and fp32 were each verified end to end with an exact-match transcription.',
  },
  {
    id: 'roest-wav2vec2-315m',
    label: 'Røst wav2vec2 315M (Danish)',
    repo: 'PierreMesure/roest-315m-onnx',
    kind: 'ctc',
    sizes: { fp32: 1_262_600_000, fp16: 631_600_000, q8: 317_400_000, q4: 241_500_000 },
    defaultDtype: 'q8',
    benchmark: {
      wer: 17.0,
      cer: 6.6,
      source: {
        label: "the model's own card (CoRal read-aloud test set)",
        url: 'https://huggingface.co/CoRal-project/roest-wav2vec2-315m-v1',
      },
    },
    note:
      'Recommended. A Danish-specific wav2vec2 CTC model — roughly half the WER of the best ' +
      'Whisper size here. This is v1 of Røst; v2 and v3 exist and score better still on the ' +
      "leaderboard but have no published ONNX export yet. Stick to q8 — this app's own testing " +
      'found fp16 and q4 degraded noticeably for this model, unlike the Whisper sizes above. ' +
      'CTC decoding also has a characteristic failure mode Whisper mostly avoids: double letters ' +
      'and word boundaries occasionally collapse ("kop kaffe" heard as "kopkafe").',
  },
];

const PIPER_BASE =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/da/da_DK/talesyntese/medium';
const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main';

export const TTS_MODELS: TtsModelSpec[] = [
  {
    id: 'supertonic-3',
    label: 'Supertonic 3 (Danish)',
    engine: 'supertonic',
    note:
      'Recommended. A flow-matching TTS model, multilingual with genuine Danish support — ' +
      "noticeably smoother than Piper's VITS voice. ~380 MB across 4 ONNX models, run directly " +
      "(not through transformers.js — the published graphs don't match that library's own " +
      "supertonic module, built against an earlier, differently-shaped release). One voice " +
      "preset (F1) for now; the model ships ten, but this app doesn't expose picking between " +
      'them yet.',
    supertonic: {
      textEncoder: `${SUPERTONIC_BASE}/onnx/text_encoder.onnx`,
      durationPredictor: `${SUPERTONIC_BASE}/onnx/duration_predictor.onnx`,
      vectorEstimator: `${SUPERTONIC_BASE}/onnx/vector_estimator.onnx`,
      vocoder: `${SUPERTONIC_BASE}/onnx/vocoder.onnx`,
      config: `${SUPERTONIC_BASE}/onnx/tts.json`,
      tokenizer: `${SUPERTONIC_BASE}/onnx/unicode_indexer.json`,
      voiceStyle: `${SUPERTONIC_BASE}/voice_styles/F1.json`,
      totalStep: 8,
      speed: 1.05,
      bytes: 398_653_248,
    },
  },
  {
    id: 'piper-da-talesyntese-medium',
    label: 'Piper — da_DK talesyntese (medium)',
    engine: 'piper',
    note: 'Neural Danish voice, runs on-device. 63 MB voice + 19 MB phonemiser.',
    voice: {
      language: 'da',
      model: `${PIPER_BASE}/da_DK-talesyntese-medium.onnx`,
      config: `${PIPER_BASE}/da_DK-talesyntese-medium.onnx.json`,
      bytes: 63_201_294,
    },
  },
  {
    id: 'system',
    label: 'System voice (da-DK)',
    engine: 'system',
    note: 'No download. Quality depends on the Danish voices your OS has installed.',
  },
];

export const DTYPES: Dtype[] = ['q4', 'q8', 'fp16', 'fp32'];

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
