// The clockwork tower on starhermit:scene, as the browser build's
// src/client/render.js drew it with three.js r185: the brick tower wall far
// behind (unlit, no fog), giant background gears and columns, the ground far
// below, and when detailed the great clock face with turning hands, glowing
// arched windows and soft additive light shafts; the tiles (instanced stone
// and brass blocks, rounded and textured when detailed; trick steps that look
// exactly like stone and shimmer once revealed; vanish platforms fading on
// their rhythm; spikes, gears, springs, the exit door with its brass frame
// and lamp, checkpoint flags, moving platforms); the wind-up climber (body,
// head, turning key, visor eyes when detailed) with its grounded marker ring;
// burst particles and drifting dust motes; the follow camera with shake.
// Graphics follow the runtime's quality tier (native/quality.ts: gfx.js's
// presets and budgets).
//
// Engine minor 23 is three.js r185's light units and shadows, so the page's
// own intensities and the key light's shadow (its fitted camera box, bias and
// normal bias, PCF) are used as written. Reflections as the page set them up:
// RoomEnvironment (r183+ room, so the renderer argument and y = -3.5)
// prefiltered with sigma 0.04 as scene.environment at environmentIntensity
// 0.3 (the ground's per-material envMapIntensity was ignored by r185 with a
// scene environment, as here). The composer (half floats → GTAO → bloom →
// OutputPass with ACES → the grade + vignette in display space → SMAA /
// FXAA / MSAA) is the runtime's renderer.ao / bloom / grade / antialias.
// The canvas spanned the window under the HUD, so the camera does too.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Fog, Group, HemisphereLight, InstancedMesh,
  MathUtils, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace,
  PCFShadowMap, Path, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial, RepeatWrapping,
  RingGeometry, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, Shape, SphereGeometry, TorusGeometry, Vector3, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { C, R, type Level, type State, type Theme } from "./game.ts";
import { particleBudget, type Look } from "./quality.ts";

type Ctx = OffscreenCanvasRenderingContext2D;
const hex = (c: Color): string => "#" + c.getHex().toString(16).padStart(6, "0");
const { PLAYER_W, PLAYER_H } = R;

// ---------------------------------------------------------------- renderer, camera, environment
const camera = new PerspectiveCamera(34, 1, 0.1, 200);
renderer.shadowMap.type = PCFShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.camera = camera;

let envTex: Texture | null = null;
function environment(): Texture | null {
  if (!envTex) {
    try {
      const room = new RoomEnvironment(renderer);
      room.position.y = -3.5; // three r183+'s room
      envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}
scene.environment = environment();
scene.environmentIntensity = 0.3;

// ---------------------------------------------------------------- state
let look: Look | null = null;
let reducedMotion = false;
let level: Level | null = null;
let theme: Theme = C.THEMES[0]!;
let disposables: { dispose(): void }[] = [];
let levelGroup: Group | null = null;
let envGroup: Group | null = null;
let levelLights: Object3D[] = [];
let keyLight: DirectionalLight | null = null;
let vanishMeshes: { mesh: Mesh; index: number }[] = [];
let fakeMeshes = new Map<number, Mesh>();
let moverMeshes: Mesh[] = [];
let gearMeshes: Mesh[] = [];
let envGears: Mesh[] = [];
let clockHands: Mesh[] = [];
let shafts: Mesh[] = [];
let playerGroup: Group | null = null;
let playerRig: Group | null = null;
let playerWindup: Mesh | null = null;
let playerMarker: Mesh | null = null;
let exitGlow: Mesh | null = null;
interface Spark { x: number; y: number; z: number; vx: number; vy: number; life: number; age: number }
let particles: { pts: Points; pos: Float32Array; live: Spark[]; max: number } | null = null;
let dust: { pts: Points; pos: Float32Array; seeds: Float32Array; n: number } | null = null;
export let levelW = 20, levelH = 12;
let camDist = 20, viewHalfH = 6, viewHalfW = 10;
let levelBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
let camBase: Vector3 | null = null;
const camTarget = new Vector3();
const desired = new Vector3();
let shake = 0;
let time = 0;
let decoRng = R.makeRng(1);
let aspect = 1;
/** Touch layouts keep the runtime's control tray along the bottom edge: bias the follow point up. */
let coarse = false;

function track<T extends { dispose(): void }>(r: T): T { disposables.push(r); return r; }

// ---------------------------------------------------------------- materials
interface MatP {
  color?: number | Color; map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number; roughnessMap?: Texture | null;
  roughness?: number; metalness?: number; emissive?: number | Color; emissiveIntensity?: number; transparent?: boolean; opacity?: number;
  clearcoat?: number; clearcoatRoughness?: number;
}
const LAMBERT_KEYS = ["color", "map", "bumpMap", "bumpScale", "emissive", "emissiveIntensity", "transparent", "opacity"] as const;
/** Colours are cloned: the engine keeps a Color passed in (three copies it). */
function own(p: MatP): MatP {
  const q: MatP = { ...p };
  if (q.color instanceof Color) q.color = q.color.clone();
  if (q.emissive instanceof Color) q.emissive = q.emissive.clone();
  return q;
}
function lambert(p: MatP): Material {
  const q: Record<string, unknown> = {};
  for (const k of LAMBERT_KEYS) if (p[k] !== undefined) q[k] = p[k];
  return new MeshLambertMaterial(q);
}
/** render.js _mat: Lambert on Low, Standard above. */
function mat(color: number | Color, opts: MatP = {}): Material {
  const p = own({ color, roughness: 0.55, metalness: 0.65, ...opts });
  if (look!.budget.material === "lambert") return lambert(p);
  const { clearcoat: _c, clearcoatRoughness: _r, ...rest } = p;
  return new MeshStandardMaterial(rest);
}
/** render.js _phys: clear-coat Physical brass on High/Ultra, Standard on Balanced, Lambert on Low. */
function phys(color: number | Color, opts: MatP = {}): Material {
  const p = own({ color, roughness: 0.35, metalness: 0.9, clearcoat: 0.6, clearcoatRoughness: 0.25, ...opts });
  if (look!.budget.material === "lambert") return lambert(p);
  if (look!.budget.material === "standard") { const { clearcoat: _c, clearcoatRoughness: _r, ...rest } = p; return new MeshStandardMaterial(rest); }
  return new MeshPhysicalMaterial(p);
}
const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * look!.budget.segments));

