import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AudioSynth } from './audioSynth';
import { DIFFICULTY_PROFILES } from './enemyAI';
import { computeLeadPosition, segmentSphereIntersect } from './flightPhysics';
import {
  buildWarTornCityScene,
  CITY_PLAYABLE_HALF,
  computeCameraWallPullIn,
  createWarTornCityLayout,
  hasCityLineOfSight,
  segmentCityImpact,
  type CityLayout,
} from './tankCity';
import {
  buildTankMesh,
  resetSharedTankMeshAssets,
  setTankRigHitFlash,
  type TankVisualRig,
} from './tankMeshes';
import {
  computeDirectionalArmorHit,
  createEnemyTankUnit,
  createInitialTankState,
  getTankWaveDefinition,
  normalizeAngle,
  stepTankHullPhysics,
  stepTurretAim,
  TANK_PHYSICS_CONFIG,
  updateEnemyTankAI,
  type EnemyTankActionEvents,
  type EnemyTankUnit,
  type PlayerTankState,
} from './tankPhysics';
import type {
  DefeatReason,
  DifficultyLevel,
  GamePhase,
  KillFeedItem,
  ProjectedIncomingMissile,
  ProjectedTankTarget,
  TankControlInput,
  TankHudSnapshot,
  TankMinimapBlip,
  Vec3,
  WaveAnnouncement,
} from './types';

interface ShellItem {
  active: boolean;
  fromPlayer: boolean;
  isMg: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
}

interface AtgmItem {
  active: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  spoofed: boolean;
  smokeTimer: number;
  damage: number;
}

interface TankParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  riseSpeed: number;
}

interface ActiveEnemyTankRecord {
  unit: EnemyTankUnit;
  rig: TankVisualRig;
}

const SHELL_POOL_SIZE = 120;
const ATGM_POOL_SIZE = 20;
const PARTICLE_POOL_SIZE = 380;
const TANK_HIGH_SCORE_KEY = 'sky_hunter_tank_highscore_v1';

