'use strict';

// Trickstep Tower — StarHermit platform adapter.
// All platform traffic goes through the canonical SDK (`starhermit-sdk.js`,
// global `StarHermit`, initialised from index.html before this module runs).
// Hosted mode = the SDK holds a launch token (#game_token / #access_token).
// Without one the adapter makes no network calls at all: progress, boards
// and preferences stay in localStorage.
//
// Hosted: profile nickname as the display name, cloud save in the
// `game:<slug>` slot (remote-first load, debounced save, flush on pagehide),
// per-player settings KV, platform control bindings, the invite share link,
// the read-only platform leaderboard, and launch-token renewal (SDK). The
// game's own server routes (/api/v1/scores, /api/v1/funnel) are tried first
// and degrade to the local casual board when absent.

function localStore() {
  return (typeof globalThis !== 'undefined' && globalThis.localStorage) || { getItem: () => null, setItem: () => {} };
}

export class Platform {
  constructor(opts) {
    opts = opts || {};
    const storage = opts.storage || localStore();
    this._storage = storage;
    this.sh = opts.sh || (typeof globalThis !== 'undefined' ? globalThis.StarHermit : null) || null;
    this.online = false;
    this.timeOffset = 0; // server-now minus client-now (round-trip adjusted)
    this.localName = storage.getItem('tt-name') || 'Guest';
    this.playerName = this.localName;
    this.sessionId = 's-' + Math.random().toString(36).slice(2, 10);
    this.userId = null;
    this.gameSlug = null;
    this.hosted = false;
    this.profile = null;
    this.cloudDoc = null; // winning save doc after init (remote preferred)
    this.syncStatus = 'offline'; // offline | saving | synced | error
    this.onAuthChange = null; // (signedIn) => void, set by the game
    if (this.sh) {
      this.sh.on('saved', (ok) => this._setSyncStatus(ok ? 'synced' : 'error'));
      this.sh.on('auth', (e) => this._onAuth(e));
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => this._flushCloud());
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushCloud(); });
      }
    }
  }

  get token() { return this.sh ? this.sh.token : null; }

  async init() {
    const sh = this.sh;
    if (!sh || !sh.token) return this.online; // standalone: no network at all
    this.hosted = true;
    this.userId = sh.userId;
    this.gameSlug = sh.slug;
    if (sh.launchSessionId) this.sessionId = sh.launchSessionId;
    try { await this.syncTime(); } catch (e) { this.timeOffset = 0; }
    this.online = true;
    await this._loadProfile();
    const res = await this.loadCloud();
    this.cloudDoc = res.doc || null;
    this._setSyncStatus('synced');
    return this.online;
  }

  _onAuth(e) {
    if (e && e.signedIn) return;
    // Renewal refused / token expired: keep playing locally.
    this.hosted = false;
    this.online = false;
    this.playerName = this.localName;
    this._setSyncStatus('offline');
    if (this.onAuthChange) this.onAuthChange(false);
  }

  now() { return Date.now() + this.timeOffset; }

  async syncTime() {
    const t0 = Date.now();
    const data = await this.sh.api('/api/v1/time');
    const t1 = Date.now();
    const serverMs = Number(data && (data.now ?? data.serverTime ?? data.epochMs));
    if (!Number.isFinite(serverMs)) throw new Error('no-time');
    this.timeOffset = serverMs - (t0 + (t1 - t0) / 2);
  }

  // ---- sign-in / invite ---------------------------------------------------

  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }
  inviteLink() { return this.hosted && this.sh ? this.sh.inviteLink() : null; }

  // ---- profile ------------------------------------------------------------

  // Display nickname, fallback "Player <id prefix>" (SDK convention).
  async _loadProfile() {
    const p = await this.sh.profile();
    if (p) { this.profile = p; this.playerName = p.displayName; }
  }

  async profileName(userId) {
    if (!userId) return null;
    const p = this.hosted ? await this.sh.profile(userId) : null;
    return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
  }

  // ---- settings KV & controls ---------------------------------------------

  async getSettings() { return this.hosted ? this.sh.getSettings() : {}; }
  patchSettings(obj) { if (this.hosted) this.sh.patchSettings(obj); }
  async loadBindings(defaults) {
    if (!this.hosted) {
      const out = {};
      for (const k of Object.keys(defaults)) out[k] = defaults[k].slice();
      return out;
    }
    return this.sh.loadBindings(defaults);
  }

  // ---- scores -------------------------------------------------------------

  // Record a won ranked run on the local casual board and, when signed in,
  // post its total to the platform `high-score` board through
  // StarHermit.submitScores (score-script.js range-checks it). Resolves
  // { rank, casual, posted } — rank on the platform board when posted.
  async submitScore(board, levelId, breakdown, envelope, meta) {
    const local = this._localSubmit(board, levelId, breakdown, meta);
    if (!this.hosted || typeof this.sh.submitScores !== 'function') return { ...local, posted: false };
    let keys = [];
    try { keys = await this.sh.submitScores({ 'high-score': breakdown.total }); } catch (e) { keys = []; }
    if (!keys || keys.indexOf('high-score') < 0) return { rank: null, casual: false, posted: false };
    try {
      const r = await this.sh.leaderboard('high-score', { pageSize: 100 });
      const me = ((r && r.items) || []).find(i => i.userId === this.sh.userId);
      return { rank: me ? me.rank : null, casual: false, posted: true };
    } catch (e) { return { rank: null, casual: false, posted: true }; }
  }

  // Hosted: the platform `high-score` board (or the game's first board);
  // otherwise the local casual board.
  async getScores(board) {
    if (this.hosted) {
      let r = await this.sh.leaderboard('high-score', { pageSize: 20 });
      if (!r.board) r = await this.sh.leaderboard(null, { pageSize: 20 });
      if (r.board) {
        const entries = [];
        for (const e of (r.items || []).slice(0, 20)) {
          entries.push({ name: e.nickname || (await this.profileName(e.userId)) || e.username, score: Number(e.score) || 0 });
        }
        return { entries, casual: false, platform: true };
      }
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
  // slot. Clients can never write platform achievements.
  async unlockAchievement(key) {
    return { ok: true, offline: !this.hosted };
  }

  // ---- cloud save ---------------------------------------------------------

  _readLocalCloud() {
    try {
      const doc = JSON.parse(this._storage.getItem('tt-cloud-doc') || 'null');
      return doc && typeof doc === 'object' ? doc : null;
    } catch (e) { return null; }
  }

  _writeLocalCloud(doc) {
    try { this._storage.setItem('tt-cloud-doc', JSON.stringify(doc)); } catch (e) { /* full/blocked */ }
  }

  _setSyncStatus(status) { this.syncStatus = status; }

  // localStorage is written synchronously; the cloud write is debounced ~2 s
  // by the SDK and flushed on pagehide/visibilitychange.
  async saveCloud(doc) {
    this._writeLocalCloud(doc);
    if (!this.hosted) {
      this._setSyncStatus('offline');
      return { ok: true, offline: true };
    }
    this._setSyncStatus('saving');
    this.sh.saveJSON(doc, 2000);
    return { ok: true, queued: true };
  }

  _flushCloud() {
    if (this.hosted && this.sh) return this.sh.flushSave(true);
    return Promise.resolve(false);
  }

  // Remote-preferred load: the newer of the cloud slot and the local cache
  // wins; no slot means "no save yet". Never throws.
  async loadCloud() {
    const local = this._readLocalCloud();
    if (!this.hosted) return { ok: true, doc: local };
    const doc = await this.sh.loadJSON();
    if (doc && typeof doc === 'object' && (!local || (doc.savedAt || 0) >= (local.savedAt || 0))) {
      this._writeLocalCloud(doc);
      return { ok: true, doc, remote: true };
    }
    return { ok: true, doc: local };
  }

  // ---- funnel -------------------------------------------------------------

  // Anonymous aggregate events to the game's own server only when hosted.
  funnel(event, props) {
    if (!this.hosted) return;
    this.sh.api('/api/v1/funnel', { method: 'POST', body: { event, ...(props || {}) } }).catch(() => {});
  }
}