// ---------------------------------------------------------------- canvas textures (render.js, the same drawing)
function canvasTex(size: number, draw: (g: Ctx, n: number) => void, linear: boolean, authored?: number): CanvasTexture {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext("2d")! as Ctx;
  if (authored && authored !== size) g.scale(size / authored, size / authored);
  draw(g, authored || size);
  const t = new CanvasTexture(c);
  t.colorSpace = linear ? NoColorSpace : SRGBColorSpace;
  t.anisotropy = 4;
  return track(t);
}
function stoneTextures(): { map: Texture; bump: Texture } {
  const rng = R.makeRng(0x5701e);
  const draw = (g: Ctx, n: number): void => {
    g.fillStyle = "#d6d0c4";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) {
      const v = 170 + Math.floor(rng() * 70);
      g.fillStyle = `rgba(${v},${v - 4},${v - 12},0.35)`;
      const s = 1 + rng() * 3;
      g.fillRect(rng() * n, rng() * n, s, s);
    }
    const gr = g.createLinearGradient(0, 0, 0, n);
    gr.addColorStop(0, "rgba(255,255,255,0.10)");
    gr.addColorStop(1, "rgba(0,0,0,0.12)");
    g.fillStyle = gr;
    g.fillRect(0, 0, n, n);
    g.strokeStyle = "rgba(60,50,40,0.55)";
    g.lineWidth = 6;
    g.strokeRect(0, 0, n, n);
  };
  const n = look!.budget.texture;
  return { map: canvasTex(n, draw, false, 128), bump: canvasTex(n, draw, true, 128) };
}
function brassTextures(): { map: Texture; bump: Texture } {
  const rng = R.makeRng(0xb4a55);
  const draw = (g: Ctx, n: number): void => {
    g.fillStyle = "#e8e2d6";
    g.fillRect(0, 0, n, n);
    for (let y = 0; y < n; y++) {
      const v = 200 + Math.floor(rng() * 50);
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(0, y, n, 1);
    }
    g.strokeStyle = "rgba(80,60,30,0.6)";
    g.lineWidth = 5;
    g.strokeRect(2, 2, n - 4, n - 4);
    for (const [x, y] of [[14, 14], [n - 14, 14], [14, n - 14], [n - 14, n - 14]] as const) {
      const r = g.createRadialGradient(x - 2, y - 2, 1, x, y, 7);
      r.addColorStop(0, "#ffffff");
      r.addColorStop(0.6, "#b8a888");
      r.addColorStop(1, "rgba(60,40,20,0.9)");
      g.fillStyle = r;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    }
  };
  const n = look!.budget.texture;
  return { map: canvasTex(n, draw, false, 128), bump: canvasTex(n, draw, true, 128) };
}
function softSprite(): Texture {
  return canvasTex(64, (g, n) => {
    const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, n, n);
  }, false);
}

// ---------------------------------------------------------------- geometry helpers
function gearGeometry(r: number, thickness: number, teeth: number): ExtrudeGeometry {
  const shape = new Shape();
  const inner = r * 0.78;
  for (let i = 0; i <= teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : inner;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const hole = new Path();
  hole.absarc(0, 0, r * 0.25, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
}
interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
/** World-space box of the tiles that exist (render.js _contentBounds). */
function contentBounds(l: Level): Bounds {
  const rows = l.ascii.split("\n");
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  let minCol = w, maxCol = -1, minRow = h, maxRow = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y] || "";
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "." || row[x] === " ") continue;
      if (x < minCol) minCol = x;
      if (x > maxCol) maxCol = x;
      if (y < minRow) minRow = y;
      if (y > maxRow) maxRow = y;
    }
  }
  if (maxCol < 0) return { minX: -w / 2, maxX: w / 2, minY: 0, maxY: h };
  return { minX: minCol - w / 2, maxX: maxCol + 1 - w / 2, minY: h - maxRow - 1, maxY: h - minRow };
}

