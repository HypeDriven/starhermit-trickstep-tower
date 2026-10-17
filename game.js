'use strict';

// Trickstep Tower — browser entry point (ES module, no build step).
// bootstrap · session · ui · input · persistence · achievements

import {
  TICK_MS, SCHEMA_VERSION, createState, step,
  terminalReason, scoreBreakdown, serialize, deserialize, stateHash, hashString,
} from './src/rules.js';
import {
  CONTENT_VERSION, THEMES, TUTORIALS, JOURNEY_COUNT, journeyStage, dailyLevel,
  CHALLENGES, challengeLevel,
} from './src/content.js';
import { Renderer } from './src/client/render.js';
import { PRESETS, CATEGORIES, DEFAULT_GFX, presetTier, choosePreset, setOverride } from './src/client/gfx.js';
import { AudioEngine, BUS_NAMES } from './src/client/audio.js';
import { Platform, mergeProgress } from './src/client/platform.js';
import { t, gt, pt, onLanguage, levelName, lessonText, challengeText, playerName } from './src/client/i18n.js';

// ---------------------------------------------------------------- persistence

// Storage shim so the module graph also evaluates outside the browser (tests).
const localStorage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
})();

const SETTINGS_KEY = 'tt-settings-v1';
const PROGRESS_KEY = 'tt-progress-v1';
const SNAPSHOT_KEY = 'tt-snapshot-v1';

function checksummed(obj) {
  const body = JSON.stringify(obj);
  return JSON.stringify({ body, sum: hashString(body).toString(16) });
}
function unchecksummed(raw) {
  try {
    const wrap = JSON.parse(raw);
    if (hashString(wrap.body).toString(16) !== wrap.sum) return null;
    return JSON.parse(wrap.body);
  } catch (e) { return null; }
}

const DEFAULT_SETTINGS = {
  v: 1,
  volumes: { music: 0.45, effects: 0.8, ambience: 0.35, voice: 0.6 },
  gfx: structuredClone(DEFAULT_GFX),
  reducedMotion: false,
  highContrast: false,
  largeText: false,
  leftHanded: false,
  haptics: true,
  palette: 'default',
  camera: 'follow',
  tutorialsSeen: {},
};

const DEFAULT_PROGRESS = {
  v: 1,
  stars: {},        // journey index → best score
  bestDaily: {},    // dailyKey → score
  achievements: {}, // key → ISO date
  streak: { count: 0, lastDay: null },
  clears: 0,
  gearMasteryStages: {},
};

function loadStored(key, def) {
  const raw = localStorage.getItem(key);
  if (!raw) return structuredClone(def);
  const obj = unchecksummed(raw);
  if (!obj || obj.v !== def.v) return structuredClone(def);
  return Object.assign(structuredClone(def), obj);
}
function store(key, obj) {
  try { localStorage.setItem(key, checksummed(obj)); } catch (e) { /* storage full/blocked */ }
}

// ---------------------------------------------------------------- achievements

// Names/descriptions are string keys (src/client/strings.js).
const ACHIEVEMENTS = [
  { key: 'first-clear', name: 'achFirstClear' },
  { key: 'gear-master', name: 'achGearMaster' },
  { key: 'streak-3', name: 'achStreak3' },
  { key: 'tower-top', name: 'achTowerTop' },
  { key: 'centurion', name: 'achCenturion' },
];

// ---------------------------------------------------------------- app

const app = {
  state: 'boot',
  stateReason: 'init',
  settings: loadStored(SETTINGS_KEY, DEFAULT_SETTINGS),
  progress: loadStored(PROGRESS_KEY, DEFAULT_PROGRESS),
  platform: new Platform(),
  session: null,
  renderer: null,
  audio: null,
  els: {},
  lastAnnounce: '',
  lastAnnounceAt: 0,
  countdownTimer: null,
  countdownHide: null,
  rerender: null, // repaints the visible screen in the current language
};

// Where the sync indicator appears (HUD + profile screen).
const SYNC_LABELS = { synced: 'syncSynced', saving: 'syncSaving', offline: 'syncOffline', error: 'syncError' };
function syncLabel() { const k = SYNC_LABELS[app.platform.syncStatus]; return k ? t(k) : ''; }

function setState(next, reason) {
  const prev = app.state;
  app.state = next;
  app.stateReason = reason;
  document.body.dataset.gameState = next;
  log('state: ' + prev + ' → ' + next + ' (' + reason + ')');
}

function log(msg) { if (window.console) console.debug('[trickstep]', msg); }

// ---------------------------------------------------------------- DOM helpers

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (attrs[k] === null || attrs[k] === undefined) continue;
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children || []) e.appendChild(c);
  return e;
}

// Repeats of the same message are suppressed only briefly: a second death or a
// second identical hint must still be announced.
const ANNOUNCE_REPEAT_MS = 1500;
function announce(text, assertive) {
  const now = Date.now();
  if (text === app.lastAnnounce && now - app.lastAnnounceAt < ANNOUNCE_REPEAT_MS) return;
  app.lastAnnounce = text;
  app.lastAnnounceAt = now;
  const region = assertive ? app.els.liveAssert : app.els.live;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}

function haptic(ms) {
  if (app.settings.haptics && navigator.vibrate) navigator.vibrate(ms || 15);
}

// ---------------------------------------------------------------- session

class Session {
  constructor(level, mode, opts) {
    this.level = level;
    this.mode = mode; // 'learn' | 'journey' | 'daily' | 'practice' | 'challenge'
    this.opts = opts || {};
    this.ranked = mode === 'journey' || mode === 'daily' || mode === 'challenge';
    this.state = createState(level);
    this.commands = [];
    this.hashes = [];
    this.undoStack = [];
    this.accumulator = 0;
    this.lastTime = 0;
    this.input = { move: 0, jump: 0 };
    this.pendingJumpId = 0;
    this.consumedJumpId = 0;
    this.countdown = 3;
    this.over = false;
    this.result = null;
    this.stepCounter = 0;
    this.stepAcc = 0;
    this.startedAt = Date.now();
    this.awaySummary = null;
  }

  // Current quantized input; jump is edge-triggered with an action identifier
  // so one press can never double-commit.
  sampleInput() {
    const move = inputState.left ? -1 : (inputState.right ? 1 : 0);
    let jump = 0;
    if (this.pendingJumpId > this.consumedJumpId) {
      jump = 1;
      this.consumedJumpId = this.pendingJumpId;
    }
    return { move, jump };
  }

  tick() {
    const s = this.state;
    const inp = this.sampleInput();
    const wasAirborne = !s.player.onGround;
    const prevInvalid = s.invalid;
    if (inp.move !== 0 || inp.jump) {
      if (this.commands.length && this.commands[this.commands.length - 1].tick === s.tick) {
        this.commands[this.commands.length - 1].input = inp;
      } else {
        this.commands.push({ tick: s.tick, input: inp });
      }
    }
    const events = step(s, inp);
    if (s.invalid > prevInvalid) {
      app.audio.event('invalid');
      announce(t('invalidAction'), true);
    }
    for (const ev of events) this.onEvent(ev);
    if (wasAirborne && s.player.onGround) app.audio.event('land');
    // Footstep ticks while walking on the ground (one per tile travelled).
    if (s.player.onGround && !s.over && Math.abs(s.player.vx) > 0) {
      this.stepAcc += Math.abs(s.player.vx) * (TICK_MS / 1000);
      if (this.stepAcc >= 1) { this.stepAcc = 0; app.audio.event('step'); }
    } else {
      this.stepAcc = 0;
    }
    if (this.mode === 'practice' && s.tick % 10 === 0) {
      this.undoStack.push(serialize(s));
      if (this.undoStack.length > 40) this.undoStack.shift();
    }
    if (s.tick % 100 === 0) this.hashes.push({ tick: s.tick, hash: stateHash(s) });
    if (s.over && !this.over) this.finish();
  }

