import { ASR_MODELS, DTYPES, TTS_MODELS, formatBytes } from '../catalog';
import type { StoredItem } from '../lib/modelStore';
import type { Device, Dtype } from '../types';

const KIND_LABEL: Record<StoredItem['kind'], string> = {
  asr: 'Speech recognition',
  tts: 'Voice',
  phonemiser: 'Phonemiser',
  runtime: 'Runtime',
};

export interface ModelsPanelProps {
  asrId: string;
  dtype: Dtype;
  device: Device;
  ttsId: string;
  webgpuAvailable: boolean;
  asrState: 'idle' | 'loading' | 'ready';
  ttsState: 'idle' | 'loading' | 'ready';
  stored: StoredItem[];
  usage: { usage: number; quota: number } | null;
  busy: boolean;
  onAsrId: (id: string) => void;
  onDtype: (dtype: Dtype) => void;
  onDevice: (device: Device) => void;
  onTtsId: (id: string) => void;
  onLoadAsr: () => void;
  onLoadTts: () => void;
  onDelete: (item: StoredItem) => void;
}

export function ModelsPanel(props: ModelsPanelProps) {
  const asr = ASR_MODELS.find((m) => m.id === props.asrId) ?? ASR_MODELS[0];
  const tts = TTS_MODELS.find((m) => m.id === props.ttsId) ?? TTS_MODELS[0];
  const totalStored = props.stored.reduce((sum, item) => sum + item.bytes, 0);

  return (
    <section className="card">
      <header className="card-head">
        <h2>Models</h2>
        {!props.webgpuAvailable && (
          <span className="warn">WebGPU unavailable — falling back to WASM</span>
        )}
      </header>

      <div className="grid">
        <label className="field">
          <span>Speech recognition</span>
          <select
            value={props.asrId}
            onChange={(event) => props.onAsrId(event.target.value)}
            disabled={props.busy}
          >
            {ASR_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Quantisation</span>
          <select
            value={props.dtype}
            onChange={(event) => props.onDtype(event.target.value as Dtype)}
            disabled={props.busy}
          >
            {DTYPES.map((dtype) => (
              <option key={dtype} value={dtype}>
                {dtype} — {formatBytes(asr.sizes[dtype])}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Backend</span>
          <select
            value={props.device}
            onChange={(event) => props.onDevice(event.target.value as Device)}
            disabled={props.busy}
          >
            <option value="webgpu" disabled={!props.webgpuAvailable}>
              WebGPU
            </option>
            <option value="wasm">WASM (CPU)</option>
          </select>
        </label>

        <div className="field field-action">
          <span>&nbsp;</span>
          <button type="button" onClick={props.onLoadAsr} disabled={props.busy}>
            {props.asrState === 'ready' ? 'Reload' : 'Load'} recogniser
          </button>
        </div>
      </div>
      <p className="muted note">{asr.note}</p>

      <div className="grid">
        <label className="field field-wide">
          <span>Voice</span>
          <select
            value={props.ttsId}
            onChange={(event) => props.onTtsId(event.target.value)}
            disabled={props.busy}
          >
            {TTS_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>

        <div className="field field-action">
          <span>&nbsp;</span>
          <button type="button" onClick={props.onLoadTts} disabled={props.busy}>
            {props.ttsState === 'ready' ? 'Reload' : 'Load'} voice
          </button>
        </div>
      </div>
      <p className="muted note">{tts.note}</p>

      <h3>
        Downloaded <span className="muted">({formatBytes(totalStored)})</span>
      </h3>
      {props.stored.length === 0 ? (
        <p className="muted">Nothing downloaded yet.</p>
      ) : (
        <ul className="stored">
          {props.stored.map((item) => (
            <li key={item.key}>
              <div>
                <strong>{item.label}</strong>
                <span className="muted">
                  {' '}
                  · {KIND_LABEL[item.kind]} · {item.urls.length} file
                  {item.urls.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="stored-actions">
                <span className="bytes">{formatBytes(item.bytes)}</span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => props.onDelete(item)}
                  disabled={props.busy}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {props.usage && (
        <p className="muted">
          Browser storage: {formatBytes(props.usage.usage)} used of{' '}
          {formatBytes(props.usage.quota)} available.
        </p>
      )}
    </section>
  );
}
