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
 * `roest-wav2vec2-315m` is an actual Danish-specific model from that
 * ecosystem: see its own `note` and `benchmark.source` for how it differs
 * from everything else here (a different architecture, a different
 * evaluation, and a bug in its published conversion that this app works
 * around — none of that applies to the whisper-* entries).
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

export const TTS_MODELS: TtsModelSpec[] = [
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