  onEvent(ev) {
    const r = app.renderer;
    const s = this.state;
    const w = r.levelW || 20, h = r.levelH || 12;
    const wx = s.player.x - w / 2, wy = h - s.player.y;
    switch (ev.t) {
      case 'death':
        app.audio.event('death'); haptic(60); r.kickShake(0.7);
        r.burst(wx, wy, '#ff5a4e', 24, 4);
        announce(t(ev.why === 'spikes' ? 'trapSpikes' : 'trapFall'), true);
        break;
      case 'gear': app.audio.event('gear'); haptic(20); r.burst(wx, wy, '#ffd777', 14, 3); break;
      case 'checkpoint': app.audio.event('checkpoint'); announce(t('checkpointReached')); break;
      case 'spring': app.audio.event('spring'); r.kickShake(0.2); break;
      case 'reveal': app.audio.event('reveal'); announce(t('trickShimmer'), false); break;
      case 'win': app.audio.event('win'); r.burst(wx, wy, '#9affd0', 40, 5); break;
      case 'fail': app.audio.event('fail'); break;
      default: break;
    }
  }

  undo() {
    if (this.mode !== 'practice') return;
    const target = this.undoStack.length > 4 ? this.undoStack[this.undoStack.length - 4] : this.undoStack[0];
    if (!target) return;
    this.state = deserialize(target);
    this.undoStack.length = Math.max(0, this.undoStack.length - 4);
    app.audio.event('ui');
    announce(t('undone'));
  }

  finish() {
    this.over = true;
    this.hashes.push({ tick: this.state.tick, hash: stateHash(this.state) });
    const breakdown = scoreBreakdown(this.state, this.level.par);
    this.result = {
      won: this.state.won,
      reason: terminalReason(this.state),
      breakdown,
      ticks: this.state.tick,
      durationMs: Date.now() - this.startedAt,
    };
    setState('resolving', 'terminal:' + this.result.reason);
    setTimeout(() => showResults(this), 600);
  }

  envelope() {
    return {
      schema: SCHEMA_VERSION,
      build: CONTENT_VERSION,
      levelId: this.level.id,
      seed: this.level.seed,
      initialHash: stateHash(createState(this.level)),
      startedOffset: this.startedAt,
      commands: this.commands,
      hashes: this.hashes,
      terminal: this.result,
    };
  }
}

// ---------------------------------------------------------------- input

// Held-direction state per source. Keyboard and touch keyups only clear their
// own source, so a released gamepad stick can never leave the climber running.
const keyHeld = { left: false, right: false };
const padHeld = { left: false, right: false };
const touchHeld = { left: false, right: false };
const inputState = {
  get left() { return keyHeld.left || padHeld.left || touchHeld.left; },
  get right() { return keyHeld.right || padHeld.right || touchHeld.right; },
};
// Keyboard actions (declared as control.* in starhermit.txt). Hosted players
// may override them on StarHermit; app.bindings holds the effective codes.
const DEFAULT_BINDINGS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['Space', 'ArrowUp', 'KeyW'],
  pause: ['Escape', 'KeyP'],
  retry: ['KeyR'],
  undo: ['KeyU'],
  camera: ['KeyC'],
};
let codeAction = {};
function setBindings(bindings) {
  app.bindings = bindings;
  codeAction = {};
  for (const [action, codes] of Object.entries(bindings)) for (const c of codes) codeAction[c] = action;
}
const KEY_GLYPHS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
function keyLabel(code) {
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}
function keysFor(action) { return (app.bindings[action] || []).map(keyLabel).join(' / '); }

function releaseHeldKeys() {
  keyHeld.left = keyHeld.right = false;
  padHeld.left = padHeld.right = false;
  for (const btn of document.querySelectorAll('[data-hold]')) {
    touchHeld[btn.dataset.hold] = false;
    btn.classList.remove('held');
  }
}

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // Never swallow browser/OS chords (Ctrl+R, Cmd+P, Alt+←, …).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    app.audio.ensure();
    const k = codeAction[e.code];
    if (k === 'left' || k === 'right') {
      // Only capture movement during play; menus keep arrow-key navigation.
      if (app.state !== 'active' && app.state !== 'countdown') return;
      keyHeld[k] = true;
      e.preventDefault();
      return;
    }
    if (k === 'jump') {
      if (app.session && app.state === 'active') {
        app.session.pendingJumpId++;
        e.preventDefault();
      }
      return;
    }
    if (k === 'pause') { onEscape(); e.preventDefault(); return; }
    if (k === 'retry' && app.session && (app.state === 'active' || app.state === 'paused' || app.state === 'results')) {
      retryLevel(); return;
    }
    if (k === 'undo' && app.session && app.state === 'active') app.session.undo();
    if (k === 'camera' && app.renderer && app.renderer.camBase) {
      app.renderer.camera.position.copy(app.renderer.camBase);
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = codeAction[e.code];
    if (k === 'left' || k === 'right') keyHeld[k] = false;
  });
  // A key held while focus leaves the window never sees its keyup.
  window.addEventListener('blur', releaseHeldKeys);

  // Touch controls (also pointer-usable).
  for (const btn of document.querySelectorAll('[data-hold]')) {
    const dir = btn.dataset.hold;
    const on = (e) => { e.preventDefault(); app.audio.ensure(); touchHeld[dir] = true; btn.classList.add('held'); btn.setPointerCapture && e.pointerId !== undefined && btn.setPointerCapture(e.pointerId); };
    const off = () => { touchHeld[dir] = false; btn.classList.remove('held'); };
    btn.addEventListener('pointerdown', on);
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('lostpointercapture', off);
  }
  const jumpBtn = document.querySelector('[data-jump]');
  jumpBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); app.audio.ensure();
    if (app.session && app.state === 'active') app.session.pendingJumpId++;
    jumpBtn.classList.add('held');
  });
  jumpBtn.addEventListener('pointerup', () => jumpBtn.classList.remove('held'));

  // Gamepad: polled in the frame loop.
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let left = false, right = false;
  for (const pad of pads) {
    if (!pad) continue;
    const ax = pad.axes[0] || 0;
    left = left || ax < -0.4 || !!(pad.buttons[14] && pad.buttons[14].pressed);
    right = right || ax > 0.4 || !!(pad.buttons[15] && pad.buttons[15].pressed);
    if (pad.buttons[0] && pad.buttons[0].pressed && !pollGamepad._jumpHeld) {
      if (app.session && app.state === 'active') app.session.pendingJumpId++;
      pollGamepad._jumpHeld = true;
    } else if (!(pad.buttons[0] && pad.buttons[0].pressed)) pollGamepad._jumpHeld = false;
    if (pad.buttons[9] && pad.buttons[9].pressed && !pollGamepad._startHeld) {
      onEscape();
      pollGamepad._startHeld = true;
    } else if (!(pad.buttons[9] && pad.buttons[9].pressed)) pollGamepad._startHeld = false;
  }
  padHeld.left = left;
  padHeld.right = right;
}

function onEscape() {
  if (app.state === 'active') { pauseGame(); return; }
  if (app.state === 'paused') { resumeGame(); return; }
  // On a menu/results screen, Escape takes the visible "← Back"/"Leave" route.
  if (!app.els.overlay || app.els.overlay.hidden) return;
  const back = app.els.overlay.querySelector('.btn.subtle');
  if (back) back.click();
}

// ---------------------------------------------------------------- game flow

// A pending countdown must never outlive its level: a retry or a leave during
// the count would otherwise flip the next screen to "active".
function clearCountdown() {
  if (app.countdownTimer !== null) { clearInterval(app.countdownTimer); app.countdownTimer = null; }
  if (app.countdownHide !== null) { clearTimeout(app.countdownHide); app.countdownHide = null; }
}

function startLevel(level, mode, opts) {
  clearCountdown();
  releaseHeldKeys();
  app.session = new Session(level, mode, opts);
  app.renderer.loadLevel(level, level.theme || 'brass');
  setState('preparing', 'level:' + level.id);
  showPlay();
  setState('countdown', 'auto');
  app.session.countdown = 3;
  app.els.countdown.hidden = false;
  announce(t('objectiveAnnounce', { detail: level.lesson ? lessonText(level).text : levelName(level) }), false);
  let n = 3;
  app.els.countdown.textContent = String(n);
  app.audio.event('countdown');
  app.countdownTimer = setInterval(() => {
    n--;
    if (n > 0) { app.els.countdown.textContent = String(n); app.audio.event('countdown'); }
    else {
      clearCountdown();
      app.els.countdown.textContent = t('go');
      app.audio.event('go');
      app.countdownHide = setTimeout(() => { app.els.countdown.hidden = true; }, 500);
      setState('active', 'countdown-done');
      app.platform.funnel('round-start', { level: level.id, mode });
    }
  }, 700);
}