// ---------------------------------------------------------------- scene build
function disposeDeep(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const x of mats as Material[]) x.dispose();
  });
}
function clearLevel(): void {
  if (levelGroup) { scene.remove(levelGroup); disposeDeep(levelGroup); }
  if (envGroup) { scene.remove(envGroup); disposeDeep(envGroup); }
  for (const l of levelLights) scene.remove(l);
  for (const r of disposables) r.dispose();
  disposables = [];
  levelGroup = new Group();
  envGroup = new Group();
  scene.add(levelGroup, envGroup);
  vanishMeshes = []; fakeMeshes = new Map(); moverMeshes = []; gearMeshes = []; envGears = []; clockHands = []; shafts = [];
  dust = null; particles = null; exitGlow = null;
}

/** render.js loadLevel: the level's tiles, environment, climber and particles, framed. */
export function loadLevel(l: Level, themeId: string): void {
  level = l;
  theme = C.THEMES.find((t) => t.id === themeId) || C.THEMES[0]!;
  if (!look) return;
  clearLevel();
  const detailed = look.detailed;
  scene.background = new Color(theme.sky);
  scene.fog = new Fog(theme.fog, 28, 85);
  // one dominant key, soft hemisphere fill, a rim from behind
  const key = new DirectionalLight(theme.key, 2.4);
  key.shadow.mapSize = 1024;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  keyLight = key;
  applyShadow();
  const fill = new HemisphereLight(theme.fill, 0x0a0a12, 1.0);
  scene.add(fill);
  const rim = new DirectionalLight(theme.accent, 0.5);
  rim.position.set(-10, 6, -8);
  scene.add(rim);
  levelLights = [key, key.target, fill, rim];
  decoRng = R.makeRng(l.seed ^ 0xdec0);
  buildEnvironment(l, detailed);
  buildTiles(l, detailed);
  buildPlayer();
  buildParticles();
  frameCamera(l);
  fitShadow(l);
  if (exitGlow && detailed) {
    const lamp = new PointLight(theme.accent, 6, 7, 1.6);
    lamp.position.copy(exitGlow.position).add(new Vector3(0, 0.3, 0.9));
    levelGroup!.add(lamp);
  }
}
function applyShadow(): void {
  if (!keyLight || !look) return;
  keyLight.castShadow = look.shadows > 0;
  if (look.shadows > 0) keyLight.shadow.mapSize = look.shadows;
}
/** The shadow frustum fitted around the playfield (render.js _fitShadow). */
function fitShadow(l: Level): void {
  const b = contentBounds(l);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 2;
  const key = keyLight!;
  key.target.position.set(cx, cy, 0);
  key.position.set(cx + 8, cy + 16, 14);
  const cam = key.shadow.camera as unknown as { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix(): void };
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = 30 + r * 2;
  cam.updateProjectionMatrix();
  key.target.updateMatrixWorld();
}

