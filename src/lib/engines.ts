import type { PhonemeGroups } from './evaluate';
import { WorkerClient } from './rpc';
import type { Device, Dtype } from '../types';

export interface LoadProgress {
  label: string;
  loaded: number;
  total: number;
}

/** transformers.js progress events, narrowed to the fields we display. */
interface HubProgress {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/** Progress from our own cached downloads. */
interface AssetProgress {
  url?: string;
  loaded?: number;
  total?: number;
}

function basename(path: string): string {
  const withoutQuery = path.split('?')[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1) || withoutQuery;
}

function toLoadProgress(data: unknown): LoadProgress | null {
  const event = data as HubProgress & AssetProgress;
  if (!event || typeof event !== 'object') return null;
  if (event.status && event.status !== 'progress') return null;
  const source = event.file ?? event.url;
  if (!source) return null;
  return {
    label: basename(source),
    loaded: event.loaded ?? 0,
    total: event.total ?? 0,
  };
}

export class Engines {
  private readonly asr = new WorkerClient(
    new Worker(new URL('../workers/asr.worker.ts', import.meta.url), { type: 'module' }),
  );
  private readonly tts = new WorkerClient(
    new Worker(new URL('../workers/tts.worker.ts', import.meta.url), { type: 'module' }),
  );

  private forward(onProgress?: (progress: LoadProgress) => void) {
    return (data: unknown) => {
      const progress = toLoadProgress(data);
      if (progress) onProgress?.(progress);
    };
  }

  loadAsr(
    repo: string,
    dtype: Dtype,
    device: Device,
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<{ reused: boolean; device: Device }> {
    return this.asr.call('load', { repo, dtype, device }, { onProgress: this.forward(onProgress) });
  }

  transcribe(samples: Float32Array): Promise<{ text: string }> {
    // Hand the buffer over rather than copying it; the UI keeps the Blob.
    const copy = Float32Array.from(samples);
    return this.asr.call('transcribe', { samples: copy }, { transfer: [copy.buffer] });
  }

  unloadAsr(): Promise<null> {
    return this.asr.call('unload');
  }

  /** Downloads the espeak-ng phonemiser if needed; required for scoring. */
  preparePhonemiser(onProgress?: (progress: LoadProgress) => void): Promise<{ language: string }> {
    return this.tts.call('prepare', {}, { onProgress: this.forward(onProgress) });
  }

  loadVoice(
    id: string,
    device: Device,
    onProgress?: (progress: LoadProgress) => void,
  ): Promise<{ reused: boolean; device: Device }> {
    return this.tts.call('loadVoice', { id, device }, { onProgress: this.forward(onProgress) });
  }

  speak(text: string): Promise<{ samples: Float32Array; sampleRate: number }> {
    return this.tts.call('speak', { text });
  }

  phonemize(texts: string[]): Promise<{ groups: (PhonemeGroups | null)[] }> {
    return this.tts.call('phonemize', { texts });
  }
}
