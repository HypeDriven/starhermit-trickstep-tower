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
import { Renderer, QUALITY_TIERS } from './src/client/render.js';
import { AudioEngine, BUS_NAMES } from './src/client/audio.js';
import { Platform } from './src/client/platform.js';

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
  graphics: 'med',
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

const ACHIEVEMENTS = [
  { key: 'first-clear', name: 'First Wind', desc: 'Complete your first level.' },
  { key: 'gear-master', name: 'Gear Collector', desc: 'Collect every gear in a journey stage.' },
  { key: 'streak-3', name: 'Wound Up Tight', desc: 'Complete the daily challenge 3 days in a row.' },
  { key: 'tower-top', name: 'Top of the Tower', desc: 'Clear journey stage 40.' },
  { key: 'centurion', name: 'Hundred Winds', desc: 'Complete 100 levels in total.' },
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
};
app.platform.playerName = app.settings.name || localStorage.getItem('tt-name') || 'Guest';

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

function announce(text, assertive) {
  if (text === app.lastAnnounce) return;
  app.lastAnnounce = text;
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
      announce('That action is not possible right now.', true);
    }
    for (const ev of events) this.onEvent(ev);
    if (!wasAirborne === false && s.player.onGround && !wasAirborne) { /* landed */ }
    if (wasAirborne && s.player.onGround) app.audio.event('land');
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
        announce('Trap! ' + (ev.why === 'spikes' ? 'Spikes.' : 'You fell.') + ' Retry from the last checkpoint.', true);
        break;
      case 'gear': app.audio.event('gear'); haptic(20); r.burst(wx, wy, '#ffd777', 14, 3); break;
      case 'checkpoint': app.audio.event('checkpoint'); announce('Checkpoint reached.'); break;
      case 'spring': app.audio.event('spring'); r.kickShake(0.2); break;
      case 'reveal': app.audio.event('reveal'); announce('A trick step shimmered — remember it.', false); break;
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
    announce('Undone — stepped back two seconds.');
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

const inputState = { left: false, right: false };
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    app.audio.ensure();
    const k = e.code;
    if (KEYMAP[k]) { inputState[KEYMAP[k]] = true; e.preventDefault(); return; }
    if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW') {
      if (app.session && app.state === 'active') {
        app.session.pendingJumpId++;
        e.preventDefault();
      }
      return;
    }
    if (k === 'Escape' || k === 'KeyP') { onEscape(); e.preventDefault(); return; }
    if (k === 'KeyR' && app.session && (app.state === 'active' || app.state === 'paused' || app.state === 'results')) {
      retryLevel(); return;
    }
    if (k === 'KeyU' && app.session && app.state === 'active') app.session.undo();
    if (k === 'KeyC' && app.renderer && app.renderer.camBase) {
      app.renderer.camera.position.copy(app.renderer.camBase);
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (k) inputState[k] = false;
  });

  // Touch controls (also pointer-usable).
  for (const btn of document.querySelectorAll('[data-hold]')) {
    const dir = btn.dataset.hold;
    const on = (e) => { e.preventDefault(); app.audio.ensure(); inputState[dir] = true; btn.classList.add('held'); btn.setPointerCapture && e.pointerId !== undefined && btn.setPointerCapture(e.pointerId); };
    const off = () => { inputState[dir] = false; btn.classList.remove('held'); };
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
  for (const pad of pads) {
    if (!pad) continue;
    const ax = pad.axes[0] || 0;
    inputState.left = inputState.left || ax < -0.4 || (pad.buttons[14] && pad.buttons[14].pressed);
    inputState.right = inputState.right || ax > 0.4 || (pad.buttons[15] && pad.buttons[15].pressed);
    if (pad.buttons[0] && pad.buttons[0].pressed && !pollGamepad._jumpHeld) {
      if (app.session && app.state === 'active') app.session.pendingJumpId++;
      pollGamepad._jumpHeld = true;
    } else if (!(pad.buttons[0] && pad.buttons[0].pressed)) pollGamepad._jumpHeld = false;
    if (pad.buttons[9] && pad.buttons[9].pressed && !pollGamepad._startHeld) {
      onEscape();
      pollGamepad._startHeld = true;
    } else if (!(pad.buttons[9] && pad.buttons[9].pressed)) pollGamepad._startHeld = false;
  }
}

