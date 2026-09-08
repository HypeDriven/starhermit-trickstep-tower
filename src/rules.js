'use strict';

// Trickstep Tower — rules engine.
// Pure deterministic state transitions, legality, scoring, seeded RNG.
// No rendering, no DOM, no I/O. Works in Node (ESM) and the browser.

export const TICK_MS = 50; // fixed simulation step (ms)
export const GRAVITY = 34; // tiles/s^2
export const JUMP_VY = -12.4; // tiles/s (negative is up)
export const MOVE_SPEED = 6.0; // tiles/s
export const MAX_FALL = 18;
export const PLAYER_W = 0.6;
export const PLAYER_H = 0.9;

// 2: below-the-map is open air (falling off the tower is a real fall), so
// states and replays recorded under version 1 no longer resolve identically.
export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------- RNG

// Seeded PRNG (mulberry32). Returns a function producing floats in [0,1).
export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t >> 7, 61 | t);
    return ((t ^ (t >> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// ---------------------------------------------------------------- tiles

// Tile legend used by level ascii maps:
//   '#' solid block        'B' brass block (solid)
//   '^' spikes (deadly)    '=' vanish platform (deterministic on/off cycle)
//   '~' fake floor (looks solid, never is — a learnable trap)
//   '-' moving platform (horizontal)   '|' moving platform (vertical)
//   'o' spring             '*' gear collectible
//   'C' checkpoint         'E' exit door            'S' spawn
//   '.' empty
export const TILE = {
  EMPTY: 0, SOLID: 1, BRASS: 2, SPIKE: 3, VANISH: 4, FAKE: 5,
  MOVER_H: 6, MOVER_V: 7, SPRING: 8, GEAR: 9, CHECKPOINT: 10, EXIT: 11, SPAWN: 12,
};

const CHAR_TO_TILE = {
  '.': TILE.EMPTY, '#': TILE.SOLID, 'B': TILE.BRASS, '^': TILE.SPIKE,
  '=': TILE.VANISH, '~': TILE.FAKE, '-': TILE.MOVER_H, '|': TILE.MOVER_V,
  'o': TILE.SPRING, '*': TILE.GEAR, 'C': TILE.CHECKPOINT, 'E': TILE.EXIT, 'S': TILE.SPAWN,
};

// Parse an ascii map into a level runtime description.
export function parseMap(ascii) {
  const rows = ascii.replace(/^\n+|\s+$/g, '').split('\n').map(r => r.replace(/\s+$/g, ''));
  const h = rows.length;
  const w = Math.max(...rows.map(r => r.length));
  const tiles = new Uint8Array(w * h);
  const gears = [];
  const movers = [];
  const checkpoints = [];
  let spawn = null;
  let exit = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] || '.';
      const t = CHAR_TO_TILE[ch];
      if (t === undefined) throw new Error('bad tile char: ' + ch);
      tiles[y * w + x] = t;
      if (t === TILE.GEAR) gears.push({ x, y });
      if (t === TILE.MOVER_H || t === TILE.MOVER_V) movers.push({ x, y, vertical: t === TILE.MOVER_V, idx: movers.length });
      if (t === TILE.CHECKPOINT) checkpoints.push({ x, y });
      if (t === TILE.SPAWN) spawn = { x, y };
      if (t === TILE.EXIT) exit = { x, y };
    }
  }
  return { w, h, tiles, gears, movers, checkpoints, spawn, exit };
}

// ---------------------------------------------------------------- state

// levelDef: { id, seed, ascii, name, par: {ticks, moves}, mechanics: [], moveLimit: null|n, timeLimit: null|ticks }
export function createState(levelDef) {
  const map = parseMap(levelDef.ascii);
  if (!map.spawn) throw new Error('level has no spawn');
  if (!map.exit) throw new Error('level has no exit');
  const rng = makeRng(levelDef.seed >>> 0);
  // Deterministic per-mover / per-vanish parameters from the level seed.
  const vanish = [];
  const moverCfg = moversCfg(map, rng);
  for (let i = 0; i < map.w * map.h; i++) {
    if (map.tiles[i] === TILE.VANISH) {
      vanish.push({ i, period: 56 + Math.floor(rng() * 24), offset: Math.floor(rng() * 80), duty: 0.62 });
    }
  }
  const state = {
    v: SCHEMA_VERSION,
    levelId: levelDef.id,
    seed: levelDef.seed >>> 0,
    tick: 0,
    w: map.w, h: map.h,
    tiles: Array.from(map.tiles),
    vanish,
    moverCfg,
    player: { x: map.spawn.x + 0.5, y: map.spawn.y + 1 - PLAYER_H, vx: 0, vy: 0, onGround: false, face: 1 },
    spawn: { x: map.spawn.x + 0.5, y: map.spawn.y + 1 - PLAYER_H },
    checkpoint: null,
    gears: map.gears.map(() => false),
    gearPos: map.gears,
    fakesRevealed: [],
    deaths: 0,
    moves: 0,
    invalid: 0,
    won: false,
    over: false,
    reason: null,
    moveLimit: levelDef.moveLimit || null,
    timeLimit: levelDef.timeLimit || null,
    springTick: -1,
  };
  return state;
}

