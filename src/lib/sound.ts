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

/** Play a soft two-tone "ding". Safe to call anytime; no-ops if audio is blocked. */
export function playChime(): void {
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
    // Rising two-note ding (A5 → D6).
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1174.66, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.37);
  } catch {
    /* ignore */
  }
}