function onEscape() {
  if (app.state === 'active') pauseGame();
  else if (app.state === 'paused') resumeGame();
}

// ---------------------------------------------------------------- game flow

function startLevel(level, mode, opts) {
  app.session = new Session(level, mode, opts);
  app.renderer.loadLevel(level, level.theme || 'brass');
  setState('preparing', 'level:' + level.id);
  showPlay();
  setState('countdown', 'auto');
  app.session.countdown = 3;
  app.els.countdown.hidden = false;
  announce('Objective: reach the exit door. ' + (level.lesson || level.name), false);
  let n = 3;
  app.els.countdown.textContent = String(n);
  app.audio.event('countdown');
  const timer = setInterval(() => {
    n--;
    if (n > 0) { app.els.countdown.textContent = String(n); app.audio.event('countdown'); }
    else {
      clearInterval(timer);
      app.els.countdown.textContent = 'GO';
      app.audio.event('go');
      setTimeout(() => { app.els.countdown.hidden = true; }, 500);
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
    }));
  } catch (e) { /* ignore */ }
}

function leaveToTitle() {
  persistSnapshot();
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
    app.els.hudLimit.textContent = 'Moves left: ' + Math.max(0, st.moveLimit - st.moves);
  } else if (st.timeLimit !== null) {
    app.els.hudLimit.textContent = 'Time left: ' + Math.max(0, ((st.timeLimit - st.tick) * TICK_MS / 1000)).toFixed(0) + 's';
  } else {
    app.els.hudLimit.textContent = '';
  }
  app.els.boardDesc.textContent = app.renderer.describeState(st, s.level);
}

// ---------------------------------------------------------------- screens

function hideOverlay() {
  app.els.overlay.hidden = true;
  app.els.overlay.innerHTML = '';
}

function showOverlay(node, focusSel) {
  app.els.overlay.innerHTML = '';
  app.els.overlay.appendChild(node);
  app.els.overlay.hidden = false;
  const focusable = node.querySelector(focusSel || 'button, [href], input, select, [tabindex]');
  if (focusable) focusable.focus();
}

function screenShell(titleText, desc) {
  const shell = el('section', { class: 'screen', 'aria-labelledby': 'screen-title' });
  shell.appendChild(el('h2', { id: 'screen-title', text: titleText }));
  if (desc) shell.appendChild(el('p', { class: 'screen-desc', text: desc }));
  return shell;
}

// ---- title

function showTitle() {
  setState('title', 'show');
  app.els.hud.hidden = true;
  const shell = screenShell('Trickstep Tower', 'A clockwork tower of trick steps. Reach each exit; learn every trap.');
  const daily = dailyLevel(new Date(app.platform.now()));
  const journeyDone = Object.keys(app.progress.stars).length;

  const play = el('button', { class: 'btn primary big', text: '▶ Play', onclick: () => { app.audio.ensure(); showModeSelect(); } });
  const row = el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', text: 'Daily — ' + daily.dailyKey, onclick: () => { app.audio.ensure(); startLevel(daily, 'daily'); } }),
    el('button', { class: 'btn', text: 'Journey (' + journeyDone + '/40)', onclick: () => { app.audio.ensure(); showJourney(); } }),
    el('button', { class: 'btn', text: 'Settings', onclick: () => showSettings() }),
  ]);
  const row2 = el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', text: 'Help & Rules', onclick: () => showHelp() }),
    el('button', { class: 'btn', text: 'Profile', onclick: () => showProfile() }),
  ]);
  shell.appendChild(play);
  shell.appendChild(row);
  shell.appendChild(row2);
  const snap = localStorage.getItem(SNAPSHOT_KEY);
  if (snap) {
    try {
      const parsed = JSON.parse(snap);
      const ago = Math.round((Date.now() - parsed.savedAt) / 60000);
      shell.appendChild(el('button', {
        class: 'btn subtle',
        text: 'Resume paused run (' + parsed.levelId + ', saved ' + (ago < 1 ? 'just now' : ago + ' min ago') + ')',
        onclick: () => resumeSnapshot(parsed),
      }));
    } catch (e) { localStorage.removeItem(SNAPSHOT_KEY); }
  }
  showOverlay(shell, '.btn.primary');
}