function buildEnvironment(l: Level, detailed: boolean): void {
  const g = envGroup!;
  const b = contentBounds(l);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const envDetail = detailed ? 1 : 0.4;
  // the tower wall far behind: dim brick courses, unlit and unfogged
  const sky = new Color(theme.sky);
  const brick = canvasTex(look!.budget.texture * 2, (ctx, n) => {
    const base = sky.clone().multiplyScalar(1.1);
    const mortar = sky.clone().multiplyScalar(0.6);
    ctx.fillStyle = hex(mortar);
    ctx.fillRect(0, 0, n, n);
    const rng = R.makeRng(0xb41c);
    const rows = 8, bh = n / rows, bw = n / 4;
    for (let r = 0; r < rows; r++) {
      for (let c = -1; c < 5; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0);
        const k = 0.85 + rng() * 0.3;
        ctx.fillStyle = hex(base.clone().multiplyScalar(k));
        ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
  }, false, 256);
  brick.wrapS = brick.wrapT = RepeatWrapping;
  brick.repeat.set(24, 14);
  const wall = new Mesh(track(new PlaneGeometry(240, 140)), track(new MeshBasicMaterial({ map: brick, fog: false, color: detailed ? 0xffffff : 0xdddddd })));
  wall.position.set(cx, cy, -40);
  g.add(wall);

  // giant background gears (dim, so they recede) and columns
  const gearGeo = track(gearGeometry(1, 0.28, 12));
  const gearMat = track(mat(new Color(theme.brass).lerp(new Color(theme.sky), 0.5).multiplyScalar(0.22), { roughness: 0.6, metalness: 0.6 }));
  const count = Math.round(look!.budget.gears * envDetail) + 2;
  for (let i = 0; i < count; i++) {
    const m = new Mesh(gearGeo, gearMat);
    const s = 2 + decoRng() * 5;
    m.scale.setScalar(s);
    m.position.set(cx + (decoRng() - 0.5) * 60, cy - 4 + decoRng() * 22, -14 - decoRng() * 14);
    m.userData.speed = ((decoRng() - 0.5) * 0.5) / s;
    g.add(m);
    envGears.push(m);
  }
  const colGeo = track(new CylinderGeometry(0.6, 0.8, 80, seg(detailed ? 16 : 10, 6)));
  const colMat = track(mat(theme.solid, { roughness: 0.7, metalness: 0.4 }));
  const lw = l.ascii.split("\n").reduce((m, r) => Math.max(m, r.length), 0);
  for (const x of [-lw * 0.7, lw * 1.7]) {
    const c = new Mesh(colGeo, colMat);
    c.position.set(x - lw / 2, cy, -10);
    g.add(c);
  }
  // the ground far below, for contact grounding
  const ground = new Mesh(track(new PlaneGeometry(200, 60)), track(mat(0x0c0e16, { roughness: 1, metalness: 0 })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -6, -4);
  ground.receiveShadow = true;
  g.add(ground);
  if (!detailed) return;

  // the great clock face beside the upper playfield, its hands turning slowly
  const clock = new Group();
  const Rr = 7.5;
  const face = new Mesh(track(new CircleGeometry(Rr, seg(48, 24))), track(mat(new Color(theme.sky).multiplyScalar(1.3), { roughness: 0.9, metalness: 0.2 })));
  const rimMat = track(mat(new Color(theme.brass).multiplyScalar(0.38), { roughness: 0.6, metalness: 0.75 }));
  const ring = new Mesh(track(new TorusGeometry(Rr, 0.35, seg(10, 6), seg(64, 32))), rimMat);
  const tickGeo = track(new BoxGeometry(0.28, 1.1, 0.2));
  clock.add(face, ring);
  for (let i = 0; i < 12; i++) {
    const t = new Mesh(tickGeo, rimMat);
    const a = (i / 12) * Math.PI * 2;
    t.position.set(Math.sin(a) * (Rr - 1), Math.cos(a) * (Rr - 1), 0.1);
    t.rotation.z = -a;
    if (i % 3 === 0) t.scale.set(1.5, 1.4, 1);
    clock.add(t);
  }
  const handGeo = track(new BoxGeometry(0.32, 1, 0.12));
  handGeo.translate(0, 0.5, 0);
  for (const [len, speed] of [[Rr * 0.55, 0.05], [Rr * 0.82, 0.6]] as const) {
    const hnd = new Mesh(handGeo, rimMat);
    hnd.scale.set(1, len, 1);
    hnd.position.z = 0.25;
    hnd.rotation.z = -decoRng() * Math.PI * 2;
    hnd.userData.speed = speed;
    clock.add(hnd);
    clockHands.push(hnd);
  }
  clock.position.set(b.maxX + Rr * 0.9, cy + (b.maxY - b.minY) * 0.2, -32);
  g.add(clock);

  // glowing arched windows in the wall (what bloom picks up)
  const winTex = canvasTex(128, (ctx, n) => {
    const glow = ctx.createLinearGradient(0, 0, 0, n);
    glow.addColorStop(0, "#ffffff");
    glow.addColorStop(1, "#b89a70");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.moveTo(n * 0.2, n);
    ctx.lineTo(n * 0.2, n * 0.3);
    ctx.arc(n * 0.5, n * 0.3, n * 0.3, Math.PI, 0);
    ctx.lineTo(n * 0.8, n);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "#1a1410";
    ctx.fillRect(n * 0.47, 0, n * 0.06, n);
    ctx.fillRect(0, n * 0.52, n, n * 0.05);
  }, false);
  const winGeo = track(new PlaneGeometry(4, 4));
  const winMat = track(new MeshBasicMaterial({ map: winTex, color: new Color(theme.key).multiplyScalar(1.3), fog: false, transparent: true, alphaTest: 0.02 }));
  for (let i = 0; i < 5; i++) {
    const w = new Mesh(winGeo, winMat);
    w.position.set(cx - 36 + i * 18 + (decoRng() - 0.5) * 4, cy + 10 + decoRng() * 6, -39.9);
    g.add(w);
  }
  // soft light shafts slanting down from the windows (additive, shimmering)
  const shaftTex = canvasTex(64, (ctx, n) => {
    const gx = ctx.createLinearGradient(0, 0, n, 0);
    gx.addColorStop(0, "rgba(255,255,255,0)");
    gx.addColorStop(0.5, "rgba(255,255,255,1)");
    gx.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, n, n);
    ctx.globalCompositeOperation = "destination-in";
    const gy = ctx.createLinearGradient(0, 0, 0, n);
    gy.addColorStop(0, "rgba(0,0,0,1)");
    gy.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, n, n);
  }, false);
  const shaftGeo = track(new PlaneGeometry(4, 36));
  for (let i = 0; i < 3; i++) {
    const m = track(new MeshBasicMaterial({ map: shaftTex, color: theme.key, transparent: true, opacity: 0.07, depthWrite: false, blending: AdditiveBlending, fog: false }));
    const s = new Mesh(shaftGeo, m);
    s.position.set(cx - 14 + i * 14 + (decoRng() - 0.5) * 6, cy + 2, -16 + i * 2);
    s.rotation.z = 0.35;
    s.userData.phase = decoRng() * Math.PI * 2;
    g.add(s);
    shafts.push(s);
  }
}

