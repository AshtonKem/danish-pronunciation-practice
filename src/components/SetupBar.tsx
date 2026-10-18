import { ASR_MODELS, TTS_MODELS } from '../catalog';

export interface SetupBarProps {
  asrId: string;
  ttsId: string;
  asrState: 'idle' | 'loading' | 'ready';
  ttsState: 'idle' | 'loading' | 'ready';
  busy: boolean;
  onAsrId: (id: string) => void;
  onTtsId: (id: string) => void;
  onLoadAsr: () => void;
  onLoadTts: () => void;
}

/**
 * The minimal "what do I need before I can practise" bar for the Practice
 * tab: pick a recogniser and a voice by name, load them, done. Everything
 * that's about *how* a model runs rather than *which* one — quantisation,
 * backend, benchmark citations, the notes on bugs hit converting one of
 * them — lives in the Advanced tab's ModelsPanel instead. That's the same
 * `asrId`/`ttsId`/`...State` the Advanced tab reads and writes, so picking a
 * model here or there stays in sync; this just doesn't show the knobs.
 */
export function SetupBar(props: SetupBarProps) {
  const row = (
    label: string,
    id: string,
    options: { id: string; label: string }[],
    state: 'idle' | 'loading' | 'ready',
    onId: (id: string) => void,
    onLoad: () => void,
  ) => (
    <div className="setup-row">
      <label className="field">
        <span>{label}</span>
        <select value={id} onChange={(event) => onId(event.target.value)} disabled={props.busy}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {state === 'ready' ? (
        <span className="ready-badge">✓ Ready</span>
      ) : (
        <button type="button" onClick={onLoad} disabled={props.busy}>
          {state === 'loading' ? 'Loading…' : 'Load'}
        </button>
      )}
    </div>
  );

  return (
    <section className="card setup-bar">
      {row(
        'Recogniser',
        props.asrId,
        ASR_MODELS.map((m) => ({ id: m.id, label: m.label })),
        props.asrState,
        props.onAsrId,
        props.onLoadAsr,
      )}
      {row(
        'Voice',
        props.ttsId,
        TTS_MODELS.map((m) => ({ id: m.id, label: m.label })),
        props.ttsState,
        props.onTtsId,
        props.onLoadTts,
      )}
    </section>
  );
}