function resumeSnapshot(parsed) {
  try {
    const level = levelById(parsed.levelId);
    const sess = new Session(level, parsed.mode, {});
    sess.state = deserialize(parsed.state);
    app.session = sess;
    app.renderer.loadLevel(level, level.theme || 'brass');
    const awayMin = Math.round((Date.now() - parsed.savedAt) / 60000);
    showPlay();
    setState('active', 'snapshot-resume');
    announce('Welcome back. While you were away (' + (awayMin < 1 ? 'moments' : awayMin + ' minutes') +
      '), the tower waited — solo play is paused. Score ' + scoreBreakdown(sess.state, level.par).total + ', deaths ' + sess.state.deaths + '.', false);
  } catch (e) {
    localStorage.removeItem(SNAPSHOT_KEY);
    showTitle();
  }
}

function levelById(id) {
  if (id.startsWith('journey-')) return journeyStage(parseInt(id.slice(8), 10));
  if (id.startsWith('learn-')) return TUTORIALS.find(t => t.id === id);
  if (id.startsWith('daily-')) return dailyLevel(new Date(id.slice(6) + 'T00:00:00Z'));
  if (id.startsWith('chal-')) return challengeLevel(id);
  throw new Error('unknown level ' + id);
}

// ---- mode select

function modeCard(name, desc, meta, onGo, recommended) {
  const card = el('div', { class: 'card' + (recommended ? ' recommended' : '') });
  card.appendChild(el('h3', { text: name }));
  card.appendChild(el('p', { class: 'card-desc', text: desc }));
  card.appendChild(el('p', { class: 'meta', text: meta }));
  card.appendChild(el('button', { class: 'btn primary', text: recommended ? 'Play (recommended)' : 'Play', onclick: onGo }));
  return card;
}

function showModeSelect() {
  setState('mode-select', 'user');
  const shell = screenShell('Choose a Mode', 'Each mode lists its rules, expected duration, and whether results are ranked.');
  const grid = el('div', { class: 'card-grid' });
  const daily = dailyLevel(new Date(app.platform.now()));
  grid.appendChild(modeCard('Learn', 'Five short interactive lessons. One rule at a time — you perform each action.', '5 lessons · ~5 min · unranked', () => showLearn()));
  grid.appendChild(modeCard('Journey', 'Forty authored stages up the tower. New mechanisms appear one at a time, with mastery stages every eighth floor.', '40 stages · ~1–2 min each · ranked', () => showJourney(), true));
  grid.appendChild(modeCard('Daily', 'One shared seed and ruleset per UTC day. Same tower for everyone, synchronized to platform time.', '1 stage · ~2 min · ranked daily board', () => startLevel(daily, 'daily')));
  grid.appendChild(modeCard('Practice', 'Any stage, selectable difficulty, restart and undo freely. Never affects ratings.', 'unranked · undo enabled', () => showPractice()));
  grid.appendChild(modeCard('Challenge', 'Constrained goals: strict move limits and hard time targets on altered layouts.', '4 challenges · ranked', () => showChallenges()));
  grid.appendChild(modeCard('Score Chase', 'Global and friends-filtered leaderboards with replay-validated scores.', 'compare scores', () => showLeaderboards()));
  shell.appendChild(grid);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showTitle }));
  showOverlay(shell);
}

// ---- learn

