'use strict';

// Trickstep Tower — versioned content: tutorials, journey stages, daily seeds,
// themes, challenges, and offline validators.

import { makeRng, hashString, parseMap, TILE, simulate } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------- themes

export const THEMES = [
  { id: 'brass', name: 'Brassworks', sky: 0x1a2233, fog: 0x1a2233, key: 0xffd9a0, fill: 0x40508a, solid: 0x8a6a3a, brass: 0xc9973f, accent: 0xffc861, hazard: 0xff5a4e, ui: '#ffc861' },
  { id: 'verdigris', name: 'Verdigris', sky: 0x0f2422, fog: 0x0f2422, key: 0xc8ffe8, fill: 0x2a4a55, solid: 0x3f7a6a, brass: 0x62b392, accent: 0x9affd0, hazard: 0xff6a5e, ui: '#9affd0' },
  { id: 'midnight', name: 'Midnight Oil', sky: 0x101018, fog: 0x101018, key: 0x9ab8ff, fill: 0x28304a, solid: 0x3a4266, brass: 0x6a78b0, accent: 0x8fb0ff, hazard: 0xff4a6a, ui: '#8fb0ff' },
  { id: 'ember', name: 'Emberforge', sky: 0x241410, fog: 0x241410, key: 0xffb070, fill: 0x552f22, solid: 0x7a4530, brass: 0xd07a3f, accent: 0xffa050, hazard: 0xffe04e, ui: '#ffa050' },
  { id: 'frost', name: 'Frostgear', sky: 0x14202e, fog: 0x14202e, key: 0xd0ecff, fill: 0x33485e, solid: 0x5a7a94, brass: 0x9ec8dd, accent: 0xbfe8ff, hazard: 0xff5a8a, ui: '#bfe8ff' },
];

// ---------------------------------------------------------------- level DSL helpers

function rowsToAscii(rows) { return rows.join('\n'); }

function emptyGrid(w, h) {
  const g = [];
  for (let y = 0; y < h; y++) g.push(new Array(w).fill('.'));
  return g;
}
function gridAscii(g) { return g.map(r => r.join('')).join('\n'); }

// ---------------------------------------------------------------- journey generator

// 40 deterministic journey stages. Difficulty curve introduces one mechanic at
// a time, combines it with a known one, then tests mastery (every 8th stage).
export const MECHANIC_ORDER = ['move', 'jump', 'gears', 'vanish', 'fake', 'spring', 'movers', 'spikes'];

