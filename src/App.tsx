import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ASR_MODELS, TTS_MODELS, formatBytes } from './catalog';
import { ModelsPanel } from './components/ModelsPanel';
import { PracticePanel } from './components/PracticePanel';
import { ResultView } from './components/ResultView';
import { Recorder, playSamples } from './lib/audio';
import { Engines, type LoadProgress } from './lib/engines';
import { evaluate, type PhonemeGroups } from './lib/evaluate';
import { listStored, removeStored, storageUsage, type StoredItem } from './lib/modelStore';
import { speakWithSystemVoice } from './lib/systemVoice';
import type { Device, Dtype, Evaluation } from './types';

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

  const webgpuAvailable = useMemo(() => 'gpu' in navigator, []);

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
        if (spec.engine === 'piper') {
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

  const speak = useCallback(() => {
    const spec = TTS_MODELS.find((m) => m.id === ttsId);
    if (!spec) return;
    void run('Speaking…', async () => {
      if (spec.engine === 'system') {
        await speakWithSystemVoice(sentence);
        return;
      }
      const { samples, sampleRate } = await engines.speak(sentence);
      await playSamples(samples, sampleRate);
    });
  }, [engines, run, sentence, ttsId]);

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

  const ttsSpec = TTS_MODELS.find((m) => m.id === ttsId);

  return (
    <main className="app">
      <header className="app-head">
        <h1>Dansk udtale</h1>
        <p className="muted">
          Type a Danish sentence, hear it, say it back, and see which sounds came out wrong. Models
          run on your own machine — nothing is uploaded.
        </p>
      </header>

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
        onTtsId={(id) => {
          setTtsId(id);
          setTtsState('idle');
        }}
        onLoadAsr={loadAsr}
        onLoadTts={loadTts}
        onDelete={deleteItem}
      />

      <PracticePanel
        sentence={sentence}
        recording={recording}
        level={level}
        canSpeak={ttsState === 'ready' || ttsSpec?.engine === 'system'}
        canRecord={asrState === 'ready'}
        busy={busy}
        recordingUrl={recordingUrl}
        onSentence={setSentence}
        onSpeak={speak}
        onToggleRecord={toggleRecord}
      />

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

      {asrState !== 'ready' && !busy && (
        <p className="hint">Load a speech recogniser to enable recording.</p>
      )}

      {evaluation && <ResultView evaluation={evaluation} />}

      <footer className="app-foot muted">
        <p>
          Whisper runs through transformers.js; the Danish voice is Piper{' '}
          <code>da_DK-talesyntese-medium</code>, phonemised with espeak-ng. Because Whisper is a
          language model it will sometimes "correct" what you said, so a perfect score is evidence
          of good pronunciation, not proof.
        </p>
      </footer>
    </main>
  );
}
