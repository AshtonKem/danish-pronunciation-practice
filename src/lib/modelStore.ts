import { ASR_MODELS, TTS_MODELS } from '../catalog';

/** Our own downloads: Piper voices and the espeak-ng phonemiser. */
export const ASSET_CACHE = 'danish-speech-assets';
/** Written by transformers.js; `env.cacheKey` defaults to this. */
export const TRANSFORMERS_CACHE = 'transformers-cache';

export type StoredKind = 'asr' | 'tts' | 'phonemiser' | 'runtime';

export interface StoredItem {
  /** Stable identity used for deletion and React keys. */
  key: string;
  label: string;
  kind: StoredKind;
  bytes: number;
  urls: string[];
  cacheName: string;
}

interface Grouping {
  key: string;
  label: string;
  kind: StoredKind;
}

const ASR_BY_REPO = new Map(ASR_MODELS.map((m) => [m.repo, m]));
const PIPER_VOICES = TTS_MODELS.filter((m) => m.voice);

/**
 * Decide which listed item a cached URL belongs to. Returning a group per model
 * repo is what lets the UI show "Whisper small — 299 MB" instead of 40 opaque
 * cache entries.
 */
function groupFor(rawUrl: string): Grouping {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { key: `other:${rawUrl}`, label: rawUrl, kind: 'runtime' };
  }

  const voice = PIPER_VOICES.find((m) => rawUrl === m.voice!.model || rawUrl === m.voice!.config);
  if (voice) return { key: `tts:${voice.id}`, label: voice.label, kind: 'tts' };

  if (/piper[-_]phonemize|piper-wasm/.test(rawUrl)) {
    return { key: 'phonemiser', label: 'espeak-ng phonemiser (Piper)', kind: 'phonemiser' };
  }

  // https://huggingface.co/<owner>/<name>/resolve/<rev>/<path>
  const hf = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\//);
  if (hf) {
    const repo = `${hf[1]}/${hf[2]}`;
    const known = ASR_BY_REPO.get(repo);
    return { key: `asr:${repo}`, label: known?.label ?? repo, kind: 'asr' };
  }

  return {
    key: 'runtime',
    label: 'ONNX Runtime (WASM)',
    kind: 'runtime',
  };
}

/**
 * Cached responses keep the headers they arrived with, so Content-Length is
 * normally there. Reading the blob is the fallback; it is backed by disk rather
 * than copied into JS memory, but it is still the slower path.
 */
async function responseBytes(response: Response): Promise<number> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0) return declared;
  try {
    return (await response.blob()).size;
  } catch {
    return 0;
  }
}

async function collect(cacheName: string, into: Map<string, StoredItem>): Promise<void> {
  if (!(await caches.has(cacheName))) return;
  const cache = await caches.open(cacheName);
  const requests = await cache.keys();

  const sized = await Promise.all(
    requests.map(async (request) => {
      const response = await cache.match(request);
      return {
        url: request.url,
        bytes: response ? await responseBytes(response) : 0,
      };
    }),
  );

  for (const { url, bytes } of sized) {
    const group = groupFor(url);
    const existing = into.get(group.key);
    if (existing) {
      existing.bytes += bytes;
      existing.urls.push(url);
    } else {
      into.set(group.key, { ...group, bytes, urls: [url], cacheName });
    }
  }
}

export async function listStored(): Promise<StoredItem[]> {
  if (typeof caches === 'undefined') return [];
  const items = new Map<string, StoredItem>();
  await collect(TRANSFORMERS_CACHE, items);
  await collect(ASSET_CACHE, items);
  const order: StoredKind[] = ['asr', 'tts', 'phonemiser', 'runtime'];
  return [...items.values()].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.bytes - a.bytes,
  );
}

export async function removeStored(item: StoredItem): Promise<void> {
  const cache = await caches.open(item.cacheName);
  await Promise.all(item.urls.map((url) => cache.delete(url)));
}

export async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

export interface DownloadProgress {
  url: string;
  loaded: number;
  total: number;
}

/**
 * Fetch through {@link ASSET_CACHE}, reporting progress on the first download.
 * Used for everything transformers.js does not fetch for us.
 */
export async function cachedFetch(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();

  const response = await fetch(url, { mode: 'cors' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ url, loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Keep Content-Length so the model list can size this without reading it back.
  await cache.put(
    url,
    new Response(bytes, {
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
      },
    }),
  );

  return bytes.buffer;
}
