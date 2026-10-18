/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';

import { TTS_MODELS } from '../catalog';
import { requireCrossOriginIsolation } from '../lib/crossOriginIsolation';
import { cachedFetch, type DownloadProgress } from '../lib/modelStore';
import { splitWords, toPhonemeStrings, type PhonemizeItem } from '../lib/phonemes';
import { serve } from '../lib/rpc';
import type { Device } from '../types';

// Served out of node_modules by the dev server and copied into dist's root
// (not alongside the worker chunk, which Vite nests under assets/) on build,
// so the runtime stays same-origin and works offline once cached.
// `BASE_URL` rather than a hardcoded "/ort/" -- the app isn't necessarily
// served from the origin root (e.g. a GitHub Pages project page lives at
// <user>.github.io/<repo>/), and Vite guarantees this reflects the
// configured `base`, always as an absolute path from the site root.
ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
// Pinned to 1 (ORT: "If set to 1, no worker thread will be spawned") rather
// than scaled with crossOriginIsolated/hardwareConcurrency. Any value above 1
// makes Emscripten's pthread runtime spin up its own worker pool — a nested
// Worker-from-a-Worker, since this code already runs inside one — and that
// silently hung forever in Firefox and Safari (no console output, no
// rejection) regardless of execution provider. One short TTS inference
// doesn't need the parallelism badly enough to risk it.
ort.env.wasm.numThreads = 1;

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

/**
 * Supertone's own config shape (`onnx/tts.json`) — model hyperparameters,
 * not a standard HF config.json. Only the fields the inference algorithm
 * below actually reads.
 */
