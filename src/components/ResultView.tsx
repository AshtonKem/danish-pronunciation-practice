import { useState } from 'react';

import type { Evaluation, PhonemeOp, WordResult, WordStatus } from '../types';

const STATUS_LABEL: Record<WordStatus, string> = {
  correct: 'Correct',
  mispronounced: 'Mispronounced',
  wrong: 'Wrong word',
  missing: 'Not spoken',
  extra: 'Extra word',
};

/** Column-aligned phoneme comparison, one column per alignment step. */
function PhonemeTrack({ ops }: { ops: PhonemeOp[] }) {
  return (
    <div className="phonemes">
      <div className="phoneme-row-label">
        <span>Expected</span>
        <span>You said</span>
      </div>
      <div className="phoneme-track">
        {ops.map((op, index) => (
          <div key={index} className={`phoneme-col phoneme-${op.type}`}>
            <span className="phoneme">{op.target ?? '·'}</span>
            <span className="phoneme">{op.spoken ?? '·'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WordDetail({ word }: { word: WordResult }) {
  return (
    <div className="word-detail">
      <div className="word-detail-head">
        <strong>{word.target ?? word.spoken}</strong>
        <span className={`badge badge-${word.status}`}>{STATUS_LABEL[word.status]}</span>
      </div>

      {word.status === 'wrong' && word.spoken && (
        <p className="muted">
          Heard <em>{word.spoken}</em> instead of <em>{word.target}</em>.
        </p>
      )}
      {word.status === 'missing' && <p className="muted">This word was not in what you said.</p>}
      {word.status === 'extra' && <p className="muted">You added this word.</p>}

      {word.phonemes && word.phonemes.length > 0 ? (
        <PhonemeTrack ops={word.phonemes} />
      ) : word.targetPhonemes ? (
        <p className="ipa">
          Target pronunciation: <code>/{word.targetPhonemes.join('')}/</code>
        </p>
      ) : null}
    </div>
  );
}

export function ResultView({ evaluation }: { evaluation: Evaluation }) {
  const [selected, setSelected] = useState<number | null>(null);
  const percent = Math.round(evaluation.score * 100);
  const problems = evaluation.words.filter((word) => word.status !== 'correct');

  return (
    <section className="card">
      <header className="card-head">
        <h2>Result</h2>
        <span className="muted">{(evaluation.durationMs / 1000).toFixed(1)}s of audio</span>
      </header>

      <div className="score">
        <div className="score-bar">
          <div
            className="score-fill"
            style={{ width: `${percent}%` }}
            data-tier={percent >= 90 ? 'high' : percent >= 60 ? 'mid' : 'low'}
          />
        </div>
        <strong>{percent}%</strong>
      </div>

      <p className="sentence-result">
        {evaluation.words.map((word, index) => (
          <button
            key={index}
            type="button"
            className={`word word-${word.status} ${selected === index ? 'word-selected' : ''}`}
            onClick={() => setSelected(selected === index ? null : index)}
            title={STATUS_LABEL[word.status]}
          >
            {word.target ?? word.spoken}
          </button>
        ))}
      </p>

      <p className="transcript">
        <span className="muted">Transcribed as:</span> {evaluation.transcript || '(silence)'}
      </p>

      {selected !== null && <WordDetail word={evaluation.words[selected]} />}

      {selected === null &&
        (problems.length === 0 ? (
          <p className="all-good">Every word matched. Try a harder sentence.</p>
        ) : (
          <p className="muted">
            Tap a highlighted word for a phoneme-by-phoneme comparison.
            {' '}
            {problems.length} of {evaluation.words.length} need work.
          </p>
        ))}

      <ul className="legend">
        {(['correct', 'mispronounced', 'wrong', 'missing', 'extra'] as WordStatus[]).map((status) => (
          <li key={status}>
            <span className={`swatch word-${status}`} /> {STATUS_LABEL[status]}
          </li>
        ))}
      </ul>
    </section>
  );
}