function retryLevel() {
  if (!app.session) return;
  const { level, mode, opts } = app.session;
  app.platform.funnel('retry', { level: level.id });
  startLevel(level, mode, opts);
}

function pauseGame() {
  if (app.state !== 'active') return;
  releaseHeldKeys();
  setState('paused', 'user');
  app.audio.suspend();
  persistSnapshot();
  showPause();
}

function resumeGame() {
  setState('active', 'resume');
  app.audio.resume();
  hideOverlay();
}

function persistSnapshot() {
  if (!app.session || app.session.over) return;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      levelId: app.session.level.id, mode: app.session.mode,
      state: serialize(app.session.state), savedAt: Date.now(),
      // The input log travels with the snapshot, so a resumed ranked run can
      // still be validated by deterministic replay.
      commands: app.session.commands, hashes: app.session.hashes,
      startedAt: app.session.startedAt,
    }));
  } catch (e) { /* ignore */ }
}

function leaveToTitle() {
  persistSnapshot();
  clearCountdown();
  releaseHeldKeys();
  app.els.countdown.hidden = true;
  app.session = null;
  hideOverlay();
  app.els.hud.hidden = true;
  setState('title', 'leave');
  showTitle();
}

// ---------------------------------------------------------------- frame loop

let lastFrame = 0;
let gamepadClear = 0;

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastFrame) / 1000 || 0);
  lastFrame = t;
  const hidden = document.hidden;

  // Gamepad move state is additive; recompute keyboard+gamepad each 100ms.
  pollGamepad();
  if (t - gamepadClear > 100) { gamepadClear = t; }

  const s = app.session;
  if (s && app.state === 'active' && !hidden) {
    s.accumulator += dt * 1000;
    let steps = 0;
    while (s.accumulator >= TICK_MS && steps < 6) {
      s.tick();
      s.accumulator -= TICK_MS;
      steps++;
    }
    updateHud();
  }
  if (s) app.renderer.render(s.state, s.accumulator / TICK_MS, dt, hidden);
  else app.renderer.render(null, 0, dt, hidden);
}

// ---------------------------------------------------------------- HUD

function updateHud() {
  const s = app.session;
  if (!s) return;
  const st = s.state;
  const gears = st.gears.filter(Boolean).length;
  app.els.hudScore.textContent = String(scoreBreakdown(st, s.level.par).total);
  app.els.hudGears.textContent = gears + ' / ' + st.gears.length;
  app.els.hudDeaths.textContent = String(st.deaths);
  app.els.hudTime.textContent = (st.tick * TICK_MS / 1000).toFixed(1) + 's';
  if (st.moveLimit !== null) {
    app.els.hudLimit.textContent = t('movesLeft', { n: Math.max(0, st.moveLimit - st.moves) });
  } else if (st.timeLimit !== null) {
    app.els.hudLimit.textContent = t('timeLeft', { n: Math.max(0, ((st.timeLimit - st.tick) * TICK_MS / 1000)).toFixed(0) });
  } else {
    app.els.hudLimit.textContent = '';
  }
  app.els.boardDesc.textContent = app.renderer.describeState(st, s.level, t, levelName(s.level));
  app.els.hudSync.textContent = syncLabel();
}

// ---------------------------------------------------------------- screens

function hideOverlay() {
  app.rerender = null;
  app.els.overlay.hidden = true;
  app.els.overlay.innerHTML = '';
}

function showOverlay(node, focusSel) {
  app.els.overlay.innerHTML = '';
  app.els.overlay.appendChild(node);
  app.els.overlay.hidden = false;
  const focusable = node.querySelector(focusSel || 'button, [href], input, select, [tabindex]');
  // keep the screen's heading in view: focusing a button low in a tall,
  // scrolling screen (e.g. Help's Back) must not scroll the title away
  if (focusable) focusable.focus({ preventScroll: true });
  node.scrollTop = 0;
  app.els.overlay.scrollTop = 0;
}

function screenShell(titleText, desc) {
  const shell = el('section', { class: 'screen', 'aria-labelledby': 'screen-title' });
  shell.appendChild(el('h2', { id: 'screen-title', text: titleText }));
  if (desc) shell.appendChild(el('p', { class: 'screen-desc', text: desc }));
  return shell;
}

// ---- title

// Every overlay screen registers how to repaint itself, so a language change
// re-renders the visible screen in place (same screen, focus kept by position).
function view(render) { app.rerender = render; }

function relabelScreen() {
  if (!app.rerender || !app.els.overlay || app.els.overlay.hidden) return;
  const overlay = app.els.overlay;
  const focusables = () => [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]')];
  const idx = focusables().indexOf(document.activeElement);
  const scroll = overlay.scrollTop;
  const shellScroll = overlay.firstElementChild ? overlay.firstElementChild.scrollTop : 0;
  app.rerender();
  const f = idx >= 0 ? focusables()[idx] : null;
  if (f) f.focus({ preventScroll: true });
  overlay.scrollTop = scroll;
  if (overlay.firstElementChild) overlay.firstElementChild.scrollTop = shellScroll;
}

function showTitle() {
  setState('title', 'show');
  app.els.hud.hidden = true;
  const shell = screenShell('Trickstep Tower', t('titleDesc'));
  const daily = dailyLevel(new Date(app.platform.now()));
  const journeyDone = Object.keys(app.progress.stars).length;

  const play = el('button', { class: 'btn primary big', 'data-action': 'play', text: t('playBig'), onclick: () => { app.audio.ensure(); showModeSelect(); } });
  const row = el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', 'data-action': 'daily', text: t('dailyBtn', { key: daily.dailyKey }), onclick: () => { app.audio.ensure(); startLevel(daily, 'daily'); } }),
    el('button', { class: 'btn', 'data-action': 'journey', text: t('journeyBtn', { n: journeyDone }), onclick: () => { app.audio.ensure(); showJourney(); } }),
    el('button', { class: 'btn', 'data-action': 'settings', text: t('settings'), onclick: () => showSettings() }),
  ]);
  const row2 = el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', 'data-action': 'help', text: t('helpRules'), onclick: () => showHelp() }),
    el('button', { class: 'btn', 'data-action': 'profile', text: t('profile'), onclick: () => showProfile() }),
  ]);
  const ptr = pt;
  if (app.platform.canSignIn()) {
    row2.appendChild(el('button', { class: 'btn', id: 'btn-signin', text: ptr('signIn'), onclick: () => app.platform.signIn() }));
  }
  if (app.platform.hosted && app.platform.inviteLink()) {
    row2.appendChild(el('button', { class: 'btn', id: 'btn-invite', text: ptr('invite'), onclick: () => copyInvite(ptr) }));
  }
  shell.appendChild(play);
  shell.appendChild(row);
  shell.appendChild(row2);
  const snap = localStorage.getItem(SNAPSHOT_KEY);
  if (snap) {
    try {
      const parsed = JSON.parse(snap);
      const ago = Math.round((Date.now() - parsed.savedAt) / 60000);
      let lvName = parsed.levelId;
      try { lvName = levelName(levelById(parsed.levelId)); } catch (e) { /* keep the id */ }
      shell.appendChild(el('button', {
        class: 'btn subtle', 'data-action': 'resume-run',
        text: t('resumeRun', { level: lvName, ago: ago < 1 ? t('justNow') : t('minAgo', { n: ago }) }),
        onclick: () => resumeSnapshot(parsed),
      }));
    } catch (e) { localStorage.removeItem(SNAPSHOT_KEY); }
  }
  showOverlay(shell, '.btn.primary');
  view(showTitle);
}

