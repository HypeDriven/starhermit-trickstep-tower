// The browser build's DOM shell (game.js buildShell + every show* screen) as
// starhermit:ui, built every frame over the tower: the wordmark, the HUD
// (objective and lesson, score / gears / deaths / time and the move or time
// limit in reserved widths, the sync line with Pause and Practice's Undo;
// groups flex-wrapped, stacked on phone portrait), the countdown, captions,
// the toast, the screen-reader board description, and the screens (title,
// modes, learn, journey, practice, challenges, score chase, settings,
// profile, help, pause, results) as dialogs over the dimmed tower. The old
// media queries are layouts picked by the window's logical size (≤ 640 px
// wide portrait: stacked HUD, two-column mode cards without blurbs, bottom
// sheets; ≤ 500 px tall landscape: the compact HUD).
import { frame, openMenu } from "starhermit:engine";
import { requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { C, L, R, SaveModel } from "./game.ts";
import { pt, t } from "./i18n.ts";
import * as platform from "./platform.ts";
import { token } from "./style.ts";
import {
  ACHIEVEMENTS, app, backAuto, computeMaxUnlocked, daily, fresh, invite, keysFor, later, lbText, leaveToTitle, menu, nextAction,
  open, pauseGame, resumeGame, resumeSnapshot, retryLevel, showLeaderboards, showTitle, signIn, sound, startLevel, startPractice, toast,
} from "./main.ts";

// ------------------------------------------------------------------ layout helpers
interface Layout { lw: number; lh: number; sc: number; portrait: boolean; land: boolean; ox: number; oy: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, portrait: lw <= 640 && lh > lw, land: lh <= 500 && lw > lh, ox: sa.left, oy: sa.top };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; width?: number; height?: number; selected?: boolean; tight?: boolean }
const btnWidth = (b: Btn): number => textWidth(b.text, b.style ?? "btn", "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected) opts.selected = true;
  const dark = style === "btn-primary" || style === "btn-big";
  if (b.width != null && btnWidth(b) > b.width) {
    opts.content = () => { ui.style(dark ? "wrap-dark" : "wrap").paragraph(b.text, Math.max(20, b.width! - (b.tight ? 14 : 38))); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.style(dark ? "wrap-dark" : "btn-label").label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (b.tight) s.padding = { top: 8, bottom: 8, start: 6, end: 6 };
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(() => { sound("ui"); b.act(); });
}
/** Buttons at their own widths in rows that wrap at `width` (.btn-row flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, justify: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? btnWidth(b));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
const back = (w: number, act: () => void, id = "btn-back"): void => flow(`${id}-row`, [{ id, text: t("back"), style: "btn-subtle", act }], w);

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L0 = layoutNow();
  ui.place("wordmark", { anchor: "top-start", x: 12, y: 4 }, () => ui.style("wordmark").id("wordmark").label("TRICKSTEP TOWER"));
  const s = app.session;
  if (s && (app.flow === "countdown" || app.flow === "active" || app.flow === "resolving" || app.flow === "paused") && !app.overlay) hud(L0);
  if (s && !app.overlay) boardDescription(L0);
  if (app.countdown && !app.overlay) {
    const big = L0.portrait ? "countdown-s" : "countdown";
    ui.place("countdown", { anchor: "center", x: 0, y: 0 }, () => ui.style(big).id("countdown-text").label(app.countdown!));
  }
  if (app.caption) {
    ui.place("captions", { anchor: "bottom", y: 104 }, () => ui.style("caption").id("caption-text").label(app.caption!.text));
  }
  if (app.toast) {
    const w = Math.min(L0.lw - 32, 520);
    const tw = textWidth(app.toast.text, "toast-text");
    ui.place("toast", { anchor: "bottom", y: 24 }, () => {
      ui.column("toast-box", () => para(app.toast!.text, Math.min(tw + 1, w - 34), "toast-text", "toast-text"), { style: "toast" });
    });
  }
  overlay(L0);
  if (app.focusNext) {
    const age = frame().frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ HUD (#hud .hud-top)
interface Group { id: string; w: number; build: (w: number) => void }
function hud(L0: Layout): void {
  const s = app.session!;
  const st = s.state;
  const small = L0.portrait || L0.land;
  const k = small ? "hud-k-s" : "hud-k", v = small ? "hud-v-s" : "hud-v", lim = small ? "hud-limit-s" : "hud-limit";
  const gs = small ? "hud-group-s" : "hud-group";
  const padX = small ? 8 : 10;
  const side = L0.lw > 1024 ? 24 : 10;
  const inner = L0.lw - 2 * side;
  const gap = 8;
  // objective + lesson
  const objective = t("hudObjective", { name: L.levelName(s.level) });
  const lesson = s.level.lesson ? L.lessonText(s.level).text : "";
  const objCap = Math.min(inner - 2 * padX - 2, 560);
  const objW = Math.min(objCap, Math.max(textWidth(objective, "hud-obj"), lesson ? Math.min(objCap, textWidth(lesson, "hud-lesson")) : 0) + 1);
  // stats: reserved widths (score 4 digits, deaths 2, time 999.9s), a counting-down limit keeps its first width
  const gears = st.gears.filter(Boolean).length;
  const dw = (n: number): number => textWidth("0".repeat(n), v);
  const stats: [string, string, number][] = [
    [t("hudScore"), String(R.scoreBreakdown(st, s.level.par).total), dw(4)],
    [t("hudGears"), `${gears} / ${st.gears.length}`, 0],
    [t("hudDeaths"), String(st.deaths), dw(2)],
    [t("hudTime"), `${((st.tick * R.TICK_MS) / 1000).toFixed(1)}s`, textWidth("000.0s", v)],
  ];
  let limit = "";
  if (st.moveLimit !== null) limit = t("movesLeft", { n: Math.max(0, st.moveLimit - st.moves) });
  else if (st.timeLimit !== null) limit = t("timeLeft", { n: Math.max(0, ((st.timeLimit - st.tick) * R.TICK_MS) / 1000).toFixed(0) });
  if (limit && !s.limitW) s.limitW = textWidth(limit, lim) + 2;
  const statGap = small ? 8 : 14;
  const statW = stats.map(([a, b, min]) => textWidth(a, k) + 4 + Math.max(min, textWidth(b, v)) + 1);
  if (limit) statW.push(Math.max(s.limitW, textWidth(limit, lim) + 1));
  // stats wrap inside their group when the screen is narrow
  const statCap = inner - 2 * padX - 2;
  const statRows: number[][] = [[]];
  let used = 0;
  statW.forEach((w, i) => {
    if (statRows[statRows.length - 1]!.length && used + statGap + w > statCap) { statRows.push([]); used = 0; }
    used += (statRows[statRows.length - 1]!.length ? statGap : 0) + w;
    statRows[statRows.length - 1]!.push(i);
  });
  const statsW = Math.max(...statRows.map((r) => r.reduce((a, i, j) => a + statW[i]! + (j ? statGap : 0), 0)));
  const sync = syncLabel();
  const pauseText = t("pauseBtn"), undoText = t("undoBtn");
  const practice = s.mode === "practice";
  const ctrlW = (sync ? textWidth(sync, k) + 8 : 0) + textWidth(pauseText, "btn-small", "button") + 2 + (practice ? 8 + textWidth(undoText, "btn-small", "button") + 2 : 0);
  const groups: Group[] = [
    {
      id: "hud-objective", w: objW + 2 * padX + 2, build: (w) => ui.column("hud-objective", () => {
        para(objective, w - 2 * padX - 2, "hud-obj", "hud-objective-text");
        if (lesson) para(lesson, w - 2 * padX - 2, "hud-lesson", "hud-lesson");
      }, { style: gs, width: w, spacing: 2 }),
    },
    {
      id: "hud-stats", w: statsW + 2 * padX + 2, build: (w) => ui.column("hud-stats", () => {
        statRows.forEach((row, ri) => ui.row(`hud-stats-r${ri}`, () => {
          for (const i of row) {
            if (i < stats.length) {
              const [a, b] = stats[i]!;
              ui.row(`hud-stat-${i}`, () => { ui.style(k).label(a); ui.style(v).id(`hud-stat-${i}-v`).label(b); }, { spacing: 4, width: statW[i]!, align: "center" });
            } else ui.style(lim).id("hud-limit").label(limit);
          }
        }, { spacing: statGap, align: "center" }));
      }, { style: gs, width: w, spacing: 4 }),
    },
    {
      id: "hud-ctrl", w: ctrlW + 2 * padX + 2, build: (w) => ui.row("hud-ctrl", () => {
        if (sync) ui.style(k).id("hud-sync").label(sync);
        button({ id: "btn-pause", text: pauseText, style: "btn-small", act: () => (app.flow === "paused" ? resumeGame() : pauseGame()) });
        if (practice) button({ id: "btn-undo", text: undoText, style: "btn-small", act: () => app.session?.undo() });
      }, { style: gs, width: w, spacing: 8, align: "center" }),
    },
  ];
  // .hud-top: space-between, wrapping; phone portrait stacks the groups
  const rows: Group[][] = [[]];
  used = 0;
  for (const g of groups) {
    const w = Math.min(inner, g.w);
    if (rows[rows.length - 1]!.length && (L0.portrait || used + gap + w > inner)) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(g);
  }
  ui.place("hud", { anchor: "top-start", x: side, y: L0.land ? 24 : 28 }, () => {
    ui.column("hud-top", () => {
      rows.forEach((row, ri) => ui.row(`hud-r${ri}`, () => {
        row.forEach((g, gi) => { if (gi > 0) ui.spacer(); g.build(Math.min(inner, g.w)); });
      }, { width: inner, spacing: gap, align: "start" }));
    }, { width: inner, spacing: gap });
  });
}
export function syncLabel(): string {
  const st = platform.syncState();
  return t(st === "local" ? "syncOffline" : st === "error" ? "syncError" : st === "synced" ? "syncSynced" : "syncSaving");
}
/** #board-desc: the text model of the board for screen readers (render.js describeState). */
const REASON_KEYS: Record<string, string> = { exit: "reasonExit", "move-limit": "reasonMoveLimit", "time-limit": "reasonTimeLimit" };
function boardDescription(L0: Layout): void {
  const s = app.session!;
  const st = s.state;
  const parts = [t("descLevel", { name: L.levelName(s.level) })];
  const pos = { x: Math.round(st.player.x), y: Math.round(st.player.y) };
  parts.push(t(st.player.onGround ? "descPlayerGround" : "descPlayerAir", pos));
  parts.push(t("descGears", { n: st.gears.filter(Boolean).length, total: st.gears.length }));
  parts.push(t("descDeaths", { deaths: st.deaths, moves: st.moves }));
  if (st.checkpoint) parts.push(t("descCheckpoint"));
  if (st.over) parts.push(st.won ? t("descComplete") : t("descEnded", { reason: t(REASON_KEYS[st.reason || ""] || "") || String(st.reason) }));
  const sc = L0.sc;
  ui.target(parts.join(" "), { x: L0.ox + 0, y: L0.oy + (L0.lh * 0.45) * sc, width: 2 * sc, height: 2 * sc }, { role: "label" });
}

// ------------------------------------------------------------------ screens (#overlay > .screen)
type O = NonNullable<typeof app.overlay>;
function overlay(L0: Layout): void {
  const o = app.overlay;
  if (!o) return;
  const w = Math.min(L0.lw > 1024 ? 900 : 860, L0.lw - (L0.portrait ? 0 : 32));
  const padX = L0.portrait ? 16 : 26, padY = L0.portrait ? 16 : 22;
  const inner = w - 2 * padX;
  const maxH = (L0.land ? 0.96 : 1) * (L0.lh - (L0.portrait ? 24 : 48));
  const key = `panel-${o}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L0.sc + 2 * padY > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(panelLabel(o), "", true, () => {
    ui.column("panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildPanel(o, iw, L0), { spacing: 12, width: iw })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 6, height: maxH - 2 * padY }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "screen", width: w, spacing: 0, padding: { top: padY, bottom: padY, start: padX, end: padX } });
  });
  if (!isOpen && fresh()) {
    // Escape takes the visible "← Back" / "Leave" route (game.js onEscape)
    if (o === "pause") later(resumeGame);
    else if (o === "results") later(leaveToTitle);
    else if (o === "modes" || o === "scores" || o === "profile") later(showTitle);
    else if (o === "learn" || o === "journey" || o === "practice" || o === "challenges") later(() => menu("modes"));
    else if (o === "help" || o === "settings") later(backAuto);
  }
}
function panelLabel(o: O): string {
  switch (o) {
    case "title": return "Trickstep Tower";
    case "modes": return t("chooseMode");
    case "learn": return t("learnTitle");
    case "journey": return t("journeyTitle");
    case "practice": return t("practiceTitle");
    case "challenges": return t("challengesTitle");
    case "scores": return t("scoreChase");
    case "settings": return t("settings");
    case "profile": return t("profile");
    case "help": return t("helpRules");
    case "pause": return t("paused");
    case "results": return app.session?.result?.won ? t("floorCleared") : t("attemptOver");
  }
}
function heading(title: string, desc: string, w: number): void {
  para(title, w, "h2", "screen-title");
  if (desc) para(desc, w, "dim", "screen-desc");
}
function buildPanel(o: O, w: number, L0: Layout): void {
  switch (o) {
    case "title": titlePanel(w); break;
    case "modes": modesPanel(w, L0); break;
    case "learn": learnPanel(w); break;
    case "journey": journeyPanel(w); break;
    case "practice": practicePanel(w); break;
    case "challenges": challengesPanel(w); break;
    case "scores": scoresPanel(w); break;
    case "settings": settingsPanel(w); break;
    case "profile": profilePanel(w); break;
    case "help": helpPanel(w, L0); break;
    case "pause": pausePanel(w); break;
    case "results": resultsPanel(w); break;
  }
}

function titlePanel(w: number): void {
  heading("Trickstep Tower", t("titleDesc"), w);
  const d = daily();
  const done = Object.keys(platform.doc().progress.stars).length;
  ui.row("play-row", () => { button({ id: "btn-play", text: t("playBig"), style: "btn-big", act: () => menu("modes") }); }, { width: w, justify: "center" });
  flow("title-row1", [
    { id: "btn-daily", text: t("dailyBtn", { key: d.dailyKey! }), act: () => startLevel(d, "daily") },
    { id: "btn-journey", text: t("journeyBtn", { n: done }), act: () => menu("journey") },
    { id: "btn-settings", text: t("settings"), act: () => { app.returnTo = "title"; menu("settings"); } },
  ], w);
  const row2: Btn[] = [
    { id: "btn-help", text: t("helpRules"), act: () => { app.returnTo = "title"; menu("help"); } },
    { id: "btn-profile", text: t("profile"), act: () => { app.nameDraft = null; menu("profile"); } },
  ];
  if (!platform.signedIn()) row2.push({ id: "btn-signin", text: pt("signIn"), act: signIn });
  if (platform.inviteLink()) row2.push({ id: "btn-invite", text: pt("invite"), act: invite });
  flow("title-row2", row2, w);
  const snap = platform.doc().snapshot;
  if (snap) {
    const ago = Math.round((platform.nowMs() - snap.savedAt) / 60000);
    let name = snap.levelId;
    try { name = L.levelName(levelFor(snap.levelId)); } catch { /* keep the id */ }
    flow("resume-row", [{ id: "btn-resume-run", style: "btn-subtle", text: t("resumeRun", { level: name, ago: ago < 1 ? t("justNow") : t("minAgo", { n: ago }) }), act: resumeSnapshot }], w);
  }
}
function levelFor(id: string): ReturnType<typeof C.journeyStage> {
  if (id.startsWith("journey-")) return C.journeyStage(parseInt(id.slice(8), 10));
  if (id.startsWith("practice-")) return { ...C.journeyStage(parseInt(id.slice(9), 10)), id };
  if (id.startsWith("daily-")) return C.dailyLevel(new Date(id.slice(6) + "T00:00:00Z"));
  if (id.startsWith("chal-")) return C.challengeLevel(id);
  return C.TUTORIALS.find((x) => x.id === id) ?? C.journeyStage(0);
}

/** .card-grid (auto-fit 220 px; phone portrait: two compact columns without the blurb). */
function grid(id: string, n: number, w: number, min: number, cols0: number | null, cell: (i: number, cw: number) => void, gap = 12): void {
  const cols = cols0 ?? Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < n; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(n, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "start" });
    }
  }, { spacing: gap, width: w });
}
function modesPanel(w: number, L0: Layout): void {
  heading(t("chooseMode"), t("chooseModeDesc"), w);
  const d = daily();
  const cards: [string, string, () => void, boolean][] = [
    ["learn", "modeLearn", () => menu("learn"), false],
    ["journey", "modeJourney", () => menu("journey"), true],
    ["daily", "modeDaily", () => startLevel(d, "daily"), false],
    ["practice", "modePractice", () => menu("practice"), false],
    ["challenge", "modeChallenge", () => menu("challenges"), false],
    ["scores", "modeScores", () => void showLeaderboards(), false],
  ];
  // phone portrait (old CSS) and short landscape: compact cards without the blurb, so all six fit
  const compact = L0.portrait || L0.land;
  const gap = compact ? 8 : 12;
  grid("modes", cards.length, w, 220, L0.portrait ? 2 : L0.land ? 3 : null, (i, cw) => {
    const [mode, key, go, rec] = cards[i]!;
    const pad = compact ? 10 : 14, iw = cw - 2 * pad - 2;
    ui.column(`card-${mode}`, () => {
      para(t(key), iw, "card-h", `card-${mode}-h`);
      if (!compact) para(t(key + "Desc"), iw, "text", `card-${mode}-desc`);
      para(t(key + "Meta"), iw, "meta", `card-${mode}-meta`);
      button({ id: `mode-${mode}`, text: rec ? t("playRecommended") : t("play"), name: `${t(key)}: ${rec ? t("playRecommended") : t("play")}`, style: "btn-primary", tight: compact, width: compact ? iw : Math.min(iw, btnWidth({ id: "", text: rec ? t("playRecommended") : t("play"), style: "btn-primary", act: go })), act: go });
    }, { style: rec ? "card-rec" : "card", width: cw, spacing: 6, padding: pad });
  }, gap);
  back(w, showTitle);
}
function listItem(id: string, title: string, sub: string, w: number, act: () => void): void {
  const iw = w - 30;
  if (ui.style("list-item", { width: w }).id(id).button(`${title}. ${sub}`, {
    content: () => ui.column(`${id}-c`, () => { para(title, iw, "item-name"); para(sub, iw, "item-sub"); }, { spacing: 4, width: iw }),
  }) && fresh()) later(() => { sound("ui"); act(); });
}
function learnPanel(w: number): void {
  heading(t("learnTitle"), t("learnDesc"), w);
  const stars = platform.doc().progress.stars;
  ui.column("learn-list", () => {
    for (const lesson of C.TUTORIALS) {
      const done = stars[lesson.id] !== undefined;
      listItem(`lesson-${lesson.id}`, (done ? "★ " : "") + L.levelName(lesson), L.lessonText(lesson).text, w, () => startLevel(lesson, "learn"));
    }
  }, { spacing: 8, width: w });
  back(w, () => menu("modes"));
}
function journeyPanel(w: number): void {
  heading(t("journeyTitle"), t("journeyDesc"), w);
  const max = computeMaxUnlocked();
  const stars = platform.doc().progress.stars;
  grid("stage-grid", C.JOURNEY_COUNT, w, 56, null, (i, cw) => {
    const lv = C.journeyStage(i);
    const best = stars[i];
    const locked = i > max;
    const name = t("stageN", { n: i + 1 }) + (lv.mastery ? t("masteryTag") : "") + (best !== undefined ? t("bestTag", { n: best }) : "") + (locked ? t("lockedTag") : "");
    const size = Math.max(44, cw);
    if (ui.style(lv.mastery ? "stage-mastery" : "stage", { width: cw, height: size }).id(`stage-${i + 1}`).button(name, {
      disabled: locked,
      content: () => ui.column(`stage-${i + 1}-c`, () => {
        ui.row(`stage-${i + 1}-star`, () => { ui.spacer(); ui.style("star").label(best !== undefined ? "★" : " "); }, { width: cw - 8, height: 14 });
        ui.row(`stage-${i + 1}-n`, () => { ui.style("stage-n").label(String(i + 1)); }, { width: cw - 8, justify: "center" });
      }, { width: cw - 8, spacing: 0, height: size - 8 }),
    }) && fresh()) later(() => { sound("ui"); startLevel(lv, "journey"); });
  }, 8);
  back(w, () => menu("modes"));
}
function selectRow(id: string, label: string, idx: number, items: string[], w: number, set: (i: number) => void): void {
  const lw = Math.min(200, w * 0.4);
  ui.row(`${id}-row`, () => {
    para(label, lw, "text", `${id}-label`);
    ui.spacer();
    const pick = ui.id(id).select(label, idx, items, { width: Math.min(w - lw - 12, 320) } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { width: w, align: "center", spacing: 12, height: 48 });
}
function practicePanel(w: number): void {
  heading(t("practiceTitle"), t("practiceDesc"), w);
  const stages = Array.from({ length: C.JOURNEY_COUNT }, (_, i) => t("stageN", { n: i + 1 }));
  selectRow("practice-stage", t("stage"), app.practice.stage, stages, w, (i) => { app.practice.stage = i; });
  selectRow("practice-diff", t("difficulty"), app.practice.diff, [t("diffRelaxed"), t("diffStandard"), t("diffStrict")], w, (i) => { app.practice.diff = i; });
  flow("practice-go", [{ id: "btn-start-practice", text: t("startPractice"), style: "btn-primary", act: startPractice }], w);
  back(w, () => menu("modes"));
}
function challengesPanel(w: number): void {
  heading(t("challengesTitle"), t("challengesDesc"), w);
  ui.column("challenge-list", () => {
    for (const c of C.CHALLENGES) {
      const txt = L.challengeText(c);
      const sub = txt.desc + (c.moveLimit ? t("moveLimitTag", { n: c.moveLimit }) : "") + (c.timeLimit ? t("timeLimitTag", { n: (c.timeLimit * R.TICK_MS) / 1000 }) : "");
      listItem(`ch-${c.id}`, txt.name, sub, w, () => startLevel(C.challengeLevel(c.id), "challenge"));
    }
  }, { spacing: 8, width: w });
  back(w, () => menu("modes"));
}
const BOARD_KEYS: Record<string, string> = { daily: "boardDaily", journey: "boardJourney", challenge: "boardChallenge" };
function scoresPanel(w: number): void {
  const b = app.board;
  heading(t("scoreChase"), platform.signedIn() ? t("lbHosted") : t("lbOffline"), w);
  flow("board-tabs", SaveModel.BOARD_KEYS.map((k) => ({
    id: `tab-${k}`, text: t(BOARD_KEYS[k]!), style: k === b.tab ? "btn-primary" : "btn", selected: k === b.tab, act: () => void showLeaderboards(k),
  })), w);
  ui.column("scores", () => {
    if (!b.entries) { para("…", w, "dim", "scores-wait"); return; }
    if (!b.entries.length) { para(t("noScores"), w, "text", "scores-none"); return; }
    b.entries.slice(0, 20).forEach((e, i) => {
      para(`${i + 1}. ${L.playerName(e.name || "Guest")} — ${e.score}${e.local ? t("localTag") : ""}${e.won === false ? t("incompleteTag") : ""}`, w, "text", `score-${i}`);
    });
  }, { spacing: 3, width: w });
  if (b.entries && !b.platform) para(t("casual"), w, "meta", "scores-casual");
  back(w, () => menu("modes"));
}
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w - 56, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("panel2"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("accent"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: token("dark"), align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => { set(!on); sound("ui"); });
  }, { width: w, align: "center", spacing: 8, height: 44 });
}
/** Settings: what the runtime's Options don't cover — the palette, left-handed touch controls, haptics. */
function settingsPanel(w: number): void {
  const o = platform.options;
  heading(t("settings"), t("settingsDesc"), w);
  para(t("audio"), w, "h3", "set-audio-h");
  para(t("optionsNote"), w, "dim", "options-note");
  flow("set-runtime", [
    { id: "btn-options", text: t("openOptions"), act: () => openMenu() },
    { id: "btn-rebind", text: t("keyBindings"), act: () => requestRebind() },
  ], w);
  para(t("display"), w, "h3", "set-display-h");
  const PAL = ["palDefault", "palDeuteranopia", "palProtanopia", "palTritanopia", "palMono"];
  selectRow("opt-palette", t("palette"), Math.max(0, SaveModel.PALETTES.indexOf(o.palette)), PAL.map((k) => t(k)), w, (i) => platform.setOption("palette", SaveModel.PALETTES[i]!));
  para(t("a11y"), w, "h3", "set-a11y-h");
  toggleRow("opt-left", t("leftHanded"), o.leftHanded, w, (v) => platform.setOption("leftHanded", v));
  toggleRow("opt-haptics", t("haptics"), o.haptics, w, (v) => platform.setOption("haptics", v));
  flow("set-tutorials", [{ id: "btn-replay-tutorials", text: t("replayTutorials"), act: () => menu("learn") }], w);
  back(w, backAuto);
}
function profilePanel(w: number): void {
  const signed = platform.signedIn();
  const doc = platform.doc();
  heading(t("profile"), signed ? t("signedInAs", { name: L.playerName(platform.displayName()) }) : t("guestMode"), w);
  if (signed) para(t("nameFromProfile"), w, "meta", "name-from-profile");
  else {
    if (app.nameDraft === null) app.nameDraft = doc.name;
    const lw = Math.min(160, w * 0.35);
    ui.row("name-row", () => {
      para(t("displayName"), lw, "text", "name-label");
      ui.spacer();
      app.nameDraft = ui.id("name-field").textField(t("displayName"), app.nameDraft ?? "", { width: w - lw - 12, maxChars: 24, placeholder: t("guest") });
    }, { width: w, align: "center", spacing: 12 });
    flow("name-save", [{
      id: "btn-save-name", text: t("saveName"), act: () => {
        doc.name = (app.nameDraft ?? "").trim();
        platform.persist();
        app.nameDraft = null;
        toast(t("nameSaved"));
        showTitle();
      },
    }], w);
  }
  para(syncLabel(), w, "meta", "profile-sync");
  const p = doc.progress;
  para(t("statsLine", { n: Object.keys(p.stars).filter((k) => /^\d+$/.test(k)).length, clears: p.clears, streak: p.streak.count }), w, "text", "profile-stats");
  para(t("achievements"), w, "h3", "ach-h");
  ui.column("achievements", () => {
    for (const a of ACHIEVEMENTS) {
      const got = p.achievements[a.key];
      para(`${got ? "★ " : "☆ "}${t(a.name)} — ${t(a.name + "Desc")}${got ? ` (${String(got).slice(0, 10)})` : ""}`, w, got ? "got" : "text", `ach-${a.key}`);
    }
  }, { spacing: 4, width: w });
  back(w, showTitle);
}
function helpPanel(w: number, L0: Layout): void {
  heading(t("helpRules"), t("helpDesc"), w);
  const keys = { left: keysFor("left"), right: keysFor("right"), jump: keysFor("jump"), pause: keysFor("pause"), retry: keysFor("retry"), camera: keysFor("camera"), undo: keysFor("undo") };
  const list = ["Goal", "Move", "Jump", "Trick", "Vanish", "Hazards", "Gears", "Score", "Pause"];
  grid("help-cards", list.length, w, L0.portrait ? 1000 : 220, null, (i, cw) => {
    const k = list[i]!;
    ui.column(`help-${k}`, () => {
      para(t("rule" + k), cw - 30, "card-h", `help-${k}-h`);
      para(t("rule" + k + "Text", keys), cw - 30, "text", `help-${k}-p`);
    }, { style: "card", width: cw, spacing: 6, padding: 14 });
  });
  back(w, backAuto);
}
function pausePanel(w: number): void {
  const s = app.session;
  heading(t("paused"), s ? L.levelName(s.level) : "", w);
  ui.row("resume-row", () => { button({ id: "btn-resume", text: t("resume"), style: "btn-big", act: resumeGame }); }, { width: w, justify: "center" });
  flow("pause-row", [
    { id: "btn-retry", text: t("retryR"), act: retryLevel },
    { id: "btn-pause-settings", text: t("settings"), act: () => { app.returnTo = "pause"; open("settings"); } },
    { id: "btn-pause-help", text: t("help"), act: () => { app.returnTo = "pause"; open("help"); } },
  ], w);
  flow("leave-row", [{ id: "btn-leave", text: t("leaveLevel"), style: "btn-subtle", act: leaveToTitle }], w);
}
function resultsPanel(w: number): void {
  const s = app.session!;
  const r = s.result!;
  const b = r.breakdown;
  heading(r.won ? t("floorCleared") : t("attemptOver"), L.levelName(s.level), w);
  const rows: [string, number][] = [
    [t("rowCompletion"), b.completion], [t("rowGears", { n: b.gearCount }), b.gears], [t("rowTime"), b.timeBonus],
    [t("rowMove"), b.moveBonus], [t("rowDeath"), -b.deathPenalty], [t("rowInvalid"), -b.invalidPenalty],
  ];
  const tw = Math.min(w, 360);
  ui.column("breakdown", () => {
    rows.forEach(([k, v], i) => ui.row(`bd-${i}`, () => { para(k, tw - 80, "td"); ui.spacer(); ui.style(v < 0 ? "td-neg" : "td-num").label(String(v)); }, { style: "tr", width: tw, spacing: 12, align: "center" }));
    ui.row("bd-total", () => { ui.style("td-total").label(t("total")); ui.spacer(); ui.style("td-total-num").id("result-total").label(String(b.total)); }, { style: "tr-total", width: tw, spacing: 12, align: "center" });
  }, { spacing: 0, width: tw });
  const reason: Record<string, string> = { exit: "reasonExit", "move-limit": "reasonMoveLimit", "time-limit": "reasonTimeLimit" };
  para(t("resultMeta", { reason: reason[r.reason] ? t(reason[r.reason]!) : r.reason, time: ((r.ticks * R.TICK_MS) / 1000).toFixed(1), deaths: s.state.deaths }), w, "meta", "result-meta");
  for (const key of s.newly) {
    const a = ACHIEVEMENTS.find((x) => x.key === key);
    if (a) para(t("achievementUnlocked", { name: t(a.name) }), w, "ach-pop", `ach-pop-${key}`);
  }
  if (s.lb) para(lbText(s.lb), w, "meta", "result-lb");
  flow("results-row", [
    { id: "btn-next", text: r.won ? t("next") : t("retryR"), style: "btn-primary", act: nextAction },
    { id: "btn-replay", text: t("replayLevel"), act: retryLevel },
    { id: "btn-scores", text: t("scores"), act: () => void showLeaderboards(s.mode === "learn" || s.mode === "practice" ? "journey" : s.mode) },
  ], w);
  flow("results-leave", [{ id: "btn-results-leave", text: t("leave"), style: "btn-subtle", act: leaveToTitle }], w);
}
