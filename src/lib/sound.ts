/*
 * A short, audible notification chime synthesised with the Web Audio API. We
 * used to ship a base64 WAV, but it was an empty (0-sample) file — completely
 * silent. Synthesising a tone needs no asset and can't be "empty".
 *
 * Browsers only allow audio after a user gesture; since both the widget and the
 * admin are opened/clicked by a user before any chime fires, the shared
 * AudioContext is unlocked by then. Calls are best-effort and never throw.
 */
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * One tone, shaped by its arguments. Both sounds below are this with different
 * numbers, which is what keeps them recognisably from the same product.
 */
function tone(from: number, to: number, peak: number, length: number): void {
  const ac = getCtx();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') void ac.resume();
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.setValueAtTime(to, now + length * 0.26);
    // Exponential ramps, because loudness is perceived logarithmically — a linear
    // fade sounds like it stops abruptly rather than decaying.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    osc.start(now);
    osc.stop(now + length + 0.02);
  } catch {
    /* ignore */
  }
}

/** Something arrived. A rising two-note ding (A5 → D6). */
export function playChime(): void {
  tone(880, 1174.66, 0.18, 0.35);
}

/**
 * Your own message went out. Deliberately not the same sound.
 *
 * Quieter, shorter and FALLING rather than rising, so the two are distinguishable
 * without looking — an inbox where sending and receiving sound alike teaches you to
 * ignore both. It confirms the send landed on the server, which on email and SMS is
 * a slower and less certain thing than it looks.
 */
export function playSent(): void {
  tone(660, 523.25, 0.07, 0.13);
}