function showLearn() {
  setState('mode-select', 'learn');
  const shell = screenShell('Learn the Tower', 'Interactive lessons — each introduces exactly one rule and asks you to perform it.');
  const list = el('div', { class: 'list' });
  for (const t of TUTORIALS) {
    const done = app.progress.stars[t.id] !== undefined;
    const item = el('button', { class: 'list-item', onclick: () => startLevel(t, 'learn') });
    item.appendChild(el('span', { text: (done ? '★ ' : '') + t.name }));
    item.appendChild(el('small', { text: t.lesson }));
    list.appendChild(item);
  }
  shell.appendChild(list);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showModeSelect }));
  showOverlay(shell);
}

// ---- journey

function showJourney() {
  setState('mode-select', 'journey');
  const shell = screenShell('Journey — Forty Floors', 'Clear a stage to unlock the next. Mastery stages test combined mechanisms.');
  const grid = el('div', { class: 'stage-grid', role: 'list' });
  const maxUnlocked = computeMaxUnlocked();
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const lv = journeyStage(i);
    const best = app.progress.stars[i];
    const locked = i > maxUnlocked;
    const b = el('button', {
      class: 'stage-cell' + (lv.mastery ? ' mastery' : '') + (locked ? ' locked' : ''),
      role: 'listitem',
      'aria-label': 'Stage ' + (i + 1) + (lv.mastery ? ' (mastery)' : '') + (best !== undefined ? ', best score ' + best : '') + (locked ? ', locked' : ''),
      disabled: locked ? 'disabled' : null,
      onclick: () => startLevel(lv, 'journey'),
    });
    b.innerHTML = '<b>' + (i + 1) + '</b>' + (best !== undefined ? '<span class="star">★</span>' : '');
    grid.appendChild(b);
  }
  shell.appendChild(grid);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showModeSelect }));
  showOverlay(shell);
}

function computeMaxUnlocked() {
  let max = 0;
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    if (app.progress.stars[i] !== undefined) max = i + 1;
  }
  return Math.min(max, JOURNEY_COUNT - 1);
}

// ---- practice

function showPractice() {
  setState('mode-select', 'practice');
  const shell = screenShell('Practice', 'Unranked. Restart and undo (U) freely; nothing here affects competitive boards.');
  const form = el('div', { class: 'form' });
  const sel = el('select', { id: 'practice-stage', 'aria-label': 'Stage' });
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const o = el('option', { value: String(i), text: 'Stage ' + (i + 1) });
    sel.appendChild(o);
  }
  const diff = el('select', { id: 'practice-diff', 'aria-label': 'Difficulty' }, [
    el('option', { value: 'relaxed', text: 'Relaxed — no penalties' }),
    el('option', { value: 'standard', text: 'Standard', selected: 'selected' }),
    el('option', { value: 'strict', text: 'Strict — move limit' }),
  ]);
  form.appendChild(el('label', { text: 'Stage ', html: '' }));
  form.lastChild.appendChild(sel);
  form.appendChild(el('label', { text: 'Difficulty ' }));
  form.lastChild.appendChild(diff);
  shell.appendChild(form);
  shell.appendChild(el('button', {
    class: 'btn primary', text: 'Start Practice',
    onclick: () => {
      const lv = journeyStage(parseInt(sel.value, 10));
      const d = diff.value;
      const level = { ...lv, id: 'practice-' + lv.index };
      if (d === 'strict') level.moveLimit = Math.round(lv.par.moves * 1.2);
      startLevel(level, 'practice', { difficulty: d });
    },
  }));
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showModeSelect }));
  showOverlay(shell);
}

// ---- challenges

function showChallenges() {
  setState('mode-select', 'challenge');
  const shell = screenShell('Challenges', 'Constrained goals on altered layouts. Ranked.');
  const list = el('div', { class: 'list' });
  for (const c of CHALLENGES) {
    const item = el('button', { class: 'list-item', onclick: () => startLevel(challengeLevel(c.id), 'challenge') });
    item.appendChild(el('span', { text: c.name }));
    item.appendChild(el('small', { text: c.desc + (c.moveLimit ? ' Move limit: ' + c.moveLimit + '.' : '') + (c.timeLimit ? ' Time limit: ' + (c.timeLimit * TICK_MS / 1000) + 's.' : '') }));
    list.appendChild(item);
  }
  shell.appendChild(list);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showModeSelect }));
  showOverlay(shell);
}