async function copyInvite(ptr) {
  const link = app.platform.inviteLink();
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast(ptr('inviteCopied'));
  } catch (e) {
    toast(ptr('inviteFailed', { link }));
  }
}

function toast(text) {
  const t = app.els.toast;
  t.textContent = text;
  t.hidden = false;
  announce(text);
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function resumeSnapshot(parsed) {
  try {
    const level = levelById(parsed.levelId);
    const sess = new Session(level, parsed.mode, {});
    sess.state = deserialize(parsed.state);
    if (Array.isArray(parsed.commands)) sess.commands = parsed.commands;
    if (Array.isArray(parsed.hashes)) sess.hashes = parsed.hashes;
    if (parsed.startedAt) sess.startedAt = parsed.startedAt;
    app.session = sess;
    app.renderer.loadLevel(level, level.theme || 'brass');
    const awayMin = Math.round((Date.now() - parsed.savedAt) / 60000);
    showPlay();
    setState('active', 'snapshot-resume');
    announce(t('welcomeBack', {
      away: awayMin < 1 ? t('awayMoments') : t('awayMinutes', { n: awayMin }),
      score: scoreBreakdown(sess.state, level.par).total, deaths: sess.state.deaths,
    }), false);
  } catch (e) {
    localStorage.removeItem(SNAPSHOT_KEY);
    showTitle();
  }
}

function levelById(id) {
  if (id.startsWith('journey-')) return journeyStage(parseInt(id.slice(8), 10));
  if (id.startsWith('practice-')) {
    const base = journeyStage(parseInt(id.slice(9), 10));
    return { ...base, id };
  }
  if (id.startsWith('learn-')) return TUTORIALS.find(t => t.id === id);
  if (id.startsWith('daily-')) return dailyLevel(new Date(id.slice(6) + 'T00:00:00Z'));
  if (id.startsWith('chal-')) return challengeLevel(id);
  throw new Error('unknown level ' + id);
}

// ---- mode select

function modeCard(mode, name, desc, meta, onGo, recommended) {
  const card = el('div', { class: 'card' + (recommended ? ' recommended' : ''), 'data-mode': mode });
  card.appendChild(el('h3', { text: name }));
  card.appendChild(el('p', { class: 'card-desc', text: desc }));
  card.appendChild(el('p', { class: 'meta', text: meta }));
  card.appendChild(el('button', { class: 'btn primary', text: recommended ? t('playRecommended') : t('play'), onclick: onGo }));
  return card;
}

function showModeSelect() {
  setState('mode-select', 'user');
  const shell = screenShell(t('chooseMode'), t('chooseModeDesc'));
  const grid = el('div', { class: 'card-grid' });
  const daily = dailyLevel(new Date(app.platform.now()));
  const card = (mode, key, onGo, rec) => grid.appendChild(modeCard(mode, t(key), t(key + 'Desc'), t(key + 'Meta'), onGo, rec));
  card('learn', 'modeLearn', () => showLearn());
  card('journey', 'modeJourney', () => showJourney(), true);
  card('daily', 'modeDaily', () => startLevel(daily, 'daily'));
  card('practice', 'modePractice', () => showPractice());
  card('challenge', 'modeChallenge', () => showChallenges());
  card('scores', 'modeScores', () => showLeaderboards());
  shell.appendChild(grid);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showTitle }));
  showOverlay(shell);
  view(showModeSelect);
}

// ---- learn

function showLearn() {
  setState('mode-select', 'learn');
  const shell = screenShell(t('learnTitle'), t('learnDesc'));
  const list = el('div', { class: 'list' });
  for (const lesson of TUTORIALS) {
    const done = app.progress.stars[lesson.id] !== undefined;
    const item = el('button', { class: 'list-item', 'data-level': lesson.id, onclick: () => startLevel(lesson, 'learn') });
    item.appendChild(el('span', { text: (done ? '★ ' : '') + levelName(lesson) }));
    item.appendChild(el('small', { text: lessonText(lesson).text }));
    list.appendChild(item);
  }
  shell.appendChild(list);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showModeSelect }));
  showOverlay(shell);
  view(showLearn);
}

// ---- journey

function showJourney() {
  setState('mode-select', 'journey');
  const shell = screenShell(t('journeyTitle'), t('journeyDesc'));
  const grid = el('div', { class: 'stage-grid', role: 'list' });
  const maxUnlocked = computeMaxUnlocked();
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const lv = journeyStage(i);
    const best = app.progress.stars[i];
    const locked = i > maxUnlocked;
    const b = el('button', {
      class: 'stage-cell' + (lv.mastery ? ' mastery' : '') + (locked ? ' locked' : ''),
      role: 'listitem',
      'data-stage': String(i + 1),
      'aria-label': t('stageN', { n: i + 1 }) + (lv.mastery ? t('masteryTag') : '') + (best !== undefined ? t('bestTag', { n: best }) : '') + (locked ? t('lockedTag') : ''),
      disabled: locked ? 'disabled' : null,
      onclick: () => startLevel(lv, 'journey'),
    });
    b.innerHTML = '<b>' + (i + 1) + '</b>' + (best !== undefined ? '<span class="star">★</span>' : '');
    grid.appendChild(b);
  }
  shell.appendChild(grid);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showModeSelect }));
  showOverlay(shell);
  view(showJourney);
}

function computeMaxUnlocked() {
  let max = 0;
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    if (app.progress.stars[i] !== undefined) max = i + 1;
  }
  return Math.min(max, JOURNEY_COUNT - 1);
}

// ---- practice

function showPractice(keep) {
  setState('mode-select', 'practice');
  const shell = screenShell(t('practiceTitle'), t('practiceDesc'));
  const form = el('div', { class: 'form' });
  const sel = el('select', { id: 'practice-stage', 'aria-label': t('stage') });
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const o = el('option', { value: String(i), text: t('stageN', { n: i + 1 }) });
    sel.appendChild(o);
  }
  const diff = el('select', { id: 'practice-diff', 'aria-label': t('difficulty') }, [
    el('option', { value: 'relaxed', text: t('diffRelaxed') }),
    el('option', { value: 'standard', text: t('diffStandard'), selected: 'selected' }),
    el('option', { value: 'strict', text: t('diffStrict') }),
  ]);
  if (keep) { sel.value = keep.stage; diff.value = keep.diff; }
  form.appendChild(el('label', { text: t('stage') + ' ' }));
  form.lastChild.appendChild(sel);
  form.appendChild(el('label', { text: t('difficulty') + ' ' }));
  form.lastChild.appendChild(diff);
  shell.appendChild(form);
  shell.appendChild(el('button', {
    class: 'btn primary', 'data-action': 'start-practice', text: t('startPractice'),
    onclick: () => {
      const lv = journeyStage(parseInt(sel.value, 10));
      const d = diff.value;
      const level = { ...lv, id: 'practice-' + lv.index };
      if (d === 'strict') level.moveLimit = Math.round(lv.par.moves * 1.2);
      startLevel(level, 'practice', { difficulty: d });
    },
  }));
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showModeSelect }));
  showOverlay(shell);
  view(() => showPractice({ stage: sel.value, diff: diff.value }));
}

// ---- challenges

function showChallenges() {
  setState('mode-select', 'challenge');
  const shell = screenShell(t('challengesTitle'), t('challengesDesc'));
  const list = el('div', { class: 'list' });
  for (const c of CHALLENGES) {
    const txt = challengeText(c);
    const item = el('button', { class: 'list-item', 'data-level': c.id, onclick: () => startLevel(challengeLevel(c.id), 'challenge') });
    item.appendChild(el('span', { text: txt.name }));
    item.appendChild(el('small', { text: txt.desc + (c.moveLimit ? t('moveLimitTag', { n: c.moveLimit }) : '') + (c.timeLimit ? t('timeLimitTag', { n: c.timeLimit * TICK_MS / 1000 }) : '') }));
    list.appendChild(item);
  }
  shell.appendChild(list);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showModeSelect }));
  showOverlay(shell);
  view(showChallenges);
}

// ---- leaderboards (score chase)

const BOARD_KEYS = { daily: 'boardDaily', journey: 'boardJourney', challenge: 'boardChallenge' };

