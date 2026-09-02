'use strict';

// Trickstep Tower — render module: Three.js scene graph, semantic entity views,
// authored camera, lighting, pooled VFX, quality tiers, disposal.

import * as THREE from '../../three.module.min.js';
import { TILE, moverOffset, isVanishSolid, makeRng, PLAYER_W, PLAYER_H } from '../rules.js';
import { THEMES } from '../content.js';

export const QUALITY_TIERS = {
  low:  { pixelRatio: 1,   shadows: false, particles: 120, envDetail: 0.4, antialias: false },
  med:  { pixelRatio: 1.5, shadows: true,  particles: 400, envDetail: 0.7, antialias: true },
  high: { pixelRatio: 2,   shadows: true,  particles: 1000, envDetail: 1,   antialias: true },
};

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_FX = 2;

export class Renderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.tier = QUALITY_TIERS[settings.graphics] || QUALITY_TIERS.med;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.tier.antialias, powerPreference: 'default' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.tier.pixelRatio));
    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);

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
    this.camTarget = new THREE.Vector3();
    this.shake = 0;
    this.time = 0;
    this.decoRng = makeRng(1);

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.renderer.compile(this.scene, this.camera); });
  }

  _track(res) { this.disposables.push(res); return res; }

  setQuality(tierName) {
    this.tier = QUALITY_TIERS[tierName] || QUALITY_TIERS.med;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.tier.pixelRatio));
    this.renderer.shadowMap.enabled = this.tier.shadows;
    if (this.level) this.loadLevel(this.level, this.themeId);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ scene build

  loadLevel(level, themeId) {
    this.level = level;
    this.themeId = themeId;
    const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
    this.theme = theme;
    this._clearLevel();

    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.fog, 30, 90);
    this._buildEnvironmentMap(theme);

    // Lighting: one dominant key, soft fill, contact grounding.
    const key = new THREE.DirectionalLight(theme.key, 2.2);
    key.position.set(8, 18, 12);
    key.castShadow = this.tier.shadows;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -20; key.shadow.camera.right = 20;
    key.shadow.camera.top = 24; key.shadow.camera.bottom = -6;
    this.scene.add(key);
    const fill = new THREE.HemisphereLight(theme.fill, 0x0a0a12, 0.9);
    this.scene.add(fill);
    this.levelLights = [key, fill];

    this.decoRng = makeRng(level.seed ^ 0xdec0);
    this._buildEnvironment(theme, level);
    this._buildTiles(theme, level);
    this._buildPlayer(theme);
    this._buildParticles(theme);
    this._frameCamera(level);
  }

  // Procedural PMREM environment: warm key window + cool bounce, so PBR metal
  // reads correctly without any loaded HDR asset.
  _buildEnvironmentMap(theme) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const gr = ctx.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#aabbdd');
    gr.addColorStop(0.5, '#44506a');
    gr.addColorStop(1, '#181a24');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#ffe9c0';
    ctx.fillRect(18, 6, 28, 12); // warm key window
    ctx.fillStyle = '#6a86b8';
    ctx.fillRect(0, 40, 64, 8); // cool floor bounce
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const envScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(50, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(geo, mat));
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    if (this.envRT) this.envRT.dispose();
    // Sigma must stay under the PMREM sampler's 20-sample cap (0.06 asks for 30).
    this.envRT = pmrem.fromScene(envScene, 0.035);
    this.scene.environment = this.envRT.texture;
    geo.dispose(); mat.dispose(); tex.dispose(); pmrem.dispose();
  }

  _clearLevel() {
    if (this.levelGroup) { this.scene.remove(this.levelGroup); this._disposeDeep(this.levelGroup); }
    if (this.envGroup) { this.scene.remove(this.envGroup); this._disposeDeep(this.envGroup); }
    if (this.levelLights) for (const l of this.levelLights) this.scene.remove(l);
    this.levelGroup = new THREE.Group();
    this.envGroup = new THREE.Group();
    this.scene.add(this.levelGroup, this.envGroup);
    this.vanishMeshes = [];
    this.fakeMeshes = new Map();
    this.moverMeshes = [];
    this.gearMeshes = [];
    this.checkpointMeshes = [];
  }

  _disposeDeep(root) {
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
  }

  _mat(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.65 }, opts));
  }

  _buildEnvironment(theme, level) {
    const g = this.envGroup;
    const detail = this.tier.envDetail;
    // Clockwork tower: giant background gears, columns, a pendulum.
    const gearGeo = this._track(this._gearGeometry(1, 0.28, 12));
    const gearMat = this._mat(theme.brass, { roughness: 0.4, metalness: 0.9 });
    const count = Math.round(6 * detail) + 2;
    this.envGears = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(gearGeo, gearMat);
      const s = 2 + this.decoRng() * 5;
      m.scale.setScalar(s);
      m.position.set((this.decoRng() - 0.5) * 60, 8 + this.decoRng() * 22, -14 - this.decoRng() * 14);
      m.userData.speed = (this.decoRng() - 0.5) * 0.5 / s;
      m.layers.set(LAYER_ENV);
      g.add(m);
      this.envGears.push(m);
    }
    const colGeo = this._track(new THREE.CylinderGeometry(0.6, 0.8, 60, 10));
    const colMat = this._mat(theme.solid, { roughness: 0.7, metalness: 0.4 });
    for (const x of [-level.w * 0.7, level.w * 1.7]) {
      const c = new THREE.Mesh(colGeo, colMat);
      c.position.set(x - level.w / 2, 10, -10);
      c.layers.set(LAYER_ENV);
      g.add(c);
    }
    // Ground plane far below for contact grounding.
    const ground = new THREE.Mesh(this._track(new THREE.PlaneGeometry(200, 60)), this._mat(0x0c0e16, { roughness: 1, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -6, -4);
    ground.receiveShadow = this.tier.shadows;
    ground.layers.set(LAYER_ENV);
    g.add(ground);
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

  _buildTiles(theme, level) {
    const g = this.levelGroup;
    const rows = level.ascii.split('\n');
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    this.levelW = w; this.levelH = h;

    const boxGeo = this._track(new THREE.BoxGeometry(1, 1, 1));
    const spikeGeo = this._track(new THREE.ConeGeometry(0.34, 0.7, 6));
    const gearGeo = this._track(new THREE.TorusGeometry(0.3, 0.11, 8, 14));
    const springGeo = this._track(new THREE.CylinderGeometry(0.32, 0.4, 0.3, 10));

    const mats = {
      solid: this._mat(theme.solid),
      brass: this._mat(theme.brass, { roughness: 0.38, metalness: 0.92 }),
      vanish: this._mat(theme.accent, { transparent: true, opacity: 0.85, emissive: theme.accent, emissiveIntensity: 0.25 }),
      fake: this._mat(theme.solid),
      spike: this._mat(theme.hazard, { roughness: 0.3, metalness: 0.7, emissive: theme.hazard, emissiveIntensity: 0.35 }),
      gear: this._mat(0xffd777, { roughness: 0.25, metalness: 1, emissive: 0x664400, emissiveIntensity: 0.4 }),
      spring: this._mat(0xd8d8e8, { roughness: 0.3, metalness: 0.9 }),
      exit: this._mat(theme.accent, { emissive: theme.accent, emissiveIntensity: 0.8, roughness: 0.3 }),
      checkpoint: this._mat(0x88ffcc, { emissive: 0x88ffcc, emissiveIntensity: 0.5 }),
      mover: this._mat(theme.brass, { roughness: 0.3, metalness: 0.95, emissive: theme.brass, emissiveIntensity: 0.12 }),
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
          const m = new THREE.Mesh(boxGeo, mats.vanish.clone());
          this._track(m.material);
          m.scale.set(1, 1, 0.6);
          m.position.set(wx, wy - 0.5, 0);
          m.castShadow = this.tier.shadows; m.receiveShadow = this.tier.shadows;
          m.layers.set(LAYER_GAME);
          g.add(m);
          this.vanishMeshes.push({ mesh: m, index: y * w + x });
        } else if (ch === '^') {
          const m = new THREE.Mesh(spikeGeo, mats.spike);
          m.position.set(wx, wy - 0.75, 0);
          m.layers.set(LAYER_GAME);
          g.add(m);
          const m2 = new THREE.Mesh(spikeGeo, mats.spike);
          m2.position.set(wx + 0.3, wy - 0.82, 0.1); m2.scale.setScalar(0.7);
          m2.layers.set(LAYER_GAME);
          g.add(m2);
        } else if (ch === '*') {
          const m = new THREE.Mesh(gearGeo, mats.gear);
          m.position.set(wx, wy - 0.5, 0);
          m.layers.set(LAYER_GAME);
          g.add(m);
          this.gearMeshes.push(m);
        } else if (ch === 'o') {
          const m = new THREE.Mesh(springGeo, mats.spring);
          m.position.set(wx, wy - 0.85, 0);
          m.layers.set(LAYER_GAME);
          g.add(m);
        } else if (ch === 'E') {
          const door = new THREE.Mesh(boxGeo, mats.exit);
          door.scale.set(0.9, 1.6, 0.3);
          door.position.set(wx, wy - 0.1, 0);
          door.layers.set(LAYER_GAME);
          g.add(door);
          this.exitGlow = door;
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
          const m = new THREE.Mesh(boxGeo, mats.mover);
          m.scale.set(1, 0.35, 0.8);
          m.position.set(wx, wy - 0.5, 0);
          m.castShadow = this.tier.shadows;
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
      const inst = new THREE.InstancedMesh(boxGeo, mats[kind], cells.length);
      const mtx = new THREE.Matrix4();
      cells.forEach(([wx, wy], i) => {
        mtx.makeTranslation(wx, wy - 0.5, 0);
        inst.setMatrixAt(i, mtx);
      });
      inst.castShadow = this.tier.shadows;
      inst.receiveShadow = this.tier.shadows;
      inst.layers.set(LAYER_GAME);
      inst.instanceMatrix.needsUpdate = true;
      g.add(inst);
    }
    // Fake floors: individual meshes so reveal shimmer can target them.
    for (const [wx, wy, idx] of solidCells.fake) {
      const m = new THREE.Mesh(boxGeo, mats.fake.clone());
      this._track(m.material);
      m.position.set(wx, wy - 0.5, 0);
      m.layers.set(LAYER_GAME);
      g.add(m);
      this.fakeMeshes.set(idx, m);
    }
  }

  _buildPlayer(theme) {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(
      this._track(new THREE.BoxGeometry(PLAYER_W, PLAYER_H * 0.72, 0.5)),
      this._mat(0xe8c87a, { roughness: 0.35, metalness: 0.85 })
    );
    body.position.y = PLAYER_H * 0.36;
    body.castShadow = this.tier.shadows;
    const head = new THREE.Mesh(
      this._track(new THREE.BoxGeometry(PLAYER_W * 0.7, PLAYER_H * 0.26, 0.44)),
      this._mat(this.theme.accent, { roughness: 0.3, metalness: 0.8, emissive: this.theme.accent, emissiveIntensity: 0.3 })
    );
    head.position.y = PLAYER_H * 0.86;
    const keyGeo = this._track(this._gearGeometry(0.16, 0.06, 8));
    const windup = new THREE.Mesh(keyGeo, this._mat(0xc9973f, { metalness: 0.95, roughness: 0.3 }));
    windup.position.set(0, PLAYER_H * 0.55, 0.3);
    grp.add(body, head, windup);
    grp.traverse(o => o.layers.set(LAYER_GAME));
    this.playerGroup = grp;
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
    const max = this.tier.particles;
    const geo = this._track(new THREE.BufferGeometry());
    const pos = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: theme.accent, size: 0.12, transparent: true, opacity: 0.9, sizeAttenuation: true });
    this._track(mat);
    const pts = new THREE.Points(geo, mat);
    pts.layers.set(LAYER_FX);
    pts.frustumCulled = false;
    this.levelGroup.add(pts);
    this.particles = { pts, pos, live: [], max, cursor: 0 };
  }

  burst(x, y, color, n, spread) {
    if (!this.particles || this.settings.reducedMotion) n = Math.min(n || 8, 4);
    n = n || 10;
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

  _frameCamera(level) {
    const rows = level.ascii.split('\n');
    const h = rows.length, w = Math.max(...rows.map(r => r.length));
    // Authored framing constants (no magic offsets elsewhere).
    const MARGIN = 1.6, DIST_PER_UNIT = 1.15, LIFT = 0.2;
    const cx = 0, cy = h / 2 + LIFT;
    const dist = Math.max(w, h * this.camera.aspect) * 0.5 * DIST_PER_UNIT + MARGIN;
    this.camBase = new THREE.Vector3(cx, cy, dist);
    this.camera.position.copy(this.camBase);
    this.camTarget.set(cx, cy, 0);
    this.camera.lookAt(this.camTarget);
  }

  // ------------------------------------------------------------ per-frame

  render(state, alpha, dt, hidden) {
    if (hidden || this.contextLost) return;
    this.time += dt;
    const w = this.levelW || 20, h = this.levelH || 12;
    const toWorld = (x, y) => [x - w / 2, h - y];

    if (state && this.playerGroup) {
      const px = state.player.x, py = state.player.y;
      const [wx, wy] = toWorld(px, py + PLAYER_H);
      this.playerGroup.position.set(wx, wy, 0);
      this.playerGroup.scale.x = state.player.face >= 0 ? 1 : -1;
      this.playerWindup.rotation.z += dt * (2 + Math.abs(state.player.vx));
      // Squash & stretch from simulation velocity (no per-frame lerp buildup).
      const stretch = state.player.onGround ? 1 : 1.08;
      this.playerGroup.scale.y = stretch;
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
          mesh.material.emissive = new THREE.Color(0xffffff);
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
        if (m) { m.visible = !got; m.rotation.z += dt * 2; }
      });
      if (this.exitGlow) this.exitGlow.material.emissiveIntensity = 0.6 + 0.3 * Math.sin(this.time * 2.4);
    }
    // Environment motion (paused when reduced motion or hidden).
    if (!this.settings.reducedMotion && this.envGears) {
      for (const g of this.envGears) g.rotation.z += g.userData.speed * dt;
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
      const [px] = toWorld(state.player.x, 0);
      const desired = this.camBase.clone();
      desired.x = THREE.MathUtils.clamp(px, this.camBase.x - 4, this.camBase.x + 4);
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
      this.camera.lookAt(this.camera.position.x, this.camBase.y, 0);
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
