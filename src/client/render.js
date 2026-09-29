'use strict';

// Trickstep Tower — render module: Three.js scene graph, semantic entity views,
// authored camera, lighting, pooled VFX, graphics quality settings, post chain,
// adaptive resolution, disposal.

import * as THREE from '../../three.module.min.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TILE, moverOffset, isVanishSolid, makeRng, PLAYER_W, PLAYER_H } from '../rules.js';
import { THEMES } from '../content.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLE_BUDGET, DUST_MOTES, DEFAULT_GFX } from './gfx.js';

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2;

// Colour grade + vignette, applied in display space (after OutputPass).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.15, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const ua = (navigator && navigator.userAgent) || '';
  return coarse || /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
}

export class Renderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    // Canvas MSAA stays off: Low renders exactly as cheaply as before, and the
    // MSAA tier is provided by a multisampled composer target instead.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.gpu = this._gpuName();
    this.detected = detectPreset(this.gpu, { mobile: isMobileDevice() });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);

    // Image-based lighting: a neutral studio room, so brass and steel read as metal.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envRT = pmrem.fromScene(room, 0.04);
    room.dispose && room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.3;

    this.disposables = [];
    this.levelGroup = null;
    this.vanishMeshes = [];
    this.fakeMeshes = new Map();
    this.moverMeshes = [];
    this.gearMeshes = [];
    this.checkpointMeshes = [];
    this.playerGroup = null;
    this.exitGlow = null;
    this.envGroup = null;
    this.particles = null;
    this.dust = null;
    this.shafts = [];
    this.clockHands = [];
    this.camTarget = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this.shake = 0;
    this.time = 0;
    this.decoRng = makeRng(1);
    // Touch builds keep a control tray along the bottom edge; bias the follow
    // point so the climber never sits behind it.
    this.coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    this.size = [1, 1];
    this.pixelRatio = 0;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.setGraphicsSettings(settings.gfx || DEFAULT_GFX);

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.postKey = null;
      this.renderer.compile(this.scene, this.camera);
    });
  }

  _track(res) { this.disposables.push(res); return res; }

  _gpuName() {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------- graphics settings

  /** Apply saved graphics settings live (no reload). */
  setGraphicsSettings(saved) {
    const prev = this.q;
    const g = resolve(saved, this.detected);
    this.q = g;
    const size = SHADOW_MAP[g.shadows];
    const shadowsChanged = !prev || prev.shadows !== g.shadows;
    this.renderer.shadowMap.enabled = size > 0;
    if (this.keyLight) this._applyShadowMap();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    if (typeof document !== 'undefined') document.body.dataset.gfxPreset = g.preset;
    // Detail and particle budgets change geometry: rebuild the current level.
    const rebuild = prev && (prev.detail !== g.detail || prev.particles !== g.particles);
    if (rebuild && this.level) this.loadLevel(this.level, this.themeId);
    else if (shadowsChanged) this.scene.traverse(o => {
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
    });
  }

  _applyShadowMap() {
    const size = SHADOW_MAP[this.q.shadows];
    const key = this.keyLight;
    key.castShadow = size > 0;
    if (size > 0 && key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const px = [this.renderer.domElement.width, this.renderer.domElement.height];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey() {
    const g = this.q;
    return g.post || g.antialias === 'msaa'
      ? [g.ao, g.bloom, g.grade, g.antialias, this.size[0], this.size[1], this.pixelRatio].join('|')
      : 'none';
  }

  _buildPost() {
    const g = this.q;
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    this.gradePass = null;
    if (!(g.post || g.antialias === 'msaa') || this.postFailed) return;
    const [w, h] = this.size;
    const pr = this.pixelRatio;
    const W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
    try {
      const target = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, W, H);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive parts (exit, gears, sparks, windows) bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.45, 0.9));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') {
        this.gradePass = new ShaderPass(GradeShader);
        composer.addPass(this.gradePass);
      }
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass());
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / W, 1 / H);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    // Frame-rate readout refreshes every 30 frames; scaling decisions use 90.
    if (f.length % 30 === 0) {
      let recent = 0;
      for (let i = f.length - 30; i < f.length; i++) recent += f[i];
      this.fps = 30000 / recent;
      const el = typeof document !== 'undefined' && document.getElementById('fps-meter');
      if (el && !el.hidden) el.textContent = Math.round(this.fps) + ' fps · ' + (Math.round(this.pixelRatio * 100) / 100) + '×';
    }
    if (f.length < 90) return;
    let sum = 0;
    for (const v of f) sum += v;
    const avg = sum / f.length;
    f.length = 0;
    if (!this.q.adaptive) { this.adaptiveScale = 1; return; }
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
  }

  resize(w, h) {
    this.size = [Math.max(1, w), Math.max(1, h)];
    this.renderer.setSize(this.size[0], this.size[1], false);
    this.camera.aspect = this.size[0] / this.size[1];
    this.camera.updateProjectionMatrix();
    this.postKey = null;
    // Re-fit: the framing distance depends on the aspect ratio, so a rotation
    // or window resize must recompute it or the level falls out of frame.
    if (this.level) this._frameCamera(this.level);
  }

  // ------------------------------------------------------------ scene build

  loadLevel(level, themeId) {
    this.level = level;
    this.themeId = themeId;
    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    this.theme = theme;
    this._clearLevel();
    const detailed = this.q.detail === 'detailed';

    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, 28, 85);

    // Lighting: one dominant key, soft hemisphere fill, contact grounding.
    const key = new THREE.DirectionalLight(theme.key, 2.4);
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    this.scene.add(key, key.target);
    this.keyLight = key;
    this._applyShadowMap();
    const fill = new THREE.HemisphereLight(theme.fill, 0x0a0a12, 1.0);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(theme.accent, 0.5);
    rim.position.set(-10, 6, -8);
    this.scene.add(rim);
    this.levelLights = [key, key.target, fill, rim];

    this.decoRng = makeRng(level.seed ^ 0xdec0);
    this._buildEnvironment(theme, level, detailed);
    this._buildTiles(theme, level, detailed);
    this._buildPlayer(theme);
    this._buildParticles(theme);
    this._frameCamera(level);
    this._fitShadow(level);
    if (this.exitGlow && detailed) {
      const lamp = new THREE.PointLight(theme.accent, 6, 7, 1.6);
      lamp.position.copy(this.exitGlow.position).add(new THREE.Vector3(0, 0.3, 0.9));
      this.levelGroup.add(lamp);
    }
  }

  // Shadow frustum fitted tightly around the playfield contents.
  _fitShadow(level) {
    const b = this._contentBounds(level);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 2;
    const key = this.keyLight;
    key.target.position.set(cx, cy, 0);
    key.position.set(cx + 8, cy + 16, 14);
    const cam = key.shadow.camera;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 30 + r * 2 });
    cam.updateProjectionMatrix();
    key.target.updateMatrixWorld();
  }

  _clearLevel() {
    if (this.levelGroup) { this.scene.remove(this.levelGroup); this._disposeDeep(this.levelGroup); }
    if (this.envGroup) { this.scene.remove(this.envGroup); this._disposeDeep(this.envGroup); }
    if (this.levelLights) for (const l of this.levelLights) this.scene.remove(l);
    if (this.keyLight && this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
    for (const r of this.disposables) if (r && r.dispose) r.dispose();
    this.disposables = [];
    this.levelGroup = new THREE.Group();
    this.envGroup = new THREE.Group();
    this.scene.add(this.levelGroup, this.envGroup);
    this.vanishMeshes = [];
    this.fakeMeshes = new Map();
    this.moverMeshes = [];
    this.gearMeshes = [];
    this.checkpointMeshes = [];
    this.shafts = [];
    this.clockHands = [];
    this.windows = [];
    this.dust = null;
    this.exitGlow = null;
  }

  _disposeDeep(root) {
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        for (const k of ['map', 'roughnessMap', 'bumpMap', 'alphaMap']) if (m[k]) m[k].dispose();
        m.dispose();
      });
    });
  }

  _mat(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.65 }, opts));
  }

  _phys(color, opts) {
    return new THREE.MeshPhysicalMaterial(Object.assign({ color, roughness: 0.35, metalness: 0.9, clearcoat: 0.6, clearcoatRoughness: 0.25 }, opts));
  }

  // ---- procedural textures (seeded, drawn once per level)

  _canvas(size, draw, linear) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return this._track(t);
  }

  // Dressed stone block: pale face with speckle and a darker chamfered rim; the
  // material colour tints it per theme. Also used as bump + roughness.
  _stoneTextures() {
    const rng = makeRng(0x5701e);
    const draw = (ctx, n) => {
      ctx.fillStyle = '#d6d0c4';
      ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 900; i++) {
        const v = 170 + Math.floor(rng() * 70);
        ctx.fillStyle = 'rgba(' + v + ',' + (v - 4) + ',' + (v - 12) + ',0.35)';
        const s = 1 + rng() * 3;
        ctx.fillRect(rng() * n, rng() * n, s, s);
      }
      const g = ctx.createLinearGradient(0, 0, 0, n);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, n, n);
      ctx.strokeStyle = 'rgba(60,50,40,0.55)';
      ctx.lineWidth = 6;
      ctx.strokeRect(0, 0, n, n);
    };
    return { map: this._canvas(128, draw, false), bump: this._canvas(128, draw, true) };
  }

  // Brass plate: brushed streaks and four corner rivets.
  _brassTextures() {
    const rng = makeRng(0xb4a55);
    const draw = (ctx, n) => {
      ctx.fillStyle = '#e8e2d6';
      ctx.fillRect(0, 0, n, n);
      for (let y = 0; y < n; y++) {
        const v = 200 + Math.floor(rng() * 50);
        ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',0.5)';
        ctx.fillRect(0, y, n, 1);
      }
      ctx.strokeStyle = 'rgba(80,60,30,0.6)';
      ctx.lineWidth = 5;
      ctx.strokeRect(2, 2, n - 4, n - 4);
      for (const [x, y] of [[14, 14], [n - 14, 14], [14, n - 14], [n - 14, n - 14]]) {
        const r = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, 7);
        r.addColorStop(0, '#ffffff');
        r.addColorStop(0.6, '#b8a888');
        r.addColorStop(1, 'rgba(60,40,20,0.9)');
        ctx.fillStyle = r;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      }
    };
    return { map: this._canvas(128, draw, false), bump: this._canvas(128, draw, true) };
  }

  _softSprite() {
    return this._canvas(64, (ctx, n) => {
      const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, n, n);
    }, false);
  }

  _buildEnvironment(theme, level, detailed) {
    const g = this.envGroup;
    const b = this._contentBounds(level);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const envDetail = detailed ? 1 : 0.4;

    // Tower wall far behind the playfield: dim brick courses, unlit (no fog) so
    // it stays a quiet backdrop that never competes with the tiles.
    const sky = new THREE.Color(theme.sky);
    const brick = this._canvas(256, (ctx, n) => {
      const base = sky.clone().multiplyScalar(1.1);
      const mortar = sky.clone().multiplyScalar(0.6);
      ctx.fillStyle = '#' + mortar.getHexString();
      ctx.fillRect(0, 0, n, n);
      const rng = makeRng(0xb41c);
      const rows = 8, bh = n / rows, bw = n / 4;
      for (let r = 0; r < rows; r++) {
        for (let c = -1; c < 5; c++) {
          const x = c * bw + (r % 2 ? bw / 2 : 0);
          const k = 0.85 + rng() * 0.3;
          ctx.fillStyle = '#' + base.clone().multiplyScalar(k).getHexString();
          ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
        }
      }
    }, false);
    brick.wrapS = brick.wrapT = THREE.RepeatWrapping;
    brick.repeat.set(24, 14);
    const wall = new THREE.Mesh(
      this._track(new THREE.PlaneGeometry(240, 140)),
      this._track(new THREE.MeshBasicMaterial({ map: brick, fog: false, color: detailed ? 0xffffff : 0xdddddd }))
    );
    wall.position.set(cx, cy, -40);
    wall.layers.set(LAYER_ENV);
    g.add(wall);

    // Clockwork tower: giant background gears, columns.
    const gearGeo = this._track(this._gearGeometry(1, 0.28, 12));
    // Background gears stay dim so they recede behind the playfield.
    const gearMat = this._track(this._mat(new THREE.Color(theme.brass).lerp(new THREE.Color(theme.sky), 0.5).multiplyScalar(0.22), { roughness: 0.6, metalness: 0.6 }));
    const count = Math.round(6 * envDetail) + 2;
    this.envGears = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(gearGeo, gearMat);
      const s = 2 + this.decoRng() * 5;
      m.scale.setScalar(s);
      m.position.set(cx + (this.decoRng() - 0.5) * 60, cy - 4 + this.decoRng() * 22, -14 - this.decoRng() * 14);
      m.userData.speed = (this.decoRng() - 0.5) * 0.5 / s;
      m.layers.set(LAYER_ENV);
      g.add(m);
      this.envGears.push(m);
    }
    const colGeo = this._track(new THREE.CylinderGeometry(0.6, 0.8, 80, detailed ? 16 : 10));
    const colMat = this._track(this._mat(theme.solid, { roughness: 0.7, metalness: 0.4 }));
    for (const x of [-level.w * 0.7, level.w * 1.7]) {
      const c = new THREE.Mesh(colGeo, colMat);
      c.position.set(x - level.w / 2, cy, -10);
      c.layers.set(LAYER_ENV);
      g.add(c);
    }
    // Ground plane far below for contact grounding.
    const ground = new THREE.Mesh(this._track(new THREE.PlaneGeometry(200, 60)), this._track(this._mat(0x0c0e16, { roughness: 1, metalness: 0, envMapIntensity: 0.15 })));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -6, -4);
    ground.receiveShadow = true;
    ground.layers.set(LAYER_ENV);
    g.add(ground);

    if (!detailed) return;

    // Great clock face behind the upper playfield, hands turning slowly.
    const clock = new THREE.Group();
    const R = 7.5;
    const face = new THREE.Mesh(this._track(new THREE.CircleGeometry(R, 48)),
      this._track(this._mat(new THREE.Color(theme.sky).multiplyScalar(1.3), { roughness: 0.9, metalness: 0.2 })));
    const rimMat = this._track(this._mat(new THREE.Color(theme.brass).multiplyScalar(0.38), { roughness: 0.6, metalness: 0.75 }));
    const ring = new THREE.Mesh(this._track(new THREE.TorusGeometry(R, 0.35, 10, 64)), rimMat);
    const tickGeo = this._track(new THREE.BoxGeometry(0.28, 1.1, 0.2));
    clock.add(face, ring);
    for (let i = 0; i < 12; i++) {
      const t = new THREE.Mesh(tickGeo, rimMat);
      const a = (i / 12) * Math.PI * 2;
      t.position.set(Math.sin(a) * (R - 1), Math.cos(a) * (R - 1), 0.1);
      t.rotation.z = -a;
      if (i % 3 === 0) t.scale.set(1.5, 1.4, 1);
      clock.add(t);
    }
    const handGeo = this._track(new THREE.BoxGeometry(0.32, 1, 0.12));
    handGeo.translate(0, 0.5, 0);
    for (const [len, speed] of [[R * 0.55, 0.05], [R * 0.82, 0.6]]) {
      const hnd = new THREE.Mesh(handGeo, rimMat);
      hnd.scale.set(1, len, 1);
      hnd.position.z = 0.25;
      hnd.rotation.z = -this.decoRng() * Math.PI * 2;
      hnd.userData.speed = speed;
      clock.add(hnd);
      this.clockHands.push(hnd);
    }
    // Beside the playfield (never behind the steps), so it frames rather than competes.
    clock.position.set(b.maxX + R * 0.9, cy + (b.maxY - b.minY) * 0.2, -32);
    clock.traverse(o => o.layers.set(LAYER_ENV));
    g.add(clock);

    // Glowing arched windows in the tower wall (these are what bloom picks up).
    const winTex = this._canvas(128, (ctx, n) => {
      // Arched window with a cross mullion; alpha outside the arch.
      const glow = ctx.createLinearGradient(0, 0, 0, n);
      glow.addColorStop(0, '#ffffff');
      glow.addColorStop(1, '#b89a70');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.moveTo(n * 0.2, n);
      ctx.lineTo(n * 0.2, n * 0.3);
      ctx.arc(n * 0.5, n * 0.3, n * 0.3, Math.PI, 0);
      ctx.lineTo(n * 0.8, n);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#1a1410';
      ctx.fillRect(n * 0.47, 0, n * 0.06, n);
      ctx.fillRect(0, n * 0.52, n, n * 0.05);
    }, false);
    const winGeo = this._track(new THREE.PlaneGeometry(4, 4));
    const winMat = this._track(new THREE.MeshBasicMaterial({
      map: winTex, color: new THREE.Color(theme.key).multiplyScalar(1.3), fog: false, transparent: true, alphaTest: 0.02,
    }));
    for (let i = 0; i < 5; i++) {
      const w = new THREE.Mesh(winGeo, winMat);
      w.position.set(cx - 36 + i * 18 + (this.decoRng() - 0.5) * 4, cy + 10 + this.decoRng() * 6, -39.9);
      w.layers.set(LAYER_ENV);
      g.add(w);
    }

    // Soft light shafts slanting down from the windows (additive, shimmering).
    const shaftTex = this._canvas(64, (ctx, n) => {
      const gx = ctx.createLinearGradient(0, 0, n, 0);
      gx.addColorStop(0, 'rgba(255,255,255,0)');
      gx.addColorStop(0.5, 'rgba(255,255,255,1)');
      gx.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gx;
      ctx.fillRect(0, 0, n, n);
      ctx.globalCompositeOperation = 'destination-in';
      const gy = ctx.createLinearGradient(0, 0, 0, n);
      gy.addColorStop(0, 'rgba(0,0,0,1)');
      gy.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gy;
      ctx.fillRect(0, 0, n, n);
    }, false);
    const shaftGeo = this._track(new THREE.PlaneGeometry(4, 36));
    for (let i = 0; i < 3; i++) {
      const mat = this._track(new THREE.MeshBasicMaterial({
        map: shaftTex, color: theme.key, transparent: true, opacity: 0.07, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }));
      const s = new THREE.Mesh(shaftGeo, mat);
      s.position.set(cx - 14 + i * 14 + (this.decoRng() - 0.5) * 6, cy + 2, -16 + i * 2);
      s.rotation.z = 0.35;
      s.userData.phase = this.decoRng() * Math.PI * 2;
      s.layers.set(LAYER_ENV);
      g.add(s);
      this.shafts.push(s);
    }
  }

  _gearGeometry(r, thickness, teeth) {
    const shape = new THREE.Shape();
    const inner = r * 0.78;
    for (let i = 0; i <= teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      const rad = i % 2 === 0 ? r : inner;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const hole = new THREE.Path();
    hole.absarc(0, 0, r * 0.25, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  }

  _buildTiles(theme, level, detailed) {
    const g = this.levelGroup;
    const rows = level.ascii.split('\n');
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    this.levelW = w; this.levelH = h;

    // Detailed: chamfered blocks with dressed-stone / riveted-brass surfaces.
    const blockGeo = this._track(detailed ? new RoundedBoxGeometry(1, 1, 1, 2, 0.06) : new THREE.BoxGeometry(1, 1, 1));
    const boxGeo = this._track(new THREE.BoxGeometry(1, 1, 1));
    const spikeGeo = this._track(new THREE.ConeGeometry(0.34, 0.7, detailed ? 8 : 6));
    const gearGeo = this._track(new THREE.TorusGeometry(0.3, 0.11, detailed ? 12 : 8, detailed ? 24 : 14));
    const springGeo = this._track(new THREE.CylinderGeometry(0.32, 0.4, 0.3, detailed ? 16 : 10));
    const stone = detailed ? this._stoneTextures() : null;
    const plate = detailed ? this._brassTextures() : null;

    const solidOpts = stone
      ? { map: stone.map, bumpMap: stone.bump, bumpScale: 0.6, roughnessMap: stone.bump, roughness: 0.95, metalness: 0.35 }
      : {};
    const mats = {
      solid: this._mat(theme.solid, solidOpts),
      brass: detailed
        ? this._phys(theme.brass, { map: plate.map, bumpMap: plate.bump, bumpScale: 0.8, roughness: 0.34, metalness: 0.92, clearcoat: 0.5 })
        : this._mat(theme.brass, { roughness: 0.38, metalness: 0.92 }),
      vanish: this._mat(theme.accent, { transparent: true, opacity: 0.85, emissive: theme.accent, emissiveIntensity: 0.25 }),
      // Trick steps must look exactly like solid stone until revealed.
      fake: this._mat(theme.solid, solidOpts),
      spike: this._mat(theme.hazard, { roughness: 0.3, metalness: 0.7, emissive: theme.hazard, emissiveIntensity: 0.45 }),
      gear: this._phys(0xffd777, { roughness: 0.2, metalness: 1, emissive: 0x996600, emissiveIntensity: 0.9, clearcoat: 1 }),
      spring: this._phys(0xd8d8e8, { roughness: 0.25, metalness: 0.9, clearcoat: 0.8 }),
      exit: this._mat(theme.accent, { emissive: theme.accent, emissiveIntensity: 1.4, roughness: 0.3 }),
      checkpoint: this._mat(0x88ffcc, { emissive: 0x88ffcc, emissiveIntensity: 0.7 }),
      mover: this._phys(theme.brass, { roughness: 0.3, metalness: 0.95, emissive: theme.brass, emissiveIntensity: 0.12, clearcoat: 0.7 }),
      frame: this._phys(theme.brass, { roughness: 0.32, metalness: 0.95 }),
    };
    for (const k in mats) this._track(mats[k]);

    const solidCells = { solid: [], brass: [], fake: [] };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < (rows[y] || '').length; x++) {
        const ch = rows[y][x];
        const wx = x - w / 2 + 0.5, wy = h - y; // world: y up
        if (ch === '#') solidCells.solid.push([wx, wy]);
        else if (ch === 'B') solidCells.brass.push([wx, wy]);
        else if (ch === '~') solidCells.fake.push([wx, wy, y * w + x]);
        else if (ch === '=') {
          const m = new THREE.Mesh(blockGeo, mats.vanish.clone());
          this._track(m.material);
          m.scale.set(1, 1, 0.6);
          m.position.set(wx, wy - 0.5, 0);
          m.castShadow = true; m.receiveShadow = true;
          m.layers.set(LAYER_GAME);
          g.add(m);
          this.vanishMeshes.push({ mesh: m, index: y * w + x });
        } else if (ch === '^') {
          const m = new THREE.Mesh(spikeGeo, mats.spike);
          m.position.set(wx, wy - 0.75, 0);
          m.castShadow = true;
          m.layers.set(LAYER_GAME);
          g.add(m);
          const m2 = new THREE.Mesh(spikeGeo, mats.spike);
          m2.position.set(wx + 0.3, wy - 0.82, 0.1); m2.scale.setScalar(0.7);
          m2.layers.set(LAYER_GAME);
          g.add(m2);
        } else if (ch === '*') {
          const m = new THREE.Mesh(gearGeo, mats.gear);
          m.position.set(wx, wy - 0.5, 0);
          m.castShadow = true;
          m.layers.set(LAYER_GAME);
          m.userData.baseY = wy - 0.5;
          m.userData.phase = x * 0.7;
          g.add(m);
          this.gearMeshes.push(m);
        } else if (ch === 'o') {
          const m = new THREE.Mesh(springGeo, mats.spring);
          m.position.set(wx, wy - 0.85, 0);
          m.castShadow = true;
          m.layers.set(LAYER_GAME);
          g.add(m);
        } else if (ch === 'E') {
          const door = new THREE.Mesh(boxGeo, mats.exit);
          door.scale.set(0.9, 1.6, 0.3);
          door.position.set(wx, wy - 0.1, 0);
          door.layers.set(LAYER_GAME);
          g.add(door);
          this.exitGlow = door;
          if (detailed) {
            // Brass door frame so the exit reads as an architectural doorway.
            for (const [sx, sy, px, py] of [[0.12, 1.8, -0.52, 0], [0.12, 1.8, 0.52, 0], [1.16, 0.14, 0, 0.9]]) {
              const f = new THREE.Mesh(boxGeo, mats.frame);
              f.scale.set(sx, sy, 0.4);
              f.position.set(wx + px, wy - 0.1 + py, 0);
              f.castShadow = true;
              f.layers.set(LAYER_GAME);
              g.add(f);
            }
          }
        } else if (ch === 'C') {
          const pole = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6)), mats.checkpoint);
          pole.position.set(wx, wy - 0.4, 0);
          pole.layers.set(LAYER_GAME);
          const flag = new THREE.Mesh(boxGeo, mats.checkpoint);
          flag.scale.set(0.4, 0.25, 0.05);
          flag.position.set(wx + 0.22, wy + 0.12, 0);
          flag.layers.set(LAYER_GAME);
          g.add(pole, flag);
          this.checkpointMeshes.push(pole);
        } else if (ch === '-' || ch === '|') {
          const m = new THREE.Mesh(blockGeo, mats.mover);
          m.scale.set(1, 0.35, 0.8);
          m.position.set(wx, wy - 0.5, 0);
          m.castShadow = true; m.receiveShadow = true;
          m.layers.set(LAYER_GAME);
          g.add(m);
          this.moverMeshes.push({ mesh: m, x, y, vertical: ch === '|' });
        }
      }
    }
    // Instanced solid blocks (draw-call friendly).
    for (const kind of ['solid', 'brass']) {
      const cells = solidCells[kind];
      if (!cells.length) continue;
      const inst = new THREE.InstancedMesh(blockGeo, mats[kind], cells.length);
      const mtx = new THREE.Matrix4();
      cells.forEach(([wx, wy], i) => {
        mtx.makeTranslation(wx, wy - 0.5, 0);
        inst.setMatrixAt(i, mtx);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.layers.set(LAYER_GAME);
      inst.instanceMatrix.needsUpdate = true;
      g.add(inst);
    }
    // Fake floors: individual meshes so reveal shimmer can target them. Same
    // geometry, surface and shadowing as solid stone — nothing gives them away.
    for (const [wx, wy, idx] of solidCells.fake) {
      const m = new THREE.Mesh(blockGeo, mats.fake.clone());
      this._track(m.material);
      m.position.set(wx, wy - 0.5, 0);
      m.castShadow = true; m.receiveShadow = true;
      m.layers.set(LAYER_GAME);
      g.add(m);
      this.fakeMeshes.set(idx, m);
    }
  }

  _buildPlayer(theme) {
    const grp = new THREE.Group();
    const rig = new THREE.Group(); // cosmetic idle bob lives here, never on grp
    const detailed = this.q.detail === 'detailed';
    const bodyGeo = detailed
      ? new RoundedBoxGeometry(PLAYER_W, PLAYER_H * 0.72, 0.5, 3, 0.08)
      : new THREE.BoxGeometry(PLAYER_W, PLAYER_H * 0.72, 0.5);
    const body = new THREE.Mesh(this._track(bodyGeo), this._track(this._phys(0xe8c87a, { roughness: 0.3, metalness: 0.85, clearcoat: 0.8 })));
    body.position.y = PLAYER_H * 0.36;
    body.castShadow = true;
    const headGeo = detailed
      ? new RoundedBoxGeometry(PLAYER_W * 0.7, PLAYER_H * 0.26, 0.44, 3, 0.06)
      : new THREE.BoxGeometry(PLAYER_W * 0.7, PLAYER_H * 0.26, 0.44);
    const head = new THREE.Mesh(this._track(headGeo),
      this._track(this._phys(this.theme.accent, { roughness: 0.3, metalness: 0.8, emissive: this.theme.accent, emissiveIntensity: 0.35, clearcoat: 0.8 })));
    head.position.y = PLAYER_H * 0.86;
    head.castShadow = true;
    const keyGeo = this._track(this._gearGeometry(0.16, 0.06, 8));
    const windup = new THREE.Mesh(keyGeo, this._track(this._phys(0xc9973f, { metalness: 0.95, roughness: 0.3 })));
    windup.position.set(0, PLAYER_H * 0.55, 0.3);
    rig.add(body, head, windup);
    if (detailed) {
      // Two bright visor eyes: they give the climber a facing and a face.
      const eyeGeo = this._track(new THREE.SphereGeometry(0.045, 10, 8));
      const eyeMat = this._track(new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
      for (const ex of [0.08, 0.2]) {
        const e = new THREE.Mesh(eyeGeo, eyeMat);
        e.position.set(ex, PLAYER_H * 0.87, 0.22);
        rig.add(e);
      }
    }
    grp.add(rig);
    grp.traverse(o => o.layers.set(LAYER_GAME));
    this.playerGroup = grp;
    this.playerRig = rig;
    this.playerWindup = windup;
    this.levelGroup.add(grp);
    // Grounded selection marker under the player.
    const marker = new THREE.Mesh(
      this._track(new THREE.RingGeometry(0.28, 0.4, 20)),
      new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    this._track(marker.material);
    marker.rotation.x = -Math.PI / 2;
    marker.layers.set(LAYER_FX);
    this.playerMarker = marker;
    this.levelGroup.add(marker);
  }

  _buildParticles(theme) {
    const max = PARTICLE_BUDGET[this.q.particles] || PARTICLE_BUDGET.low;
    const sprite = this._softSprite();
    const geo = this._track(new THREE.BufferGeometry());
    const pos = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: theme.accent, size: 0.2, map: sprite, transparent: true, opacity: 1, sizeAttenuation: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this._track(mat);
    const pts = new THREE.Points(geo, mat);
    pts.layers.set(LAYER_FX);
    pts.frustumCulled = false;
    this.levelGroup.add(pts);
    this.particles = { pts, pos, live: [], max, cursor: 0 };

    // Ambient dust motes drifting through the key light.
    const n = DUST_MOTES[this.q.particles] || 0;
    if (!n) return;
    const dgeo = this._track(new THREE.BufferGeometry());
    const dpos = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      dpos[i * 3] = (this.decoRng() - 0.5) * 40;
      dpos[i * 3 + 1] = (this.decoRng() - 0.5) * 30;
      dpos[i * 3 + 2] = -6 + this.decoRng() * 8;
      seeds[i] = this.decoRng() * Math.PI * 2;
    }
    dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    const dmat = this._track(new THREE.PointsMaterial({
      color: theme.key, size: 0.09, map: sprite, transparent: true, opacity: 0.45,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    const dust = new THREE.Points(dgeo, dmat);
    dust.layers.set(LAYER_FX);
    dust.frustumCulled = false;
    this.levelGroup.add(dust);
    this.dust = { pts: dust, pos: dpos, seeds, n };
  }

  burst(x, y, color, n, spread) {
    if (!this.particles || this.settings.reducedMotion) n = Math.min(n || 8, 4);
    n = n || 10;
    if (this.q && this.q.particles === 'high' && !this.settings.reducedMotion) n = Math.round(n * 1.6);
    const P = this.particles;
    if (!P) return;
    for (let i = 0; i < n; i++) {
      const a = this.decoRng() * Math.PI * 2;
      const sp = (0.5 + this.decoRng()) * (spread || 3);
      P.live.push({
        x, y, z: 0.2,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 1.5,
        life: 0.5 + this.decoRng() * 0.4, age: 0,
      });
    }
    if (P.live.length > P.max) P.live.splice(0, P.live.length - P.max);
    if (color) P.pts.material.color.set(color);
  }

  // World-space bounding box of the tiles that actually exist. Generated
  // stages leave large empty margins in the grid; framing on the grid instead
  // of its contents pushes the playfield into a corner of the screen.
  _contentBounds(level) {
    const rows = level.ascii.split('\n');
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    let minCol = w, maxCol = -1, minRow = h, maxRow = -1;
    for (let y = 0; y < h; y++) {
      const row = rows[y] || '';
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '.' || row[x] === ' ') continue;
        if (x < minCol) minCol = x;
        if (x > maxCol) maxCol = x;
        if (y < minRow) minRow = y;
        if (y > maxRow) maxRow = y;
      }
    }
    if (maxCol < 0) return { minX: -w / 2, maxX: w / 2, minY: 0, maxY: h };
    return {
      minX: minCol - w / 2, maxX: maxCol + 1 - w / 2,
      minY: h - maxRow - 1, maxY: h - minRow,
    };
  }

  _frameCamera(level) {
    // Authored framing constants (no magic offsets elsewhere).
    // MARGIN: tiles of breathing room around the level bounds.
    // VIEW_TILES: how much of the tower stays on screen while following, so the
    // climber and the next few steps read clearly on any viewport.
    // MIN_VIEW_W: narrow portrait viewports pull back far enough to still see
    // the next steps sideways.
    const MARGIN = 1.5, VIEW_TILES = 13, MIN_VIEW_W = 10;
    const vHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const aspect = this.camera.aspect || 1;
    const b = this._contentBounds(level);
    const spanX = b.maxX - b.minX, spanY = b.maxY - b.minY;
    // Distance that fits the whole playfield, and the closer follow distance.
    const fitDist = Math.max((spanY / 2 + MARGIN) / vHalf, (spanX / 2 + MARGIN) / (vHalf * aspect));
    const followDist = Math.max((VIEW_TILES / 2) / vHalf, (MIN_VIEW_W / 2) / (vHalf * aspect));
    const dist = Math.min(fitDist, followDist);
    this.camDist = dist;
    this.viewHalfH = dist * vHalf;
    this.viewHalfW = this.viewHalfH * aspect;
    this.levelBounds = {
      minX: b.minX - MARGIN, maxX: b.maxX + MARGIN,
      minY: b.minY - MARGIN, maxY: b.maxY + MARGIN,
    };
    const midX = (b.minX + b.maxX) / 2, midY = (b.minY + b.maxY) / 2;
    this.camBase = new THREE.Vector3(midX, midY, dist);
    const [cx, cy] = this._cameraTarget(midX, midY);
    this.camera.position.set(cx, cy, dist);
    this.camTarget.set(cx, cy, 0);
    this.camera.lookAt(this.camTarget);
  }

  // Camera centre that follows a world point but prefers not to show past the
  // playfield bounds; centres an axis outright when the view covers it. The
  // followed point always wins: a climber who leaves the platforms (a fall into
  // the void) stays on screen rather than being framed out.
  _cameraTarget(wx, wy) {
    const b = this.levelBounds;
    if (!b) return [wx, wy];
    // Tiles kept between the follow point and the frame edge, scaled to the
    // view so small viewports still clear the HUD and touch tray.
    const EDGE_PAD = Math.min(2.5, this.viewHalfH * 0.25);
    const axis = (v, min, max, half) => {
      const c = half * 2 >= max - min
        ? (min + max) / 2
        : THREE.MathUtils.clamp(v, min + half, max - half);
      const slack = Math.max(0, half - EDGE_PAD);
      return THREE.MathUtils.clamp(c, v - slack, v + slack);
    };
    return [
      axis(wx, b.minX, b.maxX, this.viewHalfW),
      axis(wy, b.minY, b.maxY, this.viewHalfH),
    ];
  }

  // ------------------------------------------------------------ per-frame

  render(state, alpha, dt, hidden) {
    if (hidden || this.contextLost) return;
    this.time += dt;
    const w = this.levelW || 20, h = this.levelH || 12;
    const toWorld = (x, y) => [x - w / 2, h - y];
    const moving = !this.settings.reducedMotion;
    const animated = moving && this.q.background === 'animated';

    if (state && this.playerGroup) {
      const px = state.player.x, py = state.player.y;
      const [wx, wy] = toWorld(px, py + PLAYER_H);
      this.playerGroup.position.set(wx, wy, 0);
      this.playerGroup.scale.x = state.player.face >= 0 ? 1 : -1;
      this.playerWindup.rotation.z += dt * (2 + Math.abs(state.player.vx));
      // Squash & stretch from simulation velocity (no per-frame lerp buildup).
      const stretch = state.player.onGround ? 1 : 1.08;
      this.playerGroup.scale.y = stretch;
      // Idle breathing bob (cosmetic child only; the hitbox never moves).
      const idle = moving && state.player.onGround && Math.abs(state.player.vx) < 0.01;
      this.playerRig.position.y = idle ? 0.02 * (1 + Math.sin(this.time * 3.2)) : 0;
      this.playerMarker.position.set(wx, wy + 0.02, 0);
      this.playerMarker.visible = state.player.onGround;
    }
    if (state) {
      for (const v of this.vanishMeshes) {
        const solid = isVanishSolid(state, v.index);
        const m = v.mesh.material;
        m.opacity = solid ? 0.9 : 0.18;
        m.emissiveIntensity = solid ? 0.35 : 0.05;
      }
      for (const [idx, mesh] of this.fakeMeshes) {
        if (state.fakesRevealed.includes(idx)) {
          mesh.material.emissive.setHex(0xffffff); // in place: no per-frame allocation
          mesh.material.emissiveIntensity = 0.12 + 0.1 * Math.sin(this.time * 6);
        }
      }
      state.moverCfg.forEach((cfg, i) => {
        const entry = this.moverMeshes[i];
        if (!entry) return;
        const off = moverOffset(cfg, state.tick);
        entry.mesh.position.set(cfg.x + 0.5 + off.dx - w / 2, h - (cfg.y + off.dy) - 0.5, 0);
      });
      state.gears.forEach((got, i) => {
        const m = this.gearMeshes[i];
        if (!m) return;
        m.visible = !got;
        m.rotation.z += dt * 2;
        if (moving) m.position.y = m.userData.baseY + 0.06 * Math.sin(this.time * 2.2 + m.userData.phase);
      });
      if (this.exitGlow) this.exitGlow.material.emissiveIntensity = 1.2 + 0.4 * Math.sin(this.time * 2.4);
    }
    // Environment motion (paused when reduced motion, static background, or hidden).
    if (animated) {
      if (this.envGears) for (const g of this.envGears) g.rotation.z += g.userData.speed * dt;
      for (const hnd of this.clockHands) hnd.rotation.z -= hnd.userData.speed * dt * 0.2;
      for (const s of this.shafts) s.material.opacity = 0.06 + 0.025 * Math.sin(this.time * 0.7 + s.userData.phase);
    }
    // Dust motes drift around the camera, wrapping so the field is always full.
    const D = this.dust;
    if (D) {
      const cx = this.camera.position.x, cy = this.camera.position.y;
      const hw = (this.viewHalfW || 12) * 1.3, hh = (this.viewHalfH || 8) * 1.3;
      const p = D.pos;
      for (let i = 0; i < D.n; i++) {
        const s = D.seeds[i];
        if (animated) {
          p[i * 3] += Math.sin(this.time * 0.3 + s) * 0.12 * dt;
          p[i * 3 + 1] += (0.08 + 0.05 * Math.cos(s)) * dt;
        }
        let x = p[i * 3] - cx, y = p[i * 3 + 1] - cy;
        if (x < -hw) x += hw * 2; else if (x > hw) x -= hw * 2;
        if (y < -hh) y += hh * 2; else if (y > hh) y -= hh * 2;
        p[i * 3] = x + cx; p[i * 3 + 1] = y + cy;
      }
      D.pts.geometry.attributes.position.needsUpdate = true;
    }
    // Particles
    const P = this.particles;
    if (P) {
      const pos = P.pos;
      let n = 0;
      for (let i = P.live.length - 1; i >= 0; i--) {
        const p = P.live[i];
        p.age += dt;
        if (p.age >= p.life) { P.live.splice(i, 1); continue; }
        p.vy -= 6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        pos[n * 3] = p.x; pos[n * 3 + 1] = p.y; pos[n * 3 + 2] = p.z;
        n++;
      }
      P.pts.geometry.setDrawRange(0, n);
      P.pts.geometry.attributes.position.needsUpdate = true;
    }
    // Camera: critically damped follow toward player, plus tiered shake.
    if (state && this.camBase) {
      const [px, py] = toWorld(state.player.x, state.player.y + PLAYER_H / 2);
      const [tx, ty] = this._cameraTarget(px, py - (this.coarsePointer ? this.viewHalfH * 0.22 : 0));
      const desired = this._desired.set(tx, ty, this.camDist);
      if (this.settings.reducedMotion) {
        this.camera.position.copy(desired);
      } else {
        const k = 1 - Math.exp(-6 * dt); // frame-rate independent damping
        this.camera.position.lerp(desired, k);
        if (this.shake > 0) {
          this.shake = Math.max(0, this.shake - dt * 2.5);
          const s = this.shake * 0.15;
          this.camera.position.x += (this.decoRng() - 0.5) * s;
          this.camera.position.y += (this.decoRng() - 0.5) * s;
        }
      }
      this.camera.lookAt(this.camera.position.x, this.camera.position.y, 0);
    }
    this._draw(dt);
  }

  // Pixel ratio = min(dpr, preset cap) × preset/render scale × adaptive scale;
  // the post chain is rebuilt only when its key (effects, size, ratio) changes.
  _draw(dt) {
    this._adapt(Math.max(1, dt * 1000));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const ratio = Math.min(dpr, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (Math.abs(ratio - this.pixelRatio) > 1e-6) {
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.size[0], this.size[1], false);
    }
    const key = this._postKey();
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost();
    }
    if (this.composer) {
      try { this.composer.render(dt); return; } catch (e) {
        this.postFailed = true;
        this.composer.dispose();
        this.composer = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  kickShake(amount) { if (!this.settings.reducedMotion) this.shake = Math.min(1, this.shake + amount); }

  // Concise navigable text model of the board for screen readers.
  describeState(state, level) {
    if (!state) return 'No active level.';
    const parts = [];
    parts.push('Level ' + (level.name || state.levelId) + '.');
    parts.push('Player at column ' + Math.round(state.player.x) + ', row ' + Math.round(state.player.y) +
      (state.player.onGround ? ', on the ground.' : ', in the air.'));
    const gears = state.gears.filter(Boolean).length;
    parts.push('Gears: ' + gears + ' of ' + state.gears.length + '.');
    parts.push('Deaths: ' + state.deaths + '. Moves: ' + state.moves + '.');
    if (state.checkpoint) parts.push('Checkpoint active.');
    if (state.over) parts.push(state.won ? 'Level complete.' : 'Attempt ended: ' + state.reason + '.');
    return parts.join(' ');
  }
}
