'use strict';

// Platform adapter + canonical StarHermit SDK with a stubbed fetch and a fake
// launch fragment: token read, profile name, cloud save in game:<slug>,
// settings KV patch, control overrides — and zero fetches standalone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform, mergeProgress } from '../src/client/platform.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_SRC = fs.readFileSync(path.join(ROOT, 'starhermit-sdk.js'), 'utf8');
function loadSdk() {
  const m = { exports: {} };
  new Function('module', 'exports', SDK_SRC)(m, m.exports);
  return m.exports;
}

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
const SLUG = 'trickstep-test';
const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
const JWT = 'x.' + b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.y';

function fakeWindow(hash, hostname = 'localhost') {
  return {
    location: { hash, search: '', pathname: '/', hostname, href: 'http://' + hostname + '/' + hash, origin: 'http://' + hostname },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
  };
}
function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

function stubServer() {
  const calls = [];
  const state = { save: null, etag: null, version: 0, settings: {} };
  const fetch = async (url, init) => {
    init = init || {};
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization, body: init.body });
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });
    if (url === '/api/v1/time') return json({ now: Date.now() });
    if (url === '/api/v1/users/' + USER + '/profile') return json({ nickname: 'Clockwork Kim', username: 'kim' });
    if (url.startsWith('/api/v1/me/cloud-saves/')) {
      // Conditional writes: PUT answers {etag}; a stale If-Match is refused (412).
      if (url.split('?')[0].endsWith('/info')) return json(state.save ? { exists: true, etag: state.etag } : { exists: false });
      if (method === 'PUT') {
        const match = init.headers && init.headers['If-Match'];
        if (match && match !== state.etag) return json({ etag: state.etag }, 412);
        const b = JSON.parse(init.body);
        state.save = Buffer.from(b.dataBase64, 'base64');
        state.etag = '"v' + (++state.version) + '"';
        return json({ etag: state.etag });
      }
      return state.save ? new Response(state.save, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (url === '/api/v1/games/' + SLUG + '/settings') {
      if (method === 'PATCH') { Object.assign(state.settings, JSON.parse(init.body).settings); return json({ settings: state.settings }); }
      return json({ settings: state.settings });
    }
    if (url === '/api/v1/games/' + SLUG + '/controls') return json({ actions: [{ action: 'jump', codes: ['KeyJ'] }] });
    return new Response(null, { status: 404 });
  };
  // Another device writing the slot: this client's next conditional write is refused.
  const otherDevice = async (sh, doc) => {
    state.save = Buffer.from(await sh._zip('save.json', new TextEncoder().encode(JSON.stringify(doc))));
    state.etag = '"v' + (++state.version) + '"';
  };
  return { fetch, calls, state, otherDevice };
}

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = stubServer();
  const win = fakeWindow('#game_token=' + JWT + '&session_id=sess-1');
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  sh.init();
  assert.equal(sh.token, JWT);
  assert.equal(sh.slug, SLUG);
  assert.equal(win.history.url, '/', 'token stripped from the URL');

  const p = new Platform({ sh, storage: memStorage() });
  await p.init();
  assert.ok(p.hosted);
  assert.equal(p.sessionId, 'sess-1');
  assert.equal(p.playerName, 'Clockwork Kim');
  assert.ok(srv.calls.every(c => c.auth === 'Bearer ' + JWT));

  await p.saveCloud({ progress: { clears: 7 }, savedAt: 123 });
  await p._flushCloud();
  const put = srv.calls.find(c => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG));
  const back = await p.loadCloud();
  assert.equal(back.doc.progress.clears, 7);

  p.patchSettings({ palette: 'mono' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(srv.state.settings, { palette: 'mono' });
  assert.equal((await p.getSettings()).palette, 'mono');

  const b = await p.loadBindings({ jump: ['Space'], left: ['ArrowLeft'] });
  assert.deepEqual(b, { jump: ['KeyJ'], left: ['ArrowLeft'] });
  assert.match(p.inviteLink(), new RegExp('/game-invite/' + USER + '/' + SLUG + '$'));
});

