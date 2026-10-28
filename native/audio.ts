// Sound, as the browser build's src/client/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, the quiet clockwork
// ambience (a soft tick every 500 ms over a 55 Hz hum, on the old ambience
// bus) and the slow clockwork arpeggio (every 375 ms a triangle note of the
// G minor-pentatonic run, a sine an octave down every fourth step, on the
// music bus). The runtime has no ambience bus, so the ambience plays on the
// music bus at the old ambience-to-music ratio; the old default bus gains
// (music 0.45, effects 0.8, ambience 0.35) set the relative levels. The
// ambience loop and the notes are rendered once into clips (a sine table, a
// slice a frame); the notes start on the fixed-step clock (main.ts calls
// tick). The synthesized stand-ins audio.js played while a sample loaded are
// not ported (a live synthesis graph makes clip loads fail on the web
// runtime). A pause silences everything, as the old context suspend did.
// The runtime's Options own the volumes and the mute.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

export type Sfx = "jump" | "land" | "step" | "gear" | "death" | "checkpoint" | "spring" | "win" | "fail" | "invalid" | "reveal" | "ui" | "countdown" | "go" | "achievement";
/** audio.js SFX_SAMPLES. */
const SAMPLES: Record<Sfx, string> = {
  jump: "jump-launch", land: "land-thud", step: "step-tick", gear: "gear-collect", death: "death-crunch", checkpoint: "checkpoint-chime",
  spring: "spring-boing", win: "win-fanfare", fail: "fail-drop", invalid: "invalid-buzz", reveal: "reveal-shimmer", ui: "ui-click",
  countdown: "countdown-beep", go: "go-horn", achievement: "achievement-chime",
};
const FX = 0.8, MUSIC = 0.45, AMB = 0.35;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let paused = false;

export function loadSfx(): void { wantClips = true; }
export function play(ev: Sfx): void {
  if (paused) return;
  const clip = clips.get(SAMPLES[ev]);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* busy */ }
}

// ---- rendered synthesis -------------------------------------------------------------------------
const RATE = 22050;
const TABLE_N = 4096;
const SINE = new Float32Array(TABLE_N + 1);
for (let i = 0; i <= TABLE_N; i++) SINE[i] = Math.sin((i / TABLE_N) * Math.PI * 2);
const sineAt = (phase: number): number => { const p = (phase - Math.floor(phase)) * TABLE_N; const i = p | 0; return SINE[i]! + (SINE[i + 1]! - SINE[i]!) * (p - i); };
const triAt = (phase: number): number => { const p = phase - Math.floor(phase); return p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4; };
interface Job { data: Float32Array; pos: number; fill: (i: number) => number; done: (c: AudioClip) => void }
const jobs: Job[] = [];
function job(n: number, fill: (i: number) => number, done: (c: AudioClip) => void): void { jobs.push({ data: new Float32Array(n), pos: 0, fill, done }); }
/** audio.js _tone: exponential attack to `gain` in 8 ms, exponential decay to silence at `dur`. */
function toneFill(freq: number, dur: number, type: "sine" | "triangle", gain: number): (i: number) => number {
  const lo = 0.0001, na = Math.round(0.008 * RATE), nd = Math.round(dur * RATE);
  const up = Math.pow(gain / lo, 1 / na), down = Math.pow(lo / gain, 1 / Math.max(1, nd - na));
  let env = lo;
  return (i) => {
    env = i < na ? env * up : i < nd ? env * down : 0;
    const ph = (freq * i) / RATE;
    return (type === "sine" ? sineAt(ph) : triAt(ph)) * env;
  };
}
const DEGREES = [0, 3, 5, 7, 10, 12, 15];
const BASE = 196; // G3
const notes = new Map<string, AudioClip>();
let ambClip: AudioClip | null = null;
let queued = false;
function queueSynthesis(): void {
  if (queued) return;
  queued = true;
  // ambience: 4 s = eight 20 ms band-passed noise ticks (gain 0.05, 2400 Hz) every 500 ms over a 55 Hz sine (gain 0.03)
  let seed = 0xa0d10;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const w0 = (2 * Math.PI * 2400) / RATE, al = Math.sin(w0) / 2, cw = Math.cos(w0);
  const b0 = al / (1 + al), a1 = (-2 * cw) / (1 + al), a2 = (1 - al) / (1 + al); // RBJ band-pass (0 dB peak), Q 1
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const tickN = Math.round(0.02 * RATE), period = Math.round(0.5 * RATE);
  job(RATE * 4, (i) => {
    const k = i % period;
    const x = k < tickN ? rand() * (1 - k / tickN) : 0;
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y * 0.05 + sineAt((55 * i) / RATE) * 0.03;
  }, (c) => { ambClip = c; });
  for (const d of DEGREES) {
    const f = BASE * Math.pow(2, d / 12);
    job(Math.round(RATE * 0.32), toneFill(f, 0.3, "triangle", 0.05), (c) => notes.set(`t${d}`, c));
    job(Math.round(RATE * 0.62), toneFill(f / 2, 0.6, "sine", 0.05), (c) => notes.set(`s${d}`, c));
  }
}
function runJobs(budget: number): void {
  let left = budget;
  while (jobs.length && left > 0) {
    const j = jobs[0]!;
    const end = Math.min(j.data.length, j.pos + left);
    for (let i = j.pos; i < end; i++) j.data[i] = j.fill(i);
    left -= end - j.pos;
    j.pos = end;
    if (j.pos >= j.data.length) {
      jobs.shift();
      try { j.done(createClip([j.data], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    }
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
/** Each frame: the clips once the mixer runs (one at a time), the synthesis slices, the ambience voice. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
    queueSynthesis();
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
  }
  runJobs(6000);
  if (!paused && ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: AMB / FX, loop: true }); } catch { ambVoice = null; }
  }
}
