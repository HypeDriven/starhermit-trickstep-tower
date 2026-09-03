'use strict';

// Trickstep Tower — platform adapter. The host guarantees exactly one route,
// GET /api/v1/time; it is probed once at startup as the connectivity check.
// Every other hosted feature (scores, achievements, cloud save, funnel)
// degrades to a local no-op and never issues a request. Tokens are never
// persisted; guest practice works fully offline.

export class Platform {
  constructor() {
    const storage = (typeof globalThis !== 'undefined' && globalThis.localStorage) || { getItem: () => null, setItem: () => {} };
    this._storage = storage;
    this.online = false;
    this.timeOffset = 0; // server-now minus client-now (round-trip adjusted)
    this.playerName = storage.getItem('tt-name') || 'Guest';
    this.sessionId = 's-' + Math.random().toString(36).slice(2, 10);
  }

  async init() {
    try {
      await this.syncTime();
      this.online = true;
    } catch (e) {
      this.online = false;
      this.timeOffset = 0;
    }
    return this.online;
  }

  now() { return Date.now() + this.timeOffset; }

  async syncTime() {
    const t0 = Date.now();
    const res = await fetch('/api/v1/time', { cache: 'no-store' });
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    const t1 = Date.now();
    // Hosts expose the epoch under different keys (`now`, `serverTime`, `epochMs`).
    const serverMs = Number(data.now ?? data.serverTime ?? data.epochMs);
    if (!Number.isFinite(serverMs)) throw new Error('no-time');
    // Round-trip-adjusted offset.
    this.timeOffset = serverMs - (t0 + (t1 - t0) / 2);
  }

  // Submit a score with its replay envelope. No hosted scores route exists,
  // so this is always the local casual board.
  async submitScore(board, levelId, breakdown, envelope, meta) {
    return { ...this._localSubmit(board, levelId, breakdown, meta), validated: false };
  }

  async getScores(board) {
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

  async unlockAchievement(key) {
    return { ok: false, offline: true };
  }

  // Cloud save is a no-op: progress persists in local storage only.
  async saveCloud(doc) {
    return { ok: false, offline: true };
  }

  async loadCloud() {
    return { ok: false, offline: true };
  }

  // Anonymous funnel events: no hosted route exists, so this is a no-op.
  funnel(event, props) {}
}
