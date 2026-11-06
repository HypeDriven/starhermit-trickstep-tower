// The look per graphics level. The engine owns shadows, ambient occlusion, bloom,
// the grade and the anti-aliasing (levelSettings(): the frame's level); the
// browser build's art columns and budgets (src/client/gfx.js TABLE / BUDGETS)
// stay keyed by the runtime's quality tier (frame().quality), with sparks and
// dust motes scaled within the tier by the level's particle budget (at most 2×).
// The runtime owns what the old Graphics panel did besides: Auto and the level
// choice, render scale and the pixel-ratio cap, adaptive resolution, the
// frame-rate limit and its readout. The old per-category overrides are not
// offered (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "low" | "high";
  animated: boolean;
  detailed: boolean;
  budget: Budget;
}
const ART: Record<QualityTier, Pick<Look, "particles" | "animated" | "detailed">> = {
  low: { particles: "low", animated: true, detailed: false },
  balanced: { particles: "high", animated: true, detailed: true },
  high: { particles: "high", animated: true, detailed: true },
  ultra: { particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 64, segments: 0.75, gears: 2, sparks: 400, dust: 60 },
  balanced: { material: "standard", texture: 128, segments: 1, gears: 4, sparks: 600, dust: 120 },
  high: { material: "physical", texture: 128, segments: 1, gears: 6, sparks: 1200, dust: 220 },
  ultra: { material: "physical", texture: 256, segments: 1.5, gears: 8, sparks: 1600, dust: 320 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 3200, DUST_MAX = 640;
/** Particles "low": gfx.js PARTICLE_BUDGET.low / DUST_MOTES.low. */
const LOW_PARTICLES = { max: 160, dust: 0 };

export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize), sparks: Math.min(SPARK_MAX, Math.round(b.sparks * k)), dust: Math.min(DUST_MAX, Math.round(b.dust * k)) },
  };
}
/** gfx.js particleBudget. */
export function particleBudget(l: Look): { max: number; dust: number } {
  return l.particles === "high" ? { max: l.budget.sparks, dust: l.budget.dust } : LOW_PARTICLES;
}
