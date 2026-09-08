'use strict';

// Browser E2E: drives the real game in headless Chromium via playwright-core.
// Skips cleanly when no Chromium executable is available.

import test from 'node:test';
import assert from 'node:assert/strict';
import server from './test-server.js';

let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch (e) { /* not installed */ }

const canRun = !!chromium;
let port;

test.before(async () => {
  if (!canRun) return;
  await new Promise((resolve) => { server.listen(0, () => { port = server.address().port; resolve(); }); });
});
test.after(() => { if (canRun) { server.closeAllConnections?.(); server.close(); } });

test('full play loop in a real browser', { skip: !canRun, timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  // Always close the browser: a failed assertion otherwise leaves Chromium
  // running and node --test never exits.
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const state = () => page.evaluate(() => window.__tt.state);
  await page.goto('http://localhost:' + port + '/');
  await page.waitForFunction(() => window.__tt && window.__tt.state === 'title');
  assert.ok(await page.locator('.btn.primary.big').isVisible());

  // Title → mode select → journey → stage 1 → countdown → active
  await page.click('.btn.primary.big');
  await page.waitForFunction(() => window.__tt.state === 'mode-select');
  await page.click('text=Play (recommended)');
  await page.waitForSelector('.stage-grid');
  assert.equal(await page.locator('.stage-cell').count(), 40);
  await page.locator('.stage-cell').first().click();
  await page.waitForFunction(() => window.__tt.state === 'active', { timeout: 10000 });
  assert.ok(await page.locator('#hud').isVisible());

  // Movement + HUD
  const x0 = await page.evaluate(() => window.__tt.session.state.player.x);
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowRight');
  const x1 = await page.evaluate(() => window.__tt.session.state.player.x);
  assert.ok(x1 > x0 + 1, 'player moved right: ' + x0 + ' → ' + x1);
  await page.waitForFunction(() => document.getElementById('hud-time').textContent !== '0.0s');

  // Jump single-commit
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const j = await page.evaluate(() => [window.__tt.session.pendingJumpId, window.__tt.session.consumedJumpId]);
  assert.equal(j[0], j[1]);

  // Pause / resume
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__tt.state === 'paused');
  assert.ok(await page.locator('text=Resume').isVisible());
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__tt.state === 'active');

  // Accessibility mirror
  const desc = await page.evaluate(() => document.getElementById('board-desc').textContent);
  assert.ok(desc.length > 10);

  // Play to results: hold right, hop whenever blocked (a fair climbing bot).
  await page.keyboard.down('ArrowRight');
  let lastX = -1;
  const t0 = Date.now();
  let reached = false;
  while (Date.now() - t0 < 60000) {
    const s = await page.evaluate(() => ({
      st: window.__tt.state,
      x: window.__tt.session ? window.__tt.session.state.player.x : 0,
      ground: window.__tt.session ? window.__tt.session.state.player.onGround : false,
    }));
    if (s.st === 'results') { reached = true; break; }
    if (s.st === 'active') {
      if (s.ground && Math.abs(s.x - lastX) < 0.05) await page.keyboard.press('Space');
      lastX = s.x;
    }
    await page.waitForTimeout(150);
  }
  await page.keyboard.up('ArrowRight');
  assert.ok(reached, 'reached results screen');
  const breakdown = await page.locator('.breakdown').textContent();
  assert.match(breakdown, /Total/);
  const announced = await page.evaluate(() =>
    document.getElementById('live-assert').textContent + document.getElementById('live').textContent);
  assert.ok(announced.length > 0);

  // Score was submitted + validated by the server (ranked journey stage).
  await page.waitForFunction(() =>
    document.querySelector('.screen').textContent.includes('Validated') ||
    document.querySelector('.screen').textContent.includes('Saved locally'), { timeout: 10000 });
  const subMsg = await page.evaluate(() => document.querySelector('.screen').textContent);
  // The platform adapter only relies on the one host-guaranteed route
  // (GET /api/v1/time); scores are kept on the local casual board, so the
  // results screen reports the local save rather than a server validation.
  assert.ok(subMsg.includes('Saved locally'), 'score recorded on the casual board: ' + subMsg.slice(0, 200));

  // Progress + next-stage unlock
  const stars = await page.evaluate(() => Object.keys(window.__tt.progress.stars).length);
  assert.ok(stars >= 1);

  // The casual board kept the entry (local storage, via the platform adapter).
  const localBoard = await page.evaluate(() => JSON.parse(localStorage.getItem('tt-board-journey') || '[]'));
  assert.ok(localBoard.length >= 1, 'casual board recorded the run');
  // The server's own board route still answers for hosted deployments.
  const res = await fetch('http://localhost:' + port + '/api/v1/scores?board=journey');
  assert.equal(res.status, 200);

  // Settings: 4 audio buses, 5 toggles.
  await page.click('text=Leave');
  await page.waitForFunction(() => window.__tt.state === 'title');
  await page.click('text=Settings');
  assert.equal(await page.locator('.slider-row input').count(), 4);
  assert.equal(await page.locator('.field input[type=checkbox]').count(), 5);

  assert.deepEqual(errors.filter(e => !/favicon/.test(e)), [], 'no page errors');
  await browser.close();
});

test('mobile portrait layout exposes touch controls', { skip: !canRun, timeout: 60000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=swiftshader'] });
  t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto('http://localhost:' + port + '/');
  await page.waitForFunction(() => window.__tt && window.__tt.state === 'title');
  // Touch controls hidden on title, visible in play for coarse pointers.
  await page.click('text=Journey');
  await page.locator('.stage-cell').first().click();
  await page.waitForFunction(() => window.__tt.state === 'active', { timeout: 10000 });
  const jumpBtn = page.locator('[data-jump]');
  assert.ok(await jumpBtn.isVisible());
  const box = await jumpBtn.boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44, 'touch target ≥44px');
  await browser.close();
});