interface SupertonicConfig {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

interface SupertonicVoiceStyle {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

interface SupertonicSessions {
  textEncoder: ort.InferenceSession;
  durationPredictor: ort.InferenceSession;
  vectorEstimator: ort.InferenceSession;
  vocoder: ort.InferenceSession;
}

let phonemiser: Phonemiser | null = null;
type LoadedTts =
  | {
      kind: 'piper';
      id: string;
      /** The device the caller asked for; distinct from `device`, what actually got used. */
      preferred: Device;
      session: ort.InferenceSession;
      config: PiperConfig;
      device: Device;
    }
  | {
      kind: 'supertonic';
      id: string;
      preferred: Device;
      sessions: SupertonicSessions;
      cfgs: SupertonicConfig;
      indexer: UnicodeIndexer;
      style: SupertonicVoiceStyle;
      totalStep: number;
      speed: number;
      device: Device;
    };
let loadedTts: LoadedTts | null = null;

async function releaseLoadedTts(): Promise<void> {
  if (!loadedTts) return;
  if (loadedTts.kind === 'piper') {
    await loadedTts.session.release();
  } else {
    await Promise.all(Object.values(loadedTts.sessions).map((s) => s.release()));
  }
  loadedTts = null;
}

function piperSpec(id: string) {
  const spec = TTS_MODELS.find((m) => m.id === id);
  if (!spec?.voice) throw new Error(`Not a downloadable voice: ${id}`);
  return spec;
}

function supertonicSpec(id: string) {
  const spec = TTS_MODELS.find((m) => m.id === id);
  if (!spec?.supertonic) throw new Error(`Not a downloadable voice: ${id}`);
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

/**
 * Minimal shape of `navigator.gpu`, since no `@webgpu/types` dependency is
 * installed and the DOM lib shipped with this TS version doesn't include it.
 */
interface MinimalGpu {
  requestAdapter: () => Promise<unknown>;
}

/**
 * `navigator.gpu` existing is not enough: WebGPU support inside a dedicated
 * Worker can lag behind main-thread support (it did at the time of writing,
 * in some browsers), so the capability flag the UI reads on the main thread
 * is not reliable evidence it will work here. Requesting a real adapter is.
 *
 * This matters beyond cosmetics: once a session.create() call fails while
 * resolving the 'webgpu' execution provider, onnxruntime-web's wasm backend
 * caches that failure as a module-level singleton and refuses to retry wasm
 * init for the rest of this worker's lifetime ("previous call to 'initWasm()'
 * failed") — including for a subsequent plain 'wasm' attempt. So the fix is
 * to never let a doomed 'webgpu' attempt touch the shared wasm backend at
 * all, rather than to catch and fall back after the fact.
 */
async function supportsWebgpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function createSession(
  bytes: ArrayBuffer,
  preferred: Device,
): Promise<{ session: ort.InferenceSession; device: Device }> {
  // An explicit 'wasm' choice skips the GPU probe and the webgpu EP entirely —
  // the only way, from the UI, to route around a stuck or misbehaving WebGPU
  // backend (shader compilation, adapter/device request) rather than waiting
  // on it. 'webgpu' still probes for a real adapter first (see supportsWebgpu)
  // and, when found, passes both providers in one call so ORT's own internal
  // fallback has a safety net without us ever issuing a second top-level call.
  const webgpu = preferred === 'webgpu' && (await supportsWebgpu());
  const executionProviders: Device[] = webgpu ? ['webgpu', 'wasm'] : ['wasm'];

  try {
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
      executionProviders,
    });
    return { session, device: webgpu ? 'webgpu' : 'wasm' };
  } catch (error) {
    throw new Error(
      `Could not start the voice: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Ported directly from Supertone's own reference implementation
 * (github.com/supertone-inc/supertonic, web/helper.js) — this is the exact
 * official algorithm, not a reverse-engineered guess from the config shape;
 * verified against the real models in Node before porting (duration scales
 * sensibly with text length, voice styles produce measurably different
 * output, waveform envelopes show speech-shaped energy bursts, not noise).
 */
const SUPERTONIC_LANGS = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr',
  'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk',
  'sl', 'sv', 'tr', 'uk', 'vi', 'na',
];

/** Flat codepoint→id lookup table (65536 entries, one per BMP codepoint). */
type UnicodeIndexer = number[];

function supertonicPreprocessText(text: string, lang: string): string {
  text = text.normalize('NFKD');
  // Wide-range emoji blocks.
  const emojiPattern =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
  text = text.replace(emojiPattern, '');
  const replacements: Record<string, string> = {
    '–': '-', '‑': '-', '—': '-', '_': ' ',
    '“': '"', '”': '"', '‘': "'", '’': "'",
    '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
  };
  for (const [from, to] of Object.entries(replacements)) text = text.replaceAll(from, to);
  text = text.replace(/[♥☆♡©\\]/g, '');
  const exprReplacements: Record<string, string> = {
    '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ',
  };
  for (const [from, to] of Object.entries(exprReplacements)) text = text.replaceAll(from, to);
  text = text
    .replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
    .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  while (text.includes('``')) text = text.replace('``', '`');
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += '.';
  if (!SUPERTONIC_LANGS.includes(lang)) {
    throw new Error(`Invalid language for Supertonic: ${lang}. Available: ${SUPERTONIC_LANGS.join(', ')}`);
  }
  return `<${lang}>${text}</${lang}>`;
}

function lengthToMask(lengths: number[], maxLen: number): number[][][] {
  return lengths.map((len) => {
    const row = new Array<number>(maxLen).fill(0);
    for (let j = 0; j < Math.min(len, maxLen); j++) row[j] = 1;
    return [row];
  });
}

function supertonicTokenize(
  textList: string[],
  langList: string[],
  indexer: UnicodeIndexer,
): { textIds: number[][]; textMask: number[][][] } {
  const processed = textList.map((text, i) => supertonicPreprocessText(text, langList[i]));
  const lengths = processed.map((text) => text.length);
  const maxLen = Math.max(...lengths);
  const textIds = processed.map((text) => {
    const row = new Array<number>(maxLen).fill(0);
    for (let j = 0; j < text.length; j++) {
      const codePoint = text.codePointAt(j)!;
      row[j] = codePoint < indexer.length ? indexer[codePoint] : -1;
    }
    return row;
  });
  return { textIds, textMask: lengthToMask(lengths, maxLen) };
}

/** Standard-normal noise for the flow-matching denoiser's starting point. */
function boxMullerSample(): number {
  const u1 = Math.max(0.0001, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleNoisyLatent(
  durations: number[],
  sampleRate: number,
  baseChunkSize: number,
  chunkCompress: number,
  latentDim: number,
): { xt: number[][][]; latentMask: number[][][] } {
  const bsz = durations.length;
  const maxDur = Math.max(...durations);
  const wavLenMax = Math.floor(maxDur * sampleRate);
  const wavLengths = durations.map((d) => Math.floor(d * sampleRate));
  const chunkSize = baseChunkSize * chunkCompress;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDimVal = latentDim * chunkCompress;

  const xt: number[][][] = [];
  for (let b = 0; b < bsz; b++) {
    const batch: number[][] = [];
    for (let d = 0; d < latentDimVal; d++) {
      const row: number[] = [];
      for (let t = 0; t < latentLen; t++) row.push(boxMullerSample());
      batch.push(row);
    }
    xt.push(batch);
  }

  const latentLengths = wavLengths.map((len) => Math.floor((len + chunkSize - 1) / chunkSize));
  const latentMask = lengthToMask(latentLengths, latentLen);
  for (let b = 0; b < bsz; b++) {
    for (let d = 0; d < latentDimVal; d++) {
      for (let t = 0; t < latentLen; t++) xt[b][d][t] *= latentMask[b][0][t];
    }
  }
  return { xt, latentMask };
}

/**
 * One text → one waveform, end to end: duration prediction, text encoding,
 * the iterative flow-matching denoise loop, then vocoding. Single-sentence
 * only (the official implementation's batching isn't needed here).
 */
async function supertonicInfer(
  sessions: SupertonicSessions,
  cfgs: SupertonicConfig,
  indexer: UnicodeIndexer,
  text: string,
  lang: string,
  style: SupertonicVoiceStyle,
  totalStep: number,
  speed: number,
): Promise<{ wav: Float32Array; durationSeconds: number }> {
  const { textIds, textMask } = supertonicTokenize([text], [lang], indexer);

  const textIdsTensor = new ort.Tensor(
    'int64',
    BigInt64Array.from(textIds.flat(), BigInt),
    [1, textIds[0].length],
  );
  const textMaskTensor = new ort.Tensor(
    'float32',
    Float32Array.from(textMask.flat(2)),
    [1, 1, textMask[0][0].length],
  );

  const dpOutputs = await sessions.durationPredictor.run({
    text_ids: textIdsTensor,
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const duration = (dpOutputs.duration.data as Float32Array)[0] / speed;

  const textEncOutputs = await sessions.textEncoder.run({
    text_ids: textIdsTensor,
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });
  const textEmb = textEncOutputs.text_emb;

  let { xt, latentMask } = sampleNoisyLatent(
    [duration],
    cfgs.ae.sample_rate,
    cfgs.ae.base_chunk_size,
    cfgs.ttl.chunk_compress_factor,
    cfgs.ttl.latent_dim,
  );
  const latentMaskTensor = new ort.Tensor(
    'float32',
    Float32Array.from(latentMask.flat(2)),
    [1, 1, latentMask[0][0].length],
  );
  const totalStepTensor = new ort.Tensor('float32', Float32Array.from([totalStep]), [1]);

  for (let step = 0; step < totalStep; step++) {
    const currentStepTensor = new ort.Tensor('float32', Float32Array.from([step]), [1]);
    const xtTensor = new ort.Tensor(
      'float32',
      Float32Array.from(xt.flat(2)),
      [1, xt[0].length, xt[0][0].length],
    );

    const vectorEstOutputs = await sessions.vectorEstimator.run({
      noisy_latent: xtTensor,
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latentMaskTensor,
      text_mask: textMaskTensor,
      current_step: currentStepTensor,
      total_step: totalStepTensor,
    });

    const denoised = vectorEstOutputs.denoised_latent.data as Float32Array;
    const latentDim = xt[0].length;
    const latentLen = xt[0][0].length;
    xt = [];
    let idx = 0;
    const batch: number[][] = [];
    for (let d = 0; d < latentDim; d++) {
      const row: number[] = [];
      for (let t = 0; t < latentLen; t++) row.push(denoised[idx++]);
      batch.push(row);
    }
    xt.push(batch);
  }

  const finalXtTensor = new ort.Tensor(
    'float32',
    Float32Array.from(xt.flat(2)),
    [1, xt[0].length, xt[0][0].length],
  );
  const vocoderOutputs = await sessions.vocoder.run({ latent: finalXtTensor });
  const wav = vocoderOutputs.wav_tts.data as Float32Array;

  const wavLen = Math.floor(cfgs.ae.sample_rate * duration);
  return { wav: wav.slice(0, wavLen), durationSeconds: duration };
}

serve({
  async prepare(_: unknown, { progress }) {
    const engine = await ensurePhonemiser((data) => progress(data));
    return { result: { language: engine.language } };
  },

  async loadVoice({ id, device: preferred }: { id: string; device: Device }, { progress }) {
    requireCrossOriginIsolation();

    // A device switch (e.g. falling back to WASM to route around a stuck
    // WebGPU session) must reload even if the voice id hasn't changed.
    if (loadedTts?.id === id && loadedTts.preferred === preferred) {
      return { result: { reused: true, device: loadedTts.device } };
    }

    const ttsSpec = TTS_MODELS.find((m) => m.id === id);
    if (ttsSpec?.engine === 'supertonic') {
      const spec = supertonicSpec(id).supertonic!;
      await ensurePhonemiser((data) => progress(data));

      const [textEncoderBytes, durationPredictorBytes, vectorEstimatorBytes, vocoderBytes, configBytes, tokenizerBytes, styleBytes] =
        await Promise.all([
          cachedFetch(spec.textEncoder, progress),
          cachedFetch(spec.durationPredictor, progress),
          cachedFetch(spec.vectorEstimator, progress),
          cachedFetch(spec.vocoder, progress),
          cachedFetch(spec.config, progress),
          cachedFetch(spec.tokenizer, progress),
          cachedFetch(spec.voiceStyle, progress),
        ]);

      await releaseLoadedTts();

      // All 4 sessions share one device choice -- mixing GPU/CPU across them
      // would work (sessions are independent) but isn't worth the complexity
      // for a consistent, predictable result.
      const [textEncoderResult, durationPredictorResult, vectorEstimatorResult, vocoderResult] =
        await Promise.all([
          createSession(textEncoderBytes, preferred),
          createSession(durationPredictorBytes, preferred),
          createSession(vectorEstimatorBytes, preferred),
          createSession(vocoderBytes, preferred),
        ]);

      const cfgs = JSON.parse(new TextDecoder().decode(configBytes)) as SupertonicConfig;
      const indexer = JSON.parse(new TextDecoder().decode(tokenizerBytes)) as UnicodeIndexer;
      const voiceStyle = JSON.parse(new TextDecoder().decode(styleBytes)) as {
        style_ttl: { data: unknown; dims: number[] };
        style_dp: { data: unknown; dims: number[] };
      };
      const style: SupertonicVoiceStyle = {
        ttl: new ort.Tensor(
          'float32',
          Float32Array.from((voiceStyle.style_ttl.data as number[]).flat(Infinity) as number[]),
          voiceStyle.style_ttl.dims,
        ),
        dp: new ort.Tensor(
          'float32',
          Float32Array.from((voiceStyle.style_dp.data as number[]).flat(Infinity) as number[]),
          voiceStyle.style_dp.dims,
        ),
      };

      const device = textEncoderResult.device;
      loadedTts = {
        kind: 'supertonic',
        id,
        preferred,
        sessions: {
          textEncoder: textEncoderResult.session,
          durationPredictor: durationPredictorResult.session,
          vectorEstimator: vectorEstimatorResult.session,
          vocoder: vocoderResult.session,
        },
        cfgs,
        indexer,
        style,
        totalStep: spec.totalStep,
        speed: spec.speed,
        device,
      };
      return { result: { reused: false, device } };
    }

    const spec = piperSpec(id).voice!;
    await ensurePhonemiser((data) => progress(data));
    const config = await fetchConfig(spec.config);
    const bytes = await cachedFetch(spec.model, (data) => progress(data));

    await releaseLoadedTts();

    const { session, device } = await createSession(bytes, preferred);
    loadedTts = { kind: 'piper', id, preferred, session, config, device };
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
    if (!loadedTts) throw new Error('No voice is loaded');

    if (loadedTts.kind === 'supertonic') {
      const { sessions, cfgs, indexer, style, totalStep, speed } = loadedTts;
      const { wav, durationSeconds } = await supertonicInfer(
        sessions,
        cfgs,
        indexer,
        text,
        'da',
        style,
        totalStep,
        speed,
      );
      if (durationSeconds <= 0 || wav.length === 0) throw new Error('Nothing to speak');
      const samples = Float32Array.from(wav);
      return {
        result: { samples, sampleRate: cfgs.ae.sample_rate },
        transfer: [samples.buffer],
      };
    }

    const { config, session } = loadedTts;
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
