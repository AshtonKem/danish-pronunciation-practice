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
| ASR | `AshtonKem/edda-v0.2-ONNX` | Danish fine-tune of Whisper-large-v3-turbo. Recommended — see below. |
| ASR | `PierreMesure/roest-315m-onnx` | Danish-specific wav2vec2 CTC. |
| ASR | `onnx-community/whisper-{tiny,base,small,large-v3-turbo}` | Multilingual; Danish via `language: 'da'`. |
| TTS | Piper `da_DK-talesyntese-medium` | 63 MB VITS voice, run directly on onnxruntime-web. |
| TTS | System voice (`da-DK`) | No download; quality depends on what your OS has installed. |
| Phonemes | espeak-ng via `piper_phonemize` | 19 MB. Needed for TTS *and* for phoneme-level scoring. |

ASR models offer whichever quantisations are actually verified working; see each
model's `note` in `catalog.ts` (`roest-315m-onnx` degrades noticeably below q8; `edda`
doesn't ship fp16/q4 at all, see below).

### Why stock Whisper alone wasn't good enough, and what's used instead

The [CoRaL Danish ASR leaderboard](https://huggingface.co/spaces/RyeAI/danish-asr-leaderboard)
ranks Danish-specific fine-tunes far ahead of stock Whisper (its #2 model, `edda-v0.2`,
scores 8.8% WER against stock `whisper-large-v3`'s 23.9%). Most of the leaderboard's
top models still aren't usable in this app, for three different reasons depending on
the model:

- Most (`roest-v2/v3`, `brage`, `saga`, `hviske-v3/v5/v5.1/v5.3/v6`, `danstral`,
  `milo-asr`) have no ONNX export published at all.
- `syvai/hviske-v5-tiny` has one, and transformers.js 4.3.1 even ships native code for
  its `cohere_asr` architecture — but the repo is gated behind Hub authentication (this
  app has no login flow), and separately, its files are named `encoder.onnx`/
  `decoder.onnx` while transformers.js hardcodes `encoder_model.onnx`/
  `decoder_model_merged.onnx` for that architecture, so it wouldn't resolve even if it
  weren't gated.
- `RyeAI/ekko-v1-tiny` and the `3dio-ai/svale-*` models are NVIDIA Parakeet RNNT/TDT
  fine-tunes exported in `sherpa-onnx` format (separate encoder/decoder/**joiner**
  networks needing a streaming label-loop decode). transformers.js does ship a
  `parakeet` module, but only the CTC variant (`ParakeetForCTC`) — not RNNT/TDT — so it
  doesn't cover these either.
- `Harmonium/brage-v1` is gated behind Hub authentication *and* its published 8.34%
  WER depends on a custom KenLM-fused decoder (`brage_decode.py`), not plain Whisper
  generation — a vanilla ONNX conversion almost certainly wouldn't reproduce that
  number even with access. Its license is Apache-2.0 plus CoRaL's Attachment A
  use-restrictions (no voice cloning/impersonation, no demographic inference, etc.),
  not AGPL; satisfying it means carrying that text, `LICENSE-CORAL`, and `NOTICE`
  verbatim, not substituting a different license.

**`AshtonKem/edda-v0.2-ONNX`** doesn't have any of these problems: `edda-v0.2` is
Apache-2.0, not gated, and its published 8.79% WER comes from plain beam search
(`num_beams=5`, the default already baked into its `generation_config.json`) — no
custom decoder dependency. It also just had no ONNX export, community or official, so
this one is this app's own conversion from the original safetensors checkpoint, done
with `optimum-cli export onnx` and `optimum.onnx.graph_transformations.merge_decoders`
(the encoder/decoder had to be exported separately, then merged — a plain
`optimum-cli export onnx` call doesn't do this automatically for every architecture).
`q8` and `fp32` are both verified end to end with an exact-match transcription against
a synthesised test sentence; `fp16` and `q4` aren't offered — `fp16` conversion hit a
genuine ONNX type-inference bug in the merged decoder's control-flow (`If`) node (an
`Add` op left with mismatched `float16`/`float32` operands, which persisted whether the
two pre-merge decoder graphs were converted to fp16 before merging or the already-merged
graph was converted after), and no reliable 4-bit weight-only quantisation tool was
available in the conversion environment. See the model repo's own README for the full
writeup.

**`PierreMesure/roest-315m-onnx`** was the first Danish-specific model added here,
before `edda` existed in this app: a community ONNX conversion of
`CoRal-project/roest-wav2vec2-315m-v1`, a plain wav2vec2 CTC architecture transformers.js
already supports natively, published with `library_name: transformers.js` and the exact
file layout it expects. It's v1 — v2 and v3 exist and score better still on the
leaderboard, but neither has a published ONNX export. Even v1 scores ~17% WER on its own
card, close to double `edda`'s. Its published conversion also had a real bug:
`tokenizer.json`'s `added_tokens` array is empty, so every special token id — including
the CTC blank token — decoded as the literal string `"<unk>"` instead of being dropped,
turning "jeg vil" into `"<unk>j<unk>eg vil<unk>"`. `tokenizer_config.json`'s
`added_tokens_decoder` has the correct data; `asr.worker.ts` patches it into
`tokenizer.json` in flight via `env.fetch` (the single choke point transformers.js
calls for every file it fetches) rather than waiting on a fix to someone else's Hub
repo. The patch is unconditional but checks first, so it's a no-op for every
correctly-formed tokenizer (every other model here included).

The leaderboard's `benchmark` scores in `catalog.ts` (mean WER/CER across CoRaL
conversation + read-aloud, FTSpeech, Common Voice 17 da, and FLEURS da, dated
2026-10-15, or a model's own card where noted) are what every size here is judged
against — not a single clean test sentence. Trust that gap more than your own quick
test: `whisper-small` transcribes an easy synthesised sentence perfectly, yet scores
46.9% WER on the real benchmark.

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
    asr.worker.ts     Whisper + wav2vec2 via transformers.js
    tts.worker.ts     Piper via onnxruntime-web + espeak-ng phonemiser
```

Inference runs in workers so a multi-hundred-megabyte model load never blocks the UI.

### Two notes on the build

- `vite.config.ts` sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`. The isolation enables
  `SharedArrayBuffer`; `credentialless` rather than `require-corp` is what keeps
  Hugging Face downloads working. `SharedArrayBuffer` is still required even though
  both workers pin `numThreads` to 1 (see below) — onnxruntime-web 1.30 only ships one
  wasm binary (`ort-wasm-simd-threaded.wasm`), and it's compiled with a shared
  `WebAssembly.Memory`, which needs `SharedArrayBuffer` to instantiate at all,
  independent of how many threads actually get used at runtime.
- ONNX Runtime's WASM sidecars are served out of `node_modules` at `/ort/` in dev and
  copied into `dist/ort/` on build, keeping them same-origin and available offline.
  `vite build` also emits two ~26 MB `*.asyncify.wasm` assets: those are static
  references inside ORT's own ESM bundles that `wasmPaths` overrides at runtime, so
  they are dead weight in `dist` rather than something the app fetches.
- The TTS worker probes `navigator.gpu.requestAdapter()` itself before telling
  onnxruntime-web to use WebGPU, rather than trusting the capability flag the UI reads
  on the main thread (WebGPU support inside a dedicated Worker can lag behind
  main-thread support). This isn't just cosmetic: once a `session.create()` call fails
  while resolving the `'webgpu'` execution provider, onnxruntime-web's wasm backend
  caches that failure as a module-level singleton and refuses to retry wasm init for
  the rest of the worker's lifetime (`"previous call to 'initWasm()' failed"`) — so a
  doomed webgpu attempt must never be issued in the first place, rather than caught and
  retried after the fact.
- Both workers pin `ort.env.wasm.numThreads` (`env.backends.onnx.wasm.numThreads` for
  the ASR worker) to `1`. Above 1, Emscripten's pthread runtime spins up its own worker
  pool to back the threads — a nested Worker-from-a-Worker, since this code already
  runs inside one — and that silently hung forever in Firefox and Safari (no console
  output, no rejection, regardless of execution provider) once the model had finished
  downloading. ONNX Runtime documents `numThreads: 1` as spawning no worker thread at
  all, which sidesteps the nested-worker path entirely rather than depending on
  browser support for it.

## Licensing

espeak-ng (via `piper_phonemize`) is GPL-3.0-or-later and is fetched at runtime rather
than bundled. Worth checking before redistributing this as a product.
