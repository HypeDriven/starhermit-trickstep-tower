'use strict';

// Graphics quality model: GPU detection, preset/override resolution, scale clamp,
// and the panel's locale picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, describe, choosePreset, setOverride, PRESETS, CATEGORIES, DEFAULT_GFX } from '../src/client/gfx.js';
import { pickLocale, gfxStrings, GFX_LOCALES } from '../src/client/gfx-i18n.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('mobile devices cap Auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({ preset: 'auto' }, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'Low renders without a post chain');
  assert.equal(a.shadows, 'off');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.ao, 'on');
  assert.equal(h.post, true);
  assert.equal(resolve({}, undefined).preset, 'balanced');
});

test('resolve: overrides apply per category and invalid tiers fall back', () => {
  const r = resolve({ preset: 'low', overrides: { bloom: 'on', shadows: 'bogus' } }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true);
});

test('resolve: render scale clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'high' }).adaptive, true);
  assert.equal(resolve({ preset: 'high' }).showFps, false);
});

test('choosing a preset clears overrides; setOverride sets and clears', () => {
  let s = setOverride(DEFAULT_GFX, 'bloom', 'off');
  assert.deepEqual(s.overrides, { bloom: 'off' });
  s = setOverride(s, 'ao', 'high');
  assert.equal(Object.keys(s.overrides).length, 2);
  s = setOverride(s, 'ao', '');
  assert.deepEqual(s.overrides, { bloom: 'off' });
  s = choosePreset(Object.assign({}, s, { render_scale: 1.5 }), 'ultra');
  assert.equal(s.preset, 'ultra');
  assert.deepEqual(s.overrides, {});
  assert.equal(s.render_scale, 1.5);
});

test('every preset defines every category with a legal tier', () => {
  for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    assert.ok(tiers.includes(presetTier(p, cat)), p + '.' + cat);
  }
  assert.match(describe(resolve({ preset: 'high' }), [800, 600]), /2048² shadows.*800×600 px/);
});

test('graphics panel strings exist for every locale', () => {
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(GFX_LOCALES.includes(l), l);
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr'), 'fr-FR');
  assert.equal(pickLocale('xx'), 'en-US');
  const keys = ['tabGraphics', 'quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postUnavailable',
    ...PRESETS.map(p => 'preset_' + p), ...Object.keys(CATEGORIES).map(c => 'cat_' + c),
    ...new Set(Object.values(CATEGORIES).flat().map(t => 'tier_' + t))];
  for (const l of GFX_LOCALES) {
    const t = gfxStrings(l);
    for (const k of keys) assert.notEqual(t(k), k, l + ' missing ' + k);
  }
  assert.equal(gfxStrings('de-DE')('auto', { tier: 'Niedrig' }), 'Automatisch (erkannt: Niedrig)');
});