// ---- leaderboards (score chase)

async function showLeaderboards(board) {
  setState('mode-select', 'scores');
  board = board || 'daily';
  const shell = screenShell('Score Chase', app.platform.online
    ? 'Replay-validated global boards. Friends filter uses your local friends list.'
    : 'Offline — showing local casual board (scores not server-validated).');
  const tabs = el('div', { class: 'btn-row', role: 'tablist' });
  for (const b of ['daily', 'journey', 'challenge']) {
    tabs.appendChild(el('button', {
      class: 'btn' + (b === board ? ' primary' : ''), role: 'tab', 'aria-selected': b === board ? 'true' : 'false',
      text: b[0].toUpperCase() + b.slice(1), onclick: () => showLeaderboards(b),
    }));
  }
  shell.appendChild(tabs);
  const data = await app.platform.getScores(board);
  const list = el('ol', { class: 'scores' });
  const entries = (data.entries || []).slice(0, 20);
  if (!entries.length) list.appendChild(el('li', { text: 'No scores yet — be the first.' }));
  for (const e of entries) {
    list.appendChild(el('li', {
      text: (e.name || 'Guest') + ' — ' + e.score + (e.local ? ' (local)' : '') + (e.meta && e.meta.won === false ? ' (incomplete)' : ''),
    }));
  }
  shell.appendChild(list);
  if (data.casual) shell.appendChild(el('p', { class: 'meta', text: 'Casual board — validation unavailable; plausibility checks only.' }));
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showModeSelect }));
  showOverlay(shell);
}

// ---- settings

function showSettings(returnTo) {
  const s = app.settings;
  const shell = screenShell('Settings', 'Saved locally and synced to the cloud when online.');
  const wrap = el('div', { class: 'form' });

  const h3a = el('h3', { text: 'Audio' });
  wrap.appendChild(h3a);
  for (const bus of BUS_NAMES) {
    const row = el('label', { class: 'slider-row' });
    row.appendChild(el('span', { text: bus[0].toUpperCase() + bus.slice(1) }));
    const input = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volumes[bus]), 'aria-label': bus + ' volume' });
    input.addEventListener('input', () => { app.audio.setVolume(bus, parseFloat(input.value)); saveSettings(); });
    row.appendChild(input);
    wrap.appendChild(row);
  }

  wrap.appendChild(el('h3', { text: 'Graphics' }));
  const tierSel = el('select', { 'aria-label': 'Graphics quality tier' });
  for (const t of Object.keys(QUALITY_TIERS)) tierSel.appendChild(el('option', { value: t, text: t, selected: s.graphics === t ? 'selected' : null }));
  tierSel.addEventListener('change', () => { s.graphics = tierSel.value; app.renderer.setQuality(tierSel.value); saveSettings(); });
  wrap.appendChild(labeled('Quality tier', tierSel));
  const palSel = el('select', { 'aria-label': 'Color palette' });
  for (const p of ['default', 'deuteranopia', 'protanopia', 'tritanopia', 'mono']) palSel.appendChild(el('option', { value: p, text: p, selected: s.palette === p ? 'selected' : null }));
  palSel.addEventListener('change', () => { s.palette = palSel.value; applyA11yClasses(); saveSettings(); });
  wrap.appendChild(labeled('Color-vision palette', palSel));

  wrap.appendChild(el('h3', { text: 'Accessibility & Controls' }));
  const toggles = [
    ['reducedMotion', 'Reduced motion (no shake, swoops, or heavy particles)'],
    ['highContrast', 'High contrast'],
    ['largeText', 'Larger text'],
    ['leftHanded', 'Left-handed touch controls'],
    ['haptics', 'Haptics (vibration)'],
  ];
  for (const [key, label] of toggles) {
    const cb = el('input', { type: 'checkbox', 'aria-label': label });
    cb.checked = !!s[key];
    cb.addEventListener('change', () => { s[key] = cb.checked; applyA11yClasses(); saveSettings(); });
    wrap.appendChild(labeled(label, cb));
  }
  wrap.appendChild(el('button', { class: 'btn', text: 'Replay tutorials', onclick: () => showLearn() }));
  shell.appendChild(wrap);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: () => (returnTo === 'pause' ? showPause() : showTitle()) }));
  showOverlay(shell);
}

