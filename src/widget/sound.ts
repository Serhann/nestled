/**
 * The incoming-reply chime.
 *
 * Synthesised rather than fetched: an audio file is another request from a third
 * party page, another thing to cache-bust, and about as many bytes as this whole
 * widget's JavaScript. The context is created lazily because constructing one
 * before a user gesture leaves it suspended in every browser's autoplay policy.
 */
let context: AudioContext | null = null;

export function chime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  } catch {
    // Audio is a nicety; never let it break a reply arriving.
  }
}
