'use strict';

// Trickstep Tower — content names by language: stages, lessons and challenges
// map by id onto string keys (assets/strings.json, the nine StarHermit locales;
// src/content.js stays English). Pure: the engine client (native/i18n.ts, on the
// engine's strings) and the node tests hand it their own t(key, vars).

const STAGE_NAMES = ['COGWHEEL RISE', 'PENDULUM HALL', 'TICKSTEP LANDING', 'THE WINDING KEY', 'GANTRY OF GEARS',
  'ESCAPEMENT ROW', 'MAINSPRING WALK', 'THE BELLFOUNDRY', 'RATCHET ALLEY', 'BALANCE BRIDGE'];
function stageNameKey(name) {
  const i = STAGE_NAMES.indexOf(String(name).toUpperCase());
  return i >= 0 ? 'sn' + i : null;
}
const LESSON_IDS = ['learn-move', 'learn-jump', 'learn-gears', 'learn-vanish', 'learn-fake'];

const CHALLENGE_KEYS = { 'chal-steps': 'chSteps', 'chal-clock': 'chClock', 'chal-ghost': 'chGhost', 'chal-toll': 'chToll' };
export function challengeKey(id) {
  if (!id) return null;
  for (const k of Object.keys(CHALLENGE_KEYS)) if (String(id).startsWith(k)) return CHALLENGE_KEYS[k];
  return null;
}
/** The content-name functions over a translator t(key, vars). */
export function createLang(t) {
  /** Display name of a level, built from its id/kind so it follows the language. */
  function levelName(level) {
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

  /** Localized challenge {name, desc} for a CHALLENGES entry. */
  function challengeText(c) {
    const k = challengeKey(c && c.id);
    return k ? { name: t(k), desc: t(k + 'Desc') } : { name: c.name, desc: c.desc };
  }
  /** Localized lesson {name, text} for a tutorial level (falls back to the authored English). */
  function lessonText(level) {
    const n = LESSON_IDS.indexOf(level && level.id) + 1;
    return n > 0 ? { name: t('les' + n), text: t('les' + n + 'Text') } : { name: level.name, text: level.lesson };
  }
  /** Built-in fallback names ('Guest', 'Player <id>') are localized at render time. */
  function playerName(name) {
    const s = String(name || '');
    if (s === 'Guest') return t('guest');
    const m = /^Player (\S+)$/.exec(s);
    return m ? t('playerN', { id: m[1] }) : name;
  }
  return { levelName, challengeText, lessonText, playerName };
}
