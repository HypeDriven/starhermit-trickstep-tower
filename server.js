'use strict';

// Trickstep Tower — StarHermit authoritative Game Script.
// Static distribution server + same-origin /api routes:
//   GET  /api/v1/time          platform time for countdown/daily sync
//   GET  /api/v1/daily         today's daily key, seed, content version
//   GET  /api/v1/scores?board= leaderboard (validated entries)
//   POST /api/v1/scores        score claim + replay envelope → authoritative validation
//   POST /api/v1/achievements  idempotent durable achievement delivery
//   GET/PUT /api/v1/save       versioned, checksummed cloud save
//   POST /api/v1/funnel        anonymous aggregate funnel events
//
// Daily sessions record content version, seed, difficulty-affecting settings,
// an ordered input log, score components, and a final checksum — validated here
// by deterministic replay. Unvalidated boards are labelled casual.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, simulate, stateHash, scoreBreakdown, SCHEMA_VERSION } from './src/rules.js';
import { dailyLevel, getLevel, CONTENT_VERSION } from './src/content.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const DATA_FILE = path.join(ROOT, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.opus': 'audio/ogg',
};

// ---------------------------------------------------------------- store

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { scores: {}, achievements: {}, saves: {}, funnel: [] }; }
}
let dirty = false;
const db = loadData();
function persist() {
  if (dirty) return;
  dirty = true;
  setTimeout(() => {
    dirty = false;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { /* read-only fs */ }
  }, 250);
}

// ---------------------------------------------------------------- helpers

function sendJson(res, code, obj, headers) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(JSON.stringify(obj));
}
function sendError(res, code, msg) { sendJson(res, code, { error: msg }); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 65536)) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// Simple per-IP rate limiting (recoverable: client backs off on 429).
const hits = new Map();
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, reset: now + 10000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 10000; }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > 60;
}

const VALID_BOARDS = ['daily', 'journey', 'challenge'];
const ACHIEVEMENT_KEYS = ['first-clear', 'gear-master', 'streak-3', 'tower-top', 'centurion'];

// Plausibility: a score can never exceed completion + all gears + max bonuses.
function plausible(breakdown, level) {
  if (!breakdown || typeof breakdown.total !== 'number') return false;
  if (!Number.isInteger(breakdown.total) || breakdown.total < 0 || breakdown.total > 100000) return false;
  const gearCount = (level.ascii.match(/\*/g) || []).length;
  const ceiling = 1000 + gearCount * 150 + (level.par ? level.par.ticks * 2 + level.par.moves * 5 : 0);
  return breakdown.total <= ceiling;
}

// ---------------------------------------------------------------- API

