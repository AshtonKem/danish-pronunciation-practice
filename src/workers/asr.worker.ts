/// <reference lib="webworker" />
import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from '@huggingface/transformers';

import { requireCrossOriginIsolation } from '../lib/crossOriginIsolation';
import { serve } from '../lib/rpc';
import type { Device, Dtype } from '../types';

// Models always come from the Hub; there is no /models/ directory to check first.
env.allowLocalModels = false;
// Left unset, this defaults to 0 ("system determined"), which in practice
// means > 1 and makes Emscripten's pthread runtime spin up its own worker
// pool -- a nested Worker-from-a-Worker, since this code already runs inside
// one. That hung the TTS worker's onnxruntime-web session silently in
// Firefox and Safari (see tts.worker.ts); pinning this to 1 avoids the same
// latent failure here before anyone hits it on the ASR side.
// Non-null: transformers.js populates `backends.onnx.wasm` as a side effect
// of its own module init, which has already run by the time this executes
// (the `env`/`pipeline` import above pulls it in). The type is optional only
// because the declared shape is generic, not because it can be empty here.
env.backends.onnx.wasm!.numThreads = 1;

/**
 * At least one community ONNX conversion used for the ASR catalog
 * (PierreMesure/roest-315m-onnx) ships a tokenizer.json whose `added_tokens`
 * array is empty, even though its special tokens — including the CTC blank
 * id — are correctly listed in tokenizer_config.json's
 * `added_tokens_decoder`. The practical effect: every one of those ids,
 * blank included, decodes as the literal string "<unk>" instead of being
 * dropped, so a transcript like "jeg vil" comes back "<unk>j<unk>eg
 * vil<unk>". This isn't a transformers.js bug or a model-weights problem —
 * it's an incomplete published artifact — so it's patched in flight instead
 * of worked around with custom decode logic. Safe to apply unconditionally:
 * it's a no-op whenever `added_tokens` is already populated correctly (every
 * Whisper repo in the catalog).
 */
const realFetch = env.fetch;
env.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  if (!String(input).endsWith('/tokenizer.json')) return response;

  const data = await response.json();
  if (!Array.isArray(data.added_tokens) || data.added_tokens.length > 0) {
    return new Response(JSON.stringify(data), { headers: response.headers });
  }

  const configUrl = String(input).replace(/tokenizer\.json$/, 'tokenizer_config.json');
  const config = await (await realFetch(configUrl, init)).json();
  const decoder = (config.added_tokens_decoder ?? {}) as Record<
    string,
    { content: string; single_word: boolean; lstrip: boolean; rstrip: boolean; normalized: boolean; special: boolean }
  >;
  data.added_tokens = Object.entries(decoder).map(([id, token]) => ({ id: Number(id), ...token }));
  return new Response(JSON.stringify(data), { headers: response.headers });
};

interface LoadParams {
  repo: string;
  kind: 'seq2seq' | 'ctc';
  dtype: Dtype;
  device: Device;
}

interface TranscribeParams {
  samples: Float32Array;
}

let loaded: { key: string; kind: LoadParams['kind']; pipe: AutomaticSpeechRecognitionPipeline } | null =
  null;

const keyOf = ({ repo, dtype, device }: LoadParams) => `${repo}|${dtype}|${device}`;

serve({
  async load(params: LoadParams, { progress }) {
    requireCrossOriginIsolation();

    const key = keyOf(params);
    if (loaded?.key === key) return { result: { reused: true, device: params.device } };

    await loaded?.pipe.dispose();
    loaded = null;

    const pipe = (await pipeline('automatic-speech-recognition', params.repo, {
      dtype: params.dtype,
      device: params.device,
      progress_callback: (info: ProgressInfo) => progress(info),
    })) as AutomaticSpeechRecognitionPipeline;

    loaded = { key, kind: params.kind, pipe };
    return { result: { reused: false, device: params.device } };
  },

  async transcribe({ samples }: TranscribeParams) {
    if (!loaded) throw new Error('No ASR model is loaded');

    // CTC models (wav2vec2) don't take a source language/task -- transformers.js
    // only logs a warning if given one, but there's no reason to pass options
    // that don't apply. Whisper needs `language` pinned, or it sometimes
    // "helpfully" transcribes halting Danish as English, which reads as a
    // wall of errors; `chunk_length_s` just avoids chunk-stitching artefacts
    // on these short practice sentences, for the one model type that chunks.
    const options =
      loaded.kind === 'seq2seq'
        ? { language: 'da', task: 'transcribe' as const, return_timestamps: false, chunk_length_s: 30 }
        : {};

    const output = await loaded.pipe(samples, options);

    const text = Array.isArray(output)
      ? output.map((part) => part.text).join(' ')
      : output.text;

    return { result: { text: text.trim() } };
  },

  async unload() {
    await loaded?.pipe.dispose();
    loaded = null;
    return { result: null };
  },
});
