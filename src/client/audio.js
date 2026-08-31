'use strict';

// Trickstep Tower — audio: WebAudio synth, buses, event mapping.
// Original short transients tied to logical events; seeded pitch variants.

import { makeRng } from '../rules.js';

const BUS_NAMES = ['music', 'effects', 'ambience', 'voice'];

// Authored one-shot samples (sfx/<name>.opus, see sfx/manifest.json) mapped to
// the logical events they back. Missing/failed files fall back to synthesis.
const SFX_SAMPLES = {
  jump: 'jump-launch',
  land: 'land-thud',
  step: 'step-tick',
  gear: 'gear-collect',
  death: 'death-crunch',
  checkpoint: 'checkpoint-chime',
  spring: 'spring-boing',
  win: 'win-fanfare',
  fail: 'fail-drop',
  invalid: 'invalid-buzz',
  reveal: 'reveal-shimmer',
  ui: 'ui-click',
  countdown: 'countdown-beep',
  go: 'go-horn',
  achievement: 'achievement-chime',
};

const CAPTIONS = {
  jump: 'jump',
  land: 'land',
  gear: 'gear collected',
  death: 'trap! retry',
  checkpoint: 'checkpoint',
  spring: 'spring',
  win: 'level complete',
  fail: 'attempt over',
  invalid: 'not possible now',
  reveal: 'trap revealed',
  countdown: 'ready',
  go: 'go',
  achievement: 'achievement unlocked',
};

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.rng = makeRng(0xa0d10);
    this.started = false;
    this._musicTimer = null;
    this._ambNodes = [];
    this._sampleCache = new Map(); // sample name → AudioBuffer | Promise | null (failed)
    this.captionSink = null; // (text) => void, set by UI for captions
  }

  // Must be called from a user gesture.
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.gain.value = 1;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const b of BUS_NAMES) {
      const g = this.ctx.createGain();
      g.gain.value = this.settings.volumes[b] ?? 0.7;
      g.connect(master);
      this.buses[b] = g;
    }
    this.started = true;
    this._startAmbience();
    this._startMusic();
  }

  setVolume(bus, v) {
    this.settings.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.value = v;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _caption(text) { if (this.captionSink) this.captionSink(text); }

  _tone(bus, freq, dur, type, gain, when, slide) {
    if (!this.ctx) return;
    const t0 = when ?? this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.buses[bus]);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  _noise(bus, dur, gain, filterFreq) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (this.rng() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = filterFreq || 1200;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t0);
  }

  // Lazy-fetch and decode an authored sample; cached per name. Resolves to
  // the AudioBuffer, or null when the file is missing/undecodable.
  _loadSample(name) {
    let entry = this._sampleCache.get(name);
    if (entry !== undefined) return entry;
    entry = fetch(`sfx/${name}.opus`)
      .then((res) => { if (!res.ok) throw new Error(`sfx ${name}: ${res.status}`); return res.arrayBuffer(); })
      .then((data) => this.ctx.decodeAudioData(data))
      .then((buf) => { this._sampleCache.set(name, buf); return buf; })
      .catch(() => { this._sampleCache.set(name, null); return null; });
    this._sampleCache.set(name, entry);
    return entry;
  }

  // Try the authored sample for an event. Returns true when a decoded sample
  // actually played; false (after kicking off the lazy load) when synthesis
  // should run instead — while loading, after failure, or when unmapped.
  _trySample(eventName) {
    const sample = SFX_SAMPLES[eventName];
    if (!sample || !this.ctx) return false;
    const cached = this._sampleCache.get(sample);
    if (cached === undefined) { this._loadSample(sample); return false; }
    if (!cached || typeof cached.then === 'function') return false;
    const src = this.ctx.createBufferSource();
    src.buffer = cached;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  // Logical event → transient. Prefers the authored sample; synthesized
  // fallback runs only while the sample loads or after it failed.
  event(name) {
    if (!this.started || !this.ctx || this.ctx.state !== 'running') { this._caption(name); return; }
    if (!this._trySample(name)) this._synthEvent(name);
    if (CAPTIONS[name]) this._caption(CAPTIONS[name]);
  }

  // Synthesized transient per event. Seeded pitch variant per call for replay consistency.
  _synthEvent(name) {
    const v = 0.9 + this.rng() * 0.2;
    switch (name) {
      case 'jump': this._tone('effects', 320 * v, 0.12, 'square', 0.12, undefined, 520 * v); break;
      case 'land': this._noise('effects', 0.06, 0.10, 500); break;
      case 'step': this._noise('effects', 0.03, 0.05, 900); break;
      case 'gear': this._tone('effects', 660 * v, 0.09, 'triangle', 0.14); this._tone('effects', 990 * v, 0.14, 'triangle', 0.12, this.ctx.currentTime + 0.07); break;
      case 'death': this._tone('effects', 220, 0.3, 'sawtooth', 0.16, undefined, 60); this._noise('effects', 0.2, 0.12, 300); break;
      case 'checkpoint': this._tone('effects', 520, 0.12, 'sine', 0.14); this._tone('effects', 780, 0.18, 'sine', 0.12, this.ctx.currentTime + 0.1); break;
      case 'spring': this._tone('effects', 240, 0.18, 'square', 0.12, undefined, 900); break;
      case 'win': {
        const seq = [523, 659, 784, 1047];
        seq.forEach((f, i) => this._tone('effects', f, 0.22, 'triangle', 0.15, this.ctx.currentTime + i * 0.11));
        break;
      }
      case 'fail': this._tone('effects', 330, 0.3, 'sine', 0.14, undefined, 165); break;
      case 'invalid': this._tone('effects', 140, 0.07, 'square', 0.08); break;
      case 'reveal': this._tone('effects', 880, 0.15, 'sine', 0.08, undefined, 440); break;
      case 'ui': this._tone('effects', 700, 0.04, 'sine', 0.06); break;
      case 'countdown': this._tone('effects', 440, 0.09, 'sine', 0.12); break;
      case 'go': this._tone('effects', 880, 0.15, 'sine', 0.14); break;
      case 'achievement': [660, 880, 1320].forEach((f, i) => this._tone('effects', f, 0.18, 'sine', 0.12, this.ctx.currentTime + i * 0.09)); break;
      default: break;
    }
  }

  // Quiet clockwork ambience: soft ticking + low hum.
  _startAmbience() {
    if (!this.ctx) return;
    const tick = () => {
      if (!this.ctx) return;
      this._noise('ambience', 0.02, 0.05, 2400);
      this._ambTimer = setTimeout(tick, 500);
    };
    tick();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 55; g.gain.value = 0.03;
    o.connect(g); g.connect(this.buses.ambience);
    o.start();
    this._ambNodes.push(o, g);
  }

  // Adaptive music: slow clockwork arpeggio; intensity rises during play.
  _startMusic() {
    if (!this.ctx) return;
    const scale = [0, 3, 5, 7, 10, 12, 15];
    const base = 196; // G3
    let stepIdx = 0;
    const tickMusic = () => {
      if (!this.ctx) return;
      if (this.settings.volumes.music > 0.01) {
        const deg = scale[(stepIdx * 3 + (stepIdx >> 3)) % scale.length];
        const f = base * Math.pow(2, deg / 12);
        this._tone('music', f, 0.3, 'triangle', 0.05);
        if (stepIdx % 4 === 0) this._tone('music', f / 2, 0.6, 'sine', 0.05);
      }
      stepIdx++;
      this._musicTimer = setTimeout(tickMusic, 375);
    };
    tickMusic();
  }
}

export { BUS_NAMES };
