'use strict';

// Trickstep Tower — localization: the string tables (strings.js, the nine
// StarHermit locales; platform-strings.js for the account lines) in the
// interface language the engine reports. Content names (stages, lessons,
// challenges) map by id; src/content.js stays English. Pure: the engine
// client (native/i18n.ts) and the node tests import it.

import { STRINGS } from './strings.js';
import { platformStrings } from './platform-strings.js';

export const SUPPORTED = Object.keys(STRINGS);
const FALLBACK = { en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
const LATAM = /^es-(4\d\d|AR|BO|CL|CO|CR|CU|DO|EC|GT|HN|MX|NI|PA|PE|PR|PY|SV|US|UY|VE)$/i;

/** Best supported locale for a BCP-47 tag (defaults to en-US). */
export function pickLocale(tag) {
  const t = String(tag || '');
  const exact = SUPPORTED.find(l => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  if (LATAM.test(t)) return 'es-419';
  if (/^fr-CA$/i.test(t)) return 'fr-CA';
  return FALLBACK[t.slice(0, 2).toLowerCase()] || 'en-US';
}

let lang = 'en-US';
let dict = STRINGS[lang];
let plat = platformStrings(lang);
export function locale() { return lang; }
/** Switches the language; returns the supported locale chosen. */
export function setLang(tag) {
  lang = pickLocale(tag);
  dict = STRINGS[lang];
  plat = platformStrings(lang);
  return lang;
}

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s);
/** Localized string for key with {placeholders} filled from vars. */
export function t(key, vars) { return fill((dict && dict[key]) ?? STRINGS['en-US'][key] ?? key, vars); }
/** The account strings (signIn, invite, inviteCopied, inviteFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function pt(key, vars) { return plat(key, vars); }

const STAGE_NAMES = ['COGWHEEL RISE', 'PENDULUM HALL', 'TICKSTEP LANDING', 'THE WINDING KEY', 'GANTRY OF GEARS',
  'ESCAPEMENT ROW', 'MAINSPRING WALK', 'THE BELLFOUNDRY', 'RATCHET ALLEY', 'BALANCE BRIDGE'];
function stageNameKey(name) {
  const i = STAGE_NAMES.indexOf(String(name).toUpperCase());
  return i >= 0 ? 'sn' + i : null;
}
const LESSON_IDS = ['learn-move', 'learn-jump', 'learn-gears', 'learn-vanish', 'learn-fake'];

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