async function showLeaderboards(board) {
  setState('mode-select', 'scores');
  board = board || 'daily';
  const data = await app.platform.getScores(board);
  renderLeaderboards(board, data);
}

function renderLeaderboards(board, data) {
  const shell = screenShell(t('scoreChase'), app.platform.hosted ? t('lbHosted')
    : app.platform.online ? t('lbOnline') : t('lbOffline'));
  const tabs = el('div', { class: 'btn-row', role: 'tablist' });
  for (const b of ['daily', 'journey', 'challenge']) {
    tabs.appendChild(el('button', {
      class: 'btn' + (b === board ? ' primary' : ''), role: 'tab', 'aria-selected': b === board ? 'true' : 'false',
      'data-board': b, text: t(BOARD_KEYS[b]), onclick: () => showLeaderboards(b),
    }));
  }
  shell.appendChild(tabs);
  const list = el('ol', { class: 'scores' });
  const entries = (data.entries || []).slice(0, 20);
  if (!entries.length) list.appendChild(el('li', { text: t('noScores') }));
  for (const e of entries) {
    list.appendChild(el('li', {
      text: (playerName(e.name || 'Guest')) + ' — ' + e.score + (e.local ? t('localTag') : '') + (e.meta && e.meta.won === false ? t('incompleteTag') : ''),
    }));
  }
  shell.appendChild(list);
  if (data.validated) shell.appendChild(el('p', { class: 'meta', text: t('validated') }));
  if (data.casual) shell.appendChild(el('p', { class: 'meta', text: t('casual') }));
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showModeSelect }));
  showOverlay(shell);
  view(() => renderLeaderboards(board, data));
}

// ---- settings

// Built once per open/tab switch. A language change repaints only this
// game's own text and controls (tabs, General content, the own graphics box);
// the shared Language/Sound/FPS/Report sections that game-options.js mounts in
// the Graphics panel stay in place and relabel themselves.
function showSettings(returnTo, tab) {
  const shell = screenShell('', '');
  const back = () => (returnTo === 'pause' ? showPause() : showTitle());
  // Tabs: General (audio, palette, accessibility) and Graphics.
  const tabs = el('div', { class: 'settings-tabs', role: 'tablist' });
  const current = tab === 'graphics' ? 'graphics' : 'general';
  const tabBtns = {};
  for (const id of ['general', 'graphics']) {
    const b = el('button', {
      class: 'btn tab' + (id === current ? ' active' : ''), role: 'tab', id: 'settings-tab-' + id,
      'data-settings-tab': id, 'aria-selected': id === current ? 'true' : 'false',
      'aria-controls': 'settings-panel', tabindex: id === current ? '0' : '-1',
      onclick: () => { if (id !== current) { showSettings(returnTo, id); const tb = document.getElementById('settings-tab-' + id); if (tb) tb.focus(); } },
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const other = id === 'general' ? 'graphics' : 'general';
        showSettings(returnTo, other);
        const tb = document.getElementById('settings-tab-' + other);
        if (tb) tb.focus();
      }
    });
    tabBtns[id] = b;
    tabs.appendChild(b);
  }
  shell.appendChild(tabs);
  const wrap = el('div', { class: 'form', id: 'settings-panel', role: 'tabpanel', 'aria-labelledby': 'settings-tab-' + current });
  shell.appendChild(wrap);
  const backBtn = el('button', { class: 'btn subtle', onclick: back });
  shell.appendChild(backBtn);

  const own = current === 'graphics' ? el('div', { class: 'tt-gfx-own' }) : wrap;
  if (current === 'graphics') { wrap.classList.add('gfx-panel'); wrap.appendChild(own); }
  const paint = () => {
    shell.querySelector('#screen-title').textContent = t('settings');
    let desc = shell.querySelector('.screen-desc');
    if (!desc) { desc = el('p', { class: 'screen-desc' }); shell.insertBefore(desc, tabs); }
    desc.textContent = t('settingsDesc');
    tabs.setAttribute('aria-label', t('settingsSections'));
    tabBtns.general.textContent = gt('tabGeneral');
    tabBtns.graphics.textContent = gt('tabGraphics');
    backBtn.textContent = t('back');
    if (current === 'graphics') buildGraphicsPanel(own);
    else buildGeneralPanel(own);
  };
  paint();
  showOverlay(shell, current === 'graphics' ? '#settings-tab-graphics' : undefined);
  view(paint);
}

function buildGeneralPanel(wrap) {
  const s = app.settings;
  wrap.replaceChildren();
  wrap.appendChild(el('h3', { text: t('audio') }));
  for (const bus of BUS_NAMES) {
    const row = el('label', { class: 'slider-row' });
    const name = t('bus' + bus[0].toUpperCase() + bus.slice(1));
    row.appendChild(el('span', { text: name }));
    const input = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volumes[bus]), 'data-bus': bus, 'aria-label': t('busVolume', { bus: name }) });
    input.addEventListener('input', () => { app.audio.setVolume(bus, parseFloat(input.value)); saveSettings(); });
    row.appendChild(input);
    wrap.appendChild(row);
  }

  wrap.appendChild(el('h3', { text: t('display') }));
  const palSel = el('select', { 'data-setting': 'palette', 'aria-label': t('palette') });
  const PAL = { default: 'palDefault', deuteranopia: 'palDeuteranopia', protanopia: 'palProtanopia', tritanopia: 'palTritanopia', mono: 'palMono' };
  for (const p of Object.keys(PAL)) palSel.appendChild(el('option', { value: p, text: t(PAL[p]), selected: s.palette === p ? 'selected' : null }));
  palSel.addEventListener('change', () => { s.palette = palSel.value; applyA11yClasses(); saveSettings(); });
  wrap.appendChild(labeled(t('palette'), palSel));

  wrap.appendChild(el('h3', { text: t('a11y') }));
  for (const key of ['reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'haptics']) {
    const cb = el('input', { type: 'checkbox', 'data-setting': key, 'aria-label': t(key) });
    cb.checked = !!s[key];
    cb.addEventListener('change', () => { s[key] = cb.checked; applyA11yClasses(); saveSettings(); });
    wrap.appendChild(labeled(t(key), cb));
  }
  wrap.appendChild(el('button', { class: 'btn', 'data-action': 'replay-tutorials', text: t('replayTutorials'), onclick: () => showLearn() }));
}

// ---- graphics panel (inside Settings → Graphics)

function currentGfx() {
  return Object.assign(structuredClone(DEFAULT_GFX), app.settings.gfx || {});
}

function applyGfx(next) {
  app.settings.gfx = next;
  app.renderer.setGraphicsSettings(next);
  saveSettings();
}

function gfxRow(label, control, id) {
  const row = el('div', { class: 'gfx-row' });
  row.appendChild(el('label', { for: id, text: label }));
  row.appendChild(control);
  return row;
}

