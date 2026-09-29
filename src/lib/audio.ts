let ctxA: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctxA) ctxA = new AC();
  if (ctxA.state === "suspended") void ctxA.resume();
  return ctxA;
}

export function ping(freq = 660, dur = 0.16, gain = 0.05, type: OscillatorType = "sine") {
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  const f = a.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.45), a.currentTime + dur);
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(gain, a.currentTime + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(f);
  f.connect(g);
  g.connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur + 0.02);
}

export function chirp() {
  ping(1180, 0.5, 0.045, "triangle");
  setTimeout(() => ping(880, 0.42, 0.035, "sine"), 90);
  setTimeout(() => ping(1560, 0.3, 0.025, "sine"), 210);
}

export function blip() {
  ping(1420, 0.05, 0.022, "square");
}
