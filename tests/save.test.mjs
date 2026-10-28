// The save model (src/save.js): normalize, the two-device merge, the browser
// build's cloud slot as a foreign save, its settings KV, the local boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/save.js';

test('normalize fills defaults and drops junk', () => {
  const d = S.normalize({ progress: { stars: { 0: 900 }, clears: 'x' }, snapshot: { levelId: 3 }, boards: { daily: [{ score: 'no' }, { name: 'A', score: 5 }] } });
  assert.equal(d.progress.stars[0], 900);
  assert.equal(d.progress.clears, 0);
  assert.equal(d.snapshot, null);
  assert.deepEqual(d.boards.daily.map((e) => e.score), [5]);
  assert.deepEqual(S.normalize(null), S.defaultSave());
});

test('two devices merge: best stars, earliest unlock, later streak, newer snapshot, union of boards', () => {
  const a = { progress: { stars: { 0: 900, 1: 100 }, achievements: { 'first-clear': '2026-10-02' }, streak: { count: 2, lastDay: '2026-10-02' }, clears: 4 },
    snapshot: { levelId: 'journey-1', state: '{}', savedAt: 10 }, boards: { daily: [{ name: 'A', score: 7, levelId: 'd', at: '1' }] } };
  const b = { progress: { stars: { 0: 950 }, achievements: { 'first-clear': '2026-10-01', 'tower-top': '2026-10-05' }, streak: { count: 1, lastDay: '2026-10-05' }, clears: 9 },
    snapshot: { levelId: 'journey-2', state: '{}', savedAt: 20 }, boards: { daily: [{ name: 'A', score: 7, levelId: 'd', at: '1' }, { name: 'B', score: 9, levelId: 'd', at: '2' }] } };
  const m = S.mergeSaves(a, b);
  assert.deepEqual(m.progress.stars, { 0: 950, 1: 100 });
  assert.equal(m.progress.achievements['first-clear'], '2026-10-01');
  assert.equal(m.progress.achievements['tower-top'], '2026-10-05');
  assert.deepEqual(m.progress.streak, { count: 1, lastDay: '2026-10-05' });
  assert.equal(m.progress.clears, 9);
  assert.equal(m.snapshot.levelId, 'journey-2');
  assert.deepEqual(m.boards.daily.map((e) => e.score), [9, 7]);
  assert.ok(S.sameSave(m, S.mergeSaves(m, a)), 'merging again changes nothing');
});

test('the browser build cloud slot reads as a foreign save', () => {
  const doc = S.readForeign(JSON.stringify({ progress: { stars: { 3: 1200 }, clears: 2 }, savedAt: 1 }));
  assert.equal(doc.progress.stars[3], 1200);
  assert.equal(S.readForeign('nope'), null);
  assert.equal(S.readForeign('{"x":1}'), null);
});

test('the old settings KV gives the game options', () => {
  const kv = { volumes: { music: 0.2 }, palette: 'mono', leftHanded: true, haptics: false, gfx: {} };
  assert.deepEqual(S.readLegacySettings(kv).options, { palette: 'mono', leftHanded: true, haptics: false });
  assert.deepEqual(S.pickOptions({ palette: 'pink' }), {});
  for (const k of Object.keys(kv)) assert.ok(S.BROWSER_KEYS.includes(k));
});

test('local casual board keeps the top 20 and reports the rank', () => {
  const save = S.defaultSave();
  for (let i = 0; i < 25; i++) S.addLocalScore(save, 'journey', { name: 'G', score: i * 10, levelId: 'journey-0', at: String(i), won: true });
  assert.equal(save.boards.journey.length, 20);
  assert.equal(S.addLocalScore(save, 'journey', { name: 'G', score: 235, levelId: 'x', at: 'z', won: true }), 2);
});
