import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ASR_MODELS, TTS_MODELS, formatBytes } from './catalog';
import { ModelsPanel } from './components/ModelsPanel';
import { PracticePanel } from './components/PracticePanel';
import { ResultView } from './components/ResultView';
import { SetupBar } from './components/SetupBar';
import { Recorder, playSamples } from './lib/audio';
import { Engines, type LoadProgress } from './lib/engines';
import { evaluate, evaluateWord, type PhonemeGroups } from './lib/evaluate';
import { listStored, removeStored, storageUsage, type StoredItem } from './lib/modelStore';
import { speakWithSystemVoice } from './lib/systemVoice';
import type { Device, Dtype, Evaluation, WordCheck } from './types';

type EngineState = 'idle' | 'loading' | 'ready';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function App() {
  const engines = useMemo(() => new Engines(), []);
  const recorder = useRef<Recorder | null>(null);

  const [tab, setTab] = useState<'practice' | 'advanced'>('practice');

  const webgpuAvailable = useMemo(() => 'gpu' in navigator, []);
  // Models need SharedArrayBuffer, which the browser only grants to a
  // cross-origin isolated page. Checked here too, not just inside the
  // workers' own requireCrossOriginIsolation(), so this shows up before
  // the user even tries to load anything.
  const crossOriginIsolated = useMemo(() => window.crossOriginIsolated === true, []);

  // Picked per the benchmark data in catalog.ts: the most accurate option
  // that stays practical to download and run in-browser.
  const defaultAsr = ASR_MODELS.find((m) => m.id === 'edda-v0.2') ?? ASR_MODELS[0];
  const [asrId, setAsrId] = useState(defaultAsr.id);
  const [dtype, setDtype] = useState<Dtype>(defaultAsr.defaultDtype);
  const [device, setDevice] = useState<Device>('webgpu');
  const [ttsId, setTtsId] = useState(TTS_MODELS[0].id);

  const [asrState, setAsrState] = useState<EngineState>('idle');
  const [ttsState, setTtsState] = useState<EngineState>('idle');
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [sentence, setSentence] = useState('Jeg vil gerne have en kop kaffe.');
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);

  // Retrying a single word from the result — kept fully separate from
  // `evaluation`/`recording` above so it can run without disturbing them.
  const wordRecorder = useRef<Recorder | null>(null);
  const [wordRecordingIndex, setWordRecordingIndex] = useState<number | null>(null);
  const [wordLevel, setWordLevel] = useState(0);
  const [wordCheck, setWordCheck] = useState<WordCheck | null>(null);

  const [stored, setStored] = useState<StoredItem[]>([]);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  const refreshStorage = useCallback(async () => {
    const [items, estimate] = await Promise.all([listStored(), storageUsage()]);
    setStored(items);
    setUsage(estimate);
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  useEffect(() => {
    if (!webgpuAvailable) setDevice('wasm');
  }, [webgpuAvailable]);

  // Picking a different model should reset the quantisation to one that suits it.
  useEffect(() => {
    setDtype(ASR_MODELS.find((m) => m.id === asrId)?.defaultDtype ?? 'q8');
    setAsrState('idle');
  }, [asrId]);

  useEffect(() => {
    return () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
  }, [recordingUrl]);

  /** Shared wrapper so every long action reports status and clears progress. */
  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setStatus(label);
      setElapsedMs(0);
      try {
        await action();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
        setStatus(null);
        setProgress(null);
        void refreshStorage();
      }
    },
    [refreshStorage],
  );

  // A byte-progress bar already says "working" for downloads; this is for
  // the steps that don't have one — notably beam-search transcription on a
  // single-threaded WASM decoder, which can run well past a minute with no
  // other sign of life. Ticking seconds is enough to tell "slow" from "stuck".
  useEffect(() => {
    if (!status) return;
    const startedAt = performance.now();
    const id = setInterval(() => setElapsedMs(performance.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [status]);

  const loadAsr = useCallback(() => {
    const spec = ASR_MODELS.find((m) => m.id === asrId);
    if (!spec) return;
    void run(`Loading ${spec.label}…`, async () => {
      setAsrState('loading');
      try {
        await engines.loadAsr(spec.repo, spec.kind, dtype, device, setProgress);
        setAsrState('ready');
      } catch (caught) {
        setAsrState('idle');
        throw caught;
      }
    });
  }, [asrId, device, dtype, engines, run]);

  const loadTts = useCallback(() => {
    const spec = TTS_MODELS.find((m) => m.id === ttsId);
    if (!spec) return;
    void run(`Loading ${spec.label}…`, async () => {
      setTtsState('loading');
      try {
        if (spec.engine === 'piper' || spec.engine === 'supertonic') {
          await engines.loadVoice(spec.id, device, setProgress);
        } else {
          // The system voice needs no model, but scoring still needs phonemes.
          await engines.preparePhonemiser(setProgress);
        }
        setTtsState('ready');
      } catch (caught) {
        setTtsState('idle');
        throw caught;
      }
    });
  }, [device, engines, run, ttsId]);

  const speakText = useCallback(
    (text: string, label: string) => {
      const spec = TTS_MODELS.find((m) => m.id === ttsId);
      if (!spec) return;
      void run(label, async () => {
        if (spec.engine === 'system') {
          await speakWithSystemVoice(text);
          return;
        }
        const { samples, sampleRate } = await engines.speak(text);
        await playSamples(samples, sampleRate);
      });
    },
    [engines, run, ttsId],
  );

  const speak = useCallback(() => speakText(sentence, 'Speaking…'), [sentence, speakText]);

  // Re-hear a single word from the result, in isolation — Piper synthesises
  // whatever text it's given, so this is just speakText() with one word
  // instead of the whole sentence.
  const playWord = useCallback(
    (word: string) => speakText(word, `Playing “${word}”…`),
    [speakText],
  );

  const check = useCallback(
    async (samples: Float32Array, durationMs: number) => {
      await run('Transcribing…', async () => {
        const { text } = await engines.transcribe(samples);

        // One phonemiser run covers both the target and what was heard.
        let groups: (PhonemeGroups | null)[] = [null, null];
        try {
          ({ groups } = await engines.phonemize([sentence, text]));
        } catch {
          // Phonemes are an enhancement; fall back to word-level comparison.
        }

        setEvaluation(evaluate(sentence, text, groups[0] ?? null, groups[1] ?? null, durationMs));
      });
    },
    [engines, run, sentence],
  );

  const toggleRecord = useCallback(() => {
    if (recording) {
      const active = recorder.current;
      recorder.current = null;
      setRecording(false);
      setLevel(0);
      if (!active) return;
      void run('Processing audio…', async () => {
        const result = await active.stop();
        setRecordingUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(result.blob);
        });
        await check(result.samples, result.durationMs);
      });
      return;
    }

    void run('Starting microphone…', async () => {
      const active = new Recorder();
      await active.start();
      recorder.current = active;
      setRecording(true);
      setEvaluation(null);
      // A fresh sentence attempt invalidates any retry of a word from the
      // previous one — indices may no longer even point at the same words.
      setWordCheck(null);
    });
  }, [check, recording, run]);

  // Poll the input level only while recording.
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    const tick = () => {
      setLevel(recorder.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording]);

  const checkWord = useCallback(
    async (index: number, target: string, samples: Float32Array) => {
      await run(`Checking “${target}”…`, async () => {
        const { text } = await engines.transcribe(samples);

        let groups: (PhonemeGroups | null)[] = [null, null];
        try {
          ({ groups } = await engines.phonemize([target, text]));
        } catch {
          // Phonemes are an enhancement; fall back to word-level comparison.
        }

        const result = evaluateWord(target, text, groups[0] ?? null, groups[1] ?? null);
        setWordCheck({ index, result });
      });
    },
    [engines, run],
  );

  // Mirrors toggleRecord, scoped to one word: never touches `evaluation` or
  // `recording`/`recorder`, so the full-sentence result stays on screen and
  // the main Record button stays untouched throughout.
  const toggleWordRecord = useCallback(
    (index: number, target: string) => {
      // Ignore a click for a different word while one is already recording —
      // the UI disables this, but never stop/evaluate the wrong recording.
      if (wordRecordingIndex !== null && wordRecordingIndex !== index) return;

      if (wordRecordingIndex !== null) {
        const active = wordRecorder.current;
        wordRecorder.current = null;
        setWordRecordingIndex(null);
        setWordLevel(0);
        if (!active) return;
        void run('Processing audio…', async () => {
          const result = await active.stop();
          await checkWord(index, target, result.samples);
        });
        return;
      }

      void run('Starting microphone…', async () => {
        const active = new Recorder();
        await active.start();
        wordRecorder.current = active;
        setWordRecordingIndex(index);
        setWordCheck(null);
      });
    },
    [checkWord, run, wordRecordingIndex],
  );

  // Poll the input level only while recording a single word.
  useEffect(() => {
    if (wordRecordingIndex === null) return;
    let frame = 0;
    const tick = () => {
      setWordLevel(wordRecorder.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [wordRecordingIndex]);

  const deleteItem = useCallback(
    (item: StoredItem) => {
      void run(`Deleting ${item.label}…`, async () => {
        await removeStored(item);
        // The in-memory session still holds the weights; make that explicit.
        if (item.kind === 'asr') {
          await engines.unloadAsr();
          setAsrState('idle');
        }
        if (item.kind === 'tts' || item.kind === 'phonemiser') setTtsState('idle');
      });
    },
    [engines, run],
  );

  // Shared between SetupBar and the Advanced tab's ModelsPanel -- picking a
  // voice invalidates whichever one was previously loaded either way.
  const selectTtsId = useCallback((id: string) => {
    setTtsId(id);
    setTtsState('idle');
  }, []);

  const ttsSpec = TTS_MODELS.find((m) => m.id === ttsId);

  return (
    <main className="app">
      <header className="app-head">
        <h1>Dansk udtale</h1>
        <p className="muted">
          Type a Danish sentence, hear it, say it back, and see which sounds came out wrong. Models
          run on your own machine — nothing is uploaded.
        </p>
        <nav className="tabs">
          <button
            type="button"
            className={tab === 'practice' ? 'tab-active' : ''}
            onClick={() => setTab('practice')}
          >
            Practice
          </button>
          <button
            type="button"
            className={tab === 'advanced' ? 'tab-active' : ''}
            onClick={() => setTab('advanced')}
          >
            Advanced
          </button>
        </nav>
      </header>

      {!crossOriginIsolated && (
        <section className="card status-card">
          <p className="error">
            This page isn't cross-origin isolated, so the browser won't grant it
            SharedArrayBuffer — which models need to load at all. Try a hard reload; if that
            doesn't help, this browser may not support the isolation workaround this site
            relies on when it can't set its own response headers.
          </p>
        </section>
      )}

      {(status || progress || error) && (
        <section className="card status-card">
          {error ? (
            <p className="error">{error}</p>
          ) : (
            <>
              <p>
                {status}
                {elapsedMs > 1500 && <span className="muted"> — {formatElapsed(elapsedMs)}</span>}
              </p>
              {progress && progress.total > 0 && (
                <>
                  <div className="score-bar">
                    <div
                      className="score-fill"
                      data-tier="mid"
                      style={{ width: `${Math.round((progress.loaded / progress.total) * 100)}%` }}
                    />
                  </div>
                  <p className="muted">
                    {progress.label} — {formatBytes(progress.loaded)} /{' '}
                    {formatBytes(progress.total)}
                  </p>
                </>
              )}
            </>
          )}
        </section>
      )}

      {tab === 'practice' ? (
        <>
          <SetupBar
            asrId={asrId}
            ttsId={ttsId}
            asrState={asrState}
            ttsState={ttsState}
            busy={busy}
            onAsrId={setAsrId}
            onTtsId={selectTtsId}
            onLoadAsr={loadAsr}
            onLoadTts={loadTts}
          />

          <PracticePanel
            sentence={sentence}
            recording={recording}
            level={level}
            canSpeak={ttsState === 'ready' || ttsSpec?.engine === 'system'}
            canRecord={asrState === 'ready' && wordRecordingIndex === null}
            busy={busy}
            recordingUrl={recordingUrl}
            onSentence={setSentence}
            onSpeak={speak}
            onToggleRecord={toggleRecord}
          />

          {asrState !== 'ready' && !busy && (
            <p className="hint">Load a speech recogniser to enable recording.</p>
          )}

          {evaluation && (
            <ResultView
              evaluation={evaluation}
              canPlayWord={ttsState === 'ready' || ttsSpec?.engine === 'system'}
              canRecordWord={asrState === 'ready' && !recording}
              busy={busy}
              wordRecordingIndex={wordRecordingIndex}
              wordLevel={wordLevel}
              wordCheck={wordCheck}
              onPlayWord={playWord}
              onToggleWordRecord={toggleWordRecord}
            />
          )}

          <footer className="app-foot muted">
            <p>
              Recognition isn't perfect, so treat a high score as good evidence of correct
              pronunciation — not proof.
            </p>
          </footer>
        </>
      ) : (
        <ModelsPanel
          asrId={asrId}
          dtype={dtype}
          device={device}
          ttsId={ttsId}
          webgpuAvailable={webgpuAvailable}
          asrState={asrState}
          ttsState={ttsState}
          stored={stored}
          usage={usage}
          busy={busy}
          onAsrId={setAsrId}
          onDtype={setDtype}
          onDevice={setDevice}
          onTtsId={selectTtsId}
          onLoadAsr={loadAsr}
          onLoadTts={loadTts}
          onDelete={deleteItem}
        />
      )}
    </main>
  );
}