// Fills the game's own graphics box; rebuilt on change and on language change
// without touching the shared sections mounted next to it.
function buildGraphicsPanel(wrap) {
  const tr = gt;
  wrap.replaceChildren();
  const g = currentGfx();
  const info = app.renderer.graphicsInfo();
  const presetName = (p) => tr('preset_' + p);
  const rebuild = () => {
    const focusId = document.activeElement && document.activeElement.id;
    buildGraphicsPanel(wrap);
    const f = focusId && document.getElementById(focusId);
    if (f) f.focus();
  };
  wrap.appendChild(el('p', { class: 'meta', text: tr('intro') }));

  // Quality preset.
  const q = el('select', { id: 'gfx-preset', 'data-gfx': 'preset' });
  q.appendChild(el('option', { value: 'auto', text: tr('auto', { tier: presetName(info.detected) }), selected: PRESETS.includes(g.preset) ? null : 'selected' }));
  for (const p of PRESETS) q.appendChild(el('option', { value: p, text: presetName(p), selected: g.preset === p ? 'selected' : null }));
  q.addEventListener('change', () => { applyGfx(choosePreset(currentGfx(), q.value)); rebuild(); });
  wrap.appendChild(gfxRow(tr('quality'), q, 'gfx-preset'));

  // Render scale 50–200 %.
  const pct = Math.round((Number(g.render_scale) || 1) * 100);
  const scaleOut = el('output', { id: 'gfx-scale-value', for: 'gfx-scale', text: pct + '%' });
  const scale = el('input', { type: 'range', id: 'gfx-scale', 'data-gfx': 'render_scale', min: '50', max: '200', step: '5', value: String(pct) });
  scale.addEventListener('input', () => { scaleOut.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => {
    applyGfx(Object.assign(currentGfx(), { render_scale: Number(scale.value) / 100 }));
    refreshGfxSummary();
  });
  const scaleBox = el('span', { class: 'gfx-scale' }, [scale, scaleOut]);
  wrap.appendChild(gfxRow(tr('renderScale'), scaleBox, 'gfx-scale'));

  // One select per category; "" = follow the preset.
  const resolvedPreset = info.resolved.preset;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = el('select', { id: 'gfx-' + cat, 'data-gfx': cat });
    const ov = g.overrides && g.overrides[cat];
    sel.appendChild(el('option', { value: '', text: tr('fromPreset', { tier: tr('tier_' + presetTier(resolvedPreset, cat)) }), selected: ov ? null : 'selected' }));
    for (const t of tiers) sel.appendChild(el('option', { value: t, text: tr('tier_' + t), selected: ov === t ? 'selected' : null }));
    sel.addEventListener('change', () => { applyGfx(setOverride(currentGfx(), cat, sel.value)); refreshGfxSummary(); });
    wrap.appendChild(gfxRow(tr('cat_' + cat), sel, 'gfx-' + cat));
  }

  for (const [key, id, label, on] of [['adaptive', 'gfx-adaptive', tr('adaptive'), g.adaptive !== false], ['show_fps', 'gfx-fps', tr('showFps'), !!g.show_fps]]) {
    const cb = el('input', { type: 'checkbox', id, 'data-gfx': key });
    cb.checked = on;
    cb.addEventListener('change', () => { applyGfx(Object.assign(currentGfx(), { [key]: cb.checked })); refreshGfxSummary(); });
    wrap.appendChild(gfxRow(label, cb, id));
  }

  wrap.appendChild(el('p', { class: 'meta gfx-summary', id: 'gfx-summary', 'aria-live': 'polite' }));
  wrap.appendChild(el('p', { class: 'meta gfx-note', id: 'gfx-post-note', hidden: 'hidden', text: tr('postUnavailable') }));
  refreshGfxSummary();
}

// The canvas size/post chain update on the next frame, so read back after it.
const GFX_WORD_KEYS = ['noShadows', 'shadows', 'fullAo', 'ao', 'bloom', 'grade', 'noAa', 'denseParticles', 'unknownGpu'];
function gfxWords() {
  const w = {};
  for (const k of GFX_WORD_KEYS) w[k] = t('gfx' + k[0].toUpperCase() + k.slice(1));
  return w;
}

function refreshGfxSummary() {
  const write = () => {
    const out = document.getElementById('gfx-summary');
    if (!out || !app.renderer) return;
    const info = app.renderer.graphicsInfo(gfxWords());
    out.textContent = info.gpu + ' · ' + info.summary;
    out.dataset.preset = info.resolved.preset;
    const note = document.getElementById('gfx-post-note');
    if (note) note.hidden = !info.postFailed;
  };
  write();
  requestAnimationFrame(() => requestAnimationFrame(write));
}

function labeled(text, control) {
  const l = el('label', { class: 'field' });
  l.appendChild(el('span', { text }));
  l.appendChild(control);
  return l;
}

// Player preferences mirrored to the StarHermit settings KV when signed in.
const PREF_KEYS = ['volumes', 'gfx', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'haptics', 'palette', 'camera', 'tutorialsSeen'];
let prefsTimer = null;
function pushPrefs() {
  if (!app.platform.hosted) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const out = {};
    for (const k of PREF_KEYS) out[k] = app.settings[k];
    app.platform.patchSettings(out);
  }, 600);
}
function applyRemotePrefs(remote) {
  if (!remote || typeof remote !== 'object') return;
  for (const k of PREF_KEYS) {
    if (remote[k] === undefined || remote[k] === null) continue;
    const v = remote[k];
    if (typeof DEFAULT_SETTINGS[k] === 'object') {
      if (typeof v === 'object' && !Array.isArray(v)) app.settings[k] = Object.assign(structuredClone(DEFAULT_SETTINGS[k]), v);
    } else if (typeof v === typeof DEFAULT_SETTINGS[k]) {
      app.settings[k] = v;
    }
  }
  store(SETTINGS_KEY, app.settings);
}

function saveSettings() {
  store(SETTINGS_KEY, app.settings);
  applyA11yClasses();
  pushPrefs();
  app.platform.funnel('settings-change', {});
}

function applyA11yClasses() {
  const b = document.body;
  const s = app.settings;
  b.classList.toggle('reduced-motion', !!s.reducedMotion);
  b.classList.toggle('high-contrast', !!s.highContrast);
  b.classList.toggle('large-text', !!s.largeText);
  b.classList.toggle('left-handed', !!s.leftHanded);
  b.dataset.palette = s.palette;
}

// ---- profile

function showProfile(draft) {
  const hosted = app.platform.hosted;
  const shell = screenShell(t('profile'), hosted
    ? t('signedInAs', { name: playerName(app.platform.playerName) })
    : app.platform.online ? t('connectedHost') : t('guestMode'));
  let nameInput = null;
  if (hosted) {
    // The name comes from the StarHermit profile; there is nothing to edit.
    shell.appendChild(el('p', { class: 'meta', text: t('nameFromProfile') }));
  } else {
    const stored = app.platform.playerName === 'Guest' ? '' : app.platform.playerName;
    nameInput = el('input', { type: 'text', value: draft != null ? draft : stored, placeholder: t('guest'), maxlength: '24', 'aria-label': t('displayName') });
    shell.appendChild(labeled(t('displayName'), nameInput));
    shell.appendChild(el('button', {
      class: 'btn', 'data-action': 'save-name', text: t('saveName'),
      onclick: () => {
        app.platform.playerName = nameInput.value.trim() || 'Guest';
        localStorage.setItem('tt-name', app.platform.playerName);
        announce(t('nameSaved'));
        showTitle();
      },
    }));
  }
  shell.appendChild(el('p', { class: 'meta', text: syncLabel() }));
  const p = app.progress;
  shell.appendChild(el('p', { text: t('statsLine', { n: Object.keys(p.stars).length, clears: p.clears, streak: p.streak.count }) }));
  const ach = el('ul', { class: 'achievements' });
  for (const a of ACHIEVEMENTS) {
    const got = p.achievements[a.key];
    ach.appendChild(el('li', { text: (got ? '★ ' : '☆ ') + t(a.name) + ' — ' + t(a.name + 'Desc') + (got ? ' (' + got.slice(0, 10) + ')' : ''), class: got ? 'got' : '' }));
  }
  shell.appendChild(el('h3', { text: t('achievements') }));
  shell.appendChild(ach);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showTitle }));
  showOverlay(shell);
  view(() => showProfile(nameInput ? nameInput.value : undefined));
}

// ---- help

function showHelp() {
  const shell = screenShell(t('helpRules'), t('helpDesc'));
  const cards = el('div', { class: 'card-grid' });
  const keys = { left: keysFor('left'), right: keysFor('right'), jump: keysFor('jump'), pause: keysFor('pause'), retry: keysFor('retry'), camera: keysFor('camera'), undo: keysFor('undo') };
  for (const k of ['Goal', 'Move', 'Jump', 'Trick', 'Vanish', 'Hazards', 'Gears', 'Score', 'Pause']) {
    const c = el('div', { class: 'card' });
    c.appendChild(el('h3', { text: t('rule' + k) }));
    c.appendChild(el('p', { text: t('rule' + k + 'Text', keys) }));
    cards.appendChild(c);
  }
  shell.appendChild(cards);
  shell.appendChild(el('button', { class: 'btn subtle', text: t('back'), onclick: showTitle }));
  showOverlay(shell);
  view(showHelp);
}

