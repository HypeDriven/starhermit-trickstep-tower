'use strict';

// Trickstep Tower — graphics quality model: presets, per-category overrides,
// StarHermit hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js), so the settings panel,
// the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  particles: ['low', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a render-scale multiplier and a device-pixel-
// ratio cap (Low renders at 1× so it stays as cheap as the original low tier).
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', particles: 'low', background: 'animated', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_BUDGET = { low: 160, high: 1200 };
export const DUST_MOTES = { low: 0, high: 220 };

export const DEFAULT_GFX = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false, overrides: {} };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 =
// RTX 5090; src/client/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low
// from 0, Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = Object.assign({ webgl: true, webgl2: true }, system || {}, { gpu: String(gpu || '') });
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter(p => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Tiles, hazards,
 * collision and rules are identical on every preset — only visuals change.
 *   material  shading: lambert (Low) / standard (Balanced) / physical clear-coat brass (High, Ultra)
 *   texture   stone / brass plate texture size in px (Detail on; the tower-wall brick is 2×)
 *   segments  multiplies spike, gear, spring, column and clock segments
 *   gears     background gears behind the tower (plus 2)
 *   sparks    live burst particles at Particles "high" (low: 160), scaled with the level
 *   dust      dust motes in the key light (Particles high), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 64, segments: 0.75, gears: 2, sparks: 400, dust: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 128, segments: 1, gears: 4, sparks: 600, dust: 120, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 128, segments: 1, gears: 6, sparks: 1200, dust: 220, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 256, segments: 1.5, gears: 8, sparks: 1600, dust: 320, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 3200;
export const DUST_MAX = 640;

/** A preset's concrete budget for a hardware level (sparks and dust scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return b;
}

/** Live particle pool and dust motes for a resolved setting (Particles low keeps the original 160 / 0). */
export function particleBudget(r) {
  return r.particles === 'high' ? { max: r.budget.sparks, dust: r.budget.dust } : { max: PARTICLE_BUDGET.low, dust: DUST_MOTES.low };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, overrides: { <category>: tier } }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const ov = s.overrides || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dprCap,
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(ov[cat]) ? ov[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every per-category override. */
export function choosePreset(saved, preset) {
  return Object.assign({}, DEFAULT_GFX, saved, { preset: PRESETS.includes(preset) ? preset : 'auto', overrides: {} });
}

/** Set (or clear with 'preset') one category override. */
export function setOverride(saved, cat, tier) {
  const next = Object.assign({}, DEFAULT_GFX, saved);
  next.overrides = Object.assign({}, next.overrides);
  if (CATEGORIES[cat] && CATEGORIES[cat].includes(tier)) next.overrides[cat] = tier;
  else delete next.overrides[cat];
  return next;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

/** Short English cost summary (the panel localizes the surrounding labels). */
// Default (English) words for the summary line; the settings panel passes the
// game-language translations of the same keys.
export const DESCRIBE_WORDS = {
  noShadows: 'no shadows', shadows: '{n}² shadows', fullAo: 'full AO', ao: 'AO', bloom: 'bloom',
  grade: 'grade', noAa: 'no AA', denseParticles: 'dense particles',
};

export function describe(r, pixels, words) {
  const w = Object.assign({}, DESCRIBE_WORDS, words || {});
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.fullAo : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.grade === 'on' ? w.grade : null,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    r.particles === 'high' ? w.denseParticles : null,
    pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
