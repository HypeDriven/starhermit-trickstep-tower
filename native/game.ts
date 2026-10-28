// The browser build's pure modules, typed for this client: the rules
// (src/rules.js: the 20 Hz platformer step, scoring, serialize/hash), the
// content (src/content.js: themes, the five lessons, the 40 Journey stages,
// the Daily, challenges), the strings (src/lang.js) and the save model
// (src/save.js). They are ES modules shared with the node tests and the dev
// server (server.js), unchanged.
import * as rules from "../src/rules.js";
import * as content from "../src/content.js";
import * as lang from "../src/lang.js";
import * as save from "../src/save.js";

export interface Input { move: -1 | 0 | 1; jump: 0 | 1 }
export interface Player { x: number; y: number; vx: number; vy: number; onGround: boolean; face: number }
export interface MoverCfg { x: number; y: number; vertical: boolean; amp: number; period: number; phase: number }
export interface State {
  v: number; levelId: string; seed: number; tick: number; w: number; h: number; tiles: number[];
  player: Player; checkpoint: unknown; gears: boolean[]; fakesRevealed: number[]; moverCfg: MoverCfg[];
  deaths: number; moves: number; invalid: number; won: boolean; over: boolean; reason: string | null;
  moveLimit: number | null; timeLimit: number | null;
}
export interface Ev { t: string; why?: string }
export interface Breakdown { completion: number; gears: number; gearCount: number; timeBonus: number; moveBonus: number; deathPenalty: number; invalidPenalty: number; total: number }
export interface Level {
  id: string; seed: number; ascii: string; name: string; par: { ticks: number; moves: number }; index?: number;
  theme?: string; lesson?: string; mastery?: boolean; dailyKey?: string; moveLimit?: number | null; timeLimit?: number | null;
  challengeId?: string; tutorial?: boolean;
}
export interface Theme { id: string; name: string; sky: number; fog: number; key: number; fill: number; solid: number; brass: number; accent: number; hazard: number; ui: string }
export interface Challenge { id: string; name: string; desc: string; moveLimit?: number; timeLimit?: number }

interface RulesApi {
  TICK_MS: number; SCHEMA_VERSION: number; PLAYER_W: number; PLAYER_H: number;
  createState(l: Level): State; step(s: State, i: Input): Ev[]; terminalReason(s: State): string;
  scoreBreakdown(s: State, par: Level["par"]): Breakdown; serialize(s: State): string; deserialize(j: string): State;
  stateHash(s: State): number; hashString(s: string): number; makeRng(seed: number): () => number;
  moverOffset(c: MoverCfg, tick: number): { dx: number; dy: number }; isVanishSolid(s: State, i: number, tick?: number): boolean;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; TUTORIALS: Level[]; JOURNEY_COUNT: number; journeyStage(i: number): Level;
  dailyLevel(d: Date): Level; CHALLENGES: Challenge[]; challengeLevel(id: string): Level;
}
export const R = rules as unknown as RulesApi;
export const C = content as unknown as ContentApi;

export interface Progress {
  v: number; stars: Record<string, number>; bestDaily: Record<string, number>; achievements: Record<string, string>;
  streak: { count: number; lastDay: string | null }; clears: number; gearMasteryStages: Record<string, unknown>;
}
export interface Snapshot { levelId: string; mode: string; state: string; savedAt: number; commands: unknown[]; hashes: unknown[]; startedAt: number; opts: Record<string, unknown> }
export interface BoardEntry { name: string; score: number; levelId: string; at: string; won: boolean }
export interface SaveDoc { v: number; progress: Progress; snapshot: Snapshot | null; name: string; boards: Record<string, BoardEntry[]> }
export interface GameOptions { palette: string; leftHanded: boolean; haptics: boolean }
interface SaveApi {
  BOARD_KEYS: string[]; PALETTES: string[]; DEFAULT_OPTIONS: GameOptions; OPTION_KEYS: (keyof GameOptions)[]; BROWSER_KEYS: string[];
  defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSaves(a: unknown, b: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  readForeign(text: string): SaveDoc | null; pickOptions(raw: unknown): Partial<GameOptions>;
  readLegacySettings(kv: Record<string, unknown>): { options: Partial<GameOptions> };
  addLocalScore(save: SaveDoc, board: string, entry: BoardEntry): number;
}
export const SaveModel = save as unknown as SaveApi;
type Vars = Record<string, string | number>;
interface LangApi {
  setLang(tag: string): string; t(key: string, vars?: Vars): string; pt(key: string, vars?: Vars): string;
  levelName(l: Level | null): string; lessonText(l: Level): { name: string; text: string };
  challengeText(c: Challenge): { name: string; desc: string }; playerName(n: string): string;
}
export const L = lang as unknown as LangApi;
