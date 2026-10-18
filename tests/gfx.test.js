'use strict';

// Graphics quality model: hardware-level detection, per-preset budgets, preset/override resolution, scale clamp,
// and the panel's locale picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// src/client/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/client/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { detectPreset, detectLevel, presetForLevel, budgetFor, particleBudget, resolve, presetTier, describe, choosePreset, setOverride, PRESETS, CATEGORIES, DEFAULT_GFX, LEVELS, BUDGETS, SPARK_MAX, DUST_MAX } = await import('../src/client/gfx.js');
import { pickLocale, gfxStrings, GFX_LOCALES } from '../src/client/gfx-i18n.js';

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budget table: explicit, never cheaper from Low to Ultra, counts scale with the level', () => {
  const keys = ['material', 'texture', 'segments', 'gears', 'sparks', 'dust', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.notEqual(BUDGETS[p][k], undefined, p + '.' + k);
  for (let i = 1; i < PRESETS.length; i++) {
    for (const k of keys.slice(1)) assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], PRESETS[i] + '.' + k);
  }
  assert.deepEqual(PRESETS.map(p => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map(p => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1]);
  assert.equal(budgetFor('high', 10).sparks, BUDGETS.high.sparks);
  assert.equal(budgetFor('high', 0).sparks, BUDGETS.high.sparks, 'a forced preset never drops below its own budget');
  assert.ok(budgetFor('high', 13).dust > BUDGETS.high.dust);
  assert.equal(budgetFor('low', 9).dust, BUDGETS.low.dust * 2, 'at most 2× within a preset');
  assert.ok(budgetFor('ultra', 20).sparks <= SPARK_MAX && budgetFor('ultra', 20).dust <= DUST_MAX);
  const r = resolve({ preset: 'balanced' }, 'low', 4);
  assert.equal(r.level, 4);
  assert.deepEqual(r.budget, budgetFor('balanced', 4));
  assert.deepEqual(particleBudget(resolve({ preset: 'low' }, 'low', 0)), { max: 160, dust: 0 }, 'Particles low keeps the original pool');
  assert.deepEqual(particleBudget(r), { max: r.budget.sparks, dust: r.budget.dust });
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
  const keys = ['tabGraphics', 'quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postUnavailable', 'level',
    ...PRESETS.map(p => 'preset_' + p), ...Object.keys(CATEGORIES).map(c => 'cat_' + c),
    ...new Set(Object.values(CATEGORIES).flat().map(t => 'tier_' + t))];
  for (const l of GFX_LOCALES) {
    const t = gfxStrings(l);
    for (const k of keys) assert.notEqual(t(k), k, l + ' missing ' + k);
  }
  assert.equal(gfxStrings('de-DE')('auto', { tier: 'Niedrig' }), 'Automatisch (erkannt: Niedrig)');
});
