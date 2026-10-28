// The native play scripts win their levels by holding Right and jumping on a
// fixed rhythm (tests/native/*.play: `key Space 1` + `frames 3p-2` = one jump
// every p rules ticks). This checks with the real rules that each scripted
// level is won at EVERY phase of that rhythm, so the scripts do not depend on
// the exact frame the climb starts on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, step } from '../src/rules.js';
import { TUTORIALS, journeyStage } from '../src/content.js';

function winsAtEveryPhase(level, p) {
  for (let ph = 0; ph < p; ph++) {
    const s = createState(level);
    for (let k = 0; k < 3000 && !s.over; k++) step(s, { move: 1, jump: (k + ph) % p === 0 ? 1 : 0 });
    if (!s.won) return false;
  }
  return true;
}
const PLANS = [
  ['learn-keys.play', [...TUTORIALS.map((l, i) => [l, i === 4 ? 9 : 6])]],
  ['journey-phone.play', [[journeyStage(0), 6], [journeyStage(1), 6]]],
];
for (const [file, plan] of PLANS) {
  test(`${file}: every scripted level is won at any phase`, () => {
    const text = readFileSync(new URL(`./native/${file}`, import.meta.url), 'utf8');
    const periods = [...text.matchAll(/key Space 1\nframes (\d+)/g)].map((m) => (Number(m[1]) + 2) / 3);
    assert.deepEqual(periods, plan.map(([, p]) => p));
    for (const [lv, p] of plan) assert.ok(winsAtEveryPhase(lv, p), `${lv.id} at period ${p}`);
  });
}
