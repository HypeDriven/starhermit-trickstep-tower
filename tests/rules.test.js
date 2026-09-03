'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICK_MS, SCHEMA_VERSION, makeRng, hashString, parseMap, createState, step,
  legalActions, isTerminal, terminalReason, scoreBreakdown, compareResults,
  serialize, deserialize, stateHash, replay, simulate, TILE,
} from '../src/rules.js';
import { TUTORIALS, journeyStage, validateLevel, validateAll, dailyLevel, challengeLevel } from '../src/content.js';

const FLAT = {
  id: 'test-flat', seed: 42,
  ascii: [
    '..........',
    '..........',
    '..........',
    '.S......E.',
    '##########',
  ].join('\n'),
  par: { ticks: 200, moves: 30 },
};

function hold(move, ticks, jumpAt) {
  const cmds = [];
  for (let t = 0; t < ticks; t++) {
    cmds.push({ tick: t, input: { move, jump: jumpAt === t ? 1 : 0 } });
  }
  return cmds;
}

test('rng is deterministic and bounded', () => {
  const a = makeRng(7), b = makeRng(7);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('map parsing finds spawn/exit/gears', () => {
  const m = parseMap('.S.*.\n#####\n...E.\n#####');
  assert.deepEqual(m.spawn, { x: 1, y: 0 });
  assert.deepEqual(m.exit, { x: 3, y: 2 });
  assert.equal(m.gears.length, 1);
  assert.throws(() => parseMap('??'), /bad tile/);
});

test('player falls and lands on ground', () => {
  const s = createState(FLAT);
  for (let i = 0; i < 20; i++) step(s, { move: 0, jump: 0 });
  assert.ok(s.player.onGround);
  assert.ok(s.player.y > 0);
});

test('walking right reaches exit and wins', () => {
  const s = simulate(FLAT, hold(1, 200));
  assert.ok(s.won);
  assert.equal(terminalReason(s), 'exit');
  assert.ok(isTerminal(s));
});

test('illegal jump in air is an invalid action', () => {
  const s = createState(FLAT);
  for (let i = 0; i < 20; i++) step(s, { move: 0, jump: 0 });
  assert.ok(s.player.onGround);
  step(s, { move: 0, jump: 1 }); // leaves ground
  step(s, { move: 0, jump: 1 }); // in air → invalid
  assert.ok(s.invalid >= 1);
});

test('legalActions reflects ground state', () => {
  const s = createState(FLAT);
  assert.equal(legalActions(s).jump, false);
  for (let i = 0; i < 20; i++) step(s, { move: 0, jump: 0 });
  assert.equal(legalActions(s).jump, true);
});

test('spikes kill and respawn with death counted', () => {
  const lvl = { ...FLAT, ascii: ['..........', '..........', '..........', '.S..^...E.', '##########'].join('\n') };
  const s = createState(lvl);
  while (s.deaths === 0 && s.tick < 200) step(s, { move: 1, jump: 0 });
  assert.equal(s.deaths, 1);
  assert.equal(s.player.x, s.spawn.x);
  assert.equal(s.player.y, s.spawn.y);
});

test('gear collection increments score component', () => {
  const lvl = { ...FLAT, ascii: ['..........', '..........', '..........', '.S..*...E.', '##########'].join('\n') };
  const s = simulate(lvl, hold(1, 200));
  assert.ok(s.won);
  const b = scoreBreakdown(s, lvl.par);
  assert.equal(b.gearCount, 1);
  assert.equal(b.gears, 150);
  assert.equal(b.completion, 1000);
  assert.equal(b.total, b.completion + b.gears + b.timeBonus + b.moveBonus - b.deathPenalty - b.invalidPenalty);
});

test('fake floor is never solid; touch reveals it', () => {
  const lvl = { ...FLAT, ascii: ['......', '......', '.S.E..', '##~###', '######'].join('\n'), seed: 9 };
  const s = simulate(lvl, hold(1, 20));
  assert.ok(s.fakesRevealed.length >= 1);
});

test('move limit ends the run with reason', () => {
  const lvl = { ...FLAT, moveLimit: 3 };
  const s = simulate(lvl, hold(1, 400));
  assert.ok(s.over);
  assert.equal(s.reason, 'move-limit');
  assert.ok(!s.won);
});

test('time limit ends the run with reason', () => {
  const lvl = { ...FLAT, timeLimit: 10 };
  const s = simulate(lvl, hold(0, 400));
  assert.ok(s.over);
  assert.equal(s.reason, 'time-limit');
});

test('serialization round-trips', () => {
  const s = createState(FLAT);
  for (let i = 0; i < 30; i++) step(s, { move: 1, jump: 0 });
  const s2 = deserialize(serialize(s));
  assert.equal(stateHash(s), stateHash(s2));
  assert.equal(s2.v, SCHEMA_VERSION);
});

test('replay determinism: same seed + commands → identical hashes', () => {
  const lvl = journeyStage(3);
  const cmds = [];
  for (let t = 0; t < 300; t++) cmds.push({ tick: t, input: { move: t % 7 < 4 ? 1 : -1, jump: t % 23 === 0 ? 1 : 0 } });
  const a = simulate(lvl, cmds);
  const b = simulate(lvl, cmds);
  assert.equal(stateHash(a), stateHash(b));
  const r = replay(lvl, { schema: SCHEMA_VERSION, commands: cmds, hashes: [{ tick: a.tick, hash: stateHash(a) }] });
  assert.equal(r.finalHash, stateHash(a));
});

test('replay rejects hash mismatch', () => {
  const r = replay(FLAT, { schema: SCHEMA_VERSION, commands: hold(1, 50), hashes: [{ tick: 10, hash: 'deadbeef' }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash-mismatch/);
});

test('fuzz: malformed commands never hang or produce NaN', () => {
  const rng = makeRng(1234);
  const lvl = journeyStage(12);
  for (let iter = 0; iter < 20; iter++) {
    const cmds = [];
    for (let t = 0; t < 200; t++) {
      const bad = rng() < 0.3;
      cmds.push({ tick: t, input: bad ? { move: 99, jump: 'x' } : { move: Math.floor(rng() * 3) - 1, jump: rng() < 0.1 ? 1 : 0 } });
    }
    const s = simulate(lvl, cmds, 5000);
    assert.ok(Number.isFinite(s.player.x) && Number.isFinite(s.player.y));
    assert.ok(s.tick <= 5000);
  }
});

test('tie ordering: completion, invalid, time, session', () => {
  const base = { won: true, invalid: 0, tick: 100, sessionId: 'b' };
  assert.ok(compareResults({ ...base }, { ...base, won: false }) < 0);
  assert.ok(compareResults({ ...base }, { ...base, invalid: 1 }) < 0);
  assert.ok(compareResults({ ...base }, { ...base, tick: 101 }) < 0);
  assert.ok(compareResults({ ...base }, { ...base, sessionId: 'a' }) > 0);
});

test('all shipped content passes validators', () => {
  const report = validateAll();
  const bad = report.filter(r => !r.ok);
  assert.deepEqual(bad, []);
});

// Greedy solver: walk right; jump when blocked (wall) or when a learned trap
// tile ('~' or '=') lies directly ahead at foot level. Uses only legality the
// rules expose; traps it has "learned" come from the map like a player would.
function solve(def, maxTicks) {
  const s = createState(def);
  const rows = def.ascii.split('\n');
  const trap = (tx, ty) => rows[ty] && (rows[ty][tx] === '~' || rows[ty][tx] === '=');
  let lastX = s.player.x, stuck = 0;
  const limit = maxTicks || 6000;
  while (!s.over && s.tick < limit) {
    let jump = 0;
    if (s.player.onGround) {
      const aheadX = Math.floor(s.player.x + 0.9);
      const feetY = Math.floor(s.player.y + 0.5);
      if (trap(aheadX, feetY) || trap(aheadX + 1, feetY)) jump = 1;
      if (s.player.x - lastX < 0.005) stuck++; else stuck = 0;
      if (stuck >= 3) jump = 1;
    }
    lastX = s.player.x;
    step(s, { move: 1, jump });
  }
  return s;
}

test('tutorials are winnable', () => {
  for (const t of TUTORIALS) {
    const s = solve(t);
    assert.ok(s.won, t.id + ' should be winnable, ended: ' + s.reason + ' at ' + s.player.x.toFixed(1) + ',' + s.player.y.toFixed(1));
  }
});

test('first journey stages are winnable by walk-right + jump-when-blocked', () => {
  for (let i = 0; i < 3; i++) {
    const s = solve(journeyStage(i));
    assert.ok(s.won, 'journey-' + i + ' ended: ' + s.reason + ' at ' + s.player.x.toFixed(1) + ',' + s.player.y.toFixed(1));
  }
});

test('daily level is stable per UTC day', () => {
  const a = dailyLevel(new Date(Date.UTC(2026, 4, 15, 23, 59)));
  const b = dailyLevel(new Date(Date.UTC(2026, 4, 15, 0, 1)));
  assert.equal(a.seed, b.seed);
  assert.equal(a.ascii, b.ascii);
  const c = dailyLevel(new Date(Date.UTC(2026, 4, 16)));
  assert.notEqual(a.seed, c.seed);
});

test('challenge levels carry limits', () => {
  const c = challengeLevel('chal-clock');
  assert.ok(c.timeLimit > 0);
  assert.equal(validateLevel(c).ok, true);
});