function moversCfg(map, rng) {
  return map.movers.map(m => ({
    x: m.x, y: m.y, vertical: m.vertical,
    amp: 1.5 + Math.floor(rng() * 3),        // tiles of travel
    period: 90 + Math.floor(rng() * 60),      // ticks per full cycle
    phase: Math.floor(rng() * 120),
  }));
}

// Position of a mover platform's center at a tick (deterministic cosine path).
export function moverOffset(cfg, tick) {
  const t = ((tick + cfg.phase) % cfg.period) / cfg.period;
  const o = cfg.amp * 0.5 * (1 - Math.cos(2 * Math.PI * t)) - cfg.amp * 0.5;
  return cfg.vertical ? { dx: 0, dy: o } : { dx: o, dy: 0 };
}

function vanishSolid(v, tick) {
  const t = (tick + v.offset) % v.period;
  return t < v.period * v.duty;
}

// Public for renderer/UI: is a vanish tile currently solid?
export function isVanishSolid(state, tileIndex, tick) {
  const v = state.vanish.find(v => v.i === tileIndex);
  if (!v) return false;
  return vanishSolid(v, tick === undefined ? state.tick : tick);
}

function tileAt(state, tx, ty) {
  // Sides and ceiling are walls; below the map is open air so that falling off
  // the tower actually falls — otherwise the grid floor is an invisible ledge
  // the climber can stand and walk on.
  if (ty >= state.h) return TILE.EMPTY;
  if (tx < 0 || tx >= state.w || ty < 0) return TILE.SOLID; // walls
  return state.tiles[ty * state.w + tx];
}

// Solid for collision at current tick (FAKE never solid; VANISH time-based).
function solidAt(state, tx, ty) {
  const t = tileAt(state, tx, ty);
  if (t === TILE.SOLID || t === TILE.BRASS) return true;
  if (t === TILE.VANISH) return isVanishSolid(state, ty * state.w + tx);
  if (t === TILE.MOVER_H || t === TILE.MOVER_V) return true;
  return false;
}

function overlaps(state, x, y, kind) {
  const x0 = Math.floor(x - PLAYER_W / 2), x1 = Math.floor(x + PLAYER_W / 2);
  const y0 = Math.floor(y), y1 = Math.floor(y + PLAYER_H);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tileAt(state, tx, ty) === kind) return { tx, ty };
    }
  }
  return null;
}

// ---------------------------------------------------------------- actions

// input per tick: { move: -1|0|1, jump: 0|1 }
export function legalActions(state) {
  const a = { move: !state.over, jump: false, retry: true, undo: false };
  if (!state.over && state.player.onGround) a.jump = true;
  return a;
}

function respawn(state) {
  const cp = state.checkpoint;
  state.player.x = cp ? cp.x : state.spawn.x;
  state.player.y = cp ? cp.y : state.spawn.y;
  state.player.vx = 0;
  state.player.vy = 0;
  state.player.onGround = false;
  state.deaths++;
}

function die(state) {
  respawn(state);
}

function applyInput(state, input) {
  if (!input || typeof input !== 'object') { state.invalid++; return; }
  const move = input.move | 0;
  const jump = input.jump ? 1 : 0;
  if (move < -1 || move > 1 || (jump !== 0 && jump !== 1)) { state.invalid++; return; }
  if (state.over) {
    if (move !== 0 || jump) state.invalid++;
    return;
  }
  if (move !== 0) state.moves++;
  state.player.vx = move * MOVE_SPEED;
  if (move !== 0) state.player.face = move;
  if (jump) {
    if (state.player.onGround) {
      state.player.vy = JUMP_VY;
      state.player.onGround = false;
      state.moves++;
    } else {
      state.invalid++; // invalid action: jump in air
    }
  }
}