// ---- play (HUD only; overlay hidden)

function showPlay() {
  hideOverlay();
  app.els.hud.hidden = false;
  app.els.undoBtn.hidden = app.session.mode !== 'practice';
  relabelHud();
}

// Static HUD/touch labels plus the per-level objective, in the current language.
function relabelHud() {
  const E = app.els;
  if (!E.hud) return;
  for (const n of document.querySelectorAll('#app [data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('#app [data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  const level = app.session && app.session.level;
  E.hudObjective.textContent = level ? t('hudObjective', { name: levelName(level) }) : '';
  E.hudLesson.textContent = level && level.lesson ? lessonText(level).text : '';
  if (app.session) updateHud();
}

// ---- pause

function showPause() {
  const shell = screenShell(t('paused'), app.session ? levelName(app.session.level) : '');
  shell.appendChild(el('button', { class: 'btn primary big', 'data-action': 'resume', text: t('resume'), onclick: resumeGame }));
  shell.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', 'data-action': 'retry', text: t('retryR'), onclick: retryLevel }),
    el('button', { class: 'btn', 'data-action': 'settings', text: t('settings'), onclick: () => showSettings('pause') }),
    el('button', { class: 'btn', 'data-action': 'help', text: t('help'), onclick: showHelp }),
  ]));
  shell.appendChild(el('button', { class: 'btn subtle', 'data-action': 'leave', text: t('leaveLevel'), onclick: leaveToTitle }));
  showOverlay(shell, '.btn.primary');
  view(showPause);
}

// ---- results

const REASON_KEYS = { exit: 'reasonExit', 'move-limit': 'reasonMoveLimit', 'time-limit': 'reasonTimeLimit' };

// Results: progression and score submission run once; the screen itself is
// painted from sess.view so a language change can repaint it in place.
function showResults(sess) {
  setState('results', sess.result.reason);
  const r = sess.result;
  const b = r.breakdown;
  announce(t(r.won ? 'announceWon' : 'announceLost', { n: b.total }), true);
  const newly = updateProgress(sess);
  for (let i = 0; i < newly.length; i++) app.audio.event('achievement');
  sess.view = { newly, lb: null };
  if (sess.ranked && r.won) {
    const hosted = app.platform.hosted;
    sess.view.lb = hosted ? { key: 'lbPosting', platform: true } : { key: 'savedLocalCasual' };
    const pending = app.platform.submitScore(
      sess.mode, sess.level.id, b, sess.envelope(),
      { won: r.won, assists: sess.mode === 'practice', version: CONTENT_VERSION, seed: sess.level.seed, durationMs: r.durationMs }
    );
    // Hosted: the StarHermit high-score board; replace the pending line in place.
    if (hosted) {
      pending.then((res) => {
        sess.view.lb = !res.posted ? { key: 'lbNotPosted', platform: true }
          : res.rank ? { key: 'lbRank', vars: { rank: res.rank }, platform: true } : { key: 'lbPosted', platform: true };
        const line = sess.view.lbEl;
        if (line && line.isConnected) line.textContent = lbText(sess.view.lb);
      });
    }
  } else if (!sess.ranked) {
    sess.view.lb = { key: 'unrankedNoSubmit' };
  }
  app.platform.funnel('round-end', { level: sess.level.id, won: r.won, score: b.total });
  renderResults(sess);
  localStorage.removeItem(SNAPSHOT_KEY);
}

function lbText(lb) { return lb.platform ? pt(lb.key, lb.vars) : t(lb.key, lb.vars); }

function renderResults(sess) {
  const r = sess.result;
  const b = r.breakdown;
  const shell = screenShell(t(r.won ? 'floorCleared' : 'attemptOver'), levelName(sess.level));
  const table = el('table', { class: 'breakdown' });
  const rows = [
    [t('rowCompletion'), b.completion], [t('rowGears', { n: b.gearCount }), b.gears],
    [t('rowTime'), b.timeBonus], [t('rowMove'), b.moveBonus],
    [t('rowDeath'), -b.deathPenalty], [t('rowInvalid'), -b.invalidPenalty],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: k }));
    tr.appendChild(el('td', { text: String(v), class: v < 0 ? 'neg' : '' }));
    table.appendChild(tr);
  }
  const total = el('tr', { class: 'total' });
  total.appendChild(el('td', { text: t('total') }));
  total.appendChild(el('td', { text: String(b.total) }));
  table.appendChild(total);
  shell.appendChild(table);
  shell.appendChild(el('p', { class: 'meta', text: t('resultMeta', {
    reason: REASON_KEYS[r.reason] ? t(REASON_KEYS[r.reason]) : r.reason,
    time: (r.ticks * TICK_MS / 1000).toFixed(1), deaths: sess.state.deaths,
  }) }));
  for (const key of sess.view.newly) {
    const a = ACHIEVEMENTS.find(x => x.key === key);
    shell.appendChild(el('p', { class: 'achievement-pop', text: t('achievementUnlocked', { name: t(a.name) }) }));
  }
  const lb = sess.view.lb;
  if (lb) {
    const line = el('p', { class: 'meta' + (sess.ranked ? ' lb-line' : ''), text: lbText(lb) });
    if (sess.ranked) { line.setAttribute('aria-live', 'polite'); sess.view.lbEl = line; }
    shell.appendChild(line);
  }

  // Next actions
  const row = el('div', { class: 'btn-row' });
  row.appendChild(el('button', { class: 'btn primary', 'data-action': r.won ? 'next' : 'retry', text: r.won ? t('next') : t('retryR'), onclick: () => nextAction(sess) }));
  row.appendChild(el('button', { class: 'btn', 'data-action': 'replay', text: t('replayLevel'), onclick: retryLevel }));
  row.appendChild(el('button', { class: 'btn', 'data-action': 'scores', text: t('scores'), onclick: () => showLeaderboards(sess.mode === 'learn' || sess.mode === 'practice' ? 'journey' : sess.mode) }));
  shell.appendChild(row);
  shell.appendChild(el('button', { class: 'btn subtle', 'data-action': 'leave', text: t('leave'), onclick: leaveToTitle }));
  showOverlay(shell, '.btn.primary');
  view(() => renderResults(sess));
}

function nextAction(sess) {
  if (sess.mode === 'journey' && sess.result.won) {
    const next = sess.level.index + 1;
    if (next < JOURNEY_COUNT) return startLevel(journeyStage(next), 'journey');
    return showJourney();
  }
  if (sess.mode === 'learn' && sess.result.won) {
    const idx = TUTORIALS.findIndex(t => t.id === sess.level.id);
    if (idx >= 0 && idx + 1 < TUTORIALS.length) return startLevel(TUTORIALS[idx + 1], 'learn');
    return showLearn();
  }
  retryLevel();
}

