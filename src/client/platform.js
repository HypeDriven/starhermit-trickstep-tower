'use strict';

// Trickstep Tower — StarHermit platform adapter.
// Hosted mode activates iff a launch token was read from the URL fragment
// (`#game_token=<jwt>`); local dev may pass `?game_token=`/`?token=` instead.
// The token travels as `Authorization: Bearer` on every REST call and is
// re-minted every 45 min via POST /api/v1/games/{scope}/launch-token. Identity
// is the profile nickname (never a username, never /api/v1/me). Progress is
// checksummed localStorage first; the cloud slot is a zip+base64 mirror.
// Scores submit to the game's own server (declared in starhermit.txt) when
// hosted, with the local casual board as fallback; the platform leaderboard
// is read-only. Achievements stay local (part of the cloud-saved doc).

const REFRESH_MS = 45 * 60 * 1000; // launch tokens live 60 min; renew at 45
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;
const CLOUD_KEY = 'tt-cloud-doc';

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export class Platform {
  constructor() {
    const storage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || { getItem: () => null, setItem: () => {} };
    this._storage = storage;
    this.online = false;
    this.timeOffset = 0; // server-now minus client-now (round-trip adjusted)
    this.playerName = storage.getItem('tt-name') || 'Guest';
    this.sessionId = 's-' + Math.random().toString(36).slice(2, 10);
    // StarHermit identity (empty in local play).
    this.token = null;
    this.userId = null;
    this.gameSlug = null;
    this.hosted = false;
    this.profile = null;
    this.cloudDoc = null; // winning save doc after init (remote preferred)
    this.syncStatus = 'offline'; // offline | saving | synced | error
    this._nameCache = new Map();
    this._cloudTimer = null;
    this._cloudPending = null;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => this._flushCloud());
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushCloud(); });
      }
    }
  }

  async init() {
    this._readLaunchToken();
    try {
      await this.syncTime();
      this.online = true;
    } catch (e) {
      this.online = false;
      this.timeOffset = 0;
    }
    if (this.token) {
      this.hosted = true;
      this._scheduleRefresh(REFRESH_MS);
      await this._loadProfile();
      const res = await this.loadCloud();
      this.cloudDoc = res.doc || null;
      this._setSyncStatus(this.online ? 'synced' : 'offline');
    }
    return this.online;
  }

  now() { return Date.now() + this.timeOffset; }

  // Bearer on every REST call; unauthenticated local dev hits stay bare.
  _api(path, opts) {
    opts = opts || {};
    if (this.token) {
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + this.token });
    }
    return fetch(path, opts);
  }

  async syncTime() {
    const t0 = Date.now();
    const res = await this._api('/api/v1/time', { cache: 'no-store' });
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    const t1 = Date.now();
    // Hosts expose the epoch under different keys (`now`, `serverTime`, `epochMs`).
    const serverMs = Number(data.now ?? data.serverTime ?? data.epochMs);
    if (!Number.isFinite(serverMs)) throw new Error('no-time');
    // Round-trip-adjusted offset.
    this.timeOffset = serverMs - (t0 + (t1 - t0) / 2);
  }

  // ---- launch token -------------------------------------------------------

  _readLaunchToken() {
    const loc = (typeof window !== 'undefined' && window.location) || null;
    if (!loc) return;
    let token = null;
    if ((loc.hash || '').indexOf('game_token=') !== -1) {
      const params = new URLSearchParams(loc.hash.slice(1));
      token = params.get('game_token');
      const sid = params.get('session_id');
      if (sid) this.sessionId = sid;
      // Read once, then strip: the token never survives in the URL.
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', loc.pathname + loc.search);
      }
    }
    if (!token) {
      // Local-dev-only fallbacks; the platform always uses the fragment.
      const q = new URLSearchParams(loc.search);
      token = q.get('game_token') || q.get('launch_token') || q.get('token') || q.get('launch');
    }
    if (!token) return;
    this.token = token;
    try {
      const part = token.split('.')[1] || '';
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
      if (payload.sub) this.userId = String(payload.sub);
      if (payload.game_scope) this.gameSlug = String(payload.game_scope);
    } catch (e) { /* malformed payload: keep the raw token */ }
    if (this.userId) this.playerName = 'Player ' + this.userId.slice(0, 8);
  }

  _scheduleRefresh(delay) {
    if (!this.token || !this.gameSlug) return;
    const t = setTimeout(() => this._refreshToken(), delay);
    if (t.unref) t.unref();
  }

  async _refreshToken() {
    try {
      const res = await this._api('/api/v1/games/' + this.gameSlug + '/launch-token', { method: 'POST' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const next = data.token || data.launchToken || data.access_token;
        if (next) this.token = next; // scoped tokens re-mint; swap in place
        this._scheduleRefresh(REFRESH_MS);
        return;
      }
    } catch (e) { /* offline or rate-limited: retry sooner */ }
    this._scheduleRefresh(REFRESH_RETRY_MS);
  }

  // ---- profile ------------------------------------------------------------

  // Display nickname only — never the username, never GET /api/v1/me.
  async _loadProfile() {
    if (!this.userId) return;
    try {
      const res = await this._api('/api/v1/users/' + this.userId + '/profile');
      if (res.ok) {
        const p = await res.json().catch(() => ({}));
        if (p && p.nickname) { this.playerName = p.nickname; this.profile = p; return; }
      }
    } catch (e) { /* offline/private: keep the "Player "+id8 fallback */ }
  }

  async profileName(userId) {
    if (!userId) return null;
    if (this._nameCache.has(userId)) return this._nameCache.get(userId);
    let name = null;
    try {
      const res = await this._api('/api/v1/users/' + userId + '/profile');
      if (res.ok) {
        const p = await res.json().catch(() => ({}));
        name = p && p.nickname ? p.nickname : null;
      }
    } catch (e) { /* fall through to the id fallback */ }
    if (!name) name = 'Player ' + String(userId).slice(0, 8);
    this._nameCache.set(userId, name);
    return name;
  }

  // ---- scores -------------------------------------------------------------

  // Submit a score with its replay envelope. Hosted: the game's own server
  // (declared in starhermit.txt) validates the replay; any failure degrades
  // to the local casual board. Local play: casual board only.
  async submitScore(board, levelId, breakdown, envelope, meta) {
    if (this.hosted) {
      try {
        const res = await this._api('/api/v1/scores', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            board, levelId, name: this.playerName, sessionId: this.sessionId,
            breakdown, envelope, meta,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.validated) return { rank: data.rank, validated: true };
        return {
          ...this._localSubmit(board, levelId, breakdown, meta),
          validated: false,
          error: (data && data.error) || ('http-' + res.status),
        };
      } catch (e) {
        return { ...this._localSubmit(board, levelId, breakdown, meta), validated: false, error: String((e && e.message) || e) };
      }
    }
    return { ...this._localSubmit(board, levelId, breakdown, meta), validated: false };
  }

  // Read-only everywhere: hosted prefers the validated own-server board, then
  // the platform leaderboard (clients never submit there); otherwise local.
  async getScores(board) {
    if (this.hosted) {
      try {
        const res = await this._api('/api/v1/scores?board=' + encodeURIComponent(board));
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (Array.isArray(data.entries)) return { entries: data.entries, casual: false, validated: true };
        }
      } catch (e) { /* own server unreachable: try the platform board */ }
      try {
        const g = await this._api('/api/v1/games/' + this.gameSlug);
        if (g.ok) {
          const meta = await g.json().catch(() => ({}));
          const lb = meta && meta.leaderboardId;
          if (lb) {
            const r = await this._api('/api/v1/leaderboards/' + lb + '/entries?page=1&pageSize=20');
            if (r.ok) {
              const data = await r.json().catch(() => ({}));
              const raw = Array.isArray(data.entries) ? data.entries : (Array.isArray(data) ? data : []);
              const entries = [];
              for (const e of raw.slice(0, 20)) {
                const uid = e.userId || e.user_id || (e.user && e.user.id);
                entries.push({
                  name: e.nickname || (await this.profileName(uid)),
                  score: typeof e.score === 'number' ? e.score : (e.value || 0),
                });
              }
              return { entries, casual: false, platform: true };
            }
          }
        }
      } catch (e) { /* no platform board: local records below */ }
    }
    return { entries: this._localBoard(board), casual: true };
  }

  _localBoard(board) {
    try { return JSON.parse(this._storage.getItem('tt-board-' + board) || '[]'); } catch (e) { return []; }
  }

  _localSubmit(board, levelId, breakdown, meta) {
    const entries = this._localBoard(board);
    entries.push({
      name: this.playerName, score: breakdown.total, breakdown,
      levelId, at: new Date().toISOString(), meta, local: true,
    });
    entries.sort((a, b) => b.score - a.score);
    const trimmed = entries.slice(0, 50);
    try { this._storage.setItem('tt-board-' + board, JSON.stringify(trimmed)); } catch (e) { /* full */ }
    return { rank: trimmed.findIndex(e => e.score === breakdown.total) + 1, casual: true };
  }

  // ---- achievements -------------------------------------------------------

  // Local only: unlocks live in the progress doc and mirror to the cloud
  // slot. A pure browser game has no server-authoritative unlock path.
  async unlockAchievement(key) {
    return { ok: true, offline: !this.hosted };
  }

  // ---- cloud save ---------------------------------------------------------

  _readLocalCloud() {
    try {
      const doc = JSON.parse(this._storage.getItem(CLOUD_KEY) || 'null');
      return doc && typeof doc === 'object' ? doc : null;
    } catch (e) { return null; }
  }

  _writeLocalCloud(doc) {
    try { this._storage.setItem(CLOUD_KEY, JSON.stringify(doc)); } catch (e) { /* full/blocked */ }
  }

  _setSyncStatus(status) {
    this.syncStatus = status;
  }

  // Mirror `doc` to the platform cloud slot. localStorage remains the offline
  // cache and is written synchronously; the PUT is debounced ~2 s and flushed
  // on pagehide/visibilitychange.
  async saveCloud(doc) {
    this._writeLocalCloud(doc);
    if (!this.token || !this.gameSlug) {
      this._setSyncStatus(this.online ? 'synced' : 'offline');
      return { ok: true, offline: true };
    }
    this._cloudPending = doc;
    this._setSyncStatus('saving');
    if (this._cloudTimer) clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this._flushCloud(), CLOUD_DEBOUNCE_MS);
    if (this._cloudTimer.unref) this._cloudTimer.unref();
    return { ok: true, queued: true };
  }

  async _flushCloud() {
    if (this._cloudTimer) { clearTimeout(this._cloudTimer); this._cloudTimer = null; }
    const doc = this._cloudPending;
    if (!doc) return;
    const body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)))) });
    try {
      const res = await this._api('/api/v1/me/cloud-saves/' + this.gameSlug, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: true,
      });
      if (!res.ok) throw new Error('http-' + res.status);
      this._cloudPending = null;
      this._setSyncStatus('synced');
    } catch (e) {
      // Keep the pending doc: the next save (or next flush) retries.
      this._setSyncStatus(this.online ? 'error' : 'offline');
    }
  }

  // Remote-preferred load: the newer of the cloud slot and the local cache
  // wins; 404 means "no save yet". Never throws — local play is untouched.
  async loadCloud() {
    const local = this._readLocalCloud();
    if (!this.token || !this.gameSlug) return { ok: true, doc: local };
    try {
      const res = await this._api('/api/v1/me/cloud-saves/' + this.gameSlug);
      if (res.status === 404) return { ok: true, doc: local };
      if (!res.ok) throw new Error('http-' + res.status);
      const raw = unzipFirstEntry(new Uint8Array(await res.arrayBuffer()));
      const doc = JSON.parse(new TextDecoder().decode(raw));
      if (doc && typeof doc === 'object' && (!local || (doc.savedAt || 0) >= (local.savedAt || 0))) {
        this._writeLocalCloud(doc);
        return { ok: true, doc, remote: true };
      }
      return { ok: true, doc: local };
    } catch (e) {
      return { ok: false, doc: local, error: String((e && e.message) || e) };
    }
  }

  // ---- funnel -------------------------------------------------------------

  // Anonymous aggregate events to the game's own server only when hosted;
  // silently absent otherwise (no platform funnel route exists).
  funnel(event, props) {
    if (!this.hosted) return;
    this._api('/api/v1/funnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, ...(props || {}) }),
    }).catch(() => {});
  }
}
