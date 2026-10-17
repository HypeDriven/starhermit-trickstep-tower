'use strict';

// Localization coverage: every string key the game uses exists in all nine
// shipped locales, placeholders match English, and content names (stages,
// lessons, challenges) resolve to translated text.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/client/strings.js';
import { TUTORIALS, JOURNEY_COUNT, journeyStage, CHALLENGES, challengeLevel, dailyLevel } from '../src/content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const EN = STRINGS['en-US'];

test('all nine locales ship every key with the same placeholders', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
  for (const loc of LOCALES) {
    for (const k of Object.keys(EN)) {
      const v = STRINGS[loc][k];
      assert.ok(typeof v === 'string' && v.length, loc + ' missing ' + k);
      assert.equal(ph(v), ph(EN[k]), loc + ' placeholders differ for ' + k);
    }
  }
});

test('every t(key) used by the client exists in en-US', () => {
  const src = ['game.js', 'src/client/render.js', 'src/client/i18n.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const used = new Set();
  for (const m of src.matchAll(/\bt\('([A-Za-z0-9]+)'(?!\s*\+)/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-aria)?="([A-Za-z0-9]+)"/g)) used.add(m[1]);
  // Keys built at runtime.
  for (const b of ['Music', 'Effects', 'Ambience', 'Voice']) used.add('bus' + b);
  for (const k of ['Goal', 'Move', 'Jump', 'Trick', 'Vanish', 'Hazards', 'Gears', 'Score', 'Pause']) { used.add('rule' + k); used.add('rule' + k + 'Text'); }
  for (const k of ['modeLearn', 'modeJourney', 'modeDaily', 'modePractice', 'modeChallenge', 'modeScores']) for (const s of ['', 'Desc', 'Meta']) used.add(k + s);
  for (const k of ['achFirstClear', 'achGearMaster', 'achStreak3', 'achTowerTop', 'achCenturion']) { used.add(k); used.add(k + 'Desc'); }
  for (const k of ['Jump', 'Land', 'Gear', 'Death', 'Checkpoint', 'Spring', 'Win', 'Fail', 'Invalid', 'Reveal', 'Countdown', 'Go', 'Achievement']) used.add('cap' + k);
  for (const k of ['NoShadows', 'Shadows', 'FullAo', 'Ao', 'Bloom', 'Grade', 'NoAa', 'DenseParticles', 'UnknownGpu']) used.add('gfx' + k);
  for (const k of ['syncSynced', 'syncSaving', 'syncOffline', 'syncError', 'reasonExit', 'reasonMoveLimit', 'reasonTimeLimit',
    'boardDaily', 'boardJourney', 'boardChallenge', 'palDefault', 'palDeuteranopia', 'palProtanopia', 'palTritanopia', 'palMono',
    'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'haptics', 'savedLocalCasual', 'unrankedNoSubmit']) used.add(k);
  const missing = [...used].filter(k => EN[k] === undefined);
  assert.deepEqual(missing, []);
});

test('content names follow the language for every level', async () => {
  let apply = null;
  globalThis.window = { StarHermitLanguage: { create: (o) => { apply = o.apply; return {}; } } };
  const i18n = await import('../src/client/i18n.js');
  delete globalThis.window;
  const levels = [...TUTORIALS, ...Array.from({ length: JOURNEY_COUNT }, (_, i) => journeyStage(i)),
    ...CHALLENGES.map(c => challengeLevel(c.id)), dailyLevel(new Date(Date.UTC(2026, 9, 17)))];
  apply('en-US');
  const english = levels.map(lv => i18n.levelName(lv));
  assert.deepEqual(english.slice(0, TUTORIALS.length), TUTORIALS.map(lv => lv.name), 'English names match the authored ones');
  assert.equal(english[TUTORIALS.length], journeyStage(0).name);
  for (const loc of LOCALES.filter(l => !l.startsWith('en'))) {
    apply(loc);
    levels.forEach((lv, i) => {
      const name = i18n.levelName(lv);
      assert.ok(name && name !== english[i], loc + ' leaves ' + lv.id + ' in English: ' + name);
    });
    for (const lv of TUTORIALS) assert.notEqual(i18n.lessonText(lv).text, lv.lesson, loc + ' lesson text ' + lv.id);
    for (const c of CHALLENGES) assert.notEqual(i18n.challengeText(c).desc, c.desc, loc + ' challenge ' + c.id);
  }
  apply('en-US');
});
