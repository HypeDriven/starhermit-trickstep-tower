'use strict';

// Trickstep Tower — localization runtime. The language comes from
// sh-language.js (window.StarHermitLanguage): explicit game choice
// (ui.language) → StarHermit account preferredLanguage → device languages →
// en-US. A change notifies listeners (onLanguage) so the current screen
// re-renders in place without restarting the level.

import { STRINGS } from './strings.js';
import { gfxStrings } from './gfx-i18n.js';
import { platformStrings } from './platform-i18n.js';

export const SUPPORTED = Object.keys(STRINGS);
let lang = 'en-US';
let dict = STRINGS[lang];
const listeners = new Set();

export function locale() { return lang; }

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s);

/** Localized string for key with {placeholders} filled from vars. */
export function t(key, vars) {
  return fill((dict && dict[key]) ?? STRINGS['en-US'][key] ?? key, vars);
}

/** Graphics-panel / platform translators for the current game language. */
export const gt = (key, vars) => gfxStrings(lang)(key, vars);
export const pt = (key, vars) => platformStrings(lang)(key, vars);

/** fn(locale) runs after every language change. */
export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function setLocale(next) {
  lang = STRINGS[next] ? next : 'en-US';
  dict = STRINGS[lang];
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
}

const SL = typeof window !== 'undefined' ? window.StarHermitLanguage : null;
export const language = SL ? SL.create({ game: 'trickstep-tower', supported: SUPPORTED, apply: setLocale }) : null;

// ---- content names (src/content.js stays English; names map by id) ----
const STAGE_NAMES = ['COGWHEEL RISE', 'PENDULUM HALL', 'TICKSTEP LANDING', 'THE WINDING KEY', 'GANTRY OF GEARS',
  'ESCAPEMENT ROW', 'MAINSPRING WALK', 'THE BELLFOUNDRY', 'RATCHET ALLEY', 'BALANCE BRIDGE'];

function stageNameKey(name) {
  const i = STAGE_NAMES.indexOf(String(name).toUpperCase());
  return i >= 0 ? 'sn' + i : null;
}

/** Display name of a level, built from its id/kind so it follows the language. */
export function levelName(level) {
  if (!level) return '';
  const name = String(level.name || '');
  let m;
  const ln = LESSON_IDS.indexOf(level.id) + 1;
  if (ln > 0) return t('lvlLesson', { n: ln, name: t('les' + ln) });
  if ((m = /^Daily Challenge — (.+)$/.exec(name))) return t('lvlDaily', { key: m[1] });
  if ((m = /^Challenge: (.+)$/.exec(name))) {
    const ch = challengeKey(level.challengeId || level.id);
    return t('lvlChallenge', { name: ch ? t(ch) : m[1] });
  }
  if ((m = /^Mastery: (.+)$/.exec(name))) {
    const k = stageNameKey(m[1]);
    return t('lvlMastery', { name: k ? t(k) : m[1] });
  }
  if ((m = /^Stage (\d+) — (.+)$/.exec(name))) {
    const k = stageNameKey(m[2]);
    return t('lvlStage', { n: m[1], name: k ? t(k) : m[2] });
  }
  return name;
}

const CHALLENGE_KEYS = { 'chal-steps': 'chSteps', 'chal-clock': 'chClock', 'chal-ghost': 'chGhost', 'chal-toll': 'chToll' };
export function challengeKey(id) {
  if (!id) return null;
  for (const k of Object.keys(CHALLENGE_KEYS)) if (String(id).startsWith(k)) return CHALLENGE_KEYS[k];
  return null;
}

/** Localized challenge {name, desc} for a CHALLENGES entry. */
export function challengeText(c) {
  const k = challengeKey(c && c.id);
  return k ? { name: t(k), desc: t(k + 'Desc') } : { name: c.name, desc: c.desc };
}

const LESSON_IDS = ['learn-move', 'learn-jump', 'learn-gears', 'learn-vanish', 'learn-fake'];

/** Localized lesson {name, text} for a tutorial level (falls back to the authored English). */
export function lessonText(level) {
  const n = LESSON_IDS.indexOf(level && level.id) + 1;
  return n > 0 ? { name: t('les' + n), text: t('les' + n + 'Text') } : { name: level.name, text: level.lesson };
}

/** Built-in fallback names ('Guest', 'Player <id>') are localized at render time. */
export function playerName(name) {
  const s = String(name || '');
  if (s === 'Guest') return t('guest');
  const m = /^Player (\S+)$/.exec(s);
  return m ? t('playerN', { id: m[1] }) : name;
}
