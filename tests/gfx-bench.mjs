// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// then starts Practice on the last Journey floor (every tile kind: gears, spikes, springs, movers, trick
// and vanishing steps) and keeps the climber running and jumping with the real keys, so the follow
// camera, moving parts, reveal shimmer, death/respawn bursts and the background clockwork all animate.
// A finished floor is replayed from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const state = (page) => page.evaluate(() => window.__tt?.state);

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__tt?.state === 'title', null, { timeout: 20000 });
  await page.click('#overlay [data-action="settings"]');
  await page.click('#overlay [data-settings-tab="graphics"]');
  await page.waitForSelector('#gfx-preset', { state: 'visible' });
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#overlay button:has-text("← Back")');
  await page.waitForFunction(() => window.__tt?.state === 'title', null, { timeout: 8000 });
}

export async function start(page) {
  await page.click('#overlay [data-action="play"]');
  await page.waitForFunction(() => window.__tt?.state === 'mode-select');
  await page.click('#overlay [data-mode="practice"] button');
  await page.waitForSelector('#practice-stage');
  const last = await page.locator('#practice-stage option').count();
  await page.selectOption('#practice-stage', String(last - 1));
  await page.selectOption('#practice-diff', 'relaxed');
  await page.click('#overlay [data-action="start-practice"]');
  await page.waitForFunction(() => window.__tt?.state === 'active', null, { timeout: 20000 });
  let open = true, n = 0, dir = 'ArrowRight';
  page.once('close', () => { open = false; });
  (async () => {
    await page.keyboard.down(dir).catch(() => {});
    while (open) {
      try {
        const s = await state(page);
        if (s === 'results') {
          await page.keyboard.up(dir);
          await page.click('#overlay [data-action="replay"]', { timeout: 3000 });
          await page.waitForFunction(() => window.__tt?.state === 'active', null, { timeout: 15000 });
          await page.keyboard.down(dir);
        } else if (s === 'paused') {
          await page.keyboard.press('Escape');
        } else if (s === 'active') {
          if (n % 3 === 0) await page.keyboard.press('Space');
          if (n % 20 === 19) { await page.keyboard.up(dir); dir = dir === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight'; await page.keyboard.down(dir); }
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error('hook:', e.message.split('\n')[0]); }
      n++;
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await page.waitForTimeout(1500);
}