function buildTiles(l: Level, detailed: boolean): void {
  const g = levelGroup!;
  const rows = l.ascii.split("\n");
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  levelW = w; levelH = h;
  const blockGeo = track(detailed ? new RoundedBoxGeometry(1, 1, 1, 2, 0.06) : new BoxGeometry(1, 1, 1));
  const boxGeo = track(new BoxGeometry(1, 1, 1));
  const spikeGeo = track(new ConeGeometry(0.34, 0.7, seg(detailed ? 8 : 6, 4)));
  const gearGeo = track(new TorusGeometry(0.3, 0.11, seg(detailed ? 12 : 8, 6), seg(detailed ? 24 : 14, 10)));
  const springGeo = track(new CylinderGeometry(0.32, 0.4, 0.3, seg(detailed ? 16 : 10, 8)));
  const poleGeo = track(new CylinderGeometry(0.04, 0.04, 1.2, 6));
  const stone = detailed ? stoneTextures() : null;
  const plate = detailed ? brassTextures() : null;
  const solidOpts: MatP = stone ? { map: stone.map, bumpMap: stone.bump, bumpScale: 0.6, roughnessMap: stone.bump, roughness: 0.95, metalness: 0.35 } : {};
  const mats = {
    solid: mat(theme.solid, solidOpts),
    brass: detailed
      ? phys(theme.brass, { map: plate!.map, bumpMap: plate!.bump, bumpScale: 0.8, roughness: 0.34, metalness: 0.92, clearcoat: 0.5 })
      : mat(theme.brass, { roughness: 0.38, metalness: 0.92 }),
    vanish: mat(theme.accent, { transparent: true, opacity: 0.85, emissive: theme.accent, emissiveIntensity: 0.25 }),
    // trick steps must look exactly like solid stone until revealed
    fake: mat(theme.solid, solidOpts),
    spike: mat(theme.hazard, { roughness: 0.3, metalness: 0.7, emissive: theme.hazard, emissiveIntensity: 0.45 }),
    gear: phys(0xffd777, { roughness: 0.2, metalness: 1, emissive: 0x996600, emissiveIntensity: 0.9, clearcoat: 1 }),
    spring: phys(0xd8d8e8, { roughness: 0.25, metalness: 0.9, clearcoat: 0.8 }),
    exit: mat(theme.accent, { emissive: theme.accent, emissiveIntensity: 1.4, roughness: 0.3 }),
    checkpoint: mat(0x88ffcc, { emissive: 0x88ffcc, emissiveIntensity: 0.7 }),
    mover: phys(theme.brass, { roughness: 0.3, metalness: 0.95, emissive: theme.brass, emissiveIntensity: 0.12, clearcoat: 0.7 }),
    frame: phys(theme.brass, { roughness: 0.32, metalness: 0.95 }),
  };
  for (const m of Object.values(mats)) track(m);
  const cells: Record<"solid" | "brass", [number, number][]> = { solid: [], brass: [] };
  const fakes: [number, number, number][] = [];
  for (let y = 0; y < h; y++) {
    const row = rows[y] || "";
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const wx = x - w / 2 + 0.5, wy = h - y;
      if (ch === "#") cells.solid.push([wx, wy]);
      else if (ch === "B") cells.brass.push([wx, wy]);
      else if (ch === "~") fakes.push([wx, wy, y * w + x]);
      else if (ch === "=") {
        const m = new Mesh(blockGeo, track(mats.vanish.clone()));
        m.scale.set(1, 1, 0.6);
        m.position.set(wx, wy - 0.5, 0);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m);
        vanishMeshes.push({ mesh: m, index: y * w + x });
      } else if (ch === "^") {
        const m = new Mesh(spikeGeo, mats.spike);
        m.position.set(wx, wy - 0.75, 0);
        m.castShadow = true;
        g.add(m);
        const m2 = new Mesh(spikeGeo, mats.spike);
        m2.position.set(wx + 0.3, wy - 0.82, 0.1); m2.scale.setScalar(0.7);
        g.add(m2);
      } else if (ch === "*") {
        const m = new Mesh(gearGeo, mats.gear);
        m.position.set(wx, wy - 0.5, 0);
        m.castShadow = true;
        m.userData.baseY = wy - 0.5;
        m.userData.phase = x * 0.7;
        g.add(m);
        gearMeshes.push(m);
      } else if (ch === "o") {
        const m = new Mesh(springGeo, mats.spring);
        m.position.set(wx, wy - 0.85, 0);
        m.castShadow = true;
        g.add(m);
      } else if (ch === "E") {
        const door = new Mesh(boxGeo, mats.exit);
        door.scale.set(0.9, 1.6, 0.3);
        door.position.set(wx, wy - 0.1, 0);
        g.add(door);
        exitGlow = door;
        if (detailed) {
          for (const [sx, sy, px, py] of [[0.12, 1.8, -0.52, 0], [0.12, 1.8, 0.52, 0], [1.16, 0.14, 0, 0.9]] as const) {
            const f = new Mesh(boxGeo, mats.frame);
            f.scale.set(sx, sy, 0.4);
            f.position.set(wx + px, wy - 0.1 + py, 0);
            f.castShadow = true;
            g.add(f);
          }
        }
      } else if (ch === "C") {
        const pole = new Mesh(poleGeo, mats.checkpoint);
        pole.position.set(wx, wy - 0.4, 0);
        const flag = new Mesh(boxGeo, mats.checkpoint);
        flag.scale.set(0.4, 0.25, 0.05);
        flag.position.set(wx + 0.22, wy + 0.12, 0);
        g.add(pole, flag);
      } else if (ch === "-" || ch === "|") {
        const m = new Mesh(blockGeo, mats.mover);
        m.scale.set(1, 0.35, 0.8);
        m.position.set(wx, wy - 0.5, 0);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m);
        moverMeshes.push(m);
      }
    }
  }
  // instanced solid blocks
  for (const kind of ["solid", "brass"] as const) {
    const list = cells[kind];
    if (!list.length) continue;
    const inst = new InstancedMesh(blockGeo, mats[kind], list.length);
    const mtx = new Matrix4();
    list.forEach(([wx, wy], i) => { mtx.makeTranslation(wx, wy - 0.5, 0); inst.setMatrixAt(i, mtx); });
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
  }
  // trick steps: their own meshes so the reveal shimmer can target them
  for (const [wx, wy, idx] of fakes) {
    const m = new Mesh(blockGeo, track(mats.fake.clone()));
    m.position.set(wx, wy - 0.5, 0);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    fakeMeshes.set(idx, m);
  }
}

