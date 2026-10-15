/// <reference lib="webworker" />
import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from '@huggingface/transformers';

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

interface LoadParams {
  repo: string;
  dtype: Dtype;
  device: Device;
}

interface TranscribeParams {
  samples: Float32Array;
}

let loaded: { key: string; pipe: AutomaticSpeechRecognitionPipeline } | null = null;

const keyOf = ({ repo, dtype, device }: LoadParams) => `${repo}|${dtype}|${device}`;

serve({
  async load(params: LoadParams, { progress }) {
    const key = keyOf(params);
    if (loaded?.key === key) return { result: { reused: true, device: params.device } };

    await loaded?.pipe.dispose();
    loaded = null;

    const pipe = (await pipeline('automatic-speech-recognition', params.repo, {
      dtype: params.dtype,
      device: params.device,
      progress_callback: (info: ProgressInfo) => progress(info),
    })) as AutomaticSpeechRecognitionPipeline;

    loaded = { key, pipe };
    return { result: { reused: false, device: params.device } };
  },

  async transcribe({ samples }: TranscribeParams) {
    if (!loaded) throw new Error('No ASR model is loaded');

    const output = await loaded.pipe(samples, {
      // Pinning the language stops Whisper from "helpfully" transcribing
      // halting Danish as English, which would read as a wall of errors.
      language: 'da',
      task: 'transcribe',
      return_timestamps: false,
      // Practice sentences are short; one window avoids chunk-stitching artefacts.
      chunk_length_s: 30,
    });

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