export function generateStage(index) {
  const seed = hashString('trickstep-journey-v' + CONTENT_VERSION + '-' + index);
  const rng = makeRng(seed);
  const w = 26, h = 18;
  const g = emptyGrid(w, h);

  // The first three stages are authored staircases: guaranteed climbable with
  // walk + jump-when-blocked, teaching the core loop before generation gets
  // spicier. Each step is exactly one tile up so it always blocks and invites
  // a jump.
  if (index < 3) {
    const rows = [
      '........................',
      '........................',
      '........................',
      '........................',
      '....................E...',
      '...................#####',
      '................####....',
      '.............####.......',
      '........*.####..........',
      '.......####.............',
      '.S..####................',
      '########################',
    ];
    // Variants: stage 1 adds a gear near the exit, stage 2 a spring on top.
    const grid = rows.map(r => r.split(''));
    if (index >= 1) grid[4][22] = '*';
    if (index >= 2) grid[4][23] = 'o';
    return {
      id: 'journey-' + index,
      index,
      version: CONTENT_VERSION,
      seed,
      name: 'Stage ' + (index + 1) + ' — ' + stageName(index, rng),
      ascii: gridAscii(grid),
      mechanics: ['move', 'jump'],
      par: { ticks: 700, moves: 80 },
      mastery: false,
      theme: THEMES[Math.floor(index / 8) % THEMES.length].id,
      tutorial: false,
      moveLimit: null,
      timeLimit: null,
    };
  }

  // Unlocked mechanics by stage index.
  const unlocked = ['move', 'jump'];
  if (index >= 3) unlocked.push('gears');
  if (index >= 5) unlocked.push('vanish');
  if (index >= 9) unlocked.push('fake');
  if (index >= 13) unlocked.push('spring');
  if (index >= 17) unlocked.push('movers');
  if (index >= 21) unlocked.push('spikes');

  const mastery = (index % 8) === 7 && index > 0; // periodic mastery stage
  const density = Math.min(1, 0.25 + index / 45);

  // Tower of platforms rising to the exit.
  const floors = 4 + Math.min(6, Math.floor(index / 5) + 1);
  let y = h - 2;
  let px = 2 + Math.floor(rng() * 4);
  g[y][px] = 'S';
  // start ledge
  for (let x = Math.max(1, px - 2); x <= Math.min(w - 2, px + 2); x++) if (g[y][x] === '.') g[y][x] = '#';
  const gearSpots = [];
  for (let f = 1; f < floors; f++) {
    y -= 2 + Math.floor(rng() * 2);
    if (y < 2) { y = 2; break; }
    const len = 3 + Math.floor(rng() * 4);
    px = Math.max(1, Math.min(w - len - 1, px + Math.floor(rng() * 11) - 5));
    for (let x = px; x < px + len; x++) g[y][x] = '#';
    // hazards / mechanics on this floor
    const roll = rng();
    if (unlocked.includes('spikes') && roll < 0.18 * density && len >= 4) {
      g[y - 1][px + 1 + Math.floor(rng() * (len - 2))] = '^';
    } else if (unlocked.includes('vanish') && roll < 0.4 * density) {
      const vx = px + Math.floor(rng() * len);
      g[y][vx] = '=';
    } else if (unlocked.includes('fake') && roll < 0.55 * density) {
      g[y][px + Math.floor(rng() * len)] = '~';
    }
    if (unlocked.includes('gears') && rng() < 0.6) gearSpots.push({ x: px + Math.floor(rng() * len), y: y - 1 });
    if (unlocked.includes('spring') && rng() < 0.22) g[y][px] = 'o';
    if (unlocked.includes('movers') && rng() < 0.3 && f < floors - 1) {
      const my = y - 2;
      if (my > 1 && g[my][px] === '.') g[my][px] = rng() < 0.5 ? '-' : '|';
    }
    if (index >= 2 && rng() < 0.3) g[y][px + len - 1] = 'C';
  }
  // exit on the top floor
  g[y][px] = 'E';
  // gears placed deterministically
  for (const s of gearSpots.slice(0, 3)) if (g[s.y] && g[s.y][s.x] === '.') g[s.y][s.x] = '*';

  const mechanics = unlocked.slice();
  const par = {
    ticks: Math.round((h * 30 + floors * 120) * (mastery ? 0.9 : 1)),
    moves: Math.round((w + floors * 8) * (mastery ? 0.85 : 1)),
  };
  return {
    id: 'journey-' + index,
    index,
    version: CONTENT_VERSION,
    seed,
    name: (mastery ? 'Mastery: ' : 'Stage ' + (index + 1) + ' — ') + stageName(index, rng),
    ascii: gridAscii(g),
    mechanics,
    par,
    mastery,
    theme: THEMES[Math.floor(index / 8) % THEMES.length].id,
    tutorial: false,
    moveLimit: null,
    timeLimit: null,
  };
}

const NAMES = ['Cogwheel Rise', 'Pendulum Hall', 'Tickstep Landing', 'The Winding Key', 'Gantry of Gears', 'Escapement Row', 'Mainspring Walk', 'The Bellfoundry', 'Ratchet Alley', 'Balance Bridge'];
function stageName(index, rng) {
  return NAMES[Math.floor(rng() * NAMES.length)];
}

export function journeyStage(index) {
  if (index < 0 || index >= 40) throw new Error('stage out of range');
  return generateStage(index);
}
export const JOURNEY_COUNT = 40;

// ---------------------------------------------------------------- tutorials (Learn mode)