function buildPlayer(): void {
  const grp = new Group();
  const rig = new Group(); // the cosmetic idle bob lives here, never on grp
  const detailed = look!.detailed;
  const bodyGeo = detailed ? new RoundedBoxGeometry(PLAYER_W, PLAYER_H * 0.72, 0.5, 3, 0.08) : new BoxGeometry(PLAYER_W, PLAYER_H * 0.72, 0.5);
  const body = new Mesh(track(bodyGeo), track(phys(0xe8c87a, { roughness: 0.3, metalness: 0.85, clearcoat: 0.8 })));
  body.position.y = PLAYER_H * 0.36;
  body.castShadow = true;
  const headGeo = detailed ? new RoundedBoxGeometry(PLAYER_W * 0.7, PLAYER_H * 0.26, 0.44, 3, 0.06) : new BoxGeometry(PLAYER_W * 0.7, PLAYER_H * 0.26, 0.44);
  const head = new Mesh(track(headGeo), track(phys(theme.accent, { roughness: 0.3, metalness: 0.8, emissive: theme.accent, emissiveIntensity: 0.35, clearcoat: 0.8 })));
  head.position.y = PLAYER_H * 0.86;
  head.castShadow = true;
  const windup = new Mesh(track(gearGeometry(0.16, 0.06, 8)), track(phys(0xc9973f, { metalness: 0.95, roughness: 0.3 })));
  windup.position.set(0, PLAYER_H * 0.55, 0.3);
  rig.add(body, head, windup);
  if (detailed) {
    // two bright visor eyes: a facing and a face
    const eyeGeo = track(new SphereGeometry(0.045, 10, 8));
    const eyeMat = track(new MeshBasicMaterial({ color: 0xfff6d8 }));
    for (const ex of [0.08, 0.2]) {
      const e = new Mesh(eyeGeo, eyeMat);
      e.position.set(ex, PLAYER_H * 0.87, 0.22);
      rig.add(e);
    }
  }
  grp.add(rig);
  playerGroup = grp; playerRig = rig; playerWindup = windup;
  levelGroup!.add(grp);
  // the grounded marker under the climber
  const marker = new Mesh(track(new RingGeometry(0.28, 0.4, 20)), track(new MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.5, side: DoubleSide })));
  marker.rotation.x = -Math.PI / 2;
  playerMarker = marker;
  levelGroup!.add(marker);
}