test('signed out by renewal: adapter falls back to local play', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  sh.init();
  const p = new Platform({ sh, storage: memStorage() });
  await p.init();
  let notified = null;
  p.onAuthChange = (v) => { notified = v; };
  sh.signOut('expired');
  assert.equal(notified, false);
  assert.equal(p.hosted, false);
  assert.equal(p.inviteLink(), null);
});

test('standalone: no token means no fetch at all', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow(''), fetch: srv.fetch });
  sh.init();
  const p = new Platform({ sh, storage: memStorage() });
  await p.init();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), false, 'no sign-in button when running locally');
  await p.saveCloud({ progress: {}, savedAt: 1 });
  await p._flushCloud();
  p.patchSettings({ palette: 'mono' });
  assert.deepEqual(await p.getSettings(), {});
  await p.getScores('daily');
  await p.loadBindings({ jump: ['Space'] });
  p.funnel('start');
  assert.equal(srv.calls.length, 0);
});

test('sign-in is offered on a StarHermit game host (UUID subdomain)', () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('', '2712e04e-461b-4d23-81ae-e40b429128a8.starhermit.com'), fetch: srv.fetch });
  sh.init();
  const p = new Platform({ sh, storage: memStorage() });
  assert.equal(p.canSignIn(), true);
});

test('mergeProgress keeps the best of both devices', () => {
  const a = { v: 1, stars: { 0: 900, 1: 400, 'learn-move': 1000 }, bestDaily: { '2026-10-01': 800 }, achievements: { 'first-clear': '2026-10-02T00:00:00.000Z' }, streak: { count: 2, lastDay: '2026-10-02' }, clears: 5, gearMasteryStages: {} };
  const b = { v: 1, stars: { 1: 700, 2: 300 }, bestDaily: { '2026-10-01': 600, '2026-10-03': 500 }, achievements: { 'first-clear': '2026-10-01T00:00:00.000Z', 'streak-3': '2026-10-03T00:00:00.000Z' }, streak: { count: 3, lastDay: '2026-10-03' }, clears: 9, gearMasteryStages: { 4: true } };
  const m = mergeProgress(a, b);
  assert.deepEqual(m.stars, { 0: 900, 1: 700, 2: 300, 'learn-move': 1000 });
  assert.deepEqual(m.bestDaily, { '2026-10-01': 800, '2026-10-03': 500 });
  assert.equal(m.achievements['first-clear'], '2026-10-01T00:00:00.000Z');
  assert.ok(m.achievements['streak-3']);
  assert.deepEqual(m.streak, { count: 3, lastDay: '2026-10-03' });
  assert.equal(m.clears, 9);
  assert.deepEqual(m.gearMasteryStages, { 4: true });
  assert.deepEqual(mergeProgress(b, a), m, 'order-independent');
});

test('a save that loses to another device triggers reload + merge + save again', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  sh.init();
  try {
    const p = new Platform({ sh, storage: memStorage() });
    await p.init();
    await p.saveCloud({ progress: { v: 1, stars: { 0: 900 }, clears: 1 }, savedAt: 1 });
    assert.equal(await p._flushCloud(), true);
    await srv.otherDevice(sh, { progress: { v: 1, stars: { 1: 500 }, clears: 4 }, savedAt: 2 });
    let resolveConflict;
    const conflicted = new Promise(r => { resolveConflict = r; });
    let local = { v: 1, stars: { 0: 900, 2: 100 }, clears: 2 };
    p.onSaveConflict = (remote) => {
      local = mergeProgress(local, remote && remote.progress);
      p.saveCloud({ progress: local, savedAt: 3 });
      resolveConflict();
    };
    await p.saveCloud({ progress: local, savedAt: 3 });
    assert.equal(await p._flushCloud(), false, 'stale write refused');
    await conflicted;
    assert.equal(await p._flushCloud(), true, 'merged write accepted');
    const back = await p.loadCloud();
    assert.deepEqual(back.doc.progress.stars, { 0: 900, 1: 500, 2: 100 });
    assert.equal(back.doc.progress.clears, 4);
  } finally { sh.signOut(); }
});