const _dummy = new THREE.Object3D();
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _unitZ = new THREE.Vector3(0, 0, -1);
const _color = new THREE.Color();
const _camAnchor = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _camPulled = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();
const _leadPos = { x: 0, y: 0, z: 0, timeToImpact: 0 };
const _targetVec3: Vec3 = { x: 0, y: 0, z: 0 };
const _targetVel3: Vec3 = { x: 0, y: 0, z: 0 };
const _shooterVec3: Vec3 = { x: 0, y: 0, z: 0 };
const _projDirXZ = { x: 0, z: 0 };
const _aiEvents: EnemyTankActionEvents = {
  firedShell: false,
  firedAtgm: false,
  deployedSmoke: false,
  lockingAtgm: false,
  originX: 0,
  originY: 0,
  originZ: 0,
  dirX: 0,
  dirY: 0,
  dirZ: 0,
};

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export class TankCombatEngine {
  private container: HTMLElement;
  private onHudUpdate: (snapshot: TankHudSnapshot) => void;
  public readonly audio = new AudioSynth();
  public readonly layout: CityLayout;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;
  private resizeObserver: ResizeObserver;

  private playerRig: TankVisualRig;
  private player: PlayerTankState;
  private enemies: ActiveEnemyTankRecord[] = [];

  // Pooled InstancedMesh renderers
  private shells: ShellItem[] = [];
  private shellMesh: THREE.InstancedMesh;
  private atgms: AtgmItem[] = [];
  private atgmMesh: THREE.InstancedMesh;
  private atgmGlowMesh: THREE.InstancedMesh;
  private particles: TankParticle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private particleCursor = 0;

  // Game & weapon state
  private phase: GamePhase = 'title';
  private difficulty: DifficultyLevel = 'normal';
  private input: TankControlInput = {
    throttle: 0,
    steer: 0,
    fireCannon: false,
    fireMg: false,
    boost: false,
    smoke: false,
  };
  private aimYaw = 0; // world-space player aim camera yaw (radians, 0 = -Z)
  private aimPitch = -0.02;
  private lockedTargetId: number | null = null;

  private cannonReloadTimer = 0; // 0 = ready
  private cannonBufferTimer = 0;
  private playerMuzzleFlashTimer = 0;
  private mgFireTimer = 0;
  private mgHeat = 0;
  private mgOverheated = false;
  private smokeReady = 2;
  private smokeMax = 2;
  private smokeReloadTimer = 0;
  private smokeBufferTimer = 0;
  private smokeActiveTimer = 0;
  private smokeEmitTimer = 0;
  private smokeSuccessTimer = 0;
  private flankNoticeTimer = 0;
  private armorDeflectTimer = 0;

  private playerHp = 160;
  private playerMaxHp = 160;
  private ghostHp = 160;
  private score = 0;
  private highScore = 0;
  private kills = 0;
  private wave = 1;
  private survivalTimeSec = 0;
  private nextWaveDelay = 0;
  private nextEnemyId = 1;
  private defeatReason: DefeatReason = 'none';
  private pendingDefeat = false;
  private defeatBeatTimer = 0;

  private waveBanner: WaveAnnouncement | null = null;
  private killFeed: KillFeedItem | null = null;
  private killFeedTimer = 0;
  private killFeedSeq = 1;

  private hitstopTimer = 0;
  private cameraTrauma = 0;
  private hitMarkerTimer = 0;
  private hitMarkerCritical = false;
  private damageFlashTimer = 0;

  private camPos = new THREE.Vector3(0, 8, 82);
  private camLook = new THREE.Vector3(0, 2, 48);

  // Ambient city smoke & ember emitter clock
  private ambientSmokeTimer = 0;
  private ambientEmberTimer = 0;

  // Frame loop & adaptive low-end scaling
  private running = true;
  private frameId = 0;
  private lastTimeMs = 0;
  private elapsedTime = 0;
  private hudEmitAccum = 0;
  private fpsSamples = 0;
  private fpsTimeAccum = 0;
  private renderScale = 1.0;
  private isTouchDevice = false;

  constructor(container: HTMLElement, onHudUpdate: (snapshot: TankHudSnapshot) => void) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;
    this.isSoftwareGl = detectSoftwareWebGL();
    this.isTouchDevice =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    try {
      const saved = window.localStorage.getItem(TANK_HIGH_SCORE_KEY);
      if (saved) this.highScore = Math.max(0, parseInt(saved, 10) || 0);
    } catch {
      // ignore storage errors
    }

    // 1. Renderer with mobile-friendly clamped DPR (max 1.5)
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5),
    );
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);

    // 2. Dusty War-Torn Urban Scene + Atmospheric FogExp2 + RoomEnvironment
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcab59a);
    this.scene.fog = new THREE.FogExp2(0xcab59a, 0.0044);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.4, 720);
    this.renderer.setSize(width, height, false);

    // 3. Warm Dusty Sunlight + Cool Sky/Ground Hemisphere Contrast
    const hemi = new THREE.HemisphereLight(0xdbe8f5, 0x6e5a44, 0.92);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe1b8, 2.25);
    sun.position.set(110, 145, 75);
    if (!this.isSoftwareGl) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 420;
      sun.shadow.camera.left = -160;
      sun.shadow.camera.right = 160;
      sun.shadow.camera.top = 160;
      sun.shadow.camera.bottom = -160;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.03;
    }
    this.scene.add(sun);

    // Subtle warm sunlit haze disc high in sky
    const sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(28, 20),
      new THREE.MeshBasicMaterial({ color: 0xfff3d4, fog: false }),
    );
    sunDisc.position.set(280, 260, -340);
    sunDisc.lookAt(0, 0, 0);
    this.scene.add(sunDisc);

    // 4. Procedural Grid-Based War-Torn City
    this.layout = createWarTornCityLayout();
    const cityGroup = buildWarTornCityScene(
      this.layout,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    this.scene.add(cityGroup);

    // 5. Player Main Battle Tank
    this.player = createInitialTankState(this.layout.playerSpawn);
    this.playerRig = buildTankMesh('player');
    this.playerRig.group.position.set(this.player.x, this.player.y, this.player.z);
    this.scene.add(this.playerRig.group);

    // 6. Pre-allocated Object Pools (Zero GC in hot loop)
    const shellGeo = new THREE.BoxGeometry(0.24, 0.24, 3.2);
    const shellMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, SHELL_POOL_SIZE);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      this.shells.push({
        active: false,
        fromPlayer: true,
        isMg: false,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        damage: 0,
      });
      this.shellMesh.setMatrixAt(i, _zeroMat);
      this.shellMesh.setColorAt(i, _color.setHex(0xffdf78));
    }
    this.shellMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.shellMesh);

    const atgmGeo = new THREE.CylinderGeometry(0.14, 0.16, 2.2, 6);
    atgmGeo.rotateX(Math.PI / 2);
    const atgmMat = new THREE.MeshBasicMaterial({ color: 0xff453a });
    this.atgmMesh = new THREE.InstancedMesh(atgmGeo, atgmMat, ATGM_POOL_SIZE);
    this.atgmMesh.frustumCulled = false;
    this.atgmMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const atgmGlowGeo = new THREE.OctahedronGeometry(0.85, 0);
    const atgmGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff5a2b,
      transparent: true,
      opacity: 0.92,
      fog: false,
    });
    this.atgmGlowMesh = new THREE.InstancedMesh(atgmGlowGeo, atgmGlowMat, ATGM_POOL_SIZE);
    this.atgmGlowMesh.frustumCulled = false;
    this.atgmGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      this.atgms.push({
        active: false,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        spoofed: false,
        smokeTimer: 0,
        damage: 34,
      });
      this.atgmMesh.setMatrixAt(i, _zeroMat);
      this.atgmGlowMesh.setMatrixAt(i, _zeroMat);
    }
    this.atgmMesh.instanceMatrix.needsUpdate = true;
    this.atgmGlowMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.atgmMesh);
    this.scene.add(this.atgmGlowMesh);

    const particleGeo = new THREE.IcosahedronGeometry(0.62, 1);
    const particleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
    });
    this.particleMesh = new THREE.InstancedMesh(particleGeo, particleMat, PARTICLE_POOL_SIZE);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.particles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        startScale: 1,
        endScale: 0.1,
        riseSpeed: 0,
      });
      this.particleMesh.setMatrixAt(i, _zeroMat);
      this.particleMesh.setColorAt(i, _color.setHex(0x4b4844));
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.particleMesh);

    // Seed initial rising city smoke plumes so first frame looks alive & atmospheric
    for (let i = 0; i < this.layout.smokeAnchors.length; i++) {
      const a = this.layout.smokeAnchors[i];
      for (let s = 0; s < 3; s++) {
        _v1.set(a.x, a.y + s * 3.8, a.z);
        _v2.set(0.8 + (Math.random() - 0.5) * 1.2, 2.0 + Math.random() * 1.4, (Math.random() - 0.5) * 1.2);
        this.spawnParticle(_v1, _v2, 3.6 + s * 0.7, 1.5 + s * 0.5, 3.8 + s * 0.6, 0x3b3835, 1.1);
      }
    }

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    // Position title showcase camera immediately
    this.stepTitleCamera(0);
    document.body.dataset.state = 'title';
    this.emitHudSnapshot(false, false);

    this.lastTimeMs = performance.now();
    this.scheduleNextFrame();
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const baseDpr = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(Math.max(0.75, baseDpr * this.renderScale));
    this.renderer.setSize(w, h, false);
  }

  private updateAdaptiveResolution(rawDt: number): void {
    if (this.isSoftwareGl || rawDt <= 0 || rawDt > 0.25) return;
    this.fpsSamples++;
    this.fpsTimeAccum += rawDt;
    if (this.fpsTimeAccum >= 1.8) {
      const avgFps = this.fpsSamples / this.fpsTimeAccum;
      this.fpsSamples = 0;
      this.fpsTimeAccum = 0;
      if (avgFps < 35 && this.renderScale > 0.75) {
        this.renderScale = Math.max(0.75, this.renderScale - 0.12);
        this.handleResize();
      } else if (avgFps > 52 && this.renderScale < 1.0) {
        this.renderScale = Math.min(1.0, this.renderScale + 0.08);
        this.handleResize();
      }
    }
  }

  public setInput(partial: Partial<TankControlInput>): void {
    Object.assign(this.input, partial);
    if (partial.fireCannon) {
      this.cannonBufferTimer = 0.2;
    }
    if (partial.smoke) {
      this.smokeBufferTimer = 0.2;
    }
  }

  public addAimDelta(deltaYawRad: number, deltaPitchRad: number): void {
    this.aimYaw = normalizeAngle(this.aimYaw + deltaYawRad);
    this.aimPitch = Math.max(-0.14, Math.min(0.24, this.aimPitch + deltaPitchRad));
  }

  public triggerCannon(): void {
    this.cannonBufferTimer = 0.22;
  }

  public triggerSmoke(): void {
    this.smokeBufferTimer = 0.22;
  }

  /**
   * Target-lock assist: snaps player aim cleanly onto the nearest visible enemy tank.
   */
  public triggerTargetSnap(): void {
    if (this.phase !== 'playing') return;
    let bestId: number | null = null;
    let bestYaw = this.aimYaw;
    let bestScore = Infinity;

    _v1.set(this.player.x, this.player.y + 2.1, this.player.z);
    for (let i = 0; i < this.enemies.length; i++) {
      const u = this.enemies[i].unit;
      if (!u.alive || u.dying) continue;
      _v2.set(u.x, u.y + 1.8, u.z);
      const dist = _v1.distanceTo(_v2);
      if (dist > 175) continue;
      const los = hasCityLineOfSight(_v1, _v2, this.layout.aabbs);
      const yawToEnemy = Math.atan2(-(u.x - this.player.x), -(u.z - this.player.z));
      const angErr = Math.abs(normalizeAngle(yawToEnemy - this.aimYaw));
      const score = dist + angErr * 35 + (los ? 0 : 120);
      if (score < bestScore) {
        bestScore = score;
        bestId = u.id;
        bestYaw = yawToEnemy;
      }
    }

    if (bestId !== null) {
      this.lockedTargetId = bestId;
      this.aimYaw = bestYaw;
      this.aimPitch = 0.01;
      this.audio.playHitConfirm();
    }
  }

  public clearInputs(): void {
    this.input.throttle = 0;
    this.input.steer = 0;
    this.input.fireCannon = false;
    this.input.fireMg = false;
    this.input.boost = false;
    this.input.smoke = false;
    this.cannonBufferTimer = 0;
    this.smokeBufferTimer = 0;
  }

  public setDifficulty(level: DifficultyLevel): void {
    this.difficulty = level;
    this.emitHudSnapshot(false, false);
  }

  public getPhase(): GamePhase {
    return this.phase;
  }

  private setPhase(next: GamePhase): void {
    this.phase = next;
    document.body.dataset.state = next;
    this.emitHudSnapshot(false, false);
  }

  public startNewGame(overrideDifficulty?: DifficultyLevel): void {
    if (overrideDifficulty) this.difficulty = overrideDifficulty;
    this.audio.unlock();
    this.clearInputs();
    this.clearEntities();

    this.player = createInitialTankState(this.layout.playerSpawn);
    this.aimYaw = this.player.hullYaw;
    this.aimPitch = 0.0;
    this.lockedTargetId = null;

    this.playerRig.group.visible = true;
    this.syncPlayerMesh();

    this.playerHp = this.playerMaxHp;
    this.ghostHp = this.playerMaxHp;
    this.score = 0;
    this.kills = 0;
    this.wave = 1;
    this.survivalTimeSec = 0;
    this.nextWaveDelay = 0;
    this.defeatReason = 'none';
    this.pendingDefeat = false;
    this.defeatBeatTimer = 0;

    this.cannonReloadTimer = 0;
    this.cannonBufferTimer = 0;
    this.playerMuzzleFlashTimer = 0;
    this.mgFireTimer = 0;
    this.mgHeat = 0;
    this.mgOverheated = false;
    this.smokeReady = this.smokeMax;
    this.smokeReloadTimer = 0;
    this.smokeActiveTimer = 0;
    this.smokeSuccessTimer = 0;
    this.flankNoticeTimer = 0;
    this.armorDeflectTimer = 0;
    this.hitstopTimer = 0;
    this.cameraTrauma = 0;
    this.hitMarkerTimer = 0;
    this.hitMarkerCritical = false;
    this.damageFlashTimer = 0;
    this.killFeed = null;
    this.killFeedTimer = 0;

    // Snap chase camera cleanly behind the tank facing down the wide central avenue
    this.camPos.set(this.player.x, this.player.y + 6.4, this.player.z + 14.5);
    this.camLook.set(this.player.x, this.player.y + 2.2, this.player.z - 28);
    this.camera.fov = 60;
    this.camera.position.copy(this.camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    this.spawnWave(1);
    this.setPhase('playing');
  }

  public togglePause(): void {
    if (this.phase === 'playing' && !this.pendingDefeat) {
      this.clearInputs();
      this.audio.updateTankContinuous(false, 0, false, false);
      this.setPhase('paused');
    } else if (this.phase === 'paused') {
      this.lastTimeMs = performance.now();
      this.setPhase('playing');
    }
  }

  public returnToTitle(): void {
    this.clearInputs();
    this.clearEntities();
    this.player = createInitialTankState(this.layout.playerSpawn);
    this.playerRig.group.visible = true;
    this.syncPlayerMesh();
    this.audio.updateTankContinuous(false, 0, false, false);
    this.stepTitleCamera(0);
    this.setPhase('title');
  }

  private clearEntities(): void {
    for (let i = 0; i < this.enemies.length; i++) {
      this.scene.remove(this.enemies[i].rig.group);
    }
    this.enemies.length = 0;

    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      this.shells[i].active = false;
      this.shellMesh.setMatrixAt(i, _zeroMat);
    }
    this.shellMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      this.atgms[i].active = false;
      this.atgmMesh.setMatrixAt(i, _zeroMat);
      this.atgmGlowMesh.setMatrixAt(i, _zeroMat);
    }
    this.atgmMesh.instanceMatrix.needsUpdate = true;
    this.atgmGlowMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnWave(waveNum: number): void {
    this.wave = waveNum;
    const def = getTankWaveDefinition(waveNum);
    this.waveBanner = {
      wave: def.wave,
      titleFa: def.titleFa,
      subtitleFa: def.subtitleFa,
      remaining: 3.4,
    };

    for (let i = 0; i < def.units.length; i++) {
      const arch = def.units[i];
      const sp = this.layout.enemySpawns[(i * 2 + (waveNum - 1)) % this.layout.enemySpawns.length];
      // Ensure enemy never spawns right on top of the player
      let sx = sp.x;
      let sz = sp.z;
      if (Math.hypot(sx - this.player.x, sz - this.player.z) < 62) {
        sx = -sx || 64;
        sz = -sz || -128;
      }
      const unit = createEnemyTankUnit(
        this.nextEnemyId++,
        arch,
        sx,
        sz,
        waveNum,
        this.difficulty,
      );
      const rig = buildTankMesh(arch);
      rig.group.position.set(unit.x, unit.y, unit.z);
      rig.hullGroup.rotation.y = unit.hullYaw;
      rig.turretPivot.rotation.y = normalizeAngle(unit.turretYaw - unit.hullYaw);
      this.scene.add(rig.group);
      this.enemies.push({ unit, rig });
    }
  }

  private spawnShell(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    fromPlayer: boolean,
    isMg: boolean,
    damage: number,
  ): void {
    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      const s = this.shells[i];
      if (!s.active) {
        s.active = true;
        s.fromPlayer = fromPlayer;
        s.isMg = isMg;
        s.pos.copy(origin);
        s.prevPos.copy(origin);
        s.vel.copy(dir).normalize().multiplyScalar(speed);
        s.life = isMg ? 1.1 : 2.8;
        s.damage = damage;
        _color.setHex(
          fromPlayer ? (isMg ? 0xfef08a : 0xffb74d) : isMg ? 0xff7043 : 0xff3d3d,
        );
        this.shellMesh.setColorAt(i, _color);
        if (this.shellMesh.instanceColor) this.shellMesh.instanceColor.needsUpdate = true;
        return;
      }
    }
  }

  private spawnAtgm(origin: THREE.Vector3, dir: THREE.Vector3, damage: number): void {
    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      const m = this.atgms[i];
      if (!m.active) {
        m.active = true;
        m.pos.copy(origin);
        m.prevPos.copy(origin);
        m.vel.copy(dir).normalize().multiplyScalar(TANK_PHYSICS_CONFIG.atgmSpeed);
        m.life = 7.5;
        m.spoofed = false;
        m.smokeTimer = 0;
        m.damage = damage;
        return;
      }
    }
  }

  private spawnParticle(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    startScale: number,
    endScale: number,
    hexColor: number,
    riseSpeed = 0,
  ): void {
    const idx = this.particleCursor;
    this.particleCursor = (this.particleCursor + 1) % PARTICLE_POOL_SIZE;
    const p = this.particles[idx];
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = life;
    p.maxLife = life;
    p.startScale = startScale;
    p.endScale = endScale;
    p.riseSpeed = riseSpeed;
    _color.setHex(hexColor);
    this.particleMesh.setColorAt(idx, _color);
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }

  private spawnImpactBurst(pos: THREE.Vector3, isDust: boolean, isFlankCrit = false): void {
    const count = isFlankCrit ? 16 : isDust ? 10 : 8;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = (isFlankCrit ? 12 : 7) + Math.random() * 14;
      _v1.set(Math.cos(a) * spd, 4 + Math.random() * 9, Math.sin(a) * spd);
      const col = isDust
        ? i % 2 === 0
          ? 0xa89b86
          : 0x736c63
        : isFlankCrit
        ? i % 2 === 0
          ? 0xfff3a0
          : 0xff7b29
        : 0xffcc66;
      this.spawnParticle(
        pos,
        _v1,
        isDust ? 0.65 + Math.random() * 0.45 : 0.28 + Math.random() * 0.22,
        isDust ? 0.9 : 0.5,
        isDust ? 2.6 : 0.12,
        col,
        isDust ? 1.8 : 0,
      );
    }
  }

  private spawnTankExplosion(pos: THREE.Vector3, heavy = true): void {
    const count = heavy ? 28 : 14;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 6 + Math.random() * (heavy ? 24 : 14);
      _v1.set(Math.cos(a) * spd, 6 + Math.random() * (heavy ? 18 : 10), Math.sin(a) * spd);
      const isFire = i < count * 0.58;
      const col = isFire
        ? i % 2 === 0
          ? 0xff8c24
          : 0xffe27a
        : 0x2f2d2b;
      this.spawnParticle(
        pos,
        _v1,
        isFire ? 0.55 + Math.random() * 0.4 : 1.15 + Math.random() * 0.85,
        isFire ? 1.4 : 1.8,
        isFire ? 3.8 : 5.4,
        col,
        isFire ? 2.2 : 3.4,
      );
    }
  }

  private deployPlayerSmoke(): void {
    if (this.smokeReady <= 0) return;
    this.smokeReady--;
    this.smokeActiveTimer = 5.4;
    this.audio.playSmokeDeploy();

    // Protective tactical smoke screen ring around tank perimeter (clear of chase camera)
    const camDirX = Math.sin(this.player.turretYaw);
    const camDirZ = Math.cos(this.player.turretYaw);
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      // Skip puffs directly behind the turret so the player's own chase view stays readable
      if (cosA * camDirX + sinA * camDirZ > 0.78) continue;
      const rad = 4.6 + Math.random() * 3.0;
      _v1.set(this.player.x + cosA * rad, this.player.y + 0.9, this.player.z + sinA * rad);
      _v2.set(cosA * 2.8, 1.4 + Math.random() * 1.2, sinA * 2.8);
      this.spawnParticle(_v1, _v2, 2.5 + Math.random() * 1.1, 1.35, 3.1, i % 2 === 0 ? 0xd2d8de : 0xb8c0c8, 0.45);
    }

    // Active Protection Pulse: spoof all incoming enemy ATGMs & break enemy ATGM locks!
    let spoofedAny = false;
    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      const m = this.atgms[i];
      if (m.active && !m.spoofed) {
        m.spoofed = true;
        // Veers harmlessly upward/sideways into the sky
        m.vel.y += 28;
        m.vel.x += (Math.random() - 0.5) * 32;
        spoofedAny = true;
      }
    }
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].unit.atgmLockProgress > 0.15) {
        this.enemies[i].unit.atgmLockProgress = 0;
        spoofedAny = true;
      }
    }
    if (spoofedAny) {
      this.smokeSuccessTimer = 2.6;
    }
  }

  private syncPlayerMesh(): void {
    this.playerRig.group.position.set(this.player.x, this.player.y, this.player.z);
    this.playerRig.hullGroup.rotation.set(
      this.player.pitchTilt,
      this.player.hullYaw,
      this.player.rollTilt,
      'YXZ',
    );
    const localTurretYaw = normalizeAngle(this.player.turretYaw - this.player.hullYaw);
    this.playerRig.turretPivot.rotation.y = localTurretYaw;
    this.playerRig.barrelPivot.rotation.x = this.player.barrelPitch;
    this.playerRig.barrelPivot.position.z = -1.35 + this.player.recoilOffset * 0.72;
    this.playerRig.muzzleFlash.visible = this.playerMuzzleFlashTimer > 0;
  }

  private stepTitleCamera(dt: number): void {
    const t = this.elapsedTime;
    const px = this.layout.playerSpawn.x;
    const pz = this.layout.playerSpawn.z;
    this.player.x = px;
    this.player.z = pz;
    this.player.y = 0;
    this.player.hullYaw = 0.25;
    this.player.turretYaw = 0.25 + Math.sin(t * 0.45) * 0.42;
    this.syncPlayerMesh();

    // Cinematic low urban orbit framing player tank against ruined towers & rising smoke
    this.camera.position.set(
      px - 8.5 + Math.sin(t * 0.22) * 3.5,
      5.2 + Math.sin(t * 0.35) * 0.6,
      pz + 11.5 + Math.cos(t * 0.22) * 2.2,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(px + 2.5, 2.4, pz - 12);
    this.camera.updateMatrixWorld();

    this.stepAmbientCityAtmosphere(dt);
    this.updateParticles(dt);
  }

  private stepAmbientCityAtmosphere(dt: number): void {
    // Rising dark warzone smoke plumes from damaged structures
    this.ambientSmokeTimer -= dt;
    if (this.ambientSmokeTimer <= 0 && this.layout.smokeAnchors.length > 0) {
      this.ambientSmokeTimer = 0.28;
      const idx = Math.floor(Math.random() * this.layout.smokeAnchors.length);
      const a = this.layout.smokeAnchors[idx];
      _v1.set(a.x + (Math.random() - 0.5) * 2.2, a.y, a.z + (Math.random() - 0.5) * 2.2);
      _v2.set(1.0 + (Math.random() - 0.5) * 1.2, 2.4 + Math.random() * 1.4, (Math.random() - 0.5) * 1.2);
      this.spawnParticle(_v1, _v2, 3.8 + Math.random() * 1.4, 1.4, 4.0, 0x363330, 0.9);
    }

    // Subtle floating warm embers drifting in dusty air away from the camera lens
    this.ambientEmberTimer -= dt;
    if (this.ambientEmberTimer <= 0) {
      this.ambientEmberTimer = 0.22;
      const ang = Math.random() * Math.PI * 2;
      const dist = 16 + Math.random() * 34;
      _v1.set(
        this.player.x + Math.cos(ang) * dist,
        2.2 + Math.random() * 10,
        this.player.z + Math.sin(ang) * dist,
      );
      _v2.set(2.0 + Math.random() * 2.2, 0.9 + Math.random() * 1.4, (Math.random() - 0.5) * 1.8);
      this.spawnParticle(_v1, _v2, 2.0 + Math.random() * 1.0, 0.14, 0.04, 0xffa042, 0.35);
    }
  }

  private scheduleNextFrame(): void {
    if (!this.running) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => this.tick());
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (!this.running) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  private tick(): void {
    if (!this.running) return;
    const now = performance.now();
    const rawDt = (now - this.lastTimeMs) / 1000;
    this.lastTimeMs = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.elapsedTime += dt;
    this.updateAdaptiveResolution(rawDt);

    if (this.phase === 'title') {
      this.stepTitleCamera(dt);
    } else if (this.phase === 'playing') {
      this.stepSimulation(dt);
    }

    this.renderer.render(this.scene, this.camera);
    this.scheduleNextFrame();
  }

  private stepSimulation(dt: number): void {
    // Visual timers always tick smoothly even during hitstop
    if (this.cameraTrauma > 0) this.cameraTrauma = Math.max(0, this.cameraTrauma - dt * 1.85);
    if (this.hitMarkerTimer > 0) this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    if (this.damageFlashTimer > 0) this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    if (this.smokeSuccessTimer > 0) this.smokeSuccessTimer = Math.max(0, this.smokeSuccessTimer - dt);
    if (this.flankNoticeTimer > 0) this.flankNoticeTimer = Math.max(0, this.flankNoticeTimer - dt);
    if (this.armorDeflectTimer > 0) this.armorDeflectTimer = Math.max(0, this.armorDeflectTimer - dt);
    if (this.playerMuzzleFlashTimer > 0) {
      this.playerMuzzleFlashTimer = Math.max(0, this.playerMuzzleFlashTimer - dt);
    }
    if (this.ghostHp > this.playerHp) {
      this.ghostHp = Math.max(this.playerHp, this.ghostHp - 32 * dt);
    } else {
      this.ghostHp = this.playerHp;
    }

    if (this.waveBanner) {
      this.waveBanner.remaining -= dt;
      if (this.waveBanner.remaining <= 0) this.waveBanner = null;
    }
    if (this.killFeedTimer > 0) {
      this.killFeedTimer -= dt;
      if (this.killFeedTimer <= 0) this.killFeed = null;
    }

    if (this.pendingDefeat) {
      this.defeatBeatTimer -= dt;
      this.updateParticles(dt);
      this.updateCamera(dt);
      if (this.defeatBeatTimer <= 0) {
        this.pendingDefeat = false;
        this.audio.updateTankContinuous(false, 0, false, false);
        this.setPhase('gameover');
      }
      return;
    }

    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      this.updateCamera(dt);
      return;
    }

    this.survivalTimeSec += dt;
    const diffProfile = DIFFICULTY_PROFILES[this.difficulty];

    // 1. Player Hull Kinematics & Independent Turret Traverse
    stepTankHullPhysics(this.player, this.input, dt, this.layout.aabbs);
    stepTurretAim(this.player, this.aimYaw, this.aimPitch, dt);

    // Subtle track dust kickup when driving fast
    if (Math.abs(this.player.speed) > 9 && Math.random() < 0.35) {
      const fx = -Math.sin(this.player.hullYaw);
      const fz = -Math.cos(this.player.hullYaw);
      _v1.set(this.player.x - fx * 3.1, this.player.y + 0.35, this.player.z - fz * 3.1);
      _v2.set((Math.random() - 0.5) * 2.2, 1.4, (Math.random() - 0.5) * 2.2);
      this.spawnParticle(_v1, _v2, 0.55, 0.85, 2.2, 0x9c8e79, 0.6);
    }

    // 2. Weapon Timers & Auto-Resupply
    if (this.cannonReloadTimer > 0) this.cannonReloadTimer = Math.max(0, this.cannonReloadTimer - dt);
    if (this.cannonBufferTimer > 0) this.cannonBufferTimer = Math.max(0, this.cannonBufferTimer - dt);
    if (this.smokeBufferTimer > 0) this.smokeBufferTimer = Math.max(0, this.smokeBufferTimer - dt);
    if (this.mgFireTimer > 0) this.mgFireTimer = Math.max(0, this.mgFireTimer - dt);

    if (this.smokeReady < this.smokeMax) {
      this.smokeReloadTimer += dt;
      if (this.smokeReloadTimer >= 12.5) {
        this.smokeReloadTimer = 0;
        this.smokeReady++;
      }
    } else {
      this.smokeReloadTimer = 0;
    }

    if (this.smokeActiveTimer > 0) {
      this.smokeActiveTimer = Math.max(0, this.smokeActiveTimer - dt);
      this.smokeEmitTimer -= dt;
      if (this.smokeEmitTimer <= 0) {
        this.smokeEmitTimer = 0.22;
        const a = Math.random() * Math.PI * 2;
        _v1.set(this.player.x + Math.cos(a) * 5.2, this.player.y + 0.9, this.player.z + Math.sin(a) * 5.2);
        _v2.set(Math.cos(a) * 1.8, 1.3, Math.sin(a) * 1.8);
        this.spawnParticle(_v1, _v2, 1.7, 1.3, 2.9, 0xcbd2da, 0.45);
      }
    }

    // Player Smoke Screen trigger
    if (this.smokeBufferTimer > 0 && this.smokeReady > 0) {
      this.smokeBufferTimer = 0;
      this.deployPlayerSmoke();
    }

    // Player Main Cannon (120mm AP Shell with recoil, muzzle flash & camera punch)
    const barrelFwdX = -Math.sin(this.player.turretYaw) * Math.cos(this.player.barrelPitch);
    const barrelFwdY = Math.sin(this.player.barrelPitch);
    const barrelFwdZ = -Math.cos(this.player.turretYaw) * Math.cos(this.player.barrelPitch);

    if ((this.cannonBufferTimer > 0 || this.input.fireCannon) && this.cannonReloadTimer <= 0) {
      this.cannonBufferTimer = 0;
      this.cannonReloadTimer = TANK_PHYSICS_CONFIG.cannonReloadSec;
      this.player.recoilOffset = 1.0;
      this.playerMuzzleFlashTimer = 0.08;
      this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.34);

      _v1.set(
        this.player.x + barrelFwdX * 6.2,
        this.player.y + 2.12 + barrelFwdY * 5.2,
        this.player.z + barrelFwdZ * 6.2,
      );
      _v2.set(barrelFwdX, barrelFwdY + 0.012, barrelFwdZ);
      this.spawnShell(_v1, _v2, TANK_PHYSICS_CONFIG.shellSpeed, true, false, 68);
      this.audio.playTankCannon();

      // Muzzle blast dust puff
      for (let p = 0; p < 5; p++) {
        _v3.set(
          barrelFwdX * (6 + Math.random() * 8) + (Math.random() - 0.5) * 4,
          1.4 + Math.random() * 2.2,
          barrelFwdZ * (6 + Math.random() * 8) + (Math.random() - 0.5) * 4,
        );
        this.spawnParticle(_v1, _v3, 0.48, 0.9, 2.5, 0xbab0a2, 0.6);
      }
    }

    // Player Coaxial Machine Gun (rapid-fire suppression with heat gauge)
    if (this.input.fireMg && !this.mgOverheated) {
      this.mgHeat = Math.min(100, this.mgHeat + 26 * dt);
      if (this.mgHeat >= 100) this.mgOverheated = true;
      if (this.mgFireTimer <= 0) {
        this.mgFireTimer = 0.09;
        const rightX = Math.cos(this.player.turretYaw);
        const rightZ = -Math.sin(this.player.turretYaw);
        _v1.set(
          this.player.x + barrelFwdX * 3.8 + rightX * 0.55,
          this.player.y + 2.08,
          this.player.z + barrelFwdZ * 3.8 + rightZ * 0.55,
        );
        _v2.set(
          barrelFwdX + (Math.random() - 0.5) * 0.022,
          barrelFwdY + (Math.random() - 0.5) * 0.014,
          barrelFwdZ + (Math.random() - 0.5) * 0.022,
        );
        this.spawnShell(_v1, _v2, TANK_PHYSICS_CONFIG.mgBulletSpeed, true, true, 11);
        this.audio.playCannonShot();
      }
    } else {
      this.mgHeat = Math.max(0, this.mgHeat - 34 * dt);
      if (this.mgOverheated && this.mgHeat <= 30) this.mgOverheated = false;
    }

    this.syncPlayerMesh();

    // 3. Update Enemy Armored Units (FSM + Attack Token Pool + Smoke Cover)
    let activeAttackers = 0;
    let anyAtgmLocking = false;
    const maxAttackers = Math.min(diffProfile.maxConcurrentAttackers + 1, 2 + Math.floor(this.wave / 2));

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const rec = this.enemies[i];
      const u = rec.unit;

      if (!u.alive) {
        this.scene.remove(rec.rig.group);
        this.enemies.splice(i, 1);
        continue;
      }

      const canAttack = activeAttackers < maxAttackers;
      updateEnemyTankAI(
        u,
        this.player,
        this.smokeActiveTimer > 0,
        canAttack,
        dt,
        this.layout,
        this.difficulty,
        _aiEvents,
      );

      if (u.state === 'ENGAGE') activeAttackers++;
      if (_aiEvents.lockingAtgm) anyAtgmLocking = true;

      if (_aiEvents.deployedSmoke) {
        _v1.set(u.x, u.y + 1.4, u.z);
        for (let s = 0; s < 10; s++) {
          const ang = (s / 10) * Math.PI * 2;
          _v2.set(Math.cos(ang) * 4, 2.4, Math.sin(ang) * 4);
          this.spawnParticle(_v1, _v2, 2.4, 2.0, 5.2, 0xc8cfd6, 0.8);
        }
      }

      if (_aiEvents.firedShell) {
        _v1.set(_aiEvents.originX, _aiEvents.originY, _aiEvents.originZ);
        _v2.set(_aiEvents.dirX, _aiEvents.dirY, _aiEvents.dirZ);
        const dmg =
          u.archetype === 'buggy'
            ? Math.round(12 * diffProfile.enemyDamageScale)
            : Math.round(24 * diffProfile.enemyDamageScale);
        this.spawnShell(_v1, _v2, u.archetype === 'buggy' ? 120 : 108, false, u.archetype === 'buggy', dmg);
      }

      if (_aiEvents.firedAtgm) {
        _v1.set(_aiEvents.originX, _aiEvents.originY, _aiEvents.originZ);
        _v2.set(_aiEvents.dirX, _aiEvents.dirY, _aiEvents.dirZ);
        this.spawnAtgm(_v1, _v2, Math.round(38 * diffProfile.enemyDamageScale));
        this.audio.playMissileLaunch();
      }

      // Sync visual mesh + recoil + hit flash
      rec.rig.group.position.set(u.x, u.y, u.z);
      rec.rig.hullGroup.rotation.y = u.hullYaw;
      rec.rig.turretPivot.rotation.y = normalizeAngle(u.turretYaw - u.hullYaw);
      rec.rig.barrelPivot.position.z = (u.archetype === 'buggy' ? -0.68 : -1.35) + u.recoilOffset * 0.55;
      setTankRigHitFlash(rec.rig, u.hitFlashTimer > 0);

      if (u.dying && Math.random() < 0.6) {
        _v1.set(u.x, u.y + 2.0, u.z);
        _v2.set((Math.random() - 0.5) * 3, 4.5, (Math.random() - 0.5) * 3);
        this.spawnParticle(_v1, _v2, 0.8, 1.4, 3.6, 0x2a2725, 1.5);
      }

      if (!u.alive) {
        _v1.set(u.x, u.y + 1.8, u.z);
        this.spawnTankExplosion(_v1, true);
        this.audio.playExplosion(true);
        this.scene.remove(rec.rig.group);
        this.enemies.splice(i, 1);
      }
    }

    // 4. Update Pooled Shells, ATGMs, & Particles with Swept CCD
    this.updateShells(dt);
    const atgmIncoming = this.updateAtgms(dt);
    this.stepAmbientCityAtmosphere(dt);
    this.updateParticles(dt);

    // 5. Endless Wave Progression with Partial Armor Repair & Smoke Resupply
    if (this.enemies.length === 0) {
      if (this.nextWaveDelay <= 0) {
        this.nextWaveDelay = 2.6;
        this.audio.playWaveClear();
        this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 45);
        this.smokeReady = Math.min(this.smokeMax, this.smokeReady + 1);
      } else {
        this.nextWaveDelay -= dt;
        if (this.nextWaveDelay <= 0) {
          this.spawnWave(this.wave + 1);
        }
      }
    }

    // 6. Camera & Continuous Tank Audio
    this.updateCamera(dt);
    const speedNorm = Math.min(1, Math.abs(this.player.speed) / TANK_PHYSICS_CONFIG.maxForwardSpeed);
    this.audio.updateTankContinuous(
      true,
      speedNorm,
      this.player.turboActive,
      atgmIncoming || anyAtgmLocking,
    );

    // 7. Throttled HUD Snapshot Push (~16.6Hz)
    this.hudEmitAccum += dt;
    if (this.hudEmitAccum >= 0.06) {
      this.hudEmitAccum = 0;
      this.emitHudSnapshot(anyAtgmLocking, atgmIncoming);
    }
  }

  private damageEnemyTank(
    unit: EnemyTankUnit,
    baseDamage: number,
    projVel: THREE.Vector3,
    hitPos: THREE.Vector3,
    isMainCannon: boolean,
  ): void {
    if (!unit.alive || unit.dying) return;
    _projDirXZ.x = projVel.x;
    _projDirXZ.z = projVel.z;
    const hitInfo = computeDirectionalArmorHit(_projDirXZ, unit.hullYaw, baseDamage);

    unit.hp -= hitInfo.damage;
    unit.hitFlashTimer = 0.075;
    this.hitMarkerTimer = 0.2;
    this.hitMarkerCritical = hitInfo.isFlankCritical || unit.hp <= 0;

    if (hitInfo.isFlankCritical && isMainCannon) {
      this.flankNoticeTimer = 1.9;
    }

    if (unit.hp <= 0) {
      unit.hp = 0;
      unit.dying = true;
      unit.deathTimer = 0.42;
      this.kills++;
      const flankBonus = hitInfo.isFlankCritical ? 80 : 0;
      const totalPts = unit.scoreValue + flankBonus;
      this.score += totalPts;
      this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 14);
      if (this.score > this.highScore) {
        this.highScore = this.score;
        try {
          window.localStorage.setItem(TANK_HIGH_SCORE_KEY, String(this.highScore));
        } catch {
          // ignore
        }
      }
      this.killFeed = {
        id: this.killFeedSeq++,
        textFa: hitInfo.isFlankCritical
          ? `${unit.nameFa} با ضربه جناح منهدم شد!`
          : `${unit.nameFa} منهدم شد`,
        points: totalPts,
      };
      this.killFeedTimer = 2.8;
      this.hitstopTimer = isMainCannon ? 0.055 : 0.035;
      this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.52);
      this.spawnTankExplosion(hitPos, true);
      this.audio.playExplosion(true);
    } else {
      if (hitInfo.isFlankCritical) {
        this.audio.playArmorCrit();
        this.spawnImpactBurst(hitPos, false, true);
      } else {
        this.audio.playHitConfirm();
        this.spawnImpactBurst(hitPos, false, false);
      }
    }
  }

  private damagePlayerTank(baseDamage: number, projVel: THREE.Vector3): void {
    if (this.pendingDefeat || this.phase !== 'playing') return;
    _projDirXZ.x = projVel.x;
    _projDirXZ.z = projVel.z;
    const hitInfo = computeDirectionalArmorHit(_projDirXZ, this.player.hullYaw, baseDamage);

    if (hitInfo.zone === 'front') {
      this.armorDeflectTimer = 1.2;
    }

    this.playerHp = Math.max(0, this.playerHp - hitInfo.damage);
    this.damageFlashTimer = 0.28;
    this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.48);
    this.audio.playPlayerHit();

    if (this.playerHp <= 0) {
      this.pendingDefeat = true;
      this.defeatReason = 'combat';
      this.defeatBeatTimer = 0.65;
      this.playerRig.group.visible = false;
      _v1.set(this.player.x, this.player.y + 1.8, this.player.z);
      this.spawnTankExplosion(_v1, true);
      this.audio.playExplosion(true);
      this.audio.playDefeatSting();
    }
  }

  private updateShells(dt: number): void {
    let anyChange = false;
    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      const s = this.shells[i];
      if (!s.active) continue;
      anyChange = true;

      s.prevPos.copy(s.pos);
      if (!s.isMg) {
        // Realistic light ballistic gravity arc on 120mm main shells
        s.vel.y -= 9.8 * dt;
      }
      s.pos.addScaledVector(s.vel, dt);
      s.life -= dt;

      let hit = false;

      // 1. Swept CCD against enemy tanks / player tank
      if (s.fromPlayer) {
        for (let e = 0; e < this.enemies.length; e++) {
          const u = this.enemies[e].unit;
          if (!u.alive || u.dying) continue;
          _targetVec3.x = u.x;
          _targetVec3.y = u.y + 1.65;
          _targetVec3.z = u.z;
          if (segmentSphereIntersect(s.prevPos, s.pos, _targetVec3, u.hitRadius + (s.isMg ? 0.35 : 0.65))) {
            this.damageEnemyTank(u, s.damage, s.vel, s.pos, !s.isMg);
            hit = true;
            break;
          }
        }
      } else {
        _targetVec3.x = this.player.x;
        _targetVec3.y = this.player.y + 1.65;
        _targetVec3.z = this.player.z;
        if (segmentSphereIntersect(s.prevPos, s.pos, _targetVec3, TANK_PHYSICS_CONFIG.hullRadius + 0.45)) {
          this.damagePlayerTank(s.damage, s.vel);
          this.spawnImpactBurst(s.pos, false, false);
          hit = true;
        }
      }

      // 2. Swept CCD against ruined buildings, concrete barricades & wrecks
      if (!hit) {
        const cityT = segmentCityImpact(s.prevPos, s.pos, this.layout.aabbs, false);
        if (cityT >= 0) {
          _v1.lerpVectors(s.prevPos, s.pos, cityT);
          this.spawnImpactBurst(_v1, true, false);
          if (!s.isMg) this.spawnImpactBurst(_v1, false, false);
          hit = true;
        } else if (s.pos.y <= 0.1) {
          this.spawnImpactBurst(s.pos, true, false);
          hit = true;
        }
      }

      if (hit || s.life <= 0) {
        s.active = false;
        this.shellMesh.setMatrixAt(i, _zeroMat);
      } else {
        _v1.copy(s.vel).normalize();
        _quat.setFromUnitVectors(_unitZ, _v1);
        _dummy.position.copy(s.pos);
        _dummy.quaternion.copy(_quat);
        if (s.isMg) _dummy.scale.set(0.45, 0.45, 0.65);
        else _dummy.scale.set(1.15, 1.15, 1.25);
        _dummy.updateMatrix();
        this.shellMesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (anyChange) this.shellMesh.instanceMatrix.needsUpdate = true;
  }

  private updateAtgms(dt: number): boolean {
    let anyChange = false;
    let incomingAlert = false;

    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      const m = this.atgms[i];
      if (!m.active) continue;
      anyChange = true;

      m.prevPos.copy(m.pos);
      m.life -= dt;

      if (!m.spoofed) {
        incomingAlert = true;
        // Guided ATGM steering toward player tank (realistic turning limit so player can duck behind ruins or pop smoke)
        _v1.set(this.player.x - m.pos.x, this.player.y + 1.65 - m.pos.y, this.player.z - m.pos.z).normalize();
        _v2.copy(m.vel).normalize();
        _v2.lerp(_v1, Math.min(1, 2.3 * dt)).normalize();
        m.vel.copy(_v2).multiplyScalar(TANK_PHYSICS_CONFIG.atgmSpeed);
      }

      m.pos.addScaledVector(m.vel, dt);

      // Vivid glowing crimson-orange exhaust trail behind ATGM
      m.smokeTimer -= dt;
      if (m.smokeTimer <= 0) {
        m.smokeTimer = 0.028;
        _v1.set((Math.random() - 0.5) * 1.5, 1.2, (Math.random() - 0.5) * 1.5);
        this.spawnParticle(
          m.pos,
          _v1,
          0.62,
          0.85,
          2.4,
          Math.random() < 0.6 ? 0xff3b24 : 0xff9b38,
          0.4,
        );
      }

      let detonated = false;

      // Swept CCD vs player tank
      if (!m.spoofed) {
        _targetVec3.x = this.player.x;
        _targetVec3.y = this.player.y + 1.65;
        _targetVec3.z = this.player.z;
        if (segmentSphereIntersect(m.prevPos, m.pos, _targetVec3, TANK_PHYSICS_CONFIG.hullRadius + 1.4)) {
          this.damagePlayerTank(m.damage, m.vel);
          this.spawnTankExplosion(m.pos, false);
          this.audio.playExplosion(false);
          detonated = true;
        }
      }

      // Swept CCD vs ruined buildings / barricades / ground
      if (!detonated) {
        const cityT = segmentCityImpact(m.prevPos, m.pos, this.layout.aabbs, false);
        if (cityT >= 0 || m.pos.y <= 0.15) {
          this.spawnTankExplosion(m.pos, false);
          this.audio.playExplosion(false);
          detonated = true;
        }
      }

      if (detonated || m.life <= 0) {
        m.active = false;
        this.atgmMesh.setMatrixAt(i, _zeroMat);
        this.atgmGlowMesh.setMatrixAt(i, _zeroMat);
      } else {
        _v1.copy(m.vel).normalize();
        _quat.setFromUnitVectors(_unitZ, _v1);
        _dummy.position.copy(m.pos);
        _dummy.quaternion.copy(_quat);
        _dummy.scale.set(1.2, 1.2, 1.2);
        _dummy.updateMatrix();
        this.atgmMesh.setMatrixAt(i, _dummy.matrix);

        // Pulsing high-visibility red rocket glow at ATGM tail
        const pulse = 1.15 + Math.sin(this.elapsedTime * 42 + i) * 0.35;
        _dummy.position.copy(m.pos).addScaledVector(_v1, -1.4);
        _dummy.rotation.set(this.elapsedTime * 9, this.elapsedTime * 7, 0);
        _dummy.scale.setScalar(pulse);
        _dummy.updateMatrix();
        this.atgmGlowMesh.setMatrixAt(i, _dummy.matrix);
      }
    }

    if (anyChange) {
      this.atgmMesh.instanceMatrix.needsUpdate = true;
      this.atgmGlowMesh.instanceMatrix.needsUpdate = true;
    }
    return incomingAlert;
  }

  private updateParticles(dt: number): void {
    let anyChange = false;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      anyChange = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.particleMesh.setMatrixAt(i, _zeroMat);
      } else {
        p.pos.addScaledVector(p.vel, dt);
        p.pos.y += p.riseSpeed * dt;
        p.vel.multiplyScalar(1 - 1.35 * dt);
        const progress = 1 - p.life / p.maxLife;
        const scale = THREE.MathUtils.lerp(p.startScale, p.endScale, progress);
        _dummy.position.copy(p.pos);
        _dummy.rotation.set(progress * 2.0, progress * 1.5, 0);
        _dummy.scale.setScalar(Math.max(0.04, scale));
        _dummy.updateMatrix();
        this.particleMesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (anyChange) this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  private updateCamera(dt: number): void {
    const aimFwdX = -Math.sin(this.aimYaw);
    const aimFwdZ = -Math.cos(this.aimYaw);
    const aimRightX = Math.cos(this.aimYaw);
    const aimRightZ = -Math.sin(this.aimYaw);

    const chaseDist = this.player.turboActive ? 15.8 : 13.8;
    const chaseHeight = 6.1 - this.aimPitch * 7.5;

    _camAnchor.set(this.player.x, this.player.y + 3.0, this.player.z);
    _camDesired.set(
      this.player.x - aimFwdX * chaseDist + aimRightX * 1.15,
      this.player.y + Math.max(3.6, chaseHeight),
      this.player.z - aimFwdZ * chaseDist + aimRightZ * 1.15,
    );

    // Pull chase camera cleanly inside building corridors so it never clips through walls
    computeCameraWallPullIn(_camAnchor, _camDesired, this.layout.aabbs, _camPulled);

    const posAlpha = 1 - Math.exp(-11 * dt);
    this.camPos.lerp(_camPulled, posAlpha);

    _lookGoal.set(
      this.player.x + aimFwdX * 36,
      this.player.y + 2.2 + Math.sin(this.aimPitch) * 28,
      this.player.z + aimFwdZ * 36,
    );
    const lookAlpha = 1 - Math.exp(-15 * dt);
    this.camLook.lerp(_lookGoal, lookAlpha);

    const shake = this.cameraTrauma * this.cameraTrauma;
    this.camera.position.copy(this.camPos);
    if (shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * shake * 1.9;
      this.camera.position.y += (Math.random() - 0.5) * shake * 1.9;
      this.camera.position.z += (Math.random() - 0.5) * shake * 1.4;
    }

    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);

    const targetFov = this.player.turboActive ? 69 : 60;
    const nextFov = THREE.MathUtils.damp(this.camera.fov, targetFov, 7, dt);
    if (Math.abs(nextFov - this.camera.fov) > 0.05) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private emitHudSnapshot(atgmLockWarning: boolean, atgmIncomingWarning: boolean): void {
    // 1. Project Dual Reticles: Player Aim Point vs Heavy Barrel Current Alignment Point
    const aimDirX = -Math.sin(this.aimYaw) * Math.cos(this.aimPitch);
    const aimDirY = Math.sin(this.aimPitch);
    const aimDirZ = -Math.cos(this.aimYaw) * Math.cos(this.aimPitch);

    _v1.set(this.player.x, this.player.y + 2.1, this.player.z);
    _v2.set(_v1.x + aimDirX * 140, Math.max(1.2, _v1.y + aimDirY * 140), _v1.z + aimDirZ * 140);
    const aimWallT = segmentCityImpact(_v1, _v2, this.layout.aabbs, false);
    if (aimWallT >= 0) _v2.lerpVectors(_v1, _v2, aimWallT);

    _proj.copy(_v2).project(this.camera);
    const aimReticleX = THREE.MathUtils.clamp((_proj.x + 1) * 0.5, 0.08, 0.92);
    const aimReticleY = THREE.MathUtils.clamp((1 - _proj.y) * 0.5, 0.08, 0.92);

    const barDirX = -Math.sin(this.player.turretYaw) * Math.cos(this.player.barrelPitch);
    const barDirY = Math.sin(this.player.barrelPitch);
    const barDirZ = -Math.cos(this.player.turretYaw) * Math.cos(this.player.barrelPitch);
    _v3.set(_v1.x + barDirX * 140, Math.max(1.2, _v1.y + barDirY * 140), _v1.z + barDirZ * 140);
    const barWallT = segmentCityImpact(_v1, _v3, this.layout.aabbs, false);
    if (barWallT >= 0) _v3.lerpVectors(_v1, _v3, barWallT);

    _proj.copy(_v3).project(this.camera);
    const barrelInFront = _proj.z >= -1 && _proj.z <= 1;
    const barrelReticleX = barrelInFront
      ? THREE.MathUtils.clamp((_proj.x + 1) * 0.5, 0.04, 0.96)
      : aimReticleX;
    const barrelReticleY = barrelInFront
      ? THREE.MathUtils.clamp((1 - _proj.y) * 0.5, 0.04, 0.96)
      : aimReticleY;
    const barrelAligned = Math.abs(normalizeAngle(this.aimYaw - this.player.turretYaw)) < 0.075;

    // 2. Project Enemy Tanks + Predictive Lead Indicator + Urban Minimap Blips
    const minimapBlips: TankMinimapBlip[] = [];
    const targets: ProjectedTankTarget[] = [];
    const incomingAtgms: ProjectedIncomingMissile[] = [];

    // Automatically select best aimed visible target if lockedTargetId is gone
    let bestAimCandidate: number | null = null;
    let bestAimErr = 0.24;
    let aliveCount = 0;

    _shooterVec3.x = this.player.x;
    _shooterVec3.y = this.player.y + 2.1;
    _shooterVec3.z = this.player.z;

    for (let i = 0; i < this.enemies.length; i++) {
      const u = this.enemies[i].unit;
      if (!u.alive || u.dying) continue;
      aliveCount++;

      const yawTo = Math.atan2(-(u.x - this.player.x), -(u.z - this.player.z));
      const err = Math.abs(normalizeAngle(yawTo - this.aimYaw));
      if (err < bestAimErr) {
        bestAimErr = err;
        bestAimCandidate = u.id;
      }
    }

    const activeLockId =
      bestAimCandidate !== null
        ? bestAimCandidate
        : this.enemies.some((e) => e.unit.id === this.lockedTargetId && e.unit.alive && !e.unit.dying)
        ? this.lockedTargetId
        : null;
    this.lockedTargetId = activeLockId;

    for (let i = 0; i < this.enemies.length; i++) {
      const u = this.enemies[i].unit;
      if (!u.alive || u.dying) continue;

      const isLocked = u.id === activeLockId;
      minimapBlips.push({
        id: u.id,
        x: THREE.MathUtils.clamp(u.x / CITY_PLAYABLE_HALF, -1, 1),
        z: THREE.MathUtils.clamp(u.z / CITY_PLAYABLE_HALF, -1, 1),
        type: u.archetype,
        isLocked,
      });

      const dist = Math.hypot(u.x - this.player.x, u.z - this.player.z);
      _proj.set(u.x, u.y + 2.6, u.z).project(this.camera);
      const inFront = _proj.z >= -1 && _proj.z <= 1;
      const sx = (_proj.x + 1) * 0.5;
      const sy = (1 - _proj.y) * 0.5;
      const onScreen = inFront && sx >= 0.04 && sx <= 0.96 && sy >= 0.06 && sy <= 0.94;

      let leadX = sx;
      let leadY = sy;
      let leadVisible = false;
      if (inFront && isLocked && dist < 175) {
        _targetVec3.x = u.x;
        _targetVec3.y = u.y + 1.8;
        _targetVec3.z = u.z;
        _targetVel3.x = u.vx;
        _targetVel3.y = 0;
        _targetVel3.z = u.vz;
        computeLeadPosition(
          _shooterVec3,
          _targetVec3,
          _targetVel3,
          TANK_PHYSICS_CONFIG.shellSpeed,
          _leadPos,
        );
        _proj.set(_leadPos.x, _leadPos.y, _leadPos.z).project(this.camera);
        if (_proj.z >= -1 && _proj.z <= 1) {
          leadX = (_proj.x + 1) * 0.5;
          leadY = (1 - _proj.y) * 0.5;
          leadVisible = leadX >= 0.03 && leadX <= 0.97 && leadY >= 0.03 && leadY <= 0.97;
        }
      }

      targets.push({
        id: u.id,
        archetype: u.archetype,
        nameFa: u.nameFa,
        screenX: sx,
        screenY: sy,
        inFront,
        onScreen,
        distance: Math.round(dist),
        hpRatio: Math.max(0, u.hp / u.maxHp),
        isLocked,
        leadX,
        leadY,
        leadVisible,
      });
    }

    // 3. Project Incoming Enemy ATGMs (screen tracker + edge arrow + minimap dot)
    for (let i = 0; i < ATGM_POOL_SIZE; i++) {
      const m = this.atgms[i];
      if (!m.active || m.spoofed) continue;

      minimapBlips.push({
        id: 30000 + i,
        x: THREE.MathUtils.clamp(m.pos.x / CITY_PLAYABLE_HALF, -1, 1),
        z: THREE.MathUtils.clamp(m.pos.z / CITY_PLAYABLE_HALF, -1, 1),
        type: 'atgm',
        isLocked: false,
      });

      const dist = Math.hypot(m.pos.x - this.player.x, m.pos.z - this.player.z);
      _proj.copy(m.pos).project(this.camera);
      const inFront = _proj.z >= -1 && _proj.z <= 1;
      const sx = (_proj.x + 1) * 0.5;
      const sy = (1 - _proj.y) * 0.5;
      const onScreen = inFront && sx >= 0.04 && sx <= 0.96 && sy >= 0.06 && sy <= 0.94;
      incomingAtgms.push({
        id: 31000 + i,
        screenX: sx,
        screenY: sy,
        inFront,
        onScreen,
        distance: Math.round(dist),
        sourceLabelFa: 'موشک ضدتانک',
      });
    }

    let hullHeadingDeg = Math.round(((-this.player.hullYaw * 180) / Math.PI) % 360);
    if (hullHeadingDeg < 0) hullHeadingDeg += 360;
    let turretHeadingDeg = Math.round(((-this.player.turretYaw * 180) / Math.PI) % 360);
    if (turretHeadingDeg < 0) turretHeadingDeg += 360;

    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      speedKmh: Math.round(Math.abs(this.player.speed) * 3.6),
      hullHeadingDeg,
      turretHeadingDeg,
      hp: Math.round(this.playerHp),
      maxHp: this.playerMaxHp,
      ghostHp: Math.round(this.ghostHp),
      score: this.score,
      highScore: this.highScore,
      kills: this.kills,
      wave: this.wave,
      enemiesRemaining: aliveCount,
      aimReticleX,
      aimReticleY,
      barrelReticleX,
      barrelReticleY,
      barrelAligned,
      cannonReloadProgress:
        this.cannonReloadTimer <= 0
          ? 1
          : 1 - this.cannonReloadTimer / TANK_PHYSICS_CONFIG.cannonReloadSec,
      cannonReady: this.cannonReloadTimer <= 0,
      mgHeat: Math.round(this.mgHeat),
      mgOverheated: this.mgOverheated,
      turboCharge: Math.round(this.player.turboCharge),
      turboActive: this.player.turboActive,
      turboOverheated: this.player.turboOverheated,
      smokeReady: this.smokeReady,
      smokeMax: this.smokeMax,
      smokeReloadProgress: Math.min(1, this.smokeReloadTimer / 12.5),
      smokeActiveTimer: this.smokeActiveTimer,
      lockedTargetId: activeLockId,
      atgmLockWarning,
      atgmIncomingWarning,
      flankNoticeTimer: this.flankNoticeTimer,
      smokeSuccessTimer: this.smokeSuccessTimer,
      armorDeflectTimer: this.armorDeflectTimer,
      hitMarkerTimer: this.hitMarkerTimer,
      hitMarkerCritical: this.hitMarkerCritical,
      damageFlashTimer: this.damageFlashTimer,
      defeatReason: this.defeatReason,
      survivalTimeSec: Math.round(this.survivalTimeSec),
      waveBanner: this.waveBanner,
      killFeed: this.killFeed,
      playerMapX: THREE.MathUtils.clamp(this.player.x / CITY_PLAYABLE_HALF, -1, 1),
      playerMapZ: THREE.MathUtils.clamp(this.player.z / CITY_PLAYABLE_HALF, -1, 1),
      minimapBlips,
      targets,
      incomingAtgms,
      isTouchDevice: this.isTouchDevice,
    });
  }

  public dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    this.audio.dispose();

    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material?.dispose();
        }
      }
    });

    resetSharedTankMeshAssets();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