function buildParticles(): void {
  const pb = particleBudget(look!);
  const sprite = softSprite();
  const geo = track(new BufferGeometry());
  const pos = new Float32Array(pb.max * 3);
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const m = track(new PointsMaterial({ color: theme.accent, size: 0.2, map: sprite, transparent: true, opacity: 1, sizeAttenuation: true, depthWrite: false, blending: AdditiveBlending }));
  const pts = new Points(geo, m);
  pts.frustumCulled = false;
  geo.setDrawRange(0, 0);
  levelGroup!.add(pts);
  particles = { pts, pos, live: [], max: pb.max };
  const n = pb.dust;
  if (!n) return;
  const dgeo = track(new BufferGeometry());
  const dpos = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dpos[i * 3] = (decoRng() - 0.5) * 40;
    dpos[i * 3 + 1] = (decoRng() - 0.5) * 30;
    dpos[i * 3 + 2] = -6 + decoRng() * 8;
    seeds[i] = decoRng() * Math.PI * 2;
  }
  dgeo.setAttribute("position", new BufferAttribute(dpos, 3));
  const dm = track(new PointsMaterial({ color: theme.key, size: 0.09, map: sprite, transparent: true, opacity: 0.45, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
  const d = new Points(dgeo, dm);
  d.frustumCulled = false;
  levelGroup!.add(d);
  dust = { pts: d, pos: dpos, seeds, n };
}

/** render.js burst: sparks at a world point. */
export function burst(x: number, y: number, color: string, n: number, spread: number): void {
  if (!particles || reducedMotion) n = Math.min(n || 8, 4);
  if (look && look.particles === "high" && !reducedMotion) n = Math.round(n * 1.6);
  const P = particles;
  if (!P) return;
  for (let i = 0; i < n; i++) {
    const a = decoRng() * Math.PI * 2;
    const sp = (0.5 + decoRng()) * (spread || 3);
    P.live.push({ x, y, z: 0.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1.5, life: 0.5 + decoRng() * 0.4, age: 0 });
  }
  if (P.live.length > P.max) P.live.splice(0, P.live.length - P.max);
  (P.pts.material as PointsMaterial).color.set(color);
}
export function kickShake(amount: number): void { if (!reducedMotion) shake = Math.min(1, shake + amount); }

// ---------------------------------------------------------------- camera (render.js _frameCamera / _cameraTarget)
function frameCamera(l: Level): void {
  const MARGIN = 1.5, VIEW_TILES = 13, MIN_VIEW_W = 10;
  const vHalf = Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const b = contentBounds(l);
  const spanX = b.maxX - b.minX, spanY = b.maxY - b.minY;
  const fitDist = Math.max((spanY / 2 + MARGIN) / vHalf, (spanX / 2 + MARGIN) / (vHalf * aspect));
  const followDist = Math.max(VIEW_TILES / 2 / vHalf, MIN_VIEW_W / 2 / (vHalf * aspect));
  const dist = Math.min(fitDist, followDist);
  camDist = dist;
  viewHalfH = dist * vHalf;
  viewHalfW = viewHalfH * aspect;
  levelBounds = { minX: b.minX - MARGIN, maxX: b.maxX + MARGIN, minY: b.minY - MARGIN, maxY: b.maxY + MARGIN };
  const midX = (b.minX + b.maxX) / 2, midY = (b.minY + b.maxY) / 2;
  camBase = new Vector3(midX, midY, dist);
  const [cx, cy] = cameraTarget(midX, midY);
  camera.position.set(cx, cy, dist);
  camTarget.set(cx, cy, 0);
  camera.lookAt(camTarget);
}
function cameraTarget(wx: number, wy: number): [number, number] {
  const b = levelBounds;
  if (!b) return [wx, wy];
  const EDGE_PAD = Math.min(2.5, viewHalfH * 0.25);
  const axis = (v: number, min: number, max: number, half: number): number => {
    const c = half * 2 >= max - min ? (min + max) / 2 : MathUtils.clamp(v, min + half, max - half);
    const slack = Math.max(0, half - EDGE_PAD);
    return MathUtils.clamp(c, v - slack, v + slack);
  };
  return [axis(wx, b.minX, b.maxX, viewHalfW), axis(wy, b.minY, b.maxY, viewHalfH)];
}
/** C: the camera back at the level's framing. */
export function resetCamera(): void { if (camBase) camera.position.copy(camBase); }

// ---------------------------------------------------------------- settings
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  renderer.shadowMap.enabled = next.shadows > 0;
  applyShadow();
  // high threshold: only emissive parts (exit, gears, sparks, windows) bloom
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.45, threshold: 0.9, resolution: next.budget.bloomRes } : null;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: next.ao === "high" ? 16 : 8,
    resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8 },
  };
  // GradeShader after OutputPass: a 0.22 S-curve, saturation 1.1, cool shadows / warm highlights by a smoothstep of
  // luma 0.15–0.8, a 0.28 vignette from 0.38 to 0.9 with x × 1.1
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.22, saturation: 1.1, split: [0.15, 0.8], shadows: [0.95, 0.98, 1.06], highlights: [1.05, 1.0, 0.94],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  const rebuild = !prev || prev.detailed !== next.detailed || prev.particles !== next.particles || JSON.stringify(prev.budget) !== JSON.stringify(next.budget);
  if (rebuild && level) loadLevel(level, theme.id);
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }

// ---------------------------------------------------------------- each frame (render.js render)
const toWorld = (x: number, y: number): [number, number] => [x - levelW / 2, levelH - y];
/** World point of a rules position (for bursts). */
export function worldOf(x: number, y: number): [number, number] { return toWorld(x, y); }