const T = rowsToAscii;
export const TUTORIALS = [
  {
    id: 'learn-move', version: CONTENT_VERSION, seed: hashString('learn-move'),
    name: 'Lesson 1 — Walking the Decks',
    lesson: 'Use Left/Right (or A/D, or the touch arrows) to walk. Reach the glowing exit door.',
    requires: 'move', // action the player must perform
    ascii: T([
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '.S...............E..',
      '####################',
    ]),
    mechanics: ['move'], par: { ticks: 400, moves: 40 }, theme: 'brass', tutorial: true,
  },
  {
    id: 'learn-jump', version: CONTENT_VERSION, seed: hashString('learn-jump'),
    name: 'Lesson 2 — The Leap',
    lesson: 'Press Jump (Space / W / Up, or the JUMP touch button) while on the ground to leap gaps.',
    requires: 'jump',
    ascii: T([
      '......................',
      '......................',
      '......................',
      '..................E...',
      '...............######.',
      '............######....',
      '.........######.......',
      '......######..........',
      '.S..#####.............',
      '######################',
    ]),
    mechanics: ['move', 'jump'], par: { ticks: 600, moves: 60 }, theme: 'brass', tutorial: true,
  },
  {
    id: 'learn-gears', version: CONTENT_VERSION, seed: hashString('learn-gears'),
    name: 'Lesson 3 — Loose Gears',
    lesson: 'Collect brass gears for score, then reach the exit. Gears are optional mastery.',
    requires: 'gear',
    ascii: T([
      '......................',
      '......................',
      '..................*...',
      '..................E...',
      '............*..######.',
      '............######....',
      '........*..######.....',
      '......######..........',
      '.S..#####.............',
      '######################',
    ]),
    mechanics: ['move', 'jump', 'gears'], par: { ticks: 800, moves: 80 }, theme: 'brass', tutorial: true,
  },
  {
    id: 'learn-vanish', version: CONTENT_VERSION, seed: hashString('learn-vanish'),
    name: 'Lesson 4 — Vanishing Steps',
    lesson: 'Paler platforms fade in and out on a fixed rhythm. Watch the cycle, then cross while solid.',
    requires: 'move',
    ascii: T([
      '......................',
      '......................',
      '......................',
      '.S.................E..',
      '######==#==#==########',
    ]),
    mechanics: ['move', 'jump', 'vanish'], par: { ticks: 1000, moves: 90 }, theme: 'brass', tutorial: true,
  },
  {
    id: 'learn-fake', version: CONTENT_VERSION, seed: hashString('learn-fake'),
    name: 'Lesson 5 — Trick Steps',
    lesson: 'Some floor tiles are decoys that shimmer when touched — you fall straight through. Learn them; they never change.',
    requires: 'move',
    ascii: T([
      '........................',
      '........................',
      '........................',
      '.S...................E..',
      '######~~###~~###~~######',
    ]),
    mechanics: ['move', 'jump', 'fake'], par: { ticks: 1000, moves: 90 }, theme: 'brass', tutorial: true,
  },
];

// ---------------------------------------------------------------- daily

// One shared seed and ruleset per UTC day, synchronized to platform time.
export function dailyLevel(dateUtc) {
  const d = dateUtc || new Date();
  const key = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const seed = hashString('trickstep-daily-v' + CONTENT_VERSION + '-' + key);
  const index = 10 + (seed % 25); // mid-to-late difficulty band
  const base = generateStage(index);
  return {
    ...base,
    id: 'daily-' + key,
    index,
    seed,
    name: 'Daily Challenge — ' + key,
    dailyKey: key,
    theme: THEMES[seed % THEMES.length].id,
    tutorial: false,
  };
}

// ---------------------------------------------------------------- challenges

export const CHALLENGES = [
  { id: 'chal-steps', name: 'Few Careful Steps', desc: 'Clear stage 9 with a strict move limit.', base: 8, moveLimit: 60, timeLimit: null },
  { id: 'chal-clock', name: 'Against the Clock', desc: 'Clear stage 12 before the tower bell tolls.', base: 11, moveLimit: null, timeLimit: 900 },
  { id: 'chal-ghost', name: 'Vanish Mastery', desc: 'Clear stage 22 with a tight move limit.', base: 21, moveLimit: 90, timeLimit: null },
  { id: 'chal-toll', name: 'The Long Toll', desc: 'Clear stage 30 under a hard time limit.', base: 29, moveLimit: null, timeLimit: 1400 },
];

