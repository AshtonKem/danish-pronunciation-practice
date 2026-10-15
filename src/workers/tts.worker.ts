/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';

import { TTS_MODELS } from '../catalog';
import { cachedFetch, type DownloadProgress } from '../lib/modelStore';
import { splitWords, toPhonemeStrings, type PhonemizeItem } from '../lib/phonemes';
import { serve } from '../lib/rpc';
import type { Device } from '../types';

// Served out of node_modules by the dev server and copied into dist on build,
// so the runtime stays same-origin and works offline once cached.
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

/**
 * Piper's own espeak-ng build, compiled to WASM. Using the exact phonemiser
 * Piper was trained with matters twice over: the voice gets the phoneme ids it
 * expects, and pronunciation scoring compares phonemes on the same footing.
 */
const PHONEMISER_BASE =
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  speaker_id_map: Record<string, number>;
}

type PhonemiserFactory = (module: Record<string, unknown>) => Promise<{
  callMain: (args: string[]) => void;
}>;

interface Phonemiser {
  factory: PhonemiserFactory;
  wasm: ArrayBuffer;
  dataUrl: string;
  /** Inverted `phoneme_id_map`, used to recover phoneme strings from ids. */
  idToPhoneme: Map<number, string>;
  language: string;
}

let phonemiser: Phonemiser | null = null;
let voice: { id: string; session: ort.InferenceSession; config: PiperConfig; device: Device } | null =
  null;

function piperSpec(id: string) {
  const spec = TTS_MODELS.find((m) => m.id === id);
  if (!spec?.voice) throw new Error(`Not a downloadable voice: ${id}`);
  return spec;
}

/** The Danish voice config doubles as the phoneme inventory for scoring. */
const PHONEME_SOURCE = piperSpec('piper-da-talesyntese-medium').voice!;

async function fetchConfig(url: string): Promise<PiperConfig> {
  const bytes = await cachedFetch(url);
  return JSON.parse(new TextDecoder().decode(bytes)) as PiperConfig;
}

async function ensurePhonemiser(
  progress: (data: DownloadProgress) => void,
): Promise<Phonemiser> {
  if (phonemiser) return phonemiser;

  const [source, wasm, data, config] = await Promise.all([
    cachedFetch(`${PHONEMISER_BASE}.js`, progress),
    cachedFetch(`${PHONEMISER_BASE}.wasm`, progress),
    cachedFetch(`${PHONEMISER_BASE}.data`, progress),
    fetchConfig(PHONEME_SOURCE.config),
  ]);

  // The build is a UMD bundle that assigns to a top-level `var`; evaluating it
  // in a function body and returning that binding gets us the factory without
  // needing importScripts (unavailable in a module worker).
  const text = new TextDecoder().decode(source);
  const factory = new Function(
    `${text}\nreturn createPiperPhonemize;`,
  )() as PhonemiserFactory;

  const idToPhoneme = new Map<number, string>();
  for (const [symbol, ids] of Object.entries(config.phoneme_id_map)) {
    for (const id of ids) if (!idToPhoneme.has(id)) idToPhoneme.set(id, symbol);
  }

  phonemiser = {
    factory,
    wasm,
    dataUrl: URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' })),
    idToPhoneme,
    language: config.espeak.voice,
  };
  return phonemiser;
}

/**
 * espeak-ng runs as a CLI whose `main` exits, so each batch needs a fresh
 * module. Passing every sentence in one `--input` array keeps that to a single
 * instantiation per evaluation instead of one per word.
 */
async function runPhonemiser(texts: string[], language: string): Promise<PhonemizeItem[]> {
  const engine = await ensurePhonemiser(() => {});
  const lines: string[] = [];
  let failure: string | null = null;

  const instance = await engine.factory({
    wasmBinary: engine.wasm,
    noInitialRun: true,
    print: (line: string) => lines.push(line),
    printErr: (line: string) => {
      failure ??= line;
    },
    locateFile: (path: string) =>
      path.endsWith('.data')
        ? engine.dataUrl
        : path.endsWith('.wasm')
          ? `${PHONEMISER_BASE}.wasm`
          : path,
  });

  instance.callMain([
    '-l',
    language,
    '--input',
    JSON.stringify(texts.map((text) => ({ text: text.trim() }))),
    '--espeak_data',
    '/espeak-ng-data',
  ]);

  const items: PhonemizeItem[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      items.push(JSON.parse(trimmed) as PhonemizeItem);
    } catch {
      // Not every stdout line is a result record; skip anything unparseable.
    }
  }

  if (items.length === 0) {
    throw new Error(failure ?? 'Phonemiser produced no output');
  }
  return items;
}

async function createSession(
  bytes: ArrayBuffer,
): Promise<{ session: ort.InferenceSession; device: Device }> {
  const attempts: Device[] = ['webgpu', 'wasm'];
  let last: unknown;
  for (const device of attempts) {
    try {
      const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: [device],
      });
      return { session, device };
    } catch (error) {
      last = error;
    }
  }
  throw new Error(
    `Could not start the voice on WebGPU or WASM: ${
      last instanceof Error ? last.message : String(last)
    }`,
  );
}

serve({
  async prepare(_: unknown, { progress }) {
    const engine = await ensurePhonemiser((data) => progress(data));
    return { result: { language: engine.language } };
  },

  async loadVoice({ id }: { id: string }, { progress }) {
    if (voice?.id === id) return { result: { reused: true, device: voice.device } };

    const spec = piperSpec(id).voice!;
    await ensurePhonemiser((data) => progress(data));
    const config = await fetchConfig(spec.config);
    const bytes = await cachedFetch(spec.model, (data) => progress(data));

    await voice?.session.release();
    voice = null;

    const { session, device } = await createSession(bytes);
    voice = { id, session, config, device };
    return { result: { reused: false, device } };
  },

  /**
   * Phonemise several texts at once. The caller passes the target sentence and
   * the transcript together so both are produced by one phonemiser run.
   */
  async phonemize({ texts }: { texts: string[] }) {
    const engine = await ensurePhonemiser(() => {});
    const items = await runPhonemiser(texts, engine.language);
    const groups = texts.map((_, index) => {
      const item = items[index];
      return item ? splitWords(toPhonemeStrings(item, engine.idToPhoneme)) : null;
    });
    return { result: { groups } };
  },

  async speak({ text }: { text: string }) {
    if (!voice) throw new Error('No voice is loaded');
    const { config, session } = voice;

    const [item] = await runPhonemiser([text], config.espeak.voice);
    const ids = item.phoneme_ids ?? [];
    if (ids.length === 0) throw new Error('Nothing to speak');

    const input = BigInt64Array.from(ids, BigInt);
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('int64', input, [1, input.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(input.length)]), [1]),
      scales: new ort.Tensor(
        'float32',
        Float32Array.from([
          config.inference.noise_scale,
          config.inference.length_scale,
          config.inference.noise_w,
        ]),
        [3],
      ),
    };
    if (Object.keys(config.speaker_id_map).length > 0) {
      feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    }

    const outputs = await session.run(feeds);
    const samples = Float32Array.from(outputs.output.data as Float32Array);
    return {
      result: { samples, sampleRate: config.audio.sample_rate },
      transfer: [samples.buffer],
    };
  },
});
