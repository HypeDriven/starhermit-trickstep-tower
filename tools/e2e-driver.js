'use strict';

// E2E driver: exercises the real UI via DOM events and observes app state.
// Results are written to <pre id="e2e"> for headless-dom inspection.

import { app } from '../game.js';

const out = [];
function render() {
  document.getElementById('e2e').textContent = 'E2E-BEGIN\n' + out.join('\n') + '\nE2E-END';
}
function step(name, ok, extra) {
  out.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
  render();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) {
    try { if (fn()) return true; } catch (e) { /* keep waiting */ }
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + label);
}
function key(code, type) {
  window.dispatchEvent(new KeyboardEvent(type || 'keydown', { code, bubbles: true }));
}
function clickText(selector, text) {
  for (const b of document.querySelectorAll(selector)) {
    if (b.textContent.includes(text)) { b.click(); return b; }
  }
  throw new Error('no element ' + selector + ' with text ' + text);
}

async function run() {
  await waitFor(() => app.state === 'title' && document.querySelector('.btn.primary'), 10000, 'title screen');
  step('boot-to-title', true);

  // Title → mode select
  document.querySelector('.btn.primary.big').click();
  await waitFor(() => app.state === 'mode-select', 3000, 'mode select');
  step('title-to-mode-select', true);

  // Mode select → journey → stage 1
  clickText('.card .btn', 'Play (recommended)').click;
  await waitFor(() => document.querySelector('.stage-grid'), 3000, 'journey map');
  step('journey-map-40-stages', document.querySelectorAll('.stage-cell').length === 40);
  document.querySelector('.stage-cell').click();
  await waitFor(() => app.state === 'countdown' || app.state === 'active', 3000, 'countdown');
  step('preparing-countdown', true);
  await waitFor(() => app.state === 'active', 6000, 'active play');
  step('countdown-to-active', true);
  step('hud-visible', !document.getElementById('hud').hidden);

  // Walk right for a while — player x must increase, HUD time advances.
  const x0 = app.session.state.player.x;
  key('ArrowRight', 'keydown');
  await sleep(1200);
  key('ArrowRight', 'keyup');
  const x1 = app.session.state.player.x;
  step('move-right', x1 > x0 + 1, 'x ' + x0.toFixed(2) + ' → ' + x1.toFixed(2));
  step('hud-updates', document.getElementById('hud-time').textContent !== '0.0s');

  // Jump edge-trigger: one press, one jump (no double commit).
  const jumps0 = app.session.state.moves;
  key('Space', 'keydown');
  await sleep(120);
  key('Space', 'keyup');
  await sleep(200);
  step('jump-single-commit', app.session.pendingJumpId === app.session.consumedJumpId);

  // Pause / resume via Escape.
  key('Escape');
  await waitFor(() => app.state === 'paused', 2000, 'paused');
  step('pause', document.querySelector('.screen h2') && document.querySelector('.screen h2').textContent === 'Paused');
  key('Escape');
  await waitFor(() => app.state === 'active', 2000, 'resumed');
  step('resume', true);

  // Board accessibility mirror exists and updates.
  step('board-mirror', document.getElementById('board-desc').textContent.length > 10);

  // Play to completion: hold right, hop periodically (stage 0 is solvable this way).
  key('ArrowRight', 'keydown');
  const hop = setInterval(() => { key('Space', 'keydown'); setTimeout(() => key('Space', 'keyup'), 80); }, 1500);
  try {
    await waitFor(() => app.state === 'results', 45000, 'results');
  } finally {
    clearInterval(hop);
    key('ArrowRight', 'keyup');
  }
  step('results-screen', true);
  const bd = document.querySelector('.breakdown');
  step('score-breakdown-shown', !!bd && bd.textContent.includes('Total'));
  step('live-announced', document.getElementById('live-assert').textContent.length > 0 ||
    document.getElementById('live').textContent.length > 0);

  // Progression recorded
  step('progress-recorded', Object.keys(app.progress.stars).length >= 1);

  // Settings screen: sliders and toggles present.
  clickText('.btn', 'Leave').click;
  await waitFor(() => app.state === 'title', 3000, 'back to title');
  clickText('.btn', 'Settings').click;
  await waitFor(() => document.querySelector('.slider-row input'), 3000, 'settings');
  const buses = document.querySelectorAll('.slider-row input').length;
  step('settings-audio-buses', buses === 4, buses + ' sliders');
  step('settings-toggles', document.querySelectorAll('.field input[type=checkbox]').length === 5);
  step('E2E-COMPLETE', true);
}

run().catch(e => { step('E2E-ERROR', false, e.message); });
