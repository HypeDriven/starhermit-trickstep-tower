'use strict';

// Trickstep Tower — graphics quality model: presets, per-category overrides,
// GPU detection and a cost summary. Pure (no three.js), so the settings panel,
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

/** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
export function detectPreset(gpu, opts) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  // Touch / mobile devices never auto-select above Balanced.
  if (opts && opts.mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, overrides: { <category>: tier } }.
 */
export function resolve(saved, detected) {
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
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
    r.ao === 'off' ? null : r.ao === 'high' ? 'full AO' : 'AO',
    r.bloom === 'on' ? 'bloom' : null,
    r.grade === 'on' ? 'grade' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    r.particles === 'high' ? 'dense particles' : null,
    pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
