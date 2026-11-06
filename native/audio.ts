// Sound, as the browser build's src/client/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, the quiet clockwork
// ambience (a soft tick every 500 ms over a 55 Hz hum, on the old ambience
// bus) and the slow clockwork arpeggio (every 375 ms a triangle note of the
// G minor-pentatonic run, a sine an octave down every fourth step, on the
// music bus). The runtime has no ambience bus, so the ambience plays on the
// music bus at the old ambience-to-music ratio; the old default bus gains
// (music 0.45, effects 0.8, ambience 0.35) set the relative levels. The
// ambience loop and the notes are rendered once into clips
// (OfflineAudioContext); the notes start on the fixed-step clock (main.ts calls
// tick). The synthesized stand-ins audio.js played while a sample loaded are
// not ported. A pause silences everything, as the old context suspend did.
// The runtime's Options own the volumes and the mute. Clips load and the renders
// run in onStart; only starting the ambience waits for the mixer.
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

export type Sfx = "jump" | "land" | "step" | "gear" | "death" | "checkpoint" | "spring" | "win" | "fail" | "invalid" | "reveal" | "ui" | "countdown" | "go" | "achievement";
/** audio.js SFX_SAMPLES. */
const SAMPLES: Record<Sfx, string> = {
  jump: "jump-launch", land: "land-thud", step: "step-tick", gear: "gear-collect", death: "death-crunch", checkpoint: "checkpoint-chime",
  spring: "spring-boing", win: "win-fanfare", fail: "fail-drop", invalid: "invalid-buzz", reveal: "reveal-shimmer", ui: "ui-click",
  countdown: "countdown-beep", go: "go-horn", achievement: "achievement-chime",
};
const FX = 0.8, MUSIC = 0.45, AMB = 0.35;
const clips = new Map<string, AudioClip>();
let paused = false;

export function play(ev: Sfx): void {
  if (paused) return;
  const clip = clips.get(SAMPLES[ev]);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* busy */ }
}

// ---- rendered synthesis -------------------------------------------------------------------------
const RATE = 22050;
/** audio.js _tone: exponential attack to `gain` in 8 ms, exponential decay to silence at `dur`. */
async function renderTone(freq: number, dur: number, type: "sine" | "triangle", g: number, seconds: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  const osc = off.createOscillator(); osc.type = type; osc.frequency.value = freq;
  const env = off.createGain();
  env.gain.setValueAtTime(0.0001, 0);
  env.gain.exponentialRampToValueAtTime(g, 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, dur);
  env.gain.setValueAtTime(0, dur);
  osc.connect(env).connect(off.destination); osc.start();
  return createClip(await off.startRendering());
}
/** 4 s: eight 20 ms band-passed noise ticks (gain 0.05, 2400 Hz, Q 1) every 500 ms over a 55 Hz sine (gain 0.03). */
async function renderAmbience(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * 4, RATE);
  const noise = off.createNoise({ seed: 0xa0d10, seconds: 4 });
  const env = off.createGain();
  env.gain.setValueAtTime(0, 0);
  for (let i = 0; i < 8; i++) {
    env.gain.setValueAtTime(1, i * 0.5);
    env.gain.linearRampToValueAtTime(0, i * 0.5 + 0.02);
  }
  const bp = off.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 1;
  const tick = off.createGain(); tick.gain.value = 0.05;
  noise.connect(env).connect(bp).connect(tick).connect(off.destination); noise.start();
  const hum = off.createOscillator(); hum.frequency.value = 55;
  const humGain = off.createGain(); humGain.gain.value = 0.03;
  hum.connect(humGain).connect(off.destination); hum.start();
  return createClip(await off.startRendering());
}
const DEGREES = [0, 3, 5, 7, 10, 12, 15];
const BASE = 196; // G3
const notes = new Map<string, AudioClip>();
let ambClip: AudioClip | null = null;
const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };

/** Loads every clip at once and renders the ambience and the notes (onStart). */
export function loadSfx(): void {
  for (const n of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${n}.opus`).then((c) => { clips.set(n, c); }, (e: unknown) => { console.warn(`sfx ${n}: ${e instanceof Error ? e.message : String(e)}`); });
  }
  renderAmbience().then((c) => { ambClip = c; }, warn);
  for (const d of DEGREES) {
    const f = BASE * Math.pow(2, d / 12);
    renderTone(f, 0.3, "triangle", 0.05, 0.32).then((c) => { notes.set(`t${d}`, c); }, warn);
    renderTone(f / 2, 0.6, "sine", 0.05, 0.62).then((c) => { notes.set(`s${d}`, c); }, warn);
  }
}

// ---- music and ambience -------------------------------------------------------------------------
let ambVoice: Sound | null = null;
let step = 0;
let nextAt = 0;
/** audio.js suspend / resume (the pause screen). */
export function setPaused(p: boolean): void {
  paused = p;
  if (p) { try { ambVoice?.stop(); } catch { /* gone */ } ambVoice = null; }
}
/** The arpeggio's 375 ms steps on the fixed-step clock (seconds). */
export function tick(now: number): void {
  if (paused || context.state !== "running" || now < nextAt) return;
  if (nextAt === 0) { nextAt = now; }
  nextAt += 0.375;
  if (nextAt < now) nextAt = now + 0.375;
  const deg = DEGREES[(step * 3 + (step >> 3)) % DEGREES.length]!;
  const g = MUSIC / FX;
  const t = notes.get(`t${deg}`);
  if (t) try { playClip(t, { bus: "music", gain: g }); } catch { /* busy */ }
  if (step % 4 === 0) { const s = notes.get(`s${deg}`); if (s) try { playClip(s, { bus: "music", gain: g }); } catch { /* busy */ } }
  step++;
}
/** Each frame, once the mixer runs: the ambience voice. */
export function update(): void {
  if (context.state !== "running") return;
  if (!paused && ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: AMB / FX, loop: true }); } catch { ambVoice = null; }
  }
}
