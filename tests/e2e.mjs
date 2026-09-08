/**
 * Trickstep Tower — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play → Journey → Stage 1 → countdown → active → a real climb
 *   by holding Right and tapping Jump whenever the climber is blocked by a
 *   step (the authored staircase teaches exactly this) → "Floor Cleared!"
 *   results with the score breakdown → exported progress persisted.
 *   Also exercises pause/resume via Esc, and Settings + Help open/close.
 * A second pass repeats the title → Journey → Stage 1 → active flow on a
 * mobile touch viewport and performs a jump through the on-screen JUMP pad.
 *
 * The game ships an app handle `window.__tt` (game.js: `window.__tt = app`).
 * The test reads that handle ONLY to observe run state (player x/y/onGround,
 * deaths/tick, terminal status) and to choose WHEN a visible move is legal
 * (jump is legal while on the ground — the same rule the player learns). It
 * never calls the game's move API; every action is a real key press or real
 * pointer tap on the visible controls. No game code is modified.
 *
 * Serving: the client `Platform` adapter is offline-first (`src/client/
 * platform.js`) — it probes `/api/v1/time` once at boot and, when that fails,
 * sets `online=false`; every other feature (scoring, achievements, cloud
 * save, funnel) degrades to local storage no-ops with zero console noise.
 * So, per the sibling-title conventions, this test embeds a minimal
 * node:http static server on an ephemeral port and answers `/api/*` probes
 * with 200 `{}` so the adapter takes its documented offline path. It also
 * serves the local `.opus`, `.js`, `.css`, `.svg` assets the page needs.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/trickstep-tower-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No hosted platform here: answer API probes with empty JSON (200) so the
    // platform adapter degrades to its documented offline path, no console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the shipped app handle ----------
// window.__tt is the game's own debug/test handle. Read only: current screen
// state and the climber's x/y/groundedness, deaths/tick/submission, used to
// decide when a jump is legal and to verify the run finished.
function readApp(page) {
  return page.evaluate(() => {
    const app = window.__tt;
    const s = app?.session;
    return {
      state: app?.state,
      phase: app?.stateReason,
      levelId: s?.level?.id,
      mode: s?.mode,
      x: s?.state?.player?.x,
      y: s?.state?.player?.y,
      onGround: s?.state?.player?.onGround,
      deaths: s?.state?.deaths,
      tick: s?.state?.tick,
      over: s?.state?.over,
      won: s?.state?.won,
      reason: s?.state?.reason,
      resultWon: s?.result?.won,
    };
  });
}

const waitState = (page, name, timeout = 20000) =>
  page.waitForFunction((n) => window.__tt?.state === n, name, { timeout });

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await waitState(page, 'title', 15000);
    await page.waitForSelector('#overlay .btn.primary.big', { state: 'visible', timeout: 15000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible ("${(await page.textContent('#overlay h2')).trim()}")`);

    if (full) {
      // Settings: open from title, count the 4 audio sliders + 5 toggles, close.
      await page.click('#overlay button:has-text("Settings")');
      await page.waitForSelector('#overlay .screen h2', { state: 'visible' });
      const slides = await page.locator('#overlay .slider-row input[type=range]').count();
      const toggles = await page.locator('#overlay .field input[type=checkbox]').count();
      if (slides !== 4) throw new Error(`expected 4 audio sliders, got ${slides}`);
      if (toggles !== 5) throw new Error(`expected 5 toggles, got ${toggles}`);
      await page.screenshot({ path: SHOT('settings', name) });
      await page.click('#overlay button:has-text("← Back")');
      await waitState(page, 'title', 8000);
      ok(`${name}: Settings opens and closes (${slides} sliders, ${toggles} toggles)`);

      // Help: rule cards present, then back.
      await page.click('#overlay button:has-text("Help & Rules")');
      await page.waitForSelector('#overlay .card');
      const cards = await page.locator('#overlay .card').count();
      if (cards < 5) throw new Error(`expected >=5 help cards, got ${cards}`);
      await page.click('#overlay button:has-text("← Back")');
      await waitState(page, 'title', 8000);
      ok(`${name}: Help & Rules opens and closes (${cards} rule cards)`);
    }

    // Title → Play → mode select → Journey → Stage 1
    await page.click('#overlay .btn.primary.big'); // ▶ Play
    await waitState(page, 'mode-select', 8000);
    await page.click('#overlay button:has-text("Play (recommended)")'); // Journey
    await page.waitForSelector('#overlay .stage-grid');
    const cells = await page.locator('#overlay .stage-cell').count();
    if (cells !== 40) throw new Error(`expected 40 journey stages, got ${cells}`);
    await page.locator('#overlay .stage-cell').first().click(); // Stage 1
    await waitState(page, 'countdown', 10000);
    await waitState(page, 'active', 15000);
    const appAtStart = await readApp(page);
    if (appAtStart.levelId !== 'journey-0') throw new Error(`expected stage journey-0, got ${appAtStart.levelId}`);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: journey Stage 1 started (${appAtStart.levelId}) and play is active`);

    if (full) {
      // Pause / resume via Esc, then a visible Resume button.
      await page.keyboard.press('Escape');
      await waitState(page, 'paused', 8000);
      await page.waitForSelector('#overlay button:has-text("Resume")', { state: 'visible' });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#overlay button:has-text("Resume")');
      await waitState(page, 'active', 8000);
      ok(`${name}: pause (Esc) and resume work`);
    }

    if (full) {
      // REAL climb on desktop: hold Right; when the climber is grounded and
      // blocked by a one-tile step, tap Jump (Space). The authored Stage-1
      // staircase always blocks at each step, so jump-when-stuck climbs it to
      // the exit. All actions are real keyboard presses; readApp is read-only.
      let lastX = null;
      let reached = false;
      const t0 = Date.now();
      await page.keyboard.down('ArrowRight');
      while (Date.now() - t0 < 90000) {
        const a = await readApp(page);
        if (a.state === 'results') { reached = true; break; }
        if (a.state === 'active') {
          if (a.onGround && lastX !== null && Math.abs((a.x ?? 0) - lastX) < 0.03) {
            await page.keyboard.press('Space'); // blocked step → jump
          }
          lastX = a.x;
        } else if (a.state === 'paused') {
          await page.keyboard.press('Escape'); // safety: unpause
        }
        await page.waitForTimeout(120);
      }
      await page.keyboard.up('ArrowRight');
      if (!reached) throw new Error(`did not reach results within 90s (last state=${(await readApp(page)).state})`);
      const final = await readApp(page);
      if (!final.won) throw new Error(`stage not won (reason=${final.reason}, over=${final.over})`);
      await page.screenshot({ path: SHOT('results', name) });

      // Results screen: headline, score breakdown, persisted progress.
      await page.waitForSelector('#overlay .screen h2');
      const title = (await page.textContent('#overlay .screen h2')).trim();
      if (!/Floor Cleared/.test(title)) throw new Error(`unexpected results headline "${title}"`);
      const breakdown = (await page.textContent('#overlay .breakdown')) || '';
      if (!/Total/.test(breakdown)) throw new Error('results breakdown missing Total');
      const body = (await page.textContent('#overlay .screen')) || '';
      if (!/Saved locally/.test(body)) throw new Error(`expected local (offline) submission note, got: "${body.slice(0, 160)}"`);
      ok(`${name}: stage cleared on the visible board — results shown ("${title}", ${final.deaths} deaths, breakdown w/ Total)`);

      const progress = await page.evaluate(() => window.__tt?.progress?.stars);
      if (!progress || progress[0] === undefined) throw new Error('journey Stage 1 star not persisted');
      ok(`${name}: progression persisted (journey stage 0 best score: ${progress[0]})`);
    } else {
      // MOBILE (shorter): verify the coarse-pointer touch controls are exposed
      // and make a few real moves via touchscreen.tap on the JUMP pad, then
      // confirm the HUD is advancing. The held arrow is driven through the
      // real `[data-hold]` pointer control.
      const jumpBtn = page.locator('#touch-controls [data-jump]');
      if (!(await jumpBtn.isVisible())) throw new Error('JUMP touch control not visible');
      const box = await jumpBtn.boundingBox();
      if (!box || box.width < 44 || box.height < 44) throw new Error('JUMP touch target < 44px');
      const x0 = (await readApp(page)).x;
      const tick0 = (await readApp(page)).tick;
      // Walk right using the real on-screen hold pad (pointer events).
      const rightBtn = page.locator('#touch-controls [data-hold="right"]');
      const rb = await rightBtn.boundingBox();
      await rightBtn.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch' });
      await page.waitForTimeout(500);
      await rightBtn.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' });
      // Jump twice through the JUMP pad via a real tap.
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(300);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
      const a1 = await readApp(page);
      if (!(a1.tick > tick0)) throw new Error(`simulation did not advance on mobile (tick ${tick0} → ${a1.tick})`);
      if (!(a1.x > x0 + 0.5)) throw new Error(`climber did not move right on touch (x ${x0?.toFixed(2)} → ${a1.x?.toFixed(2)})`);
      const hud = (await page.textContent('#hud-time')) || '';
      if (hud === '0.0s') throw new Error('HUD time did not advance');
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: active play on touch; JUMP pad tapped and sim advanced (x ${x0?.toFixed(2)} → ${a1.x?.toFixed(2)}, HUD ${hud})`);
    }

    if (full) {
      // Next → Stage 2 (authentic progression through the visible button).
      await page.click('#overlay button:has-text("Next →")');
      await waitState(page, 'active', 15000);
      const st2 = await readApp(page);
      if (st2.levelId !== 'journey-1') throw new Error(`expected journey-1 via Next, got ${st2.levelId}`);
      ok(`${name}: "Next →" starts Stage 2 (${st2.levelId})`);
      // Back out to title to leave a clean run.
      await page.keyboard.press('Escape');
      await waitState(page, 'paused', 8000);
      await page.click('#overlay button:has-text("Leave level")');
      await waitState(page, 'title', 8000);
      ok(`${name}: left the level back to title`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  ok(`${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — trickstep-tower, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