function labeled(text, control) {
  const l = el('label', { class: 'field' });
  l.appendChild(el('span', { text }));
  l.appendChild(control);
  return l;
}

function saveSettings() {
  store(SETTINGS_KEY, app.settings);
  applyA11yClasses();
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

function showProfile() {
  const shell = screenShell('Profile', app.platform.online ? 'Connected to the StarHermit host.' : 'Guest mode — progress is stored locally.');
  const nameInput = el('input', { type: 'text', value: app.platform.playerName, maxlength: '24', 'aria-label': 'Display name' });
  shell.appendChild(labeled('Display name', nameInput));
  shell.appendChild(el('button', {
    class: 'btn', text: 'Save name',
    onclick: () => {
      app.platform.playerName = nameInput.value.trim() || 'Guest';
      localStorage.setItem('tt-name', app.platform.playerName);
      announce('Name saved.');
      showTitle();
    },
  }));
  const p = app.progress;
  shell.appendChild(el('p', { text: 'Stages cleared: ' + Object.keys(p.stars).length + ' / 40 · Total clears: ' + p.clears + ' · Daily streak: ' + p.streak.count }));
  const ach = el('ul', { class: 'achievements' });
  for (const a of ACHIEVEMENTS) {
    const got = p.achievements[a.key];
    ach.appendChild(el('li', { text: (got ? '★ ' : '☆ ') + a.name + ' — ' + a.desc + (got ? ' (' + got.slice(0, 10) + ')' : ''), class: got ? 'got' : '' }));
  }
  shell.appendChild(el('h3', { text: 'Achievements' }));
  shell.appendChild(ach);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showTitle }));
  showOverlay(shell);
}

// ---- help

function showHelp() {
  const shell = screenShell('Help & Rules', 'Rule cards reflect your current control mappings.');
  const cards = el('div', { class: 'card-grid' });
  const ruleCards = [
    ['Goal', 'Guide your wind-up climber to the glowing exit door on each floor of the tower.'],
    ['Move', 'Walk with ← / → or A / D. On touch, hold the arrow pads. Gamepad: left stick or D-pad.'],
    ['Jump', 'Press Space, W, or ↑ — or the JUMP pad — while on the ground. Jumping in mid-air is an invalid action and costs score.'],
    ['Trick steps', 'Some floors are decoys: they shimmer once touched, then you fall through. They never change — learn them.'],
    ['Vanishing platforms', 'Paler platforms fade in and out on a fixed, deterministic rhythm. Watch a full cycle before crossing.'],
    ['Hazards', 'Red spikes and long falls rewind you to the last checkpoint flag. Retries are instant and unlimited.'],
    ['Gears', 'Golden gears are optional collectibles worth 150 points each.'],
    ['Score', 'Completion 1000 + gears + time/move bonuses − 40 per death − 5 per invalid action. Results show the full breakdown.'],
    ['Pause / retry', 'Esc or P pauses. R retries instantly. C resets the camera. U undoes in Practice.'],
  ];
  for (const [t, d] of ruleCards) {
    const c = el('div', { class: 'card' });
    c.appendChild(el('h3', { text: t }));
    c.appendChild(el('p', { text: d }));
    cards.appendChild(c);
  }
  shell.appendChild(cards);
  shell.appendChild(el('button', { class: 'btn subtle', text: '← Back', onclick: showTitle }));
  showOverlay(shell);
}

// ---- play (HUD only; overlay hidden)

