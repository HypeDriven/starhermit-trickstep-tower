// Trickstep Tower on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js) and content
// (src/content.js) are the browser build's, unchanged; this module is what
// game.js did around them: the session (a 20 Hz rules step every third
// 60 Hz fixed step, edge-triggered jumps, footsteps, Practice undo every
// half second, replay hashes), the countdown, pause / resume / retry / leave,
// the paused-run snapshot and "Resume paused run", results with progress,
// achievements and the daily streak, the local casual boards and the
// StarHermit high-score post of won ranked runs, and the lifecycle (a hidden
// window pauses the round). Screens are drawn by screens.ts (starhermit:ui),
// the tower by render.ts (starhermit:scene).
import { frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, isDown, onAction, setTouchControls, touchControlsVisible, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { clipboard } from "starhermit:engine";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { C, L, R, SaveModel, type Breakdown, type Ev, type Input, type Level, type State } from "./game.ts";
import * as audio from "./audio.ts";
import { pt, t } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Overlay = "title" | "modes" | "learn" | "journey" | "practice" | "challenges" | "scores" | "settings" | "profile" | "help" | "pause" | "results" | null;
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge";
export interface Result { won: boolean; reason: string; breakdown: Breakdown; ticks: number; durationMs: number }
export interface LbLine { key: string; vars?: Record<string, string | number>; platform?: boolean }
export const ACHIEVEMENTS = [
  { key: "first-clear", name: "achFirstClear" }, { key: "gear-master", name: "achGearMaster" }, { key: "streak-3", name: "achStreak3" },
  { key: "tower-top", name: "achTowerTop" }, { key: "centurion", name: "achCenturion" },
];

// ------------------------------------------------------------------ the session (game.js Session)
export class Session {
  state: State;
  commands: { tick: number; input: Input }[] = [];
  hashes: { tick: number; hash: number }[] = [];
  undoStack: string[] = [];
  pendingJumpId = 0;
  consumedJumpId = 0;
  over = false;
  result: Result | null = null;
  stepAcc = 0;
  startedAt: number;
  ranked: boolean;
  newly: string[] = [];
  lb: LbLine | null = null;
  limitW = 0;
  constructor(public level: Level, public mode: Mode, public opts: Record<string, unknown> = {}) {
    this.ranked = mode === "journey" || mode === "daily" || mode === "challenge";
    this.state = R.createState(level);
    this.startedAt = platform.nowMs();
  }
  sampleInput(): Input {
    const left = isDown("left"), right = isDown("right");
    const move = left ? -1 : right ? 1 : 0;
    let jump: 0 | 1 = 0;
    if (this.pendingJumpId > this.consumedJumpId) { jump = 1; this.consumedJumpId = this.pendingJumpId; }
    return { move, jump };
  }
  tick(): void {
    const s = this.state;
    const inp = this.sampleInput();
    const wasAirborne = !s.player.onGround;
    const prevInvalid = s.invalid;
    if (inp.move !== 0 || inp.jump) {
      const last = this.commands[this.commands.length - 1];
      if (last && last.tick === s.tick) last.input = inp;
      else this.commands.push({ tick: s.tick, input: inp });
    }
    const events = R.step(s, inp);
    if (s.invalid > prevInvalid) { sound("invalid"); announce(t("invalidAction"), true); }
    for (const ev of events) this.onEvent(ev);
    if (wasAirborne && s.player.onGround) sound("land");
    if (s.player.onGround && !s.over && Math.abs(s.player.vx) > 0) {
      this.stepAcc += Math.abs(s.player.vx) * (R.TICK_MS / 1000);
      if (this.stepAcc >= 1) { this.stepAcc = 0; sound("step"); }
    } else this.stepAcc = 0;
    if (this.mode === "practice" && s.tick % 10 === 0) {
      this.undoStack.push(R.serialize(s));
      if (this.undoStack.length > 40) this.undoStack.shift();
    }
    if (s.tick % 100 === 0) this.hashes.push({ tick: s.tick, hash: R.stateHash(s) });
    if (s.over && !this.over) this.finish();
  }
  onEvent(ev: Ev): void {
    const s = this.state;
    const [wx, wy] = render.worldOf(s.player.x, s.player.y);
    switch (ev.t) {
      case "death":
        sound("death"); haptic(60); render.kickShake(0.7); render.burst(wx, wy, "#ff5a4e", 24, 4);
        announce(t(ev.why === "spikes" ? "trapSpikes" : "trapFall"), true);
        break;
      case "gear": sound("gear"); haptic(20); render.burst(wx, wy, "#ffd777", 14, 3); break;
      case "checkpoint": sound("checkpoint"); announce(t("checkpointReached")); break;
      case "spring": sound("spring"); render.kickShake(0.2); break;
      case "reveal": sound("reveal"); announce(t("trickShimmer")); break;
      case "win": sound("win"); render.burst(wx, wy, "#9affd0", 40, 5); break;
      case "fail": sound("fail"); break;
    }
  }
  undo(): void {
    if (this.mode !== "practice") return;
    const target = this.undoStack.length > 4 ? this.undoStack[this.undoStack.length - 4] : this.undoStack[0];
    if (!target) return;
    this.state = R.deserialize(target);
    this.undoStack.length = Math.max(0, this.undoStack.length - 4);
    sound("ui");
    announce(t("undone"));
  }
  finish(): void {
    this.over = true;
    this.hashes.push({ tick: this.state.tick, hash: R.stateHash(this.state) });
    this.result = {
      won: this.state.won, reason: R.terminalReason(this.state), breakdown: R.scoreBreakdown(this.state, this.level.par),
      ticks: this.state.tick, durationMs: platform.nowMs() - this.startedAt,
    };
    app.flow = "resolving";
    app.resultsAt = steps + 36; // 600 ms
  }
}

// ------------------------------------------------------------------ app state
export const app = {
  overlay: "title" as Overlay,
  openedFrame: 0,
  focusNext: null as string | null,
  /** title | menu | countdown | active | paused | resolving | results (game.js setState). */
  flow: "title",
  session: null as Session | null,
  returnTo: "title" as "title" | "pause",
  board: { tab: "daily", entries: null as { name: string; score: number; local?: boolean; won?: boolean }[] | null, platform: false },
  practice: { stage: 0, diff: 1 },
  nameDraft: null as string | null,
  toast: null as { text: string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  countdown: null as string | null,
  countN: 0,
  countAt: 0,
  countHide: 0,
  resultsAt: 0,
};
let steps = 0; // fixed steps (60 Hz) since start
export const now = (): number => steps / 60;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (#live polite, #live-assert assertive): one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  if (!spoken.includes(text)) spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
export function toast(text: string, ms = 3500): void { app.toast = { text, until: now() + ms / 1000 }; announce(text); }
const CAPTIONS: Partial<Record<audio.Sfx, string>> = {
  land: "capLand", gear: "capGear", death: "capDeath", checkpoint: "capCheckpoint", spring: "capSpring", win: "capWin", fail: "capFail",
  invalid: "capInvalid", reveal: "capReveal", countdown: "capCountdown", go: "capGo", achievement: "capAchievement",
};
/** audio.js event with its caption (#captions, 1.8 s). */
export function sound(ev: audio.Sfx): void {
  audio.play(ev);
  const c = CAPTIONS[ev];
  if (c) app.caption = { text: `♪ ${t(c)}`, until: now() + 1.8 };
}
function haptic(ms: number): void { if (platform.options.haptics) try { vibrate(ms); } catch { /* none */ } }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built. */
export function later(fn: () => void): void { pending.push(fn); }
export const playing = (): boolean => app.flow === "countdown" || app.flow === "active" || app.flow === "resolving";

const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
/** game.js keysFor over the effective bindings (the runtime's rebinding). */
export function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join(" / ") || "—";
}

// ------------------------------------------------------------------ overlays
export function open(o: Overlay, focus: string | null = null): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? (touchControlsVisible() ? null : firstFocus(o));
  ui.setFocus(null);
}
function firstFocus(o: Overlay): string | null {
  switch (o) {
    case "title": return "btn-play";
    case "pause": return "btn-resume";
    case "results": return "btn-next";
    case "modes": return "mode-journey";
    default: return null;
  }
}
export function daily(): Level { return C.dailyLevel(new Date(platform.nowMs())); }

// ------------------------------------------------------------------ game flow
export function startLevel(level: Level, mode: Mode, opts: Record<string, unknown> = {}): void {
  app.session = new Session(level, mode, opts);
  render.loadLevel(level, level.theme || "brass");
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  app.flow = "countdown";
  app.countN = 3;
  app.countdown = "3";
  app.countAt = steps + 42; // 700 ms
  app.countHide = 0;
  audio.setPaused(false);
  sound("countdown");
  announce(t("objectiveAnnounce", { detail: level.lesson ? L.lessonText(level).text : L.levelName(level) }));
}
export function retryLevel(): void {
  const s = app.session;
  if (!s) return;
  startLevel(s.level, s.mode, s.opts);
}
export function pauseGame(): void {
  if (app.flow !== "active") return;
  app.flow = "paused";
  audio.setPaused(true);
  persistSnapshot();
  open("pause");
}
export function resumeGame(): void {
  if (app.flow !== "paused") return;
  app.flow = "active";
  audio.setPaused(false);
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
function persistSnapshot(): void {
  const s = app.session;
  if (!s || s.over) return;
  platform.doc().snapshot = {
    levelId: s.level.id, mode: s.mode, state: R.serialize(s.state), savedAt: platform.nowMs(),
    commands: JSON.parse(JSON.stringify(s.commands)), hashes: JSON.parse(JSON.stringify(s.hashes)), startedAt: s.startedAt, opts: s.opts,
  };
  platform.persist();
}
export function leaveToTitle(): void {
  persistSnapshot();
  app.session = null;
  app.countdown = null;
  audio.setPaused(false);
  showTitle();
}
export function showTitle(): void {
  app.flow = "title";
  app.returnTo = "title";
  open("title");
}
export function levelById(id: string): Level {
  if (id.startsWith("journey-")) return C.journeyStage(parseInt(id.slice(8), 10));
  if (id.startsWith("practice-")) return { ...C.journeyStage(parseInt(id.slice(9), 10)), id };
  if (id.startsWith("learn-")) { const l = C.TUTORIALS.find((x) => x.id === id); if (l) return l; }
  if (id.startsWith("daily-")) return C.dailyLevel(new Date(id.slice(6) + "T00:00:00Z"));
  if (id.startsWith("chal-")) return C.challengeLevel(id);
  throw new Error("unknown level " + id);
}
export function resumeSnapshot(): void {
  const snap = platform.doc().snapshot;
  if (!snap) return;
  try {
    const level = levelById(snap.levelId);
    const sess = new Session(level, snap.mode as Mode, snap.opts || {});
    sess.state = R.deserialize(snap.state);
    sess.commands = snap.commands as Session["commands"];
    sess.hashes = snap.hashes as Session["hashes"];
    if (snap.startedAt) sess.startedAt = snap.startedAt;
    app.session = sess;
    render.loadLevel(level, level.theme || "brass");
    const awayMin = Math.round((platform.nowMs() - snap.savedAt) / 60000);
    app.overlay = null;
    app.openedFrame = frame().frame;
    app.flow = "active";
    announce(t("welcomeBack", {
      away: awayMin < 1 ? t("awayMoments") : t("awayMinutes", { n: awayMin }),
      score: R.scoreBreakdown(sess.state, level.par).total, deaths: sess.state.deaths,
    }));
  } catch {
    platform.doc().snapshot = null;
    platform.persist();
    showTitle();
  }
}
export function startPractice(): void {
  const lv = C.journeyStage(app.practice.stage);
  const d = (["relaxed", "standard", "strict"] as const)[app.practice.diff]!;
  const level: Level = { ...lv, id: "practice-" + lv.index };
  if (d === "strict") level.moveLimit = Math.round(lv.par.moves * 1.2);
  startLevel(level, "practice", { difficulty: d });
}
export function computeMaxUnlocked(): number {
  let max = 0;
  const stars = platform.doc().progress.stars;
  for (let i = 0; i < C.JOURNEY_COUNT; i++) if (stars[i] !== undefined) max = i + 1;
  return Math.min(max, C.JOURNEY_COUNT - 1);
}
export function nextAction(): void {
  const s = app.session!;
  if (s.mode === "journey" && s.result?.won) {
    const next = (s.level.index ?? 0) + 1;
    if (next < C.JOURNEY_COUNT) { startLevel(C.journeyStage(next), "journey"); return; }
    app.flow = "menu"; open("journey"); return;
  }
  if (s.mode === "learn" && s.result?.won) {
    const idx = C.TUTORIALS.findIndex((x) => x.id === s.level.id);
    if (idx >= 0 && idx + 1 < C.TUTORIALS.length) { startLevel(C.TUTORIALS[idx + 1]!, "learn"); return; }
    app.flow = "menu"; open("learn"); return;
  }
  retryLevel();
}
export function menu(o: Overlay): void { app.flow = app.session && app.flow !== "results" ? app.flow : "menu"; open(o); }
/** Back from Help / Settings: the pause screen when opened from it, else the title. */
export function backAuto(): void {
  if (app.returnTo === "pause" && app.session && app.flow === "paused") open("pause");
  else showTitle();
}

// ------------------------------------------------------------------ results (game.js showResults / updateProgress)
function showResults(): void {
  const s = app.session!;
  const r = s.result!;
  app.flow = "results";
  announce(t(r.won ? "announceWon" : "announceLost", { n: r.breakdown.total }), true);
  s.newly = updateProgress(s);
  for (let i = 0; i < s.newly.length; i++) sound("achievement");
  if (s.ranked && r.won) {
    const signed = platform.signedIn();
    SaveModel.addLocalScore(platform.doc(), s.mode, { name: platform.signedIn() ? platform.displayName() : (platform.doc().name || "Guest"), score: r.breakdown.total, levelId: s.level.id, at: new Date(platform.nowMs()).toISOString(), won: true });
    platform.persist();
    s.lb = signed ? { key: "lbPosting", platform: true } : { key: "savedLocalCasual" };
    if (signed) {
      void platform.postScore(Math.max(0, r.breakdown.total)).then((res) => {
        s.lb = !res.posted ? { key: "lbNotPosted", platform: true } : res.rank ? { key: "lbRank", vars: { rank: res.rank }, platform: true } : { key: "lbPosted", platform: true };
      });
    }
  } else if (!s.ranked) s.lb = { key: "unrankedNoSubmit" };
  platform.doc().snapshot = null;
  platform.persist();
  open("results");
}
export function lbText(lb: LbLine): string { return lb.platform ? pt(lb.key, lb.vars) : t(lb.key, lb.vars); }
function updateProgress(s: Session): string[] {
  const p = platform.doc().progress;
  const newly: string[] = [];
  const unlock = (key: string): void => {
    if (!p.achievements[key]) { p.achievements[key] = new Date(platform.nowMs()).toISOString(); newly.push(key); }
  };
  const r = s.result!;
  if (r.won) {
    p.clears++;
    unlock("first-clear");
    if (p.clears >= 100) unlock("centurion");
    if (s.mode === "journey") {
      const i = String(s.level.index);
      const prev = p.stars[i];
      if (prev === undefined || r.breakdown.total > prev) p.stars[i] = r.breakdown.total;
      if (s.state.gears.length > 0 && s.state.gears.every(Boolean)) unlock("gear-master");
      if (s.level.index === C.JOURNEY_COUNT - 1) unlock("tower-top");
    }
    if (s.mode === "learn") p.stars[s.level.id] = r.breakdown.total;
    if (s.mode === "daily") {
      const key = s.level.dailyKey!;
      const prev = p.bestDaily[key];
      if (prev === undefined || r.breakdown.total > prev) p.bestDaily[key] = r.breakdown.total;
      const yesterday = new Date(new Date(key + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
      if (p.streak.lastDay === key) { /* already counted */ }
      else if (p.streak.lastDay === yesterday) { p.streak.count++; p.streak.lastDay = key; }
      else { p.streak.count = 1; p.streak.lastDay = key; }
      if (p.streak.count >= 3) unlock("streak-3");
    }
  }
  platform.persist();
  return newly;
}

// ------------------------------------------------------------------ leaderboards
export async function showLeaderboards(tab = "daily"): Promise<void> {
  app.board = { tab, entries: null, platform: false };
  menu("scores");
  if (platform.signedIn()) {
    try {
      const rows = await platform.topEntries(20);
      if (rows) { app.board = { tab, entries: rows.map((r) => ({ name: r.name, score: r.score })), platform: true }; return; }
    } catch { /* the local board */ }
  }
  app.board = { tab, entries: (platform.doc().boards[tab] || []).map((e) => ({ name: e.name, score: e.score, local: true, won: e.won })), platform: false };
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(pt("inviteCopied")); } catch { toast(pt("inviteFailed", { link })); }
}

// ------------------------------------------------------------------ keys, pads and the touch controls
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  const s = app.session;
  if (a === "pause") {
    if (app.flow === "active" && !app.overlay) later(pauseGame);
    else if (app.overlay === "pause" && fresh()) later(resumeGame);
    return;
  }
  if (app.overlay && !(app.overlay === "pause" || app.overlay === "results")) return;
  if (a === "retry" && s && (app.flow === "active" || app.flow === "paused" || app.flow === "results")) { later(retryLevel); return; }
  if (app.flow !== "active" || app.overlay) return;
  ui.setFocus(null); // keys play the level, not the HUD buttons
  if (a === "jump" && s) s.pendingJumpId++;
  else if (a === "undo" && s) later(() => s.undo());
  else if (a === "camera") render.resetCamera();
});
let touchKey = "";
function touchControls(): void {
  const want = app.flow === "countdown" || app.flow === "active" || app.flow === "resolving";
  const key = want ? `${platform.options.leftHanded}:${t("jumpPad")}` : "";
  if (key === touchKey) return;
  touchKey = key;
  if (!want) { setTouchControls(null); return; }
  const lh = platform.options.leftHanded;
  const moveAnchor = lh ? "bottom-right" : "bottom-left", jumpAnchor = lh ? "bottom-left" : "bottom-right";
  const jl = t("jumpPad").slice(0, 16);
  setTouchControls([
    { kind: "button", action: lh ? "right" : "left", label: lh ? "▶" : "◀", anchor: moveAnchor, offset: [44, 40], radius: 32 },
    { kind: "button", action: lh ? "left" : "right", label: lh ? "◀" : "▶", anchor: moveAnchor, offset: [120, 40], radius: 32 },
    { kind: "button", action: "jump", label: jl, anchor: jumpAnchor, offset: [54, 50], radius: 42 },
  ]);
}

// ------------------------------------------------------------------ the clock (game.js frame loop and setInterval timers)
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  steps++;
  audio.tick(now());
  const s = app.session;
  if (app.flow === "countdown" && steps >= app.countAt) {
    app.countN--;
    if (app.countN > 0) { app.countdown = String(app.countN); sound("countdown"); app.countAt = steps + 42; }
    else { app.countdown = t("go"); sound("go"); app.countHide = steps + 30; app.flow = "active"; }
  }
  if (app.countHide && steps >= app.countHide) { app.countdown = null; app.countHide = 0; }
  if (s && app.flow === "active" && steps % 3 === 0) s.tick();
  if (app.flow === "resolving" && steps >= app.resultsAt) showResults();
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  // the idle scene behind the title screen
  render.loadLevel(C.journeyStage(0), C.THEMES[0]!.id);
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast(pt("signedOut")));
platform.onProgressMerged(() => toast(t("progressMerged")));
onSuspend(() => {
  hidden = true;
  if (app.flow === "active") pauseGame();
  else persistSnapshot();
  platform.flush();
});
onResume(() => { hidden = false; });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(platform.options.palette, ui.preferences().highContrast);
  audio.update();
  const n = now();
  if (app.toast && app.toast.until < n) app.toast = null;
  if (app.caption && app.caption.until < n) app.caption = null;
  touchControls();
});
onRender(() => {
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  const f = frame();
  render.update(app.session ? app.session.state : null, frameDt, f.width, f.height, touchControlsVisible());
  flushAnnouncements();
});
