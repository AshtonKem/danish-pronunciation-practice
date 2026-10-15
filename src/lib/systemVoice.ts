/**
 * Web Speech fallback. Needs no download, but is only as good as the Danish
 * voices the OS ships, and is unavailable inside a worker — hence main thread.
 */
export function danishVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices().filter((voice) => /^da([-_]|$)/i.test(voice.lang));
}

/** Resolves when the utterance finishes, or rejects if the engine refuses it. */
export function speakWithSystemVoice(text: string): Promise<void> {
  const [voice] = danishVoices();
  if (!voice) {
    throw new Error(
      'No Danish system voice found. Install one in your OS speech settings, or use the Piper voice.',
    );
  }

  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = () => resolve();
    utterance.onerror = (event) => reject(new Error(`Speech failed: ${event.error}`));
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}
