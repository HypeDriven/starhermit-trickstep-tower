'use strict';

// Trickstep Tower — the save document (pure; the engine client and the node
// tests share it). The engine save holds:
//   { v: 1, progress, snapshot, name, boards }
// progress  stars/bestDaily/achievements/streak/clears/gearMasteryStages
//           (the browser build's tt-progress-v1 and its cloud slot's
//           `progress`), merged across devices by mergeProgress;
// snapshot  the paused run "Resume paused run" offers (tt-snapshot-v1), or null;
// name      the guest display name for the local boards (tt-name);
// boards    the local casual boards per board key (tt-board-*), top 20.
// The browser build's cloud slot (game:<slug>, { progress, savedAt }) is read
// as a foreign save; its settings KV (PREF_KEYS) gives the game's options.

export const BOARD_KEYS = ['daily', 'journey', 'challenge'];
export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia', 'mono'];
export const DEFAULT_OPTIONS = { palette: 'default', leftHanded: false, haptics: true };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
/** The browser build's settings KV keys (session PREF_KEYS); all removed once read. */
export const BROWSER_KEYS = ['volumes', 'gfx', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'haptics', 'palette', 'camera', 'tutorialsSeen'];

export function defaultProgress() {
  return { v: 1, stars: {}, bestDaily: {}, achievements: {}, streak: { count: 0, lastDay: null }, clears: 0, gearMasteryStages: {} };
}
export function defaultSave() {
  return { v: 1, progress: defaultProgress(), snapshot: null, name: '', boards: { daily: [], journey: [], challenge: [] } };
}

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// Union of two progress docs, so a save from another device never erases
// local clears: best score per stage/daily, earliest unlock per achievement,
// the streak with the later day (longer on a tie), the higher clear count.
export function mergeProgress(a, b) {
  a = isObj(a) ? a : {};
  b = isObj(b) ? b : {};
  const maxMap = (x, y) => {
    const out = Object.assign({}, isObj(x) ? x : {});
    for (const [k, v] of Object.entries(isObj(y) ? y : {})) if (!(k in out) || Number(v) > Number(out[k])) out[k] = v;
    return out;
  };
  const achievements = Object.assign({}, isObj(a.achievements) ? a.achievements : {});
  for (const [k, v] of Object.entries(isObj(b.achievements) ? b.achievements : {})) if (!achievements[k] || String(v) < String(achievements[k])) achievements[k] = v;
  const sa = isObj(a.streak) ? a.streak : { count: 0, lastDay: null };
  const sb = isObj(b.streak) ? b.streak : { count: 0, lastDay: null };
  const later = String(sa.lastDay || '') > String(sb.lastDay || '') ? sa
    : String(sb.lastDay || '') > String(sa.lastDay || '') ? sb
      : ((sa.count || 0) >= (sb.count || 0) ? sa : sb);
  const gear = Object.assign({}, isObj(a.gearMasteryStages) ? a.gearMasteryStages : {});
  for (const [k, v] of Object.entries(isObj(b.gearMasteryStages) ? b.gearMasteryStages : {})) gear[k] = gear[k] || v;
  return {
    v: 1,
    stars: maxMap(a.stars, b.stars),
    bestDaily: maxMap(a.bestDaily, b.bestDaily),
    achievements,
    streak: { count: Number(later.count) || 0, lastDay: later.lastDay || null },
    clears: Math.max(Number(a.clears) || 0, Number(b.clears) || 0),
    gearMasteryStages: gear,
  };
}

function normBoard(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => isObj(e) && Number.isFinite(Number(e.score)))
    .map((e) => ({ name: String(e.name || 'Guest').slice(0, 24), score: Number(e.score), levelId: String(e.levelId || ''), at: String(e.at || ''), won: e.won !== false }))
    .sort((x, y) => y.score - x.score).slice(0, 20);
}
function normSnapshot(s) {
  if (!isObj(s) || typeof s.levelId !== 'string' || typeof s.state !== 'string') return null;
  return {
    levelId: s.levelId, mode: String(s.mode || 'journey'), state: s.state, savedAt: Number(s.savedAt) || 0,
    commands: Array.isArray(s.commands) ? s.commands : [], hashes: Array.isArray(s.hashes) ? s.hashes : [],
    startedAt: Number(s.startedAt) || 0, opts: isObj(s.opts) ? s.opts : {},
  };
}
/** Any stored value → a well-formed save. */
export function normalize(raw) {
  const d = defaultSave();
  if (!isObj(raw)) return d;
  d.progress = mergeProgress(defaultProgress(), raw.progress);
  d.snapshot = normSnapshot(raw.snapshot);
  d.name = typeof raw.name === 'string' ? raw.name.slice(0, 24) : '';
  const b = isObj(raw.boards) ? raw.boards : {};
  for (const k of BOARD_KEYS) d.boards[k] = normBoard(b[k]);
  return d;
}
/** Two devices' saves: progress unioned, the newer snapshot, boards merged. */
export function mergeSaves(a, b) {
  const x = normalize(a), y = normalize(b);
  const out = normalize(x);
  out.progress = mergeProgress(x.progress, y.progress);
  const sx = x.snapshot, sy = y.snapshot;
  out.snapshot = sx && sy ? (sy.savedAt > sx.savedAt ? sy : sx) : (sx || sy);
  out.name = x.name || y.name;
  for (const k of BOARD_KEYS) {
    const seen = new Set();
    out.boards[k] = normBoard([...x.boards[k], ...y.boards[k]].filter((e) => {
      const id = e.name + '|' + e.score + '|' + e.levelId + '|' + e.at;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }));
  }
  return out;
}
const canon = (o) => JSON.stringify(o, (k, v) => (isObj(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
export function sameSave(a, b) { return canon(normalize(a)) === canon(normalize(b)); }

/** The browser build's cloud slot text ({ progress, savedAt }) as a save, or null. */
export function readForeign(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isObj(doc) || !isObj(doc.progress)) return null;
  const d = defaultSave();
  d.progress = mergeProgress(defaultProgress(), doc.progress);
  return d;
}
/** Valid game options in raw. */
export function pickOptions(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  if (PALETTES.includes(raw.palette)) out.palette = raw.palette;
  if (typeof raw.leftHanded === 'boolean') out.leftHanded = raw.leftHanded;
  if (typeof raw.haptics === 'boolean') out.haptics = raw.haptics;
  return out;
}
/** The browser build's settings KV → the game's options. */
export function readLegacySettings(kv) { return { options: pickOptions(kv) }; }

/** A won ranked run on a local casual board (platform.js _localSubmit); returns the new board and the rank. */
export function addLocalScore(save, board, entry) {
  const list = normBoard([...(save.boards[board] || []), entry]);
  save.boards[board] = list;
  return list.findIndex((e) => e.score === entry.score) + 1;
}