export function update(state: State | null, dt: number, w: number, h: number, isCoarse: boolean): void {
  dt = Math.min(0.1, dt);
  coarse = isCoarse;
  if (w > 0 && h > 0 && Math.abs(w / h - aspect) > 1e-4) {
    aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    if (level) frameCamera(level);
  }
  time += dt;
  const moving = !reducedMotion;
  const animated = moving && !!look?.animated;
  if (state && playerGroup) {
    const [wx, wy] = toWorld(state.player.x, state.player.y + PLAYER_H);
    playerGroup.position.set(wx, wy, 0);
    playerGroup.scale.x = state.player.face >= 0 ? 1 : -1;
    playerWindup!.rotation.z += dt * (2 + Math.abs(state.player.vx));
    playerGroup.scale.y = state.player.onGround ? 1 : 1.08;
    const idle = moving && state.player.onGround && Math.abs(state.player.vx) < 0.01;
    playerRig!.position.y = idle ? 0.02 * (1 + Math.sin(time * 3.2)) : 0;
    playerMarker!.position.set(wx, wy + 0.02, 0);
    playerMarker!.visible = state.player.onGround;
  }
  if (state) {
    for (const v of vanishMeshes) {
      const solid = R.isVanishSolid(state, v.index);
      const m = v.mesh.material as MeshStandardMaterial;
      m.opacity = solid ? 0.9 : 0.18;
      m.emissiveIntensity = solid ? 0.35 : 0.05;
    }
    for (const [idx, mesh] of fakeMeshes) {
      if (state.fakesRevealed.includes(idx)) {
        const m = mesh.material as MeshStandardMaterial;
        m.emissive.setHex(0xffffff);
        m.emissiveIntensity = 0.12 + 0.1 * Math.sin(time * 6);
      }
    }
    state.moverCfg.forEach((cfg, i) => {
      const m = moverMeshes[i];
      if (!m) return;
      const off = R.moverOffset(cfg, state.tick);
      m.position.set(cfg.x + 0.5 + off.dx - levelW / 2, levelH - (cfg.y + off.dy) - 0.5, 0);
    });
    state.gears.forEach((got, i) => {
      const m = gearMeshes[i];
      if (!m) return;
      m.visible = !got;
      m.rotation.z += dt * 2;
      if (moving) m.position.y = (m.userData.baseY as number) + 0.06 * Math.sin(time * 2.2 + (m.userData.phase as number));
    });
    if (exitGlow) (exitGlow.material as MeshStandardMaterial).emissiveIntensity = 1.2 + 0.4 * Math.sin(time * 2.4);
  }
  if (animated) {
    for (const g of envGears) g.rotation.z += (g.userData.speed as number) * dt;
    for (const hnd of clockHands) hnd.rotation.z -= (hnd.userData.speed as number) * dt * 0.2;
    for (const s of shafts) (s.material as MeshBasicMaterial).opacity = 0.06 + 0.025 * Math.sin(time * 0.7 + (s.userData.phase as number));
  }
  // dust drifts around the camera, wrapping so the field stays full
  if (dust) {
    const cx = camera.position.x, cy = camera.position.y;
    const hw = viewHalfW * 1.3, hh = viewHalfH * 1.3;
    const p = dust.pos;
    for (let i = 0; i < dust.n; i++) {
      const s = dust.seeds[i]!;
      if (animated) {
        p[i * 3] = p[i * 3]! + Math.sin(time * 0.3 + s) * 0.12 * dt;
        p[i * 3 + 1] = p[i * 3 + 1]! + (0.08 + 0.05 * Math.cos(s)) * dt;
      }
      let x = p[i * 3]! - cx, y = p[i * 3 + 1]! - cy;
      if (x < -hw) x += hw * 2; else if (x > hw) x -= hw * 2;
      if (y < -hh) y += hh * 2; else if (y > hh) y -= hh * 2;
      p[i * 3] = x + cx; p[i * 3 + 1] = y + cy;
    }
    (dust.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }
  if (particles) {
    const pos = particles.pos;
    let n = 0;
    for (let i = particles.live.length - 1; i >= 0; i--) {
      const p = particles.live[i]!;
      p.age += dt;
      if (p.age >= p.life) { particles.live.splice(i, 1); continue; }
      p.vy -= 6 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
      n++;
    }
    particles.pts.geometry.setDrawRange(0, n);
    (particles.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }
  // critically damped follow toward the climber, plus shake
  if (state && camBase) {
    const [px, py] = toWorld(state.player.x, state.player.y + PLAYER_H / 2);
    const [tx, ty] = cameraTarget(px, py - (coarse ? viewHalfH * 0.22 : 0));
    desired.set(tx, ty, camDist);
    if (reducedMotion) camera.position.copy(desired);
    else {
      camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
      if (shake > 0) {
        shake = Math.max(0, shake - dt * 2.5);
        const s = shake * 0.15;
        camera.position.x += (decoRng() - 0.5) * s;
        camera.position.y += (decoRng() - 0.5) * s;
      }
    }
    camera.lookAt(camera.position.x, camera.position.y, 0);
  }
}
