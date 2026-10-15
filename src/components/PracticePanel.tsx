export const EXAMPLE_SENTENCES = [
  'Jeg vil gerne have en kop kaffe.',
  'Hvor lang tid tager det at komme til stationen?',
  'Rødgrød med fløde smager godt om sommeren.',
  'Jeg har boet i København i tre år.',
  'Kan du sige det en gang til, lidt langsommere?',
  'Det regner, så jeg tager cyklen i morgen.',
];

export interface PracticePanelProps {
  sentence: string;
  recording: boolean;
  level: number;
  canSpeak: boolean;
  canRecord: boolean;
  busy: boolean;
  recordingUrl: string | null;
  onSentence: (value: string) => void;
  onSpeak: () => void;
  onToggleRecord: () => void;
}

export function PracticePanel(props: PracticePanelProps) {
  const shuffle = () => {
    const options = EXAMPLE_SENTENCES.filter((s) => s !== props.sentence);
    props.onSentence(options[Math.floor(Math.random() * options.length)]);
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>Practise</h2>
        <button type="button" className="link" onClick={shuffle}>
          Example sentence
        </button>
      </header>

      <label className="field field-wide">
        <span>Danish sentence</span>
        <textarea
          value={props.sentence}
          onChange={(event) => props.onSentence(event.target.value)}
          rows={3}
          placeholder="Skriv en dansk sætning…"
          spellCheck={false}
        />
      </label>

      <div className="actions">
        <button
          type="button"
          onClick={props.onSpeak}
          disabled={!props.canSpeak || props.busy || props.sentence.trim() === ''}
        >
          Listen
        </button>

        <button
          type="button"
          className={props.recording ? 'recording' : 'primary'}
          onClick={props.onToggleRecord}
          disabled={!props.canRecord || (props.busy && !props.recording)}
        >
          {props.recording ? 'Stop and check' : 'Record'}
        </button>

        {props.recording && (
          <div className="meter" aria-label="Input level">
            <div className="meter-fill" style={{ width: `${Math.round(props.level * 100)}%` }} />
          </div>
        )}

        {!props.recording && props.recordingUrl && (
          <audio controls src={props.recordingUrl} className="playback" />
        )}
      </div>
    </section>
  );
}