function updateProgress(sess) {
  const p = app.progress;
  const newly = [];
  const unlock = (key) => {
    if (!p.achievements[key]) {
      p.achievements[key] = new Date().toISOString();
      newly.push(key);
      app.platform.unlockAchievement(key);
    }
  };
  if (sess.result.won) {
    p.clears++;
    unlock('first-clear');
    if (p.clears >= 100) unlock('centurion');
    if (sess.mode === 'journey') {
      const prev = p.stars[sess.level.index];
      const score = sess.result.breakdown.total;
      if (prev === undefined || score > prev) p.stars[sess.level.index] = score;
      if (sess.state.gears.length > 0 && sess.state.gears.every(Boolean)) unlock('gear-master');
      if (sess.level.index === JOURNEY_COUNT - 1) unlock('tower-top');
    }
    if (sess.mode === 'learn') p.stars[sess.level.id] = sess.result.breakdown.total;
    if (sess.mode === 'daily') {
      const key = sess.level.dailyKey;
      const prev = p.bestDaily[key];
      if (prev === undefined || sess.result.breakdown.total > prev) p.bestDaily[key] = sess.result.breakdown.total;
      const today = key;
      const yesterday = new Date(new Date(key + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
      if (p.streak.lastDay === today) { /* already counted */ }
      else if (p.streak.lastDay === yesterday) { p.streak.count++; p.streak.lastDay = today; }
      else { p.streak.count = 1; p.streak.lastDay = today; }
      if (p.streak.count >= 3) unlock('streak-3');
    }
  }
  store(PROGRESS_KEY, p);
  app.platform.saveCloud({ progress: p, savedAt: Date.now() });
  return newly;
}

// ---------------------------------------------------------------- boot

function buildShell() {
  const appRoot = document.getElementById('app');
  appRoot.innerHTML = '';

  const canvas = el('canvas', { id: 'game-canvas', 'aria-hidden': 'true' });
  const hud = el('div', { id: 'hud', hidden: 'hidden' });
  hud.innerHTML =
    '<div class="hud-top">' +
    '  <div class="hud-group"><span id="hud-objective"></span><span id="hud-lesson"></span></div>' +
    '  <div class="hud-group stats">' +
    '    <span><span data-i18n="hudScore"></span> <b id="hud-score">0</b></span>' +
    '    <span><span data-i18n="hudGears"></span> <b id="hud-gears">0 / 0</b></span>' +
    '    <span><span data-i18n="hudDeaths"></span> <b id="hud-deaths">0</b></span>' +
    '    <span><span data-i18n="hudTime"></span> <b id="hud-time">0.0s</b></span>' +
    '    <span id="hud-limit"></span>' +
    '  </div>' +
    '  <div class="hud-group"><span id="hud-sync" class="sync-status"></span>' +
    '  <button id="btn-pause" class="btn small" data-i18n="pauseBtn"></button>' +
    '  <button id="btn-undo" class="btn small" data-i18n="undoBtn" hidden></button></div>' +
    '</div>';
  const overlay = el('div', { id: 'overlay', role: 'dialog', 'aria-modal': 'false' });
  const countdown = el('div', { id: 'countdown', hidden: 'hidden', 'aria-hidden': 'true' });
  const touch = el('div', { id: 'touch-controls' });
  touch.innerHTML =
    '<div class="pad move-pad">' +
    '  <button class="touch-btn" data-hold="left" data-i18n-aria="moveLeft">◀</button>' +
    '  <button class="touch-btn" data-hold="right" data-i18n-aria="moveRight">▶</button>' +
    '</div>' +
    '<div class="pad jump-pad"><button class="touch-btn jump" data-jump data-i18n-aria="jump" data-i18n="jumpPad"></button></div>';
  const live = el('div', { id: 'live', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  const liveAssert = el('div', { id: 'live-assert', class: 'visually-hidden', role: 'alert', 'aria-live': 'assertive' });
  const boardDesc = el('div', { id: 'board-desc', class: 'visually-hidden', 'data-i18n-aria': 'boardState' });
  const captions = el('div', { id: 'captions', 'aria-hidden': 'true' });
  const toastEl = el('div', { id: 'toast', class: 'toast', hidden: 'hidden', 'aria-hidden': 'true' });

  appRoot.appendChild(canvas);
  appRoot.appendChild(hud);
  appRoot.appendChild(overlay);
  appRoot.appendChild(countdown);
  appRoot.appendChild(touch);
  appRoot.appendChild(live);
  appRoot.appendChild(liveAssert);
  appRoot.appendChild(boardDesc);
  appRoot.appendChild(captions);
  appRoot.appendChild(toastEl);

  app.els = {
    canvas, hud, overlay, countdown, touch, live, liveAssert, boardDesc, captions, toast: toastEl,
    hudObjective: hud.querySelector('#hud-objective'),
    hudLesson: hud.querySelector('#hud-lesson'),
    hudScore: hud.querySelector('#hud-score'),
    hudGears: hud.querySelector('#hud-gears'),
    hudDeaths: hud.querySelector('#hud-deaths'),
    hudTime: hud.querySelector('#hud-time'),
    hudLimit: hud.querySelector('#hud-limit'),
    hudSync: hud.querySelector('#hud-sync'),
    undoBtn: hud.querySelector('#btn-undo'),
  };
  hud.querySelector('#btn-pause').addEventListener('click', () => (app.state === 'paused' ? resumeGame() : pauseGame()));
  app.els.undoBtn.addEventListener('click', () => app.session && app.session.undo());
  relabelHud();
}

// Language change: relabel the shell/HUD and repaint the visible screen.
function relabelAll() {
  const root = document.getElementById('app');
  if (root) root.setAttribute('aria-label', t('gameLabel'));
  relabelHud();
  relabelScreen();
}

function onResize() {
  const canvas = app.els.canvas;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  app.renderer.resize(w, h);
}

async function boot() {
  setState('boot', 'init');
  buildShell();
  applyA11yClasses();
  app.audio = new AudioEngine(app.settings);
  app.audio.captionSink = (text, name) => {
    const key = name ? 'cap' + name[0].toUpperCase() + name.slice(1) : '';
    app.els.captions.textContent = '♪ ' + (key && t(key) !== key ? t(key) : text);
    clearTimeout(app.audio._capTimer);
    app.audio._capTimer = setTimeout(() => { app.els.captions.textContent = ''; }, 1800);
  };
  try {
    app.renderer = new Renderer(app.els.canvas, app.settings);
  } catch (e) {
    const root = document.getElementById('app');
    const compat = el('main', { class: 'compat' }, [el('h1', { text: 'Trickstep Tower' }), el('p', { text: t('compatText') })]);
    root.replaceChildren(compat);
    onLanguage(() => { compat.lastChild.textContent = t('compatText'); });
    return;
  }
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 100));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.state === 'active') pauseGame();
  });
  window.addEventListener('beforeunload', persistSnapshot);
  setBindings(DEFAULT_BINDINGS);
  bindInput();
  await app.platform.init();
  if (app.platform.hosted) {
    setBindings(await app.platform.loadBindings(DEFAULT_BINDINGS));
    applyRemotePrefs(await app.platform.getSettings());
    applyA11yClasses();
    for (const bus of BUS_NAMES) app.audio.setVolume(bus, app.settings.volumes[bus]);
    app.renderer.setGraphicsSettings(currentGfx());
  }
  app.platform.onAuthChange = () => {
    toast(pt('signedOut'));
    if (app.state === 'title') showTitle();
  };
  // Cloud load: merge the platform slot with the local cache (best scores,
  // earliest unlocks, longest streak) before the first screen renders, and
  // write the union back when it adds anything the cloud lacked.
  if (app.platform.cloudDoc && app.platform.cloudDoc.progress && typeof app.platform.cloudDoc.progress === 'object') {
    const merged = Object.assign(structuredClone(DEFAULT_PROGRESS), mergeProgress(app.progress, app.platform.cloudDoc.progress));
    const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
    const cloudBehind = canon(mergeProgress(app.platform.cloudDoc.progress, {})) !== canon(mergeProgress(merged, {}));
    app.progress = merged;
    store(PROGRESS_KEY, app.progress);
    if (cloudBehind) app.platform.saveCloud({ progress: app.progress, savedAt: Date.now() });
  }
  // A write rejected because another device saved first: merge both sides
  // and save again (the SDK re-reads the slot so the retry is conditional on
  // the fresh version).
  app.platform.onSaveConflict = (remote) => {
    const theirs = remote && remote.progress && typeof remote.progress === 'object' ? remote.progress : {};
    app.progress = Object.assign(structuredClone(DEFAULT_PROGRESS), mergeProgress(app.progress, theirs));
    store(PROGRESS_KEY, app.progress);
    app.platform.saveCloud({ progress: app.progress, savedAt: Date.now() });
    toast(t('progressMerged'));
    relabelScreen();
  };
  onLanguage(relabelAll);
  relabelAll();
  // Idle scene behind the title screen.
  app.renderer.loadLevel(journeyStage(0), THEMES[0].id);
  requestAnimationFrame(frame);
  setState('profile-ready', 'guest:' + app.platform.playerName);
  showTitle();
  app.platform.funnel('start', { online: app.platform.online });
}

if (typeof window !== 'undefined') {
  window.__tt = app; // debug/test hook
  window.addEventListener('DOMContentLoaded', boot);
}

export { boot, app, Session, setState };
