// The two sounds of a call, made with the Web Audio API: the ring of an
// incoming call (two soft notes, every three seconds) and the ring-back the
// caller hears (one low tone, a second in every five). A browser plays them
// only on a page the person has used; the screens never rely on them.

type Tone = [frequency: number, start: number, length: number];
const SOUNDS: Record<'ring' | 'ringback', { every: number; tones: Tone[] }> = {
  ring: { every: 3, tones: [[660, 0, 0.35], [880, 0.4, 0.5]] },
  ringback: { every: 5, tones: [[425, 0, 1]] },
};
const VOLUME = 0.08;

/** Plays the sound until the returned function is called. */
export function playCallSound(sound: 'ring' | 'ringback'): () => void {
  const Context = typeof window === 'undefined' ? undefined : window.AudioContext;
  if (!Context) return () => undefined;
  let context: AudioContext;
  // A browser that will open no further audio output: the call goes on without the sound.
  try { context = new Context(); } catch { return () => undefined; }
  const { every, tones } = SOUNDS[sound];
  const round = () => {
    for (const [frequency, start, length] of tones) {
      const from = context.currentTime + start;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      // Faded in and out: no click at either end.
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(VOLUME, from + 0.03);
      gain.gain.setValueAtTime(VOLUME, from + length - 0.08);
      gain.gain.linearRampToValueAtTime(0, from + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(from);
      oscillator.stop(from + length);
    }
  };
  round();
  const timer = setInterval(round, every * 1000);
  return () => {
    clearInterval(timer);
    void context.close().catch(() => undefined);
  };
}
