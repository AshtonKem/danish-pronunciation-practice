import type { AsrModelSpec, Dtype, TtsModelSpec } from './types';

/**
 * Whisper is multilingual and handles Danish; there is no Danish-specific
 * fine-tune on the Hub with a transformers.js-compatible ONNX export (the
 * CoRaL leaderboard's top Danish models are either unexported, gated, or
 * published in a sherpa-onnx/RNNT layout this app's ASR pipeline can't run —
 * see the README), so the choice here is stock Whisper, sized by accuracy.
 *
 * `coral` scores are mean WER/CER across CoRaL conversation + read-aloud,
 * FTSpeech, Common Voice 17 da, and FLEURS da, from
 * https://huggingface.co/spaces/RyeAI/danish-asr-leaderboard (2026-10-15).
 * They are a much harder, more realistic test than a single clean sentence;
 * take the gap between whisper-small and whisper-large-v3-turbo here as a
 * warning against judging a model by how well it handles one recording.
 */
export const ASR_MODELS: AsrModelSpec[] = [
  {
    id: 'whisper-tiny',
    label: 'Whisper tiny',
    repo: 'onnx-community/whisper-tiny',
    sizes: { fp32: 151_500_000, fp16: 76_100_000, q8: 40_800_000, q4: 95_700_000 },
    coral: { wer: 132.69, cer: 88.29 },
    note: 'Fastest, but effectively unusable on Danish: more errors than words.',
  },
  {
    id: 'whisper-base',
    label: 'Whisper base',
    repo: 'onnx-community/whisper-base',
    sizes: { fp32: 291_000_000, fp16: 146_100_000, q8: 76_900_000, q4: 142_400_000 },
    coral: { wer: 96.67, cer: 61.27 },
    note: 'Still close to unusable on real Danish speech. Rough checks only.',
  },
  {
    id: 'whisper-small',
    label: 'Whisper small',
    repo: 'onnx-community/whisper-small',
    sizes: { fp32: 968_200_000, fp16: 485_200_000, q8: 249_100_000, q4: 299_300_000 },
    coral: { wer: 46.9, cer: 25.41 },
    note: 'Handles clean, simple sentences; still misses roughly every other word on harder speech.',
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    sizes: { fp32: 1_700_000_000, fp16: 1_618_600_000, q8: 1_084_800_000, q4: 759_100_000 },
    coral: { wer: 28.43, cer: 16.35 },
    note: 'Recommended. The most accurate size that stays practical in-browser; q4 on WebGPU is the best balance of size and speed.',
  },
];

export const DEFAULT_DTYPE: Record<string, Dtype> = {
  'whisper-tiny': 'q8',
  'whisper-base': 'q8',
  'whisper-small': 'q4',
  'whisper-large-v3-turbo': 'q4',
};

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
