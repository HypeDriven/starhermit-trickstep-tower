// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs), the loader index.html that `npm run package` writes: on
// the desktop Journey stage 1 won by keys (Right held, Space on a 300 ms
// rhythm, which the rules win at any phase) with a pause by Escape; on a
// phone (390 x 844, DPR 3) the menus by finger and stage 1 won on the
// runtime's touch controls (a finger held on ▶, JUMP tapped by a second
// finger); sideways (844 x 390, DPR 3) Help, Settings and a Practice run
// paused and left. Widgets are found through the page's accessibility
// mirror. Fails on console errors or warnings, the runtime's error screen,
// or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const W = v.viewport.width, H = v.viewport.height;
  const cleared = () => page.getByText('Floor Cleared!').first().isVisible().catch(() => false);
  const go = async () => { await find('Pause (Esc)').waitFor({ timeout: 60000 }); await page.waitForTimeout(2600); };
  try {
    await shot('title');
    if (v.name === 'landscape') {
      await press('Help & Rules');
      await page.getByText('Rule cards', { exact: false }).first().waitFor({ timeout: 15000 });
      await shot('help');
      await page.keyboard.press('Escape'); await page.waitForTimeout(500);
      await press('Settings');
      await page.getByText('Color-vision palette').first().waitFor({ timeout: 15000 });
      await shot('settings');
      await page.keyboard.press('Escape'); await page.waitForTimeout(500);
      await press('▶ Play');
      await page.mouse.move(W / 2, H / 2); await page.mouse.wheel(0, 600); await page.waitForTimeout(500);
      await press('Practice: Play');
      await press('Start Practice');
      await go();
      await shot('practice');
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(400);
      await shot('pause');
      await press('Leave level');
      await page.getByRole('button', { name: /Resume paused run/ }).first().waitFor({ timeout: 15000 });
      await shot('resumable');
    } else {
      await press('▶ Play');
      await page.getByText('Choose a Mode').first().waitFor({ timeout: 15000 });
      await shot('modes');
      await press('Journey: Play (recommended)');
      await press('Stage 1');
      await go();
      await shot('stage1');
      if (cdp) {
        const right = { x: 120, y: H - 40, id: 1 }, jump = { x: W - 54, y: H - 50, id: 2 };
        // ▶ held by one finger, JUMP tapped by a second each cycle (both lift together at the cycle's end)
        for (let i = 0; i < 90 && !(await cleared()); i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [right] });
          await page.waitForTimeout(150);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [right, jump] });
          await page.waitForTimeout(150);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          if (i === 4) await shot('climbing');
        }
      } else {
        await page.keyboard.down('ArrowRight');
        for (let i = 0; i < 80 && !(await cleared()); i++) {
          await page.keyboard.press('Space');
          await page.waitForTimeout(300);
          if (i === 4) await shot('climbing');
        }
        await page.keyboard.up('ArrowRight');
      }
      await page.getByText('Floor Cleared!').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      await shot('cleared');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