function showPlay() {
  hideOverlay();
  app.els.hud.hidden = false;
  app.els.hudObjective.textContent = 'Objective: reach the exit — ' + (app.session.level.name || '');
  app.els.hudLesson.textContent = app.session.level.lesson || '';
  app.els.undoBtn.hidden = app.session.mode !== 'practice';
  updateHud();
}

// ---- pause

function showPause() {
  const shell = screenShell('Paused', app.session ? app.session.level.name : '');
  shell.appendChild(el('button', { class: 'btn primary big', text: 'Resume', onclick: resumeGame }));
  shell.appendChild(el('div', { class: 'btn-row' }, [
    el('button', { class: 'btn', text: 'Retry (R)', onclick: retryLevel }),
    el('button', { class: 'btn', text: 'Settings', onclick: () => showSettings('pause') }),
    el('button', { class: 'btn', text: 'Help', onclick: showHelp }),
  ]));
  shell.appendChild(el('button', { class: 'btn subtle', text: 'Leave level', onclick: leaveToTitle }));
  showOverlay(shell, '.btn.primary');
}

// ---- results

async function showResults(sess) {
  setState('results', sess.result.reason);
  const r = sess.result;
  const b = r.breakdown;
  const shell = screenShell(r.won ? 'Floor Cleared!' : 'Attempt Over', sess.level.name);

  const table = el('table', { class: 'breakdown' });
  const rows = [
    ['Completion', b.completion], ['Gears (' + b.gearCount + ')', b.gears],
    ['Time bonus', b.timeBonus], ['Move bonus', b.moveBonus],
    ['Death penalty', -b.deathPenalty], ['Invalid-action penalty', -b.invalidPenalty],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: k }));
    tr.appendChild(el('td', { text: String(v), class: v < 0 ? 'neg' : '' }));
    table.appendChild(tr);
  }
  const total = el('tr', { class: 'total' });
  total.appendChild(el('td', { text: 'Total' }));
  total.appendChild(el('td', { text: String(b.total) }));
  table.appendChild(total);
  shell.appendChild(table);
  shell.appendChild(el('p', { class: 'meta', text: 'Reason: ' + r.reason + ' · Time: ' + (r.ticks * TICK_MS / 1000).toFixed(1) + 's · Deaths: ' + sess.state.deaths }));
  announce((r.won ? 'Level complete. ' : 'Attempt over. ') + 'Score ' + b.total + '.', true);

  // Progression
  const newly = updateProgress(sess);
  for (const key of newly) {
    const a = ACHIEVEMENTS.find(a => a.key === key);
    shell.appendChild(el('p', { class: 'achievement-pop', text: '★ Achievement unlocked: ' + a.name }));
    app.audio.event('achievement');
  }

  // Score submission
  if (sess.ranked && r.won) {
    shell.appendChild(el('p', { class: 'meta', text: 'Submitting score for validation…' }));
    const res = await app.platform.submitScore(
      sess.mode, sess.level.id, b, sess.envelope(),
      { won: r.won, assists: sess.mode === 'practice', version: CONTENT_VERSION, seed: sess.level.seed, durationMs: r.durationMs }
    );
    shell.querySelector('.meta:last-of-type');
    const msg = res.validated
      ? 'Validated ✓ — rank #' + res.rank + ' on the ' + sess.mode + ' board.'
      : 'Saved locally (casual board' + (res.error ? ', host unreachable: ' + res.error : '') + ').';
    shell.appendChild(el('p', { class: 'meta', text: msg }));
  } else if (!sess.ranked) {
    shell.appendChild(el('p', { class: 'meta', text: 'Unranked mode — no leaderboard submission.' }));
  }

  // Next actions
  const row = el('div', { class: 'btn-row' });
  row.appendChild(el('button', { class: 'btn primary', text: r.won ? 'Next →' : 'Retry (R)', onclick: () => nextAction(sess) }));
  row.appendChild(el('button', { class: 'btn', text: 'Replay level', onclick: retryLevel }));
  row.appendChild(el('button', { class: 'btn', text: 'Scores', onclick: () => showLeaderboards(sess.mode === 'learn' || sess.mode === 'practice' ? 'journey' : sess.mode) }));
  shell.appendChild(row);
  shell.appendChild(el('button', { class: 'btn subtle', text: 'Leave', onclick: leaveToTitle }));
  app.platform.funnel('round-end', { level: sess.level.id, won: r.won, score: b.total });
  showOverlay(shell, '.btn.primary');
  localStorage.removeItem(SNAPSHOT_KEY);
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
    '    <span>Score <b id="hud-score">0</b></span>' +
    '    <span>Gears <b id="hud-gears">0 / 0</b></span>' +
    '    <span>Deaths <b id="hud-deaths">0</b></span>' +
    '    <span>Time <b id="hud-time">0.0s</b></span>' +
    '    <span id="hud-limit"></span>' +
    '  </div>' +
    '  <div class="hud-group"><button id="btn-pause" class="btn small">Pause (Esc)</button>' +
    '  <button id="btn-undo" class="btn small" hidden>Undo (U)</button></div>' +
    '</div>';
  const overlay = el('div', { id: 'overlay', role: 'dialog', 'aria-modal': 'false' });
  const countdown = el('div', { id: 'countdown', hidden: 'hidden', 'aria-hidden': 'true' });
  const touch = el('div', { id: 'touch-controls' });
  touch.innerHTML =
    '<div class="pad move-pad">' +
    '  <button class="touch-btn" data-hold="left" aria-label="Move left">◀</button>' +
    '  <button class="touch-btn" data-hold="right" aria-label="Move right">▶</button>' +
    '</div>' +
    '<div class="pad jump-pad"><button class="touch-btn jump" data-jump aria-label="Jump">JUMP</button></div>';
  const live = el('div', { id: 'live', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  const liveAssert = el('div', { id: 'live-assert', class: 'visually-hidden', role: 'alert', 'aria-live': 'assertive' });
  const boardDesc = el('div', { id: 'board-desc', class: 'visually-hidden', 'aria-label': 'Board state' });
  const captions = el('div', { id: 'captions', 'aria-hidden': 'true' });

  appRoot.appendChild(canvas);
  appRoot.appendChild(hud);
  appRoot.appendChild(overlay);
  appRoot.appendChild(countdown);
  appRoot.appendChild(touch);
  appRoot.appendChild(live);
  appRoot.appendChild(liveAssert);
  appRoot.appendChild(boardDesc);
  appRoot.appendChild(captions);

  app.els = {
    canvas, hud, overlay, countdown, touch, live, liveAssert, boardDesc, captions,
    hudObjective: hud.querySelector('#hud-objective'),
    hudLesson: hud.querySelector('#hud-lesson'),
    hudScore: hud.querySelector('#hud-score'),
    hudGears: hud.querySelector('#hud-gears'),
    hudDeaths: hud.querySelector('#hud-deaths'),
    hudTime: hud.querySelector('#hud-time'),
    hudLimit: hud.querySelector('#hud-limit'),
    undoBtn: hud.querySelector('#btn-undo'),
  };
  hud.querySelector('#btn-pause').addEventListener('click', () => (app.state === 'paused' ? resumeGame() : pauseGame()));
  app.els.undoBtn.addEventListener('click', () => app.session && app.session.undo());
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
  app.audio.captionSink = (text) => {
    app.els.captions.textContent = '♪ ' + text;
    clearTimeout(app.audio._capTimer);
    app.audio._capTimer = setTimeout(() => { app.els.captions.textContent = ''; }, 1800);
  };
  try {
    app.renderer = new Renderer(app.els.canvas, app.settings);
  } catch (e) {
    document.getElementById('app').innerHTML =
      '<main class="compat"><h1>Trickstep Tower</h1><p>This device or browser does not support WebGL, which the tower needs to render. ' +
      'Your settings and progress are preserved for your next visit.</p></main>';
    return;
  }
  onResize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 100));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.state === 'active') pauseGame();
  });
  window.addEventListener('beforeunload', persistSnapshot);
  bindInput();
  await app.platform.init();
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