export function challengeLevel(id) {
  const c = CHALLENGES.find(c => c.id === id);
  if (!c) throw new Error('unknown challenge: ' + id);
  const base = generateStage(c.base);
  return {
    ...base,
    id: c.id,
    name: 'Challenge: ' + c.name,
    moveLimit: c.moveLimit,
    timeLimit: c.timeLimit,
    challenge: true,
  };
}

// ---------------------------------------------------------------- validators

// Offline validation: legality, bounded shape, reachable exit, no soft lock.
export function validateLevel(def) {
  const errors = [];
  if (!def.id || !def.ascii) errors.push('missing id/ascii');
  let map;
  try { map = parseMap(def.ascii); } catch (e) { return { ok: false, errors: ['parse: ' + e.message] }; }
  if (!map.spawn) errors.push('no spawn');
  if (!map.exit) errors.push('no exit');
  if (map.w < 8 || map.h < 4) errors.push('too small');
  if (map.w > 64 || map.h > 64) errors.push('too large');
  if (!errors.length) {
    // Reachability: flood fill over "potentially solid" tiles (treat vanish as
    // solid — it is sometimes solid — and fake as not solid). A cell is
    // standable if the tile below may be solid and the cell + headroom is open.
    const solidish = (t) => t === TILE.SOLID || t === TILE.BRASS || t === TILE.VANISH ||
      t === TILE.MOVER_H || t === TILE.MOVER_V || t === TILE.SPRING;
    const open = (t) => t !== TILE.SOLID && t !== TILE.BRASS && t !== TILE.FAKE;
    const idx = (x, y) => y * map.w + x;
    const seen = new Set();
    const q = [[map.spawn.x, map.spawn.y]];
    seen.add(idx(map.spawn.x, map.spawn.y));
    let exitReach = false;
    while (q.length) {
      const [x, y] = q.pop();
      if (map.tiles[idx(x, y)] === TILE.EXIT) { exitReach = true; break; }
      const cand = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
        cand.push([x + dx, y + dy]);
      }
      // jump arcs: up to 2 up / across gaps of 3
      for (let jx = -3; jx <= 3; jx++) { for (let jy = -3; jy <= 1; jy++) cand.push([x + jx, y + jy]); }
      for (const [nx, ny] of cand) {
        if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
        const k = idx(nx, ny);
        if (seen.has(k)) continue;
        const t = map.tiles[k];
        const below = ny + 1 < map.h ? map.tiles[idx(nx, ny + 1)] : TILE.SOLID;
        if (open(t) && (solidish(below) || t === TILE.EXIT)) { seen.add(k); q.push([nx, ny]); }
      }
    }
    if (!exitReach) errors.push('exit unreachable');
  }
  return { ok: errors.length === 0, errors };
}

export function validateAll() {
  const report = [];
  for (const t of TUTORIALS) report.push({ id: t.id, ...validateLevel(t) });
  for (let i = 0; i < JOURNEY_COUNT; i++) report.push({ id: 'journey-' + i, ...validateLevel(journeyStage(i)) });
  for (const c of CHALLENGES) report.push({ id: c.id, ...validateLevel(challengeLevel(c.id)) });
  report.push({ id: 'daily-sample', ...validateLevel(dailyLevel(new Date(Date.UTC(2026, 0, 1)))) });
  return report;
}

export function getLevel(ref) {
  if (ref.startsWith('journey-')) return journeyStage(parseInt(ref.slice(8), 10));
  if (ref.startsWith('learn-')) return TUTORIALS.find(t => t.id === ref);
  if (ref.startsWith('daily-')) return dailyLevel(new Date(ref.slice(6) + 'T00:00:00Z'));
  if (ref.startsWith('chal-')) return challengeLevel(ref);
  throw new Error('unknown level ref: ' + ref);
}
