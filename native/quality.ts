// The look per graphics level: the browser build's four presets and budgets
// (src/client/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the
// weakest GPU its Auto gave it) keyed by the runtime's quality tier
// (frame().quality), with sparks and dust motes scaled within the tier by the
// level (frame().levelIndex, at most 2×), as gfx.js scaled them by its
// hardware level. The runtime owns what the old Graphics panel did besides:
// Auto and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and its readout. The old per-category
// overrides are not offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  material: "lambert" | "standard" | "physical";
  /** Stone / brass plate texture size (the tower-wall brick is 2×). */
  texture: number;
  segments: number;
  /** Background gears (plus 2). */
  gears: number;
  sparks: number;
  dust: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "low" | "high";
  animated: boolean;
  detailed: boolean;
  budget: Budget;
}
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", particles: "low", animated: true, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 64, segments: 0.75, gears: 2, sparks: 400, dust: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 128, segments: 1, gears: 4, sparks: 600, dust: 120, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 128, segments: 1, gears: 6, sparks: 1200, dust: 220, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 256, segments: 1.5, gears: 8, sparks: 1600, dust: 320, bloomRes: 1, aoRes: 1 },
};
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 3200, DUST_MAX = 640;
/** Particles "low": gfx.js PARTICLE_BUDGET.low / DUST_MOTES.low. */
const LOW_PARTICLES = { max: 160, dust: 0 };

export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.5, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particleBudget. */
export function particleBudget(l: Look): { max: number; dust: number } {
  return l.particles === "high" ? { max: l.budget.sparks, dust: l.budget.dust } : LOW_PARTICLES;
}
