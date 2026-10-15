/** Whisper's feature extractor expects mono PCM at this rate. */
export const ASR_SAMPLE_RATE = 16_000;

export interface Recording {
  blob: Blob;
  /** Mono PCM at {@link ASR_SAMPLE_RATE}, ready for the ASR worker. */
  samples: Float32Array;
  durationMs: number;
}

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Wraps MediaRecorder with a live input level, so the UI can show that the mic
 * is actually picking something up before the user finds out post-hoc that it
 * recorded silence.
 */
export class Recorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private levels?: Float32Array<ArrayBuffer>;
  private chunks: Blob[] = [];
  private startedAt = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.levels = new Float32Array(this.analyser.fftSize);
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);

    this.chunks = [];
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(100);
    this.startedAt = performance.now();
  }

  /** Current input level, 0–1, as RMS of the latest analyser frame. */
  level(): number {
    if (!this.analyser || !this.levels) return 0;
    this.analyser.getFloatTimeDomainData(this.levels);
    let sum = 0;
    for (const sample of this.levels) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.levels.length) * 4);
  }

  async stop(): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Recorder was not started');

    const durationMs = performance.now() - this.startedAt;
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;

    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.stream = undefined;
    this.recorder = undefined;
    this.context = undefined;
    this.analyser = undefined;

    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    return { blob, samples: await decodeToMono(blob), durationMs };
  }
}

/** Decode any browser-supported container down to mono PCM at the ASR rate. */
export async function decodeToMono(
  blob: Blob,
  sampleRate = ASR_SAMPLE_RATE,
): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(bytes);
  } finally {
    await decoder.close();
  }

  // A 1-channel destination downmixes and resamples in one render pass.
  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
  const offline = new OfflineAudioContext(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Plays raw PCM, e.g. the Piper voice output. Resolves when playback ends. */
export async function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  const context = new AudioContext();
  try {
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    // `set` rather than `copyToChannel`: the samples may arrive backed by a
    // SharedArrayBuffer when threaded WASM is in play.
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  } finally {
    await context.close();
  }
}