async function handleApi(req, res, url) {
  if (rateLimited(req)) return sendError(res, 429, 'rate limit — back off and retry');

  if (url.pathname === '/api/v1/time' && req.method === 'GET') {
    return sendJson(res, 200, { now: Date.now() });
  }

  if (url.pathname === '/api/v1/daily' && req.method === 'GET') {
    const d = dailyLevel(new Date());
    return sendJson(res, 200, {
      key: d.dailyKey, seed: d.seed, contentVersion: CONTENT_VERSION, schema: SCHEMA_VERSION,
    });
  }

  if (url.pathname === '/api/v1/scores' && req.method === 'GET') {
    const board = url.searchParams.get('board') || 'daily';
    if (!VALID_BOARDS.includes(board)) return sendError(res, 400, 'unknown board');
    const entries = (db.scores[board] || []).slice(0, 50);
    return sendJson(res, 200, { entries, casual: false });
  }

  if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
    const body = await readBody(req, 262144);
    const { board, levelId, name, sessionId, breakdown, envelope, meta } = body;
    if (!VALID_BOARDS.includes(board)) return sendError(res, 400, 'unknown board');
    if (typeof name !== 'string' || name.length > 24) return sendError(res, 400, 'bad name');
    if (!envelope || envelope.schema !== SCHEMA_VERSION) return sendError(res, 400, 'stale schema version');
    if (envelope.build !== CONTENT_VERSION) return sendError(res, 422, 'stale content version — refresh and replay');

    let level;
    try { level = getLevel(levelId); } catch (e) { return sendError(res, 400, 'unknown level'); }
    if (level.seed !== envelope.seed) return sendError(res, 400, 'seed mismatch');
    if (!plausible(breakdown, level)) return sendError(res, 422, 'implausible score');

    // Authoritative validation: deterministic replay of the input log.
    const check = replay(level, envelope);
    if (!check.ok) return sendError(res, 422, 'replay failed: ' + check.reason);
    if (!check.result.won) return sendError(res, 422, 'run did not complete');
    const serverBreakdown = check.result.score;
    if (serverBreakdown.total !== breakdown.total) {
      return sendError(res, 422, 'score mismatch: client ' + breakdown.total + ' vs server ' + serverBreakdown.total);
    }

    const entries = db.scores[board] || (db.scores[board] = []);
    // Idempotent by session + level: resubmits replace, never duplicate.
    const entry = {
      name, sessionId, levelId, score: breakdown.total, breakdown,
      seed: level.seed, version: CONTENT_VERSION,
      assists: !!(meta && meta.assists), durationMs: meta && meta.durationMs,
      finalHash: check.finalHash, at: new Date().toISOString(),
    };
    const existing = entries.findIndex(e => e.sessionId === sessionId && e.levelId === levelId);
    if (existing >= 0) entries.splice(existing, 1);
    entries.push(entry);
    entries.sort((a, b) => b.score - a.score || (a.durationMs || 0) - (b.durationMs || 0) || String(a.sessionId).localeCompare(String(b.sessionId)));
    db.scores[board] = entries.slice(0, 100);
    persist();
    const rank = db.scores[board].findIndex(e => e.sessionId === sessionId && e.levelId === levelId) + 1;
    return sendJson(res, 200, { ok: true, rank, validated: true });
  }

  if (url.pathname === '/api/v1/achievements' && req.method === 'POST') {
    const body = await readBody(req);
    const { key, sessionId, name } = body;
    if (!ACHIEVEMENT_KEYS.includes(key)) return sendError(res, 400, 'unknown achievement');
    if (typeof sessionId !== 'string' || sessionId.length > 40) return sendError(res, 400, 'bad session');
    const owner = name || sessionId;
    const rec = db.achievements[owner] || (db.achievements[owner] = {});
    const already = !!rec[key];
    if (!already) { rec[key] = new Date().toISOString(); persist(); }
    return sendJson(res, 200, { ok: true, key, already }); // idempotent
  }

  if (url.pathname === '/api/v1/save' && req.method === 'GET') {
    const name = url.searchParams.get('name') || 'Guest';
    const doc = db.saves[name];
    if (!doc) return sendJson(res, 200, { ok: true, doc: null });
    return sendJson(res, 200, { ok: true, doc });
  }

  if (url.pathname === '/api/v1/save' && req.method === 'PUT') {
    const body = await readBody(req, 131072);
    const { name, doc } = body;
    if (typeof name !== 'string' || name.length > 24) return sendError(res, 400, 'bad name');
    if (!doc || typeof doc !== 'object') return sendError(res, 400, 'bad document');
    const prev = db.saves[name];
    // Conflict policy: keep both snapshots; client resolves when neither is a
    // strict descendant (here: newer savedAt wins, previous kept under .conflict).
    if (prev && prev.savedAt > doc.savedAt) {
      return sendJson(res, 200, { ok: true, conflict: true, kept: prev });
    }
    if (prev && prev.savedAt !== doc.savedAt) doc.conflict = prev;
    db.saves[name] = doc;
    persist();
    return sendJson(res, 200, { ok: true, conflict: false });
  }

  if (url.pathname === '/api/v1/funnel' && req.method === 'POST') {
    const body = await readBody(req, 8192);
    const allowed = ['start', 'tutorial-step', 'round-start', 'round-end', 'retry', 'settings-change', 'error'];
    if (allowed.includes(body.event)) {
      db.funnel.push({ event: body.event, at: Date.now() });
      if (db.funnel.length > 5000) db.funnel = db.funnel.slice(-2500);
      persist();
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'unknown endpoint');
}

// ---------------------------------------------------------------- static

const IMMUTABLE = /\.(js|css|png|svg)$/;

function handleStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return sendError(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return sendError(res, 404, 'not found');
    const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (IMMUTABLE.test(file)) headers['cache-control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return handleStatic(req, res, url);
  } catch (e) {
    return sendError(res, 500, 'internal error');
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => { console.log('Trickstep Tower serving on http://localhost:' + PORT); });
}

export default server;
export { handleApi, plausible };
