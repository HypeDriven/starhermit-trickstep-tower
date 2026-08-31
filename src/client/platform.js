'use strict';

// Trickstep Tower — platform adapter: same-origin /api routes with offline
// fallback. Tokens are never persisted; guest practice works fully offline.

export class Platform {
  constructor() {
    const storage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || { getItem: () => null, setItem: () => {} };
    this._storage = storage;
    this.online = false;
    this.timeOffset = 0; // server-now minus client-now (round-trip adjusted)
    this.rateLimitedUntil = 0;
    this.playerName = storage.getItem('tt-name') || 'Guest';
    this.sessionId = 's-' + Math.random().toString(36).slice(2, 10);
  }

  async init() {
    try {
      await this.syncTime();
      this.online = true;
    } catch (e) {
      this.online = false;
    }
    return this.online;
  }

  now() { return Date.now() + this.timeOffset; }

  async syncTime() {
    const t0 = Date.now();
    const res = await this._fetch('/api/v1/time');
    const t1 = Date.now();
    const data = await res.json();
    // Round-trip-adjusted offset.
    this.timeOffset = data.now - (t0 + (t1 - t0) / 2);
  }

  async _fetch(url, opts, retries) {
    if (Date.now() < this.rateLimitedUntil) throw new Error('rate-limited');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = Math.min(30000, 2000 * Math.pow(2, (retries || 0)));
        this.rateLimitedUntil = Date.now() + wait;
        throw new Error('rate-limited');
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('http-' + res.status));
        return { json: async () => data, ok: true, status: res.status, headers: res.headers };
      }
      if (!res.ok) throw new Error('http-' + res.status);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if ((retries || 0) < 2 && e.name !== 'AbortError' && !/rate-limited|http-4/.test(e.message)) {
        return this._fetch(url, opts, (retries || 0) + 1);
      }
      throw e;
    }
  }

  async getDaily() {
    const res = await this._fetch('/api/v1/daily');
    return res.json();
  }

  // Submit a score with its replay envelope for authoritative validation.
  async submitScore(board, levelId, breakdown, envelope, meta) {
    if (!this.online) return this._localSubmit(board, levelId, breakdown, meta);
    try {
      const res = await this._fetch('/api/v1/scores', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          board, levelId, name: this.playerName, sessionId: this.sessionId,
          breakdown, envelope, meta,
        }),
      });
      const data = await res.json();
      return { ...data, validated: true };
    } catch (e) {
      const local = this._localSubmit(board, levelId, breakdown, meta);
      return { ...local, validated: false, error: e.message };
    }
  }

  async getScores(board) {
    if (!this.online) return { entries: this._localBoard(board), casual: true };
    try {
      const res = await this._fetch('/api/v1/scores?board=' + encodeURIComponent(board));
      return await res.json();
    } catch (e) {
      return { entries: this._localBoard(board), casual: true, error: e.message };
    }
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

  async unlockAchievement(key) {
    if (!this.online) return { ok: false, offline: true };
    try {
      const res = await this._fetch('/api/v1/achievements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, sessionId: this.sessionId, name: this.playerName }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Cloud save: versioned, checksummed document; conflicts kept on both sides.
  async saveCloud(doc) {
    if (!this.online) return { ok: false, offline: true };
    try {
      const res = await this._fetch('/api/v1/save', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.playerName, doc }),
      });
      return await res.json();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async loadCloud() {
    if (!this.online) return { ok: false, offline: true };
    try {
      const res = await this._fetch('/api/v1/save?name=' + encodeURIComponent(this.playerName));
      return await res.json();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Anonymous funnel events (aggregate only; no text, no identifiers beyond session).
  funnel(event, props) {
    const payload = { event, props: props || {}, session: this.sessionId, at: Date.now() };
    if (this.online) {
      this._fetch('/api/v1/funnel', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }).catch(() => {});
    }
  }
}