// Advance one fixed tick. Returns list of events for feedback/replay notes.
export function step(state, input) {
  const events = [];
  if (state.over) return events;
  applyInput(state, input);
  if (state.over) return events;

  const dt = TICK_MS / 1000;
  const p = state.player;

  // Vertical
  p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
  let ny = p.y + p.vy * dt;
  const x0 = Math.floor(p.x - PLAYER_W / 2 + 0.001), x1 = Math.floor(p.x + PLAYER_W / 2 - 0.001);
  p.onGround = false;
  if (p.vy >= 0) {
    const ty = Math.floor(ny + PLAYER_H);
    for (let tx = x0; tx <= x1; tx++) {
      if (solidAt(state, tx, ty)) {
        ny = ty - PLAYER_H;
        p.vy = 0;
        p.onGround = true;
        break;
      }
    }
  } else {
    const ty = Math.floor(ny);
    for (let tx = x0; tx <= x1; tx++) {
      if (solidAt(state, tx, ty)) {
        ny = ty + 1;
        p.vy = 0;
        break;
      }
    }
  }
  p.y = ny;

  // Horizontal
  let nx = p.x + p.vx * dt;
  const dir = Math.sign(p.vx);
  if (dir !== 0) {
    const y0 = Math.floor(p.y + 0.001), y1 = Math.floor(p.y + PLAYER_H - 0.001);
    const tx = dir > 0 ? Math.floor(nx + PLAYER_W / 2) : Math.floor(nx - PLAYER_W / 2);
    for (let ty = y0; ty <= y1; ty++) {
      if (solidAt(state, tx, ty)) {
        nx = dir > 0 ? tx - PLAYER_W / 2 - 0.0001 : tx + 1 + PLAYER_W / 2 + 0.0001;
        p.vx = 0;
        break;
      }
    }
  }
  p.x = nx;

  // Riding moving platforms: if standing on a mover, carry along.
  const belowY = Math.floor(p.y + PLAYER_H + 0.02);
  for (const cfg of state.moverCfg) {
    const off = moverOffset(cfg, state.tick);
    const offPrev = moverOffset(cfg, state.tick - 1);
    const cx = cfg.x + 0.5 + off.dx, cy = cfg.y + off.dy;
    if (Math.floor(cy) === belowY || Math.abs((p.y + PLAYER_H) - cy) < 0.05) {
      if (Math.abs(p.x - cx) < 0.9 && p.onGround) {
        p.x += off.dx - offPrev.dx;
        p.y += off.dy - offPrev.dy;
        events.push({ t: 'ride' });
      }
    }
  }

  // Interactions
  const sp = overlaps(state, p.x, p.y, TILE.SPIKE);
  if (sp) { die(state); events.push({ t: 'death', why: 'spikes' }); return finish(state, events); }

  if (p.y > state.h + 2) { die(state); events.push({ t: 'death', why: 'fell' }); return finish(state, events); }

  const fk = overlaps(state, p.x, p.y, TILE.FAKE);
  if (fk && !state.fakesRevealed.includes(fk.ty * state.w + fk.tx)) {
    state.fakesRevealed.push(fk.ty * state.w + fk.tx);
    events.push({ t: 'reveal', why: 'fake-floor' });
  }

  const spr = overlaps(state, p.x, p.y, TILE.SPRING);
  if (spr && p.vy >= 0) {
    p.vy = JUMP_VY * 1.55;
    p.onGround = false;
    state.springTick = state.tick;
    events.push({ t: 'spring' });
  }

  const cp = overlaps(state, p.x, p.y, TILE.CHECKPOINT);
  if (cp) {
    const pos = { x: cp.tx + 0.5, y: cp.ty + 1 - PLAYER_H };
    if (!state.checkpoint || state.checkpoint.x !== pos.x || state.checkpoint.y !== pos.y) {
      state.checkpoint = pos;
      events.push({ t: 'checkpoint' });
    }
  }

  for (let i = 0; i < state.gearPos.length; i++) {
    if (state.gears[i]) continue;
    const g = state.gearPos[i];
    const dx = p.x - (g.x + 0.5), dy = (p.y + PLAYER_H / 2) - (g.y + 0.5);
    if (dx * dx + dy * dy < 0.55) {
      state.gears[i] = true;
      events.push({ t: 'gear', i });
    }
  }

  const ex = overlaps(state, p.x, p.y, TILE.EXIT);
  if (ex) {
    state.won = true;
    state.over = true;
    state.reason = 'exit';
    events.push({ t: 'win' });
  }
  return finish(state, events);
}

