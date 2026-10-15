# Dansk udtale — Danish speech practice

A browser app for drilling Danish pronunciation. Type a sentence, hear a native-ish
voice say it, record yourself saying it back, and see which **sounds** came out wrong —
not just which words.

Everything runs on-device. No audio leaves the machine; the only network traffic is
downloading model weights from Hugging Face the first time.

## Quick start

```sh
nix develop          # or ensure Node 24+ is on PATH
npm install
npm run dev          # http://localhost:5173
```

Then, in the app:

1. **Models** → pick a recogniser (start with *Whisper small*) and click **Load recogniser**.
2. **Models** → click **Load voice** to fetch the Danish Piper voice + phonemiser.
3. **Practise** → type a sentence, **Listen** to it, then **Record** and say it back.

Chrome or Edge is required for WebGPU. Without it the app falls back to WASM on the
CPU, which works but is noticeably slower.

## How the error highlighting works

Comparing two strings only tells you *which words* were wrong. To say *which sounds*
were wrong, the app phonemises both sides with the same engine Piper was trained on:

1. Whisper transcribes the recording (with the language pinned to `da`, so halting
   Danish is not "helpfully" transcribed as English).
2. espeak-ng phonemises the target sentence **and** the transcript in one pass,
   yielding IPA phonemes grouped per word.
3. Words are aligned with Needleman-Wunsch, using a substitution cost derived from
   edit distance. The gap cost is tuned so a genuinely different word becomes an
   *extra* + *missing* pair rather than a misleading substitution.
4. Each substituted word gets a second alignment pass over its phonemes, which is
   what distinguishes *mispronounced* (right word, wrong sounds — shown phoneme by
   phoneme) from *wrong* (different word entirely).

Two consequences worth knowing:

- Saying *kafe* where the target says *kaffe* scores **correct**, because the phonemes
  are identical. Spelling is not what is being graded.
- Stress marks are dropped and combining diacritics are folded into the sound they
  modify, so `ɐ` + U+032F compares as the single unit `ɐ̯`.

### The honest caveat

Whisper is a language model, so it will sometimes *correct* sloppy pronunciation into
the word you clearly meant. A high score is good evidence of good pronunciation, not
proof of it. Errors it does report are reliable; errors it misses are possible. Using a
larger recogniser reduces, but does not remove, this effect.

## Models

| Role | Model | Notes |
| --- | --- | --- |
| ASR | `onnx-community/whisper-{tiny,base,small,large-v3-turbo}` | Multilingual; Danish via `language: 'da'`. Selectable quantisation (q4/q8/fp16/fp32). |
| TTS | Piper `da_DK-talesyntese-medium` | 63 MB VITS voice, run directly on onnxruntime-web. |
| TTS | System voice (`da-DK`) | No download; quality depends on what your OS has installed. |
| Phonemes | espeak-ng via `piper_phonemize` | 19 MB. Needed for TTS *and* for phoneme-level scoring. |

There is no Danish-specific ASR fine-tune on the Hub with a transformers.js-compatible
ONNX layout, which is why the choice here is model *size* rather than a Danish model.

In testing, `whisper-base` garbled a clean synthesised sentence
(*"Jep igen hen, kop kaffe."*) while `whisper-small` transcribed it exactly — hence
small being the default.

### Managing downloads

**Models → Downloaded** lists every cached artefact with its real byte size and a
delete button, plus total browser storage use. Weights are large, and the browser will
otherwise hold on to them indefinitely.

Downloads live in two Cache Storage buckets: `transformers-cache` (written by
transformers.js) and `danish-speech-assets` (the Piper voice and phonemiser). Deleting
an entry also drops the in-memory session, so the next use re-downloads it.

## Layout

```
src/
  catalog.ts          model catalog, sizes, defaults
  lib/
    align.ts          Needleman-Wunsch + edit distance
    danish.ts         normalisation (case, punctuation, numerals, æøå)
    phonemes.ts       espeak symbol stream -> per-word phoneme units
    evaluate.ts       word + phoneme alignment -> per-word verdicts
    modelStore.ts     cache listing, sizing, deletion, progress downloads
    audio.ts          mic capture, resampling to 16 kHz, playback
    engines.ts        typed facade over the workers
    rpc.ts            promise-per-message worker RPC
  workers/
    asr.worker.ts     Whisper via transformers.js
    tts.worker.ts     Piper via onnxruntime-web + espeak-ng phonemiser
```

Inference runs in workers so a multi-hundred-megabyte model load never blocks the UI.

### Two notes on the build

- `vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`. The isolation enables
  `SharedArrayBuffer`, and therefore multi-threaded WASM; `credentialless` rather than
  `require-corp` is what keeps Hugging Face downloads working.
- ONNX Runtime's WASM sidecars are served out of `node_modules` at `/ort/` in dev and
  copied into `dist/ort/` on build, keeping them same-origin and available offline.
  `vite build` also emits two ~26 MB `*.asyncify.wasm` assets: those are static
  references inside ORT's own ESM bundles that `wasmPaths` overrides at runtime, so
  they are dead weight in `dist` rather than something the app fetches.

## Licensing

espeak-ng (via `piper_phonemize`) is GPL-3.0-or-later and is fetched at runtime rather
than bundled. Worth checking before redistributing this as a product.