function finish(state, events) {
  if (!state.over) {
    if (state.moveLimit !== null && state.moves >= state.moveLimit) {
      state.over = true;
      state.reason = 'move-limit';
      events.push({ t: 'fail', why: 'move-limit' });
    } else if (state.timeLimit !== null && state.tick >= state.timeLimit) {
      state.over = true;
      state.reason = 'time-limit';
      events.push({ t: 'fail', why: 'time-limit' });
    }
  }
  state.tick++;
  return events;
}

export function isTerminal(state) { return state.over; }
export function terminalReason(state) { return state.reason; }

// ---------------------------------------------------------------- scoring

// Integer score with a full component breakdown.
export function scoreBreakdown(state, par) {
  const gears = state.gears.filter(Boolean).length;
  const completion = state.won ? 1000 : 0;
  const gearScore = gears * 150;
  const timeBonus = state.won && par && par.ticks ? Math.max(0, (par.ticks - state.tick)) * 2 : 0;
  const moveBonus = state.won && par && par.moves ? Math.max(0, (par.moves - state.moves)) * 5 : 0;
  const deathPenalty = state.deaths * 40;
  const invalidPenalty = state.invalid * 5;
  const total = Math.max(0, completion + gearScore + timeBonus + moveBonus - deathPenalty - invalidPenalty);
  return { completion, gears: gearScore, gearCount: gears, timeBonus, moveBonus, deathPenalty, invalidPenalty, total };
}

// Tie ordering: completion, fewer invalid actions, lower elapsed ticks, session id.
export function compareResults(a, b) {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.invalid !== b.invalid) return a.invalid - b.invalid;
  if (a.tick !== b.tick) return a.tick - b.tick;
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

// ---------------------------------------------------------------- serialization

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const s = JSON.parse(json);
  if (s.v !== SCHEMA_VERSION) throw new Error('unsupported state version: ' + s.v);
  return s;
}

// Canonical state hash (FNV-1a over a stable projection).
export function stateHash(state) {
  const proj = {
    tick: state.tick,
    p: [round3(state.player.x), round3(state.player.y), round3(state.player.vx), round3(state.player.vy), state.player.onGround ? 1 : 0],
    g: state.gears, d: state.deaths, m: state.moves, inv: state.invalid,
    w: state.won, o: state.over, r: state.reason,
    cp: state.checkpoint, fr: state.fakesRevealed,
  };
  return hashString(JSON.stringify(proj)).toString(16).padStart(8, '0');
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// Initial-state hash for replay envelopes.
export function initialHash(levelDef) {
  return stateHash(createState(levelDef));
}

// ---------------------------------------------------------------- replay

// A replay envelope: { schema, level, seed, commands: [{tick, input}], hashes: [{tick, hash}], result }
// Replays deterministically; returns { ok, reason, finalHash }.
export function replay(levelDef, envelope) {
  if (!envelope || envelope.schema !== SCHEMA_VERSION) return { ok: false, reason: 'schema' };
  const state = createState(levelDef);
  const cmds = (envelope.commands || []).slice().sort((a, b) => a.tick - b.tick);
  let ci = 0;
  const hashes = envelope.hashes || [];
  let hi = 0;
  const maxTicks = (levelDef.timeLimit || 0) + 200000 || 200000;
  while (!state.over && state.tick < maxTicks) {
    let input = { move: 0, jump: 0 };
    while (ci < cmds.length && cmds[ci].tick === state.tick) { input = cmds[ci].input; ci++; }
    step(state, input);
    if (hi < hashes.length && hashes[hi].tick === state.tick) {
      if (hashes[hi].hash !== stateHash(state)) {
        return { ok: false, reason: 'hash-mismatch@' + state.tick, finalHash: stateHash(state) };
      }
      hi++;
    }
  }
  return {
    ok: true,
    state,
    finalHash: stateHash(state),
    result: { won: state.won, reason: state.reason, score: scoreBreakdown(state, levelDef.par) },
  };
}

// Run a command script from scratch; used by tests and the authoritative server.
export function simulate(levelDef, commands, maxTicks) {
  const state = createState(levelDef);
  const cmds = (commands || []).slice().sort((a, b) => a.tick - b.tick);
  let ci = 0;
  const limit = maxTicks || 200000;
  while (!state.over && state.tick < limit) {
    let input = { move: 0, jump: 0 };
    while (ci < cmds.length && cmds[ci].tick === state.tick) { input = cmds[ci].input; ci++; }
    step(state, input);
  }
  return state;
}
