import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AudioSynth } from './audioSynth';
import {
  createEnemyUnit,
  DIFFICULTY_PROFILES,
  getWaveDefinition,
  updateEnemyAI,
  type EnemyActionEvents,
  type EnemyUnit,
} from './enemyAI';
import {
  checkTerrainCollision,
  computeLeadPosition,
  createInitialFlightState,
  evaluateGPWS,
  FLIGHT_CONFIG,
  segmentCapsuleIntersect,
  segmentSphereDistanceSq,
  segmentSphereIntersect,
  segmentTerrainImpact,
  stepFlightPhysics,
  stepProportionalNavigation,
  type FlightState,
} from './flightPhysics';
import {
  buildCommandBaseMesh,
  buildEnemyJetMesh,
  buildPlayerJetMesh,
  buildSamBatteryMesh,
  buildWarshipMesh,
  resetSharedMeshAssets,
  setRigHitFlash,
  type JetVisualRig,
  type SurfaceVisualRig,
} from './meshes';
import {
  createStrikeSurfaceUnits,
  createSurfaceWaveUnits,
  getStrikeMissionDefinition,
  updateSurfaceUnit,
  type StrikeMissionDef,
  type SurfaceActionEvents,
  type SurfaceUnit,
} from './surfaceUnits';
import { buildCloudLayer, buildOceanMesh, buildTerrainMesh, getTerrainHeight } from './terrain';
import type {
  ControlInput,
  DefeatReason,
  DifficultyLevel,
  GamePhase,
  HudSnapshot,
  JetSubMode,
  KillFeedItem,
  ProjectedIncomingMissile,
  ProjectedTarget,
  RadarBlip,
  StrikeObjectiveInfo,
  WaveAnnouncement,
} from './types';

const HIGH_SCORE_KEY = 'sky_hunter_fa_highscore_v1';
const BULLET_POOL_SIZE = 160;
const MISSILE_POOL_SIZE = 28;
const FLARE_POOL_SIZE = 24;
const PARTICLE_POOL_SIZE = 340;
const PLAYER_BULLET_SPEED = 560;
const ENEMY_BULLET_SPEED = 410;
const MISSILE_SPEED = 310;
const RADAR_RANGE = 1850;
const PROXIMITY_FUSE_EXTRA_M = 10.5;

const EXPLOSION_COLORS: readonly number[] = [0xfff2a6, 0xff9d2e, 0xe84824, 0x3b3f47];
const SPARK_COLORS: readonly number[] = [0xffffff, 0xffe484, 0xff9c38];

interface PooledBullet {
  active: boolean;
  fromPlayer: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  damage: number;
}

interface PooledMissile {
  active: boolean;
  fromPlayer: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  targetId: number | null; // enemy aircraft or surface unit id if fromPlayer
  decoyFlareIndex: number; // -1 if tracking real target, >=0 if spoofed by flare
  maxLateralAccel: number; // G-limited proportional navigation turn envelope
  speed: number;
  sourceLabelFa: string;
  life: number;
  smokeTimer: number;
}

interface PooledFlare {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  smokeTimer: number;
}

interface PooledParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
  color: THREE.Color;
}

interface ActiveEnemyRecord {
  unit: EnemyUnit;
  rig: JetVisualRig;
}

interface ActiveSurfaceRecord {
  unit: SurfaceUnit;
  rig: SurfaceVisualRig;
}

// Reusable module-scope math scratchpads (strict zero GC inside game loop)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _titleCamOffset = new THREE.Vector3(0, 4.5, 0);
const _camGoal = new THREE.Vector3();
const _lookGoal = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _leadPos = { x: 0, y: 0, z: 0 };
const _dummy = new THREE.Object3D();
const _quat = new THREE.Quaternion();
const _color = new THREE.Color();
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
const _unitZ = new THREE.Vector3(0, 0, 1);

const _aiEvents: EnemyActionEvents = {
  firedCannon: false,
  cannonOrigin: new THREE.Vector3(),
  cannonDir: new THREE.Vector3(),
  firedMissile: false,
  lockingPlayer: false,
  deployedFlare: false,
};

const _surfaceEvents: SurfaceActionEvents = {
  firedMissile: false,
  launchOrigin: new THREE.Vector3(),
  launchDir: new THREE.Vector3(),
  lockingPlayer: false,
  lockBrokenByTerrain: false,
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

export class AirCombatEngine {
  private container: HTMLElement;
  private onHudUpdate: (snapshot: HudSnapshot) => void;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;
  public audio: AudioSynth;

  // World visuals
  private ocean: { mesh: THREE.Mesh; update: (elapsed: number) => void };
  private clouds: { mesh: THREE.InstancedMesh; update: (dt: number) => void };
  private sunLight: THREE.DirectionalLight;

  // Player rig & physics
  private playerRig: JetVisualRig;
  private flight: FlightState;
  private playerHp = 100;
  private readonly playerMaxHp = 100;
  private ghostHp = 100;
  private gunFireTimer = 0;
  private gunBarrelToggle = 1;
  private missilesReady = 4;
  private readonly missilesMax = 4;
  private missileReloadTimer = 0;
  private flaresReady = 3;
  private readonly flaresMax = 3;
  private flareReloadTimer = 0;
  private flareSuccessTimer = 0;
  private enemyFlareNoticeTimer = 0;
  private samMaskNoticeTimer = 0;
  private difficulty: DifficultyLevel = 'normal';
  private jetSubMode: JetSubMode = 'dogfight';
  private currentStrikeMission: StrikeMissionDef | null = null;
  private strikeObjectiveTotal = 0;

  // Radar lock-on
  private lockTargetId: number | null = null;
  private lockProgress = 0;

  // Enemies, surface SAMs/warships & waves
  private enemies: ActiveEnemyRecord[] = [];
  private surfaceUnits: ActiveSurfaceRecord[] = [];
  private nextEnemyId = 1;
  private nextSurfaceId = 5000;
  private wave = 1;
  private nextWaveDelay = 0;
  private waveBanner: WaveAnnouncement | null = null;
  private waveBannerTimer = 0;
  private killFeed: KillFeedItem | null = null;
  private killFeedTimer = 0;
  private killFeedSeq = 1;

  // Score & run state
  private phase: GamePhase = 'title';
  private defeatReason: DefeatReason = 'none';
  private defeatBeatTimer = 0;
  private pendingDefeat = false;
  private score = 0;
  private highScore = 0;
  private kills = 0;
  private survivalTimeSec = 0;

  // Juice: hitstop, trauma camera shake, hit flash
  private hitstopTimer = 0;
  private cameraTrauma = 0;
  private hitMarkerTimer = 0;
  private hitMarkerCritical = false;
  private damageFlashTimer = 0;
  private camPos = new THREE.Vector3(0, 238, 392);
  private camLook = new THREE.Vector3(0, 225, 300);
  private titleOrbitAngle = 0.55;

  // Object pools + InstancedMeshes
  private bullets: PooledBullet[] = [];
  private bulletMesh: THREE.InstancedMesh;
  private missiles: PooledMissile[] = [];
  private missileMesh: THREE.InstancedMesh;
  private missileGlowMesh: THREE.InstancedMesh;
  private flares: PooledFlare[] = [];
  private flareMesh: THREE.InstancedMesh;
  private particles: PooledParticle[] = [];
  private particleCursor = 0;
  private particleMesh: THREE.InstancedMesh;

  // Input state
  private input: ControlInput = {
    pitch: 0,
    roll: 0,
    yaw: 0,
    fireGun: false,
    fireMissile: false,
    boost: false,
    flare: false,
  };
  private missileBufferTimer = 0;
  private flareBufferTimer = 0;
  private isTouchDevice = false;

  // Adaptive resolution scaling & loop lifecycle
  private running = true;
  private frameId = 0;
  private lastFrameTs = 0;
  private elapsedTime = 0;
  private hudEmitAccum = 0;
  private basePixelRatio = 1;
  private renderScale = 1.0;
  private fpsFrameCount = 0;
  private fpsTimeAccum = 0;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, onHudUpdate: (snapshot: HudSnapshot) => void) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;
    this.audio = new AudioSynth();
    this.isTouchDevice =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    try {
      const saved = window.localStorage.getItem(HIGH_SCORE_KEY);
      if (saved) this.highScore = Math.max(0, parseInt(saved, 10) || 0);
    } catch {
      this.highScore = 0;
    }

    this.isSoftwareGl = detectSoftwareWebGL();
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.basePixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const width = Math.max(1, container.clientWidth || window.innerWidth);
    const height = Math.max(1, container.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    // Handle WebGL context loss gracefully
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    });

    // Scene, horizon-matched sky & atmospheric FogExp2
    this.scene = new THREE.Scene();
    const skyColor = new THREE.Color(0x88b8de);
    this.scene.background = skyColor;
    this.scene.fog = new THREE.FogExp2(0x88b8de, 0.00023);

    this.camera = new THREE.PerspectiveCamera(64, width / height, 0.8, 5200);

    // Studio IBL via RoomEnvironment on all devices so metals & glass canopy look crisp
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Warm/cool 3-point aviation daylight rig
    const hemi = new THREE.HemisphereLight(0xbce0ff, 0x2a4559, 0.92);
    this.scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.1);
    this.sunLight.position.set(420, 620, 260);
    this.sunLight.castShadow = !this.isSoftwareGl;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 50;
    this.sunLight.shadow.camera.far = 1600;
    const d = 140;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Distant warm sun disc in sky for orientation & horizon depth
    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(95, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff5d6, fog: false }),
    );
    sunDisc.position.set(1750, 1450, -2400);
    this.scene.add(sunDisc);

    // Procedural archipelago terrain, ocean & instanced clouds
    const terrainMesh = buildTerrainMesh();
    this.scene.add(terrainMesh);
    this.ocean = buildOceanMesh();
    this.scene.add(this.ocean.mesh);
    this.clouds = buildCloudLayer();
    this.scene.add(this.clouds.mesh);

    // Player jet
    this.flight = createInitialFlightState();
    this.playerRig = buildPlayerJetMesh();
    this.playerRig.group.position.copy(this.flight.position);
    this.scene.add(this.playerRig.group);

    // Pre-allocated InstancedMesh Pools
    const bulletGeo = new THREE.CylinderGeometry(0.18, 0.18, 5.2, 5);
    bulletGeo.rotateX(Math.PI / 2);
    const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.bulletMesh = new THREE.InstancedMesh(bulletGeo, bulletMat, BULLET_POOL_SIZE);
    this.bulletMesh.frustumCulled = false;
    this.scene.add(this.bulletMesh);
    for (let i = 0; i < BULLET_POOL_SIZE; i++) {
      this.bullets.push({
        active: false,
        fromPlayer: true,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        damage: 14,
      });
      this.bulletMesh.setMatrixAt(i, _zeroMat);
      this.bulletMesh.setColorAt(i, _color.setHex(0xffd66b));
    }

    const missileGeo = new THREE.CylinderGeometry(0.24, 0.34, 4.1, 6);
    missileGeo.rotateX(Math.PI / 2);
    const missileMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.45,
      emissive: 0x441400,
    });
    this.missileMesh = new THREE.InstancedMesh(missileGeo, missileMat, MISSILE_POOL_SIZE);
    this.missileMesh.frustumCulled = false;
    this.scene.add(this.missileMesh);

    // High-contrast glowing rocket exhaust flare sphere for every missile (vivid red/orange on incoming enemy/SAM missiles)
    const glowGeo = new THREE.OctahedronGeometry(1.15, 1);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      fog: false,
    });
    this.missileGlowMesh = new THREE.InstancedMesh(glowGeo, glowMat, MISSILE_POOL_SIZE);
    this.missileGlowMesh.frustumCulled = false;
    this.scene.add(this.missileGlowMesh);

    for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
      this.missiles.push({
        active: false,
        fromPlayer: true,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        targetId: null,
        decoyFlareIndex: -1,
        maxLateralAccel: 240,
        speed: MISSILE_SPEED,
        sourceLabelFa: 'موشک دشمن',
        life: 0,
        smokeTimer: 0,
      });
      this.missileMesh.setMatrixAt(i, _zeroMat);
      this.missileMesh.setColorAt(i, _color.setHex(0xf4f4f5));
      this.missileGlowMesh.setMatrixAt(i, _zeroMat);
      this.missileGlowMesh.setColorAt(i, _color.setHex(0xff5226));
    }

    const flareGeo = new THREE.OctahedronGeometry(0.95, 0);
    const flareMat = new THREE.MeshBasicMaterial({ color: 0xfff3b0 });
    this.flareMesh = new THREE.InstancedMesh(flareGeo, flareMat, FLARE_POOL_SIZE);
    this.flareMesh.frustumCulled = false;
    this.scene.add(this.flareMesh);
    for (let i = 0; i < FLARE_POOL_SIZE; i++) {
      this.flares.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 3.4,
        smokeTimer: 0,
      });
      this.flareMesh.setMatrixAt(i, _zeroMat);
    }

    const particleGeo = new THREE.DodecahedronGeometry(1, 0);
    const particleMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.particleMesh = new THREE.InstancedMesh(particleGeo, particleMat, PARTICLE_POOL_SIZE);
    this.particleMesh.frustumCulled = false;
    this.scene.add(this.particleMesh);
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.particles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        startScale: 1,
        endScale: 0.1,
        color: new THREE.Color(0xffffff),
      });
      this.particleMesh.setMatrixAt(i, _zeroMat);
      this.particleMesh.setColorAt(i, _color.setHex(0xffffff));
    }

    // Pre-warm shaders on GPU devices
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // Responsive ResizeObserver
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    // Sync initial state & start render loop
    this.setPhase('title');
    this.lastFrameTs = performance.now();
    this.scheduleNextFrame();
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  public setInput(partial: Partial<ControlInput>): void {
    if (partial.pitch !== undefined) this.input.pitch = partial.pitch;
    if (partial.roll !== undefined) this.input.roll = partial.roll;
    if (partial.yaw !== undefined) this.input.yaw = partial.yaw;
    if (partial.fireGun !== undefined) this.input.fireGun = partial.fireGun;
    if (partial.boost !== undefined) this.input.boost = partial.boost;
    if (partial.fireMissile) {
      this.missileBufferTimer = 0.16;
    }
    if (partial.flare) {
      this.flareBufferTimer = 0.16;
    }
  }

  public clearInputs(): void {
    this.input.pitch = 0;
    this.input.roll = 0;
    this.input.yaw = 0;
    this.input.fireGun = false;
    this.input.fireMissile = false;
    this.input.boost = false;
    this.input.flare = false;
    this.missileBufferTimer = 0;
    this.flareBufferTimer = 0;
  }

  public triggerMissile(): void {
    this.missileBufferTimer = 0.18;
  }

  public triggerFlare(): void {
    this.flareBufferTimer = 0.18;
  }

  public setDifficulty(level: DifficultyLevel): void {
    this.difficulty = level;
    this.emitHudSnapshot();
  }

  public getDifficulty(): DifficultyLevel {
    return this.difficulty;
  }

  public setJetSubMode(subMode: JetSubMode): void {
    this.jetSubMode = subMode;
    this.emitHudSnapshot();
  }

  public getJetSubMode(): JetSubMode {
    return this.jetSubMode;
  }

  public getPhase(): GamePhase {
    return this.phase;
  }

  private setPhase(next: GamePhase): void {
    this.phase = next;
    document.body.dataset.state = next;
    this.emitHudSnapshot();
  }

  public startNewGame(overrideDifficulty?: DifficultyLevel, overrideSubMode?: JetSubMode): void {
    if (overrideDifficulty) {
      this.difficulty = overrideDifficulty;
    }
    if (overrideSubMode) {
      this.jetSubMode = overrideSubMode;
    }
    this.audio.unlock();
    this.clearInputs();
    this.clearEntities();
    this.currentStrikeMission = null;
    this.strikeObjectiveTotal = 0;
    this.nextWaveDelay = 0;

    this.flight = createInitialFlightState();
    this.playerRig.group.visible = true;
    this.playerRig.group.position.copy(this.flight.position);
    this.playerRig.group.quaternion.copy(this.flight.quaternion);

    this.playerHp = this.playerMaxHp;
    this.ghostHp = this.playerMaxHp;
    this.score = 0;
    this.kills = 0;
    this.wave = 1;
    this.survivalTimeSec = 0;
    this.defeatReason = 'none';
    this.pendingDefeat = false;
    this.defeatBeatTimer = 0;

    this.missilesReady = this.missilesMax;
    this.missileReloadTimer = 0;
    this.flaresReady = this.flaresMax;
    this.flareReloadTimer = 0;
    this.flareSuccessTimer = 0;
    this.enemyFlareNoticeTimer = 0;
    this.samMaskNoticeTimer = 0;
    this.lockTargetId = null;
    this.lockProgress = 0;
    this.hitstopTimer = 0;
    this.cameraTrauma = 0;
    this.hitMarkerTimer = 0;
    this.hitMarkerCritical = false;
    this.damageFlashTimer = 0;
    this.killFeed = null;
    this.killFeedTimer = 0;

    // Position chase camera cleanly behind player facing clear forward horizon
    this.camPos.set(0, 232, 384);
    this.camLook.set(0, 225, 290);
    this.camera.fov = 64;
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
      this.audio.updateContinuous(false, 0, false, 0, false, false, false);
      this.setPhase('paused');
    } else if (this.phase === 'paused') {
      this.clearInputs();
      this.lastFrameTs = performance.now();
      this.setPhase('playing');
    }
  }

  public returnToTitle(): void {
    this.clearInputs();
    this.clearEntities();
    this.flight = createInitialFlightState();
    this.playerRig.group.visible = true;
    this.audio.updateContinuous(false, 0, false, 0, false, false, false);
    this.setPhase('title');
  }

  private clearEntities(): void {
    for (let i = 0; i < this.enemies.length; i++) {
      this.scene.remove(this.enemies[i].rig.group);
    }
    this.enemies.length = 0;

    for (let i = 0; i < this.surfaceUnits.length; i++) {
      this.scene.remove(this.surfaceUnits[i].rig.group);
    }
    this.surfaceUnits.length = 0;

    for (let i = 0; i < BULLET_POOL_SIZE; i++) {
      this.bullets[i].active = false;
      this.bulletMesh.setMatrixAt(i, _zeroMat);
    }
    this.bulletMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
      this.missiles[i].active = false;
      this.missileMesh.setMatrixAt(i, _zeroMat);
      this.missileGlowMesh.setMatrixAt(i, _zeroMat);
    }
    this.missileMesh.instanceMatrix.needsUpdate = true;
    this.missileGlowMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < FLARE_POOL_SIZE; i++) {
      this.flares[i].active = false;
      this.flareMesh.setMatrixAt(i, _zeroMat);
    }
    this.flareMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.particles[i].active = false;
      this.particleMesh.setMatrixAt(i, _zeroMat);
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  private buildSurfaceRig(type: SurfaceUnit['type']): SurfaceVisualRig {
    if (type === 'command') return buildCommandBaseMesh();
    if (type === 'sam') return buildSamBatteryMesh();
    return buildWarshipMesh();
  }

  private spawnWave(waveNum: number): void {
    this.wave = waveNum;

    if (this.jetSubMode === 'strike') {
      const mission = getStrikeMissionDefinition(waveNum);
      this.currentStrikeMission = mission;

      // Clear leftover surface structures from previous strike mission before spawning next sector
      for (let i = 0; i < this.surfaceUnits.length; i++) {
        this.scene.remove(this.surfaceUnits[i].rig.group);
      }
      this.surfaceUnits.length = 0;

      const freshSurface = createStrikeSurfaceUnits(
        mission,
        this.nextSurfaceId,
        this.difficulty,
        getTerrainHeight,
      );
      this.nextSurfaceId += freshSurface.length;

      let primarySurfaceCount = 0;
      for (let i = 0; i < freshSurface.length; i++) {
        const su = freshSurface[i];
        if (su.isPrimaryObjective) primarySurfaceCount++;
        const rig = this.buildSurfaceRig(su.type);
        rig.group.position.copy(su.position);
        rig.group.rotation.y = su.headingRad;
        this.scene.add(rig.group);
        this.surfaceUnits.push({ unit: su, rig });
      }

      const airCount = mission.airUnits.length;
      for (let i = 0; i < airCount; i++) {
        const archetype = mission.airUnits[i];
        const spread = (i - (airCount - 1) / 2) * 0.34;
        const headingAngle = -Math.PI / 2 + spread + (Math.random() - 0.5) * 0.14;
        const dist = 840 + i * 125;
        const sx = this.flight.position.x + Math.cos(headingAngle) * dist;
        const sz = this.flight.position.z + Math.sin(headingAngle) * dist;
        const groundH = getTerrainHeight(sx, sz);
        const sy = Math.max(265, groundH + 155) + (i % 3) * 45;

        const unit = createEnemyUnit(
          this.nextEnemyId++,
          archetype,
          new THREE.Vector3(sx, sy, sz),
          (i / Math.max(1, airCount)) * Math.PI * 2,
          waveNum,
          this.difficulty,
        );
        const rig = buildEnemyJetMesh(archetype);
        rig.group.position.copy(unit.position);
        rig.group.quaternion.copy(unit.quaternion);
        this.scene.add(rig.group);
        this.enemies.push({ unit, rig });
      }

      this.strikeObjectiveTotal =
        mission.objectiveKind === 'air' ? airCount : Math.max(1, primarySurfaceCount);

      this.waveBanner = {
        wave: waveNum,
        titleFa: mission.titleFa,
        subtitleFa: mission.subtitleFa,
        remaining: this.strikeObjectiveTotal,
      };
      this.waveBannerTimer = 4.2;
      return;
    }

    // Standard Dogfight Survival (نبرد آزاد) — exact existing endless mode
    this.currentStrikeMission = null;
    this.strikeObjectiveTotal = 0;
    const def = getWaveDefinition(waveNum);
    this.waveBanner = {
      wave: waveNum,
      titleFa: def.titleFa,
      subtitleFa: def.subtitleFa,
      remaining: def.units.length,
    };
    this.waveBannerTimer = 3.8;

    const count = def.units.length;
    for (let i = 0; i < count; i++) {
      const archetype = def.units[i];
      // Spawn formation ahead and flanking in the sky, well above mountains
      const spread = (i - (count - 1) / 2) * 0.32;
      const headingAngle = -Math.PI / 2 + spread + (Math.random() - 0.5) * 0.14;
      const dist = 780 + i * 115;
      const sx = this.flight.position.x + Math.cos(headingAngle) * dist;
      const sz = this.flight.position.z + Math.sin(headingAngle) * dist;
      const groundH = getTerrainHeight(sx, sz);
      const sy = Math.max(255, groundH + 150) + (i % 3) * 45;

      const unit = createEnemyUnit(
        this.nextEnemyId++,
        archetype,
        new THREE.Vector3(sx, sy, sz),
        (i / count) * Math.PI * 2,
        waveNum,
        this.difficulty,
      );
      const rig = buildEnemyJetMesh(archetype);
      rig.group.position.copy(unit.position);
      rig.group.quaternion.copy(unit.quaternion);
      this.scene.add(rig.group);
      this.enemies.push({ unit, rig });
    }

    // Spawn or replenish Ground SAM Batteries & Patrolling Naval Destroyers
    if (this.surfaceUnits.length === 0) {
      const freshSurface = createSurfaceWaveUnits(
        waveNum,
        this.nextSurfaceId,
        this.difficulty,
        getTerrainHeight,
      );
      this.nextSurfaceId += freshSurface.length;
      for (let i = 0; i < freshSurface.length; i++) {
        const su = freshSurface[i];
        const rig = this.buildSurfaceRig(su.type);
        rig.group.position.copy(su.position);
        rig.group.rotation.y = su.headingRad;
        this.scene.add(rig.group);
        this.surfaceUnits.push({ unit: su, rig });
      }
    }
  }

  private spawnBullet(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    fromPlayer: boolean,
    damage: number,
  ): void {
    for (let i = 0; i < BULLET_POOL_SIZE; i++) {
      const b = this.bullets[i];
      if (!b.active) {
        b.active = true;
        b.fromPlayer = fromPlayer;
        b.pos.copy(origin);
        b.prevPos.copy(origin);
        b.vel.copy(dir).normalize().multiplyScalar(speed);
        b.life = fromPlayer ? 2.4 : 2.8;
        b.damage = damage;
        _color.setHex(fromPlayer ? 0xffe073 : 0xff5a4f);
        this.bulletMesh.setColorAt(i, _color);
        if (this.bulletMesh.instanceColor) {
          this.bulletMesh.instanceColor.needsUpdate = true;
        }
        return;
      }
    }
  }

  private spawnMissile(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    fromPlayer: boolean,
    targetId: number | null,
    sourceLabelFa = 'موشک دشمن',
    speedOverride?: number,
    maxLateralAccelOverride?: number,
  ): boolean {
    for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
      const m = this.missiles[i];
      if (!m.active) {
        m.active = true;
        m.fromPlayer = fromPlayer;
        m.pos.copy(origin);
        m.prevPos.copy(origin);
        const spd = speedOverride ?? (fromPlayer ? MISSILE_SPEED : MISSILE_SPEED * 0.85);
        m.speed = spd;
        m.maxLateralAccel = maxLateralAccelOverride ?? (fromPlayer ? 245 : 165);
        m.vel.copy(dir).normalize().multiplyScalar(spd);
        m.targetId = targetId;
        m.decoyFlareIndex = -1;
        m.sourceLabelFa = sourceLabelFa;
        m.life = fromPlayer ? 8.5 : 8.2;
        m.smokeTimer = 0;
        _color.setHex(fromPlayer ? 0xf8fafc : 0xff3b2f);
        this.missileMesh.setColorAt(i, _color);
        if (this.missileMesh.instanceColor) {
          this.missileMesh.instanceColor.needsUpdate = true;
        }
        _color.setHex(fromPlayer ? 0xffc864 : 0xff2a1a);
        this.missileGlowMesh.setColorAt(i, _color);
        if (this.missileGlowMesh.instanceColor) {
          this.missileGlowMesh.instanceColor.needsUpdate = true;
        }
        return true;
      }
    }
    return false;
  }

  private deployFlares(): void {
    if (this.flaresReady <= 0) return;
    this.flaresReady--;
    this.audio.playFlarePop();

    _forward.set(0, 0, -1).applyQuaternion(this.flight.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.flight.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.flight.quaternion);

    let firstFlareIndex = -1;
    // Release a crisp 3-decoy countermeasure salvo behind the tail
    for (let burst = -1; burst <= 1; burst++) {
      for (let i = 0; i < FLARE_POOL_SIZE; i++) {
        const f = this.flares[i];
        if (!f.active) {
          f.active = true;
          f.pos
            .copy(this.flight.position)
            .addScaledVector(_forward, -5.5)
            .addScaledVector(_right, burst * 1.4);
          f.vel
            .copy(this.flight.velocity)
            .multiplyScalar(0.35)
            .addScaledVector(_right, burst * 28)
            .addScaledVector(_up, -14 - Math.abs(burst) * 6);
          f.life = 3.4;
          f.maxLife = 3.4;
          f.smokeTimer = 0;
          if (firstFlareIndex === -1) firstFlareIndex = i;
          break;
        }
      }
    }

    // Spoof all incoming enemy missiles & break active enemy locks!
    let spoofedAny = false;
    if (firstFlareIndex !== -1) {
      for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
        const m = this.missiles[i];
        if (m.active && !m.fromPlayer && m.decoyFlareIndex === -1) {
          if (m.pos.distanceTo(this.flight.position) < 950) {
            m.decoyFlareIndex = firstFlareIndex;
            spoofedAny = true;
          }
        }
      }
    }
    for (let i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].unit.missileLockOnPlayer > 0.25) {
        this.enemies[i].unit.missileLockOnPlayer = 0;
        spoofedAny = true;
      }
    }
    for (let i = 0; i < this.surfaceUnits.length; i++) {
      if (this.surfaceUnits[i].unit.lockProgress > 0.25) {
        this.surfaceUnits[i].unit.lockProgress = 0;
        this.surfaceUnits[i].unit.wasLockingPlayer = false;
        spoofedAny = true;
      }
    }
    if (spoofedAny) {
      this.flareSuccessTimer = 2.0;
    }
  }

  private deployEnemyFlares(enemy: EnemyUnit): void {
    _forward.set(0, 0, -1).applyQuaternion(enemy.quaternion);
    _right.set(1, 0, 0).applyQuaternion(enemy.quaternion);
    _up.set(0, 1, 0).applyQuaternion(enemy.quaternion);

    let firstFlareIndex = -1;
    for (let burst = -1; burst <= 1; burst += 2) {
      for (let i = 0; i < FLARE_POOL_SIZE; i++) {
        const f = this.flares[i];
        if (!f.active) {
          f.active = true;
          f.pos
            .copy(enemy.position)
            .addScaledVector(_forward, -5.5)
            .addScaledVector(_right, burst * 2.2);
          f.vel
            .copy(enemy.velocity)
            .multiplyScalar(0.32)
            .addScaledVector(_right, burst * 34)
            .addScaledVector(_up, -12);
          f.life = 2.8;
          f.maxLife = 2.8;
          f.smokeTimer = 0;
          if (firstFlareIndex === -1) firstFlareIndex = i;
          break;
        }
      }
    }

    if (firstFlareIndex !== -1) {
      for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
        const m = this.missiles[i];
        if (m.active && m.fromPlayer && m.targetId === enemy.id && m.decoyFlareIndex === -1) {
          if (m.pos.distanceTo(enemy.position) < 340) {
            m.decoyFlareIndex = firstFlareIndex;
            this.enemyFlareNoticeTimer = 2.2;
          }
        }
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
    p.color.setHex(hexColor);
    this.particleMesh.setColorAt(idx, p.color);
    if (this.particleMesh.instanceColor) {
      this.particleMesh.instanceColor.needsUpdate = true;
    }
  }

  private spawnHitSparks(pos: THREE.Vector3): void {
    for (let i = 0; i < 8; i++) {
      const speed = 28 + Math.random() * 52;
      _v1
        .set(Math.random() - 0.5, Math.random() - 0.35, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(speed);
      this.spawnParticle(
        pos,
        _v1,
        0.18 + Math.random() * 0.16,
        1.15,
        0.1,
        SPARK_COLORS[i % SPARK_COLORS.length],
      );
    }
  }

  private spawnExplosion(pos: THREE.Vector3, heavy: boolean): void {
    const count = heavy ? 26 : 12;
    for (let i = 0; i < count; i++) {
      const speed = (heavy ? 24 : 14) + Math.random() * (heavy ? 58 : 30);
      _v1
        .set(Math.random() - 0.5, Math.random() - 0.4, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(speed);
      const isSmoke = i >= count * 0.65;
      this.spawnParticle(
        pos,
        _v1,
        (heavy ? 0.65 : 0.35) + Math.random() * (heavy ? 0.65 : 0.3),
        isSmoke ? (heavy ? 4.2 : 2.1) : heavy ? 3.2 : 1.6,
        isSmoke ? (heavy ? 11.5 : 5.5) : 0.2,
        EXPLOSION_COLORS[isSmoke ? 3 : i % 3],
      );
    }
  }

  private triggerPlayerDefeat(reason: DefeatReason): void {
    if (this.pendingDefeat || this.phase !== 'playing') return;
    this.pendingDefeat = true;
    this.defeatReason = reason;
    this.defeatBeatTimer = 0.65;
    this.playerHp = 0;
    this.playerRig.group.visible = false;
    this.cameraTrauma = 1.0;
    this.spawnExplosion(this.flight.position, true);
    this.audio.playExplosion(true);
    this.audio.playDefeatSting();
    this.audio.updateContinuous(false, 0, false, 0, false, false, false);

    if (this.score > this.highScore) {
      this.highScore = this.score;
      try {
        window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
      } catch {
        // ignore storage errors
      }
    }
  }

  private scheduleNextFrame(): void {
    if (!this.running) return;
    if (this.isSoftwareGl) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      if (gl && typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (!this.running) return;
          const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
          if (status === gl.UNSIGNALED) {
            this.frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            this.frameId = window.setTimeout(() => this.tick(), 80);
          }
        };
        this.frameId = window.setTimeout(poll, 5);
      } else {
        this.frameId = window.setTimeout(() => this.tick(), 90);
      }
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (!this.running) return;

    const now = performance.now();
    const rawDt = (now - this.lastFrameTs) / 1000;
    this.lastFrameTs = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.elapsedTime += dt;

    // Adaptive Resolution Scaling for low-end GPUs (maintains smooth FPS without losing features)
    if (!this.isSoftwareGl && this.phase === 'playing') {
      this.fpsFrameCount++;
      this.fpsTimeAccum += Math.min(rawDt, 0.25);
      if (this.fpsTimeAccum >= 1.2) {
        const rollingFps = this.fpsFrameCount / this.fpsTimeAccum;
        this.fpsFrameCount = 0;
        this.fpsTimeAccum = 0;
        if (rollingFps < 35 && this.renderScale > 0.72) {
          this.renderScale = Math.max(0.72, +(this.renderScale - 0.14).toFixed(2));
          this.renderer.setPixelRatio(Math.max(0.75, this.basePixelRatio * this.renderScale));
        } else if (rollingFps > 52 && this.renderScale < 1.0) {
          this.renderScale = Math.min(1.0, +(this.renderScale + 0.08).toFixed(2));
          this.renderer.setPixelRatio(this.basePixelRatio * this.renderScale);
        }
      }
    }

    if (this.phase === 'title') {
      this.stepTitleFlyover(dt);
    } else if (this.phase === 'playing') {
      this.stepGameplay(dt);
    }

    this.renderer.render(this.scene, this.camera);
    this.scheduleNextFrame();
  }

  private stepTitleFlyover(dt: number): void {
    // Graceful scenic cruise around the sunlit archipelago (zero allocations)
    this.titleOrbitAngle += dt * 0.14;
    const cruiseR = 460;
    const jetX = Math.cos(this.titleOrbitAngle) * cruiseR;
    const jetZ = Math.sin(this.titleOrbitAngle) * cruiseR - 260;
    const jetY = 235 + Math.sin(this.titleOrbitAngle * 2.2) * 18;

    const nextAngle = this.titleOrbitAngle + 0.05;
    const nextX = Math.cos(nextAngle) * cruiseR;
    const nextZ = Math.sin(nextAngle) * cruiseR - 260;
    const nextY = 235 + Math.sin(nextAngle * 2.2) * 18;

    this.flight.position.set(jetX, jetY, jetZ);
    this.playerRig.group.position.copy(this.flight.position);
    this.playerRig.group.lookAt(nextX, nextY, nextZ);
    this.playerRig.group.rotateY(Math.PI);
    this.playerRig.group.rotateZ(-0.28);

    const pulse = 0.85 + Math.sin(this.elapsedTime * 18) * 0.15;
    for (let i = 0; i < this.playerRig.afterburners.length; i++) {
      this.playerRig.afterburners[i].scale.set(0.85, 0.85, pulse);
    }

    _v1.set(nextX - jetX, nextY - jetY, nextZ - jetZ).normalize();
    _right.crossVectors(_v1, _worldUp).normalize();
    this.camera.position
      .copy(this.flight.position)
      .addScaledVector(_v1, -18)
      .addScaledVector(_right, 10)
      .add(_titleCamOffset);
    _lookGoal
      .copy(this.flight.position)
      .addScaledVector(_v1, 14)
      .addScaledVector(_right, -5.5);
    this.camera.lookAt(_lookGoal);

    this.ocean.update(this.elapsedTime);
    this.clouds.update(dt);
  }

  private stepGameplay(dt: number): void {
    // Tick visual/camera timers in real dt even during hitstop
    this.cameraTrauma = Math.max(0, this.cameraTrauma - dt * 1.9);
    this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    if (this.hitMarkerTimer === 0) this.hitMarkerCritical = false;
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    this.flareSuccessTimer = Math.max(0, this.flareSuccessTimer - dt);
    this.enemyFlareNoticeTimer = Math.max(0, this.enemyFlareNoticeTimer - dt);
    this.samMaskNoticeTimer = Math.max(0, this.samMaskNoticeTimer - dt);
    if (this.waveBannerTimer > 0) {
      this.waveBannerTimer = Math.max(0, this.waveBannerTimer - dt);
      if (this.waveBannerTimer === 0) this.waveBanner = null;
    }
    if (this.killFeedTimer > 0) {
      this.killFeedTimer = Math.max(0, this.killFeedTimer - dt);
      if (this.killFeedTimer === 0) this.killFeed = null;
    }

    // Smooth trailing damage ghost bar
    if (this.ghostHp > this.playerHp) {
      this.ghostHp = Math.max(this.playerHp, this.ghostHp - dt * 28);
    } else {
      this.ghostHp = this.playerHp;
    }

    // Defeat beat before Game Over modal
    if (this.pendingDefeat) {
      this.defeatBeatTimer -= dt;
      this.updateParticles(dt);
      this.ocean.update(this.elapsedTime);
      this.updateCamera(dt);
      if (this.defeatBeatTimer <= 0) {
        this.pendingDefeat = false;
        this.setPhase('gameover');
      }
      return;
    }

    // Sim-level hitstop freeze on heavy kills/explosions
    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      this.updateCamera(dt);
      return;
    }

    this.survivalTimeSec += dt;

    // 1. Flight Physics
    stepFlightPhysics(this.flight, this.input, dt);
    this.playerRig.group.position.copy(this.flight.position);
    this.playerRig.group.quaternion.copy(this.flight.quaternion);

    // Move directional shadow frustum with player
    this.sunLight.position.set(
      this.flight.position.x + 320,
      this.flight.position.y + 480,
      this.flight.position.z + 210,
    );
    this.sunLight.target.position.copy(this.flight.position);
    this.sunLight.target.updateMatrixWorld();

    // Update player afterburner flames & subtle wingtip contrails
    const burnScale = this.flight.afterburnerActive
      ? 1.75 + Math.sin(this.elapsedTime * 42) * 0.28
      : 0.72 + Math.sin(this.elapsedTime * 22) * 0.1;
    for (const flame of this.playerRig.afterburners) {
      flame.scale.set(
        this.flight.afterburnerActive ? 1.25 : 0.85,
        this.flight.afterburnerActive ? 1.25 : 0.85,
        burnScale,
      );
      (flame.material as THREE.MeshBasicMaterial).color.setHex(
        this.flight.afterburnerActive ? 0xff9f38 : 0x45c8ff,
      );
    }

    // 2. Exact Ocean & Mountain Collision
    const crash = checkTerrainCollision(this.flight.position, this.flight.quaternion);
    if (crash !== 'none') {
      this.triggerPlayerDefeat(crash);
      return;
    }

    // 3. Weapon cooldowns, reloads & buffered actions
    this.gunFireTimer = Math.max(0, this.gunFireTimer - dt);
    this.missileBufferTimer = Math.max(0, this.missileBufferTimer - dt);
    this.flareBufferTimer = Math.max(0, this.flareBufferTimer - dt);

    const diffProfile = DIFFICULTY_PROFILES[this.difficulty];
    if (this.missilesReady < this.missilesMax) {
      this.missileReloadTimer += dt;
      if (this.missileReloadTimer >= diffProfile.missileReloadSec) {
        this.missileReloadTimer = 0;
        this.missilesReady++;
      }
    } else {
      this.missileReloadTimer = 0;
    }

    if (this.flaresReady < this.flaresMax) {
      this.flareReloadTimer += dt;
      if (this.flareReloadTimer >= diffProfile.flareReloadSec) {
        this.flareReloadTimer = 0;
        this.flaresReady++;
      }
    } else {
      this.flareReloadTimer = 0;
    }

    _forward.set(0, 0, -1).applyQuaternion(this.flight.quaternion).normalize();
    _right.set(1, 0, 0).applyQuaternion(this.flight.quaternion).normalize();

    // Player Autocannon fire
    if (this.input.fireGun && this.gunFireTimer <= 0) {
      this.gunFireTimer = 0.085;
      this.gunBarrelToggle *= -1;
      _v1
        .copy(this.flight.position)
        .addScaledVector(_forward, 5.2)
        .addScaledVector(_right, this.gunBarrelToggle * 1.35);
      // Slight realistic dispersion
      _v2
        .copy(_forward)
        .addScaledVector(_right, (Math.random() - 0.5) * 0.012)
        .normalize();
      this.spawnBullet(
        _v1,
        _v2,
        PLAYER_BULLET_SPEED + this.flight.speed * 0.35,
        true,
        16,
      );
      this.audio.playCannonShot();
    }

    // 4. Radar Conical Lock-On Acquisition (1.5s inside 17° cone)
    this.updateRadarLock(dt);

    // Player Missile launch (buffered edge trigger)
    if (this.missileBufferTimer > 0 && this.missilesReady > 0) {
      this.missileBufferTimer = 0;
      const targetId = this.lockProgress >= 1 ? this.lockTargetId : null;
      _v1
        .copy(this.flight.position)
        .addScaledVector(_forward, 2.5)
        .addScaledVector(_right, (this.missilesReady % 2 === 0 ? 1 : -1) * 2.6);
      if (this.spawnMissile(_v1, _forward, true, targetId)) {
        this.missilesReady--;
        this.audio.playMissileLaunch();
        this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.22);
      }
    }

    // Player Flares deployment
    if (this.flareBufferTimer > 0 && this.flaresReady > 0) {
      this.flareBufferTimer = 0;
      this.deployFlares();
    }

    // 5. Update Enemies (FSM + Attack Token Pool + Standoff Tactics + Enemy Flares)
    let activeAttackers = 0;
    let anyEnemyLocking = false;
    const maxAttackers = Math.min(
      diffProfile.maxConcurrentAttackers,
      1 + Math.floor(this.wave / 2),
    );

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const rec = this.enemies[i];
      const u = rec.unit;

      if (!u.alive) {
        this.scene.remove(rec.rig.group);
        this.enemies.splice(i, 1);
        continue;
      }

      // Measure closest incoming player missile distance for enemy evasion & countermeasure flares
      let closestPlayerMissileDist = Infinity;
      for (let mIdx = 0; mIdx < MISSILE_POOL_SIZE; mIdx++) {
        const m = this.missiles[mIdx];
        if (m.active && m.fromPlayer && m.targetId === u.id && m.decoyFlareIndex === -1) {
          const d = m.pos.distanceTo(u.position);
          if (d < closestPlayerMissileDist) closestPlayerMissileDist = d;
        }
      }

      const isLockedByPlayer = this.lockTargetId === u.id && this.lockProgress > 0.45;
      const canAttack = activeAttackers < maxAttackers;

      updateEnemyAI(
        u,
        this.flight.position,
        this.flight.velocity,
        _forward,
        closestPlayerMissileDist,
        isLockedByPlayer,
        canAttack,
        dt,
        _aiEvents,
        getTerrainHeight,
        this.difficulty,
      );

      if (u.state === 'ATTACK') activeAttackers++;
      if (_aiEvents.lockingPlayer) anyEnemyLocking = true;

      if (_aiEvents.deployedFlare) {
        this.deployEnemyFlares(u);
      }

      if (_aiEvents.firedCannon) {
        this.spawnBullet(
          _aiEvents.cannonOrigin,
          _aiEvents.cannonDir,
          ENEMY_BULLET_SPEED,
          false,
          Math.max(4, Math.round(8 * diffProfile.enemyDamageScale)),
        );
      }
      if (_aiEvents.firedMissile) {
        this.spawnMissile(
          u.position,
          _aiEvents.cannonDir.lengthSq() > 0.1 ? _aiEvents.cannonDir : _forward,
          false,
          null,
          'موشک دشمن',
          MISSILE_SPEED * 0.85,
          165,
        );
      }

      // Sync visual mesh + shared-material hit flash + trailing death smoke
      rec.rig.group.position.copy(u.position);
      rec.rig.group.quaternion.copy(u.quaternion);
      setRigHitFlash(rec.rig, u.hitFlashTimer > 0);

      if (u.dying && Math.random() < 0.65) {
        _v1.set((Math.random() - 0.5) * 8, 6, (Math.random() - 0.5) * 8);
        this.spawnParticle(u.position, _v1, 0.55, 2.2, 6.2, 0x383c42);
      }

      // Final explosion when dying timer completes
      if (!u.alive) {
        this.spawnExplosion(u.position, true);
        this.audio.playExplosion(true);
        this.scene.remove(rec.rig.group);
        this.enemies.splice(i, 1);
      }
    }

    // 5b. Update Ground SAM Batteries & Patrolling Naval Warships (with canyon terrain LOS masking)
    let anySamLocking = false;
    for (let i = this.surfaceUnits.length - 1; i >= 0; i--) {
      const rec = this.surfaceUnits[i];
      const su = rec.unit;
      if (!su.alive) {
        this.scene.remove(rec.rig.group);
        this.surfaceUnits.splice(i, 1);
        continue;
      }

      updateSurfaceUnit(
        su,
        this.flight.position,
        dt,
        _surfaceEvents,
        this.difficulty,
        getTerrainHeight,
      );

      if (_surfaceEvents.lockingPlayer) {
        anySamLocking = true;
        anyEnemyLocking = true;
      }
      if (_surfaceEvents.lockBrokenByTerrain) {
        this.samMaskNoticeTimer = 2.6;
      }
      if (_surfaceEvents.firedMissile) {
        this.spawnMissile(
          _surfaceEvents.launchOrigin,
          _surfaceEvents.launchDir,
          false,
          null,
          su.type === 'sam'
            ? 'موشک پدافند'
            : su.type === 'command'
            ? 'موشک مقر راداری'
            : 'موشک ناو',
          MISSILE_SPEED * 0.9,
          172,
        );
      }

      rec.rig.group.position.copy(su.position);
      if (su.type === 'warship') {
        rec.rig.group.rotation.y = su.headingRad;
      }
      rec.rig.radarDish.rotation.y = su.radarAngle;
      setRigHitFlash(rec.rig, su.hitFlashTimer > 0);
    }

    // 6. Update Pooled Bullets, Missiles, Flares, Particles (with Swept CCD & Proximity Fuse)
    this.updateBullets(dt);
    const missileIncoming = this.updateMissiles(dt);
    this.updateFlares(dt);
    this.updateParticles(dt);

    // 7. Endless Wave Progression (Dogfight: clear air enemies | Strike: destroy primary objective)
    let waveCleared = false;
    if (this.jetSubMode === 'strike' && this.currentStrikeMission) {
      if (this.currentStrikeMission.objectiveKind === 'air') {
        waveCleared = this.enemies.length === 0;
      } else {
        let primaryAlive = 0;
        for (let i = 0; i < this.surfaceUnits.length; i++) {
          if (this.surfaceUnits[i].unit.alive && this.surfaceUnits[i].unit.isPrimaryObjective) {
            primaryAlive++;
          }
        }
        waveCleared = primaryAlive === 0;
      }
    } else {
      waveCleared = this.enemies.length === 0;
    }

    if (waveCleared) {
      if (this.nextWaveDelay <= 0) {
        this.nextWaveDelay = 2.6;
        this.audio.playWaveClear();
        this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 30);
        this.missilesReady = Math.min(this.missilesMax, this.missilesReady + 2);
        this.flaresReady = Math.min(this.flaresMax, this.flaresReady + 1);
        if (this.jetSubMode === 'strike' && this.currentStrikeMission) {
          const bonus = 400;
          this.score += bonus;
          if (this.score > this.highScore) {
            this.highScore = this.score;
            try {
              window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
            } catch {
              // ignore
            }
          }
          this.killFeed = {
            id: this.killFeedSeq++,
            textFa: `ماموریت موج تکمیل شد — اعزام به هدف بعدی`,
            points: bonus,
          };
          this.killFeedTimer = 2.6;
        }
      } else {
        this.nextWaveDelay -= dt;
        if (this.nextWaveDelay <= 0) {
          this.spawnWave(this.wave + 1);
        }
      }
    }

    // 8. Environment, Camera & Procedural Audio
    this.ocean.update(this.elapsedTime);
    this.clouds.update(dt);
    this.updateCamera(dt);

    const gpws = evaluateGPWS(this.flight.position, this.flight.velocity);
    const speedNorm =
      (this.flight.speed - FLIGHT_CONFIG.minSpeed) /
      (FLIGHT_CONFIG.maxBoostSpeed - FLIGHT_CONFIG.minSpeed);
    this.audio.updateContinuous(
      true,
      THREE.MathUtils.clamp(speedNorm, 0, 1),
      this.flight.afterburnerActive,
      this.lockProgress,
      this.lockProgress >= 1,
      gpws.warning,
      missileIncoming || anyEnemyLocking,
    );

    // 9. Throttled HUD snapshot push (~16.6Hz for crisp tracking without React 60Hz overhead)
    this.hudEmitAccum += dt;
    if (this.hudEmitAccum >= 0.06) {
      this.hudEmitAccum = 0;
      this.emitHudSnapshot(
        gpws.warning,
        gpws.agl,
        anyEnemyLocking,
        missileIncoming,
        anySamLocking,
      );
    }
  }

  private updateRadarLock(dt: number): void {
    const diffProfile = DIFFICULTY_PROFILES[this.difficulty];
    const lockCosThreshold = Math.cos(THREE.MathUtils.degToRad(diffProfile.lockConeDeg));
    let bestId: number | null = null;
    let bestScore = -1;

    _forward.set(0, 0, -1).applyQuaternion(this.flight.quaternion).normalize();

    // Check airborne enemy aircraft
    for (let i = 0; i < this.enemies.length; i++) {
      const u = this.enemies[i].unit;
      if (!u.alive || u.dying) continue;
      _v1.subVectors(u.position, this.flight.position);
      const dist = _v1.length();
      if (dist > 1750 || dist < 18) continue;
      const align = _v1.dot(_forward) / dist;
      if (align >= lockCosThreshold) {
        const stickiness = u.id === this.lockTargetId ? 0.05 : 0;
        const score = align + stickiness - dist * 0.00008;
        if (score > bestScore) {
          bestScore = score;
          bestId = u.id;
        }
      }
    }

    // Check ground SAM batteries & enemy naval warships
    for (let i = 0; i < this.surfaceUnits.length; i++) {
      const su = this.surfaceUnits[i].unit;
      if (!su.alive) continue;
      _v1.set(su.position.x, su.position.y + 6, su.position.z).sub(this.flight.position);
      const dist = _v1.length();
      if (dist > 1850 || dist < 24) continue;
      const align = _v1.dot(_forward) / dist;
      if (align >= lockCosThreshold) {
        const stickiness = su.id === this.lockTargetId ? 0.05 : 0;
        const score = align + stickiness - dist * 0.00008;
        if (score > bestScore) {
          bestScore = score;
          bestId = su.id;
        }
      }
    }

    if (bestId !== null) {
      if (bestId === this.lockTargetId) {
        this.lockProgress = Math.min(1, this.lockProgress + dt / diffProfile.lockDurationSec);
      } else {
        this.lockTargetId = bestId;
        this.lockProgress = dt / diffProfile.lockDurationSec;
      }
    } else {
      this.lockTargetId = null;
      this.lockProgress = 0;
    }
  }

  private damageEnemy(unit: EnemyUnit, dmg: number, isMissile: boolean): void {
    if (!unit.alive || unit.dying) return;
    unit.hp -= dmg;
    unit.hitFlashTimer = 0.075;
    this.hitMarkerTimer = 0.18;
    this.hitMarkerCritical = isMissile || unit.hp <= 0;

    if (unit.hp <= 0) {
      unit.hp = 0;
      unit.dying = true;
      unit.deathTimer = 0.42;
      this.kills++;
      this.score += unit.scoreValue;
      // Endless combat momentum: small hull patch + faster ammo recharge per kill
      this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 8);
      this.missileReloadTimer += 1.6;
      this.flareReloadTimer += 1.8;
      if (this.score > this.highScore) {
        this.highScore = this.score;
        try {
          window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
        } catch {
          // ignore
        }
      }
      this.killFeed = {
        id: this.killFeedSeq++,
        textFa: `${unit.nameFa} منهدم شد`,
        points: unit.scoreValue,
      };
      this.killFeedTimer = 2.6;
      this.hitstopTimer = isMissile ? 0.055 : 0.038;
      this.cameraTrauma = Math.min(1, this.cameraTrauma + (isMissile ? 0.55 : 0.35));
      this.spawnExplosion(unit.position, true);
      this.audio.playExplosion(true);
    } else {
      this.audio.playHitConfirm();
      this.spawnHitSparks(unit.position);
    }
  }

  private damageSurfaceUnit(su: SurfaceUnit, dmg: number, isMissile: boolean): void {
    if (!su.alive) return;
    su.hp -= dmg;
    su.hitFlashTimer = 0.085;
    this.hitMarkerTimer = 0.18;
    this.hitMarkerCritical = isMissile || su.hp <= 0;

    _v2.set(su.position.x, su.position.y + 8, su.position.z);

    if (su.hp <= 0) {
      su.hp = 0;
      su.alive = false;
      this.kills++;
      this.score += su.scoreValue;
      this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 12);
      this.missileReloadTimer += 2.2;
      this.flareReloadTimer += 2.2;
      if (this.score > this.highScore) {
        this.highScore = this.score;
        try {
          window.localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
        } catch {
          // ignore
        }
      }
      this.killFeed = {
        id: this.killFeedSeq++,
        textFa: `${su.nameFa} دشمن منهدم شد!`,
        points: su.scoreValue,
      };
      this.killFeedTimer = 2.8;
      this.hitstopTimer = 0.055;
      this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.58);
      this.spawnExplosion(_v2, true);
      this.audio.playExplosion(true);
    } else {
      this.audio.playHitConfirm();
      this.spawnHitSparks(_v2);
    }
  }

  private damagePlayer(dmg: number): void {
    if (this.pendingDefeat || this.phase !== 'playing') return;
    this.playerHp = Math.max(0, this.playerHp - dmg);
    this.damageFlashTimer = 0.28;
    this.cameraTrauma = Math.min(1, this.cameraTrauma + 0.52);
    this.audio.playPlayerHit();
    if (this.playerHp <= 0) {
      this.triggerPlayerDefeat('combat');
    }
  }

  private checkSurfaceCapsuleHit(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    su: SurfaceUnit,
    extraRadius: number,
  ): boolean {
    if (su.capsuleHalfLength > 0) {
      const sinH = Math.sin(su.headingRad);
      const cosH = Math.cos(su.headingRad);
      _capA.set(
        su.position.x - sinH * su.capsuleHalfLength,
        su.position.y + 6,
        su.position.z - cosH * su.capsuleHalfLength,
      );
      _capB.set(
        su.position.x + sinH * su.capsuleHalfLength,
        su.position.y + 6,
        su.position.z + cosH * su.capsuleHalfLength,
      );
      return segmentCapsuleIntersect(p0, p1, _capA, _capB, su.hitRadius + extraRadius);
    }
    _capA.set(su.position.x, su.position.y + 5, su.position.z);
    return segmentSphereIntersect(p0, p1, _capA, su.hitRadius + extraRadius);
  }

  private updateBullets(dt: number): void {
    let anyChange = false;
    for (let i = 0; i < BULLET_POOL_SIZE; i++) {
      const b = this.bullets[i];
      if (!b.active) continue;
      anyChange = true;

      b.prevPos.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;

      let hit = false;
      if (b.fromPlayer) {
        // 1. Swept CCD against enemy aircraft
        for (let e = 0; e < this.enemies.length; e++) {
          const u = this.enemies[e].unit;
          if (!u.alive || u.dying) continue;
          if (segmentSphereIntersect(b.prevPos, b.pos, u.position, u.hitRadius)) {
            this.damageEnemy(u, b.damage, false);
            hit = true;
            break;
          }
        }
        // 2. Swept CCD against SAM sites & Naval Warships (capsule for ships, sphere for SAM)
        if (!hit) {
          for (let s = 0; s < this.surfaceUnits.length; s++) {
            const su = this.surfaceUnits[s].unit;
            if (!su.alive) continue;
            if (this.checkSurfaceCapsuleHit(b.prevPos, b.pos, su, 0)) {
              this.damageSurfaceUnit(su, b.damage, false);
              hit = true;
              break;
            }
          }
        }
      } else {
        if (segmentSphereIntersect(b.prevPos, b.pos, this.flight.position, 5.5)) {
          this.damagePlayer(b.damage);
          hit = true;
        }
      }

      // 3. Swept terrain & ocean impact check (zero tunneling through ridges)
      if (!hit && segmentTerrainImpact(b.prevPos, b.pos, getTerrainHeight, 3)) {
        hit = true;
      }

      if (hit || b.life <= 0) {
        b.active = false;
        this.bulletMesh.setMatrixAt(i, _zeroMat);
      } else {
        _v1.copy(b.vel).normalize();
        _quat.setFromUnitVectors(_unitZ, _v1);
        _dummy.position.copy(b.pos);
        _dummy.quaternion.copy(_quat);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        this.bulletMesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (anyChange) this.bulletMesh.instanceMatrix.needsUpdate = true;
  }

  private updateMissiles(dt: number): boolean {
    let anyChange = false;
    let incomingWarning = false;

    for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
      const m = this.missiles[i];
      if (!m.active) continue;
      anyChange = true;

      m.life -= dt;
      m.prevPos.copy(m.pos);

      // True Proportional Navigation guidance with realistic G-limits & flare spoofing
      if (m.fromPlayer) {
        const spoofFlare = m.decoyFlareIndex >= 0 ? this.flares[m.decoyFlareIndex] : null;
        if (spoofFlare && spoofFlare.active) {
          stepProportionalNavigation(
            m.pos,
            m.vel,
            spoofFlare.pos,
            spoofFlare.vel,
            m.speed,
            m.maxLateralAccel,
            4.0,
            dt,
          );
          if (segmentSphereIntersect(m.prevPos, m.pos, spoofFlare.pos, 16)) {
            this.spawnExplosion(m.pos, false);
            m.active = false;
            this.missileMesh.setMatrixAt(i, _zeroMat);
            this.missileGlowMesh.setMatrixAt(i, _zeroMat);
            continue;
          }
        } else if (m.targetId !== null) {
          // Track either locked enemy aircraft OR locked SAM/Warship
          let targetPos: THREE.Vector3 | null = null;
          let targetVel: THREE.Vector3 | null = null;
          for (let e = 0; e < this.enemies.length; e++) {
            const u = this.enemies[e].unit;
            if (u.id === m.targetId && u.alive && !u.dying) {
              targetPos = u.position;
              targetVel = u.velocity;
              break;
            }
          }
          if (!targetPos) {
            for (let s = 0; s < this.surfaceUnits.length; s++) {
              const su = this.surfaceUnits[s].unit;
              if (su.id === m.targetId && su.alive) {
                _v3.set(su.position.x, su.position.y + 6, su.position.z);
                targetPos = _v3;
                targetVel = su.velocity;
                break;
              }
            }
          }
          if (targetPos && targetVel) {
            stepProportionalNavigation(
              m.pos,
              m.vel,
              targetPos,
              targetVel,
              m.speed,
              m.maxLateralAccel,
              4.2,
              dt,
            );
          }
        }
      } else {
        // Incoming Enemy / SAM / Warship missile: tracks active decoy flare if spoofed, else PN tracks player
        const flare = m.decoyFlareIndex >= 0 ? this.flares[m.decoyFlareIndex] : null;
        if (flare && flare.active) {
          stepProportionalNavigation(
            m.pos,
            m.vel,
            flare.pos,
            flare.vel,
            m.speed,
            210,
            4.0,
            dt,
          );
          if (segmentSphereIntersect(m.prevPos, m.pos, flare.pos, 16)) {
            this.spawnExplosion(m.pos, false);
            m.active = false;
            this.missileMesh.setMatrixAt(i, _zeroMat);
            this.missileGlowMesh.setMatrixAt(i, _zeroMat);
            continue;
          }
        } else {
          incomingWarning = true;
          stepProportionalNavigation(
            m.pos,
            m.vel,
            this.flight.position,
            this.flight.velocity,
            m.speed,
            m.maxLateralAccel,
            3.8,
            dt,
          );
        }
      }

      m.pos.addScaledVector(m.vel, dt);

      // High-contrast exhaust smoke & glowing flame plume trail
      m.smokeTimer -= dt;
      if (m.smokeTimer <= 0) {
        m.smokeTimer = m.fromPlayer ? 0.032 : 0.022;
        _v1.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4);
        if (m.fromPlayer) {
          this.spawnParticle(m.pos, _v1, 0.55, 0.95, 3.2, 0xe8edf2);
        } else {
          // Vivid red-orange glowing streak behind incoming enemy/SAM missiles
          this.spawnParticle(
            m.pos,
            _v1,
            0.68,
            1.45,
            4.2,
            Math.random() < 0.55 ? 0xff3b24 : 0xff9b38,
          );
        }
      }

      // Swept CCD Proximity-Fuse Detonation (8m-12m blast envelope) & Swept Terrain Impact
      let detonated = false;
      const diffDamageScale = DIFFICULTY_PROFILES[this.difficulty].enemyDamageScale;

      if (m.fromPlayer && m.decoyFlareIndex === -1) {
        // 1. Check airborne enemies with swept CCD + proximity fuse
        for (let e = 0; e < this.enemies.length; e++) {
          const u = this.enemies[e].unit;
          if (!u.alive || u.dying) continue;
          const proxRadius = u.hitRadius + PROXIMITY_FUSE_EXTRA_M;
          const distSq = segmentSphereDistanceSq(m.prevPos, m.pos, u.position);
          if (distSq <= proxRadius * proxRadius) {
            const dist = Math.sqrt(distSq);
            const blastFactor = dist <= u.hitRadius + 3 ? 1.0 : 0.78;
            this.damageEnemy(u, Math.round(115 * blastFactor), true);
            detonated = true;
            break;
          }
        }
        // 2. Check SAM batteries & Naval Warships with swept CCD + proximity fuse
        if (!detonated) {
          for (let s = 0; s < this.surfaceUnits.length; s++) {
            const su = this.surfaceUnits[s].unit;
            if (!su.alive) continue;
            if (this.checkSurfaceCapsuleHit(m.prevPos, m.pos, su, PROXIMITY_FUSE_EXTRA_M)) {
              this.damageSurfaceUnit(su, 125, true);
              detonated = true;
              break;
            }
          }
        }
      } else if (!m.fromPlayer && m.decoyFlareIndex === -1) {
        // Swept CCD proximity fuse against player jet (direct hit vs near-miss blast falloff)
        const proxRadius = 11.5;
        const distSq = segmentSphereDistanceSq(m.prevPos, m.pos, this.flight.position);
        if (distSq <= proxRadius * proxRadius) {
          const dist = Math.sqrt(distSq);
          const blastScale = dist <= 6 ? 1.0 : 0.72;
          this.damagePlayer(Math.round(32 * diffDamageScale * blastScale));
          this.spawnExplosion(m.pos, true);
          this.audio.playExplosion(true);
          detonated = true;
        }
      }

      // Swept terrain & water impact check (missiles explode cleanly on ridges or ocean)
      if (!detonated && segmentTerrainImpact(m.prevPos, m.pos, getTerrainHeight, 4)) {
        detonated = true;
        this.spawnExplosion(m.pos, false);
        this.audio.playExplosion(false);
      }

      if (detonated || m.life <= 0) {
        m.active = false;
        this.missileMesh.setMatrixAt(i, _zeroMat);
        this.missileGlowMesh.setMatrixAt(i, _zeroMat);
      } else {
        _v1.copy(m.vel).normalize();
        _quat.setFromUnitVectors(_unitZ, _v1);
        _dummy.position.copy(m.pos);
        _dummy.quaternion.copy(_quat);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        this.missileMesh.setMatrixAt(i, _dummy.matrix);

        // Pulsing glowing rocket exhaust flare trailing the missile tail
        const glowPulse = m.fromPlayer
          ? 0.9 + Math.sin(this.elapsedTime * 35 + i) * 0.25
          : 2.15 + Math.sin(this.elapsedTime * 48 + i) * 0.55;
        _dummy.position.copy(m.pos).addScaledVector(_v1, -2.5);
        _dummy.rotation.set(this.elapsedTime * 9, this.elapsedTime * 7, 0);
        _dummy.scale.setScalar(glowPulse);
        _dummy.updateMatrix();
        this.missileGlowMesh.setMatrixAt(i, _dummy.matrix);
      }
    }

    if (anyChange) {
      this.missileMesh.instanceMatrix.needsUpdate = true;
      this.missileGlowMesh.instanceMatrix.needsUpdate = true;
    }
    return incomingWarning;
  }

  private updateFlares(dt: number): void {
    let anyChange = false;
    for (let i = 0; i < FLARE_POOL_SIZE; i++) {
      const f = this.flares[i];
      if (!f.active) continue;
      anyChange = true;
      f.life -= dt;
      f.vel.y -= 18 * dt;
      f.vel.multiplyScalar(1 - 0.85 * dt);
      f.pos.addScaledVector(f.vel, dt);

      f.smokeTimer -= dt;
      if (f.smokeTimer <= 0) {
        f.smokeTimer = 0.045;
        _v1.set(0, 3, 0);
        this.spawnParticle(f.pos, _v1, 0.45, 0.75, 2.4, 0xffe49c);
      }

      if (f.life <= 0 || f.pos.y <= 0) {
        f.active = false;
        this.flareMesh.setMatrixAt(i, _zeroMat);
      } else {
        const s = 0.75 + 0.4 * (f.life / f.maxLife);
        _dummy.position.copy(f.pos);
        _dummy.rotation.set(this.elapsedTime * 5, this.elapsedTime * 4, 0);
        _dummy.scale.setScalar(s);
        _dummy.updateMatrix();
        this.flareMesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (anyChange) this.flareMesh.instanceMatrix.needsUpdate = true;
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
        p.vel.multiplyScalar(1 - 1.4 * dt);
        const progress = 1 - p.life / p.maxLife;
        const scale = THREE.MathUtils.lerp(p.startScale, p.endScale, progress);
        _dummy.position.copy(p.pos);
        _dummy.rotation.set(progress * 2.2, progress * 1.8, 0);
        _dummy.scale.setScalar(Math.max(0.05, scale));
        _dummy.updateMatrix();
        this.particleMesh.setMatrixAt(i, _dummy.matrix);
      }
    }
    if (anyChange) this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  private updateCamera(dt: number): void {
    // Smooth exponential damped chase camera with dynamic FOV boost & trauma shake
    _forward.set(0, 0, -1).applyQuaternion(this.flight.quaternion).normalize();
    _up.set(0, 1, 0).applyQuaternion(this.flight.quaternion).normalize();
    _right.set(1, 0, 0).applyQuaternion(this.flight.quaternion).normalize();

    const chaseDist = this.flight.afterburnerActive ? 24.5 : 21.5;
    const chaseHeight = 6.2;

    _camGoal
      .copy(this.flight.position)
      .addScaledVector(_forward, -chaseDist)
      .addScaledVector(_up, chaseHeight);

    // Prevent camera from dipping below ocean/terrain
    const camGround = Math.max(2, getTerrainHeight(_camGoal.x, _camGoal.z) + 5);
    if (_camGoal.y < camGround) _camGoal.y = camGround;

    const posAlpha = 1 - Math.exp(-9.5 * dt);
    this.camPos.lerp(_camGoal, posAlpha);

    _lookGoal.copy(this.flight.position).addScaledVector(_forward, 68);
    const lookAlpha = 1 - Math.exp(-14 * dt);
    this.camLook.lerp(_lookGoal, lookAlpha);

    // Apply decaying trauma^2 camera shake
    const shake = this.cameraTrauma * this.cameraTrauma;
    this.camera.position.copy(this.camPos);
    if (shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * shake * 4.2;
      this.camera.position.y += (Math.random() - 0.5) * shake * 4.2;
      this.camera.position.z += (Math.random() - 0.5) * shake * 2.6;
    }

    // Subtle camera horizon banking blend (keeps horizon readable while feeling dynamic)
    _v3.set(0, 1, 0).lerp(_up, 0.34).normalize();
    this.camera.up.copy(_v3);
    this.camera.lookAt(this.camLook);

    // Dynamic FOV widening during afterburner boost
    const targetFov = this.flight.afterburnerActive ? 78 : 64 + Math.max(0, (this.flight.speed - 125) * 0.08);
    const nextFov = THREE.MathUtils.damp(this.camera.fov, targetFov, 6.5, dt);
    if (Math.abs(nextFov - this.camera.fov) > 0.05) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private emitHudSnapshot(
    gpwsWarning = false,
    aglM = 225,
    missileLockWarning = false,
    missileIncomingWarning = false,
    samLockWarning = false,
  ): void {
    _forward.set(0, 0, -1).applyQuaternion(this.flight.quaternion).normalize();
    _right.set(1, 0, 0).applyQuaternion(this.flight.quaternion).normalize();
    _up.set(0, 1, 0).applyQuaternion(this.flight.quaternion).normalize();

    let headingDeg = (Math.atan2(_forward.x, -_forward.z) * 180) / Math.PI;
    if (headingDeg < 0) headingDeg += 360;
    const pitchDeg = Math.asin(THREE.MathUtils.clamp(_forward.y, -1, 1)) * (180 / Math.PI);
    const rollDeg = Math.atan2(_right.y, _up.y) * (180 / Math.PI);

    const radarBlips: RadarBlip[] = [];
    const targets: ProjectedTarget[] = [];
    const incomingMissiles: ProjectedIncomingMissile[] = [];

    const fwdFlatLen = Math.hypot(_forward.x, _forward.z) || 1;
    const fx = _forward.x / fwdFlatLen;
    const fz = _forward.z / fwdFlatLen;
    const rx = -fz;
    const rz = fx;

    const bulletSpeed = PLAYER_BULLET_SPEED + this.flight.speed * 0.35;

    const isAirObjective =
      this.jetSubMode === 'strike' && this.currentStrikeMission?.objectiveKind === 'air';
    let primaryObjectiveRemaining = 0;
    let nearestPrimaryDist = Infinity;

    let aliveAirCount = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const u = this.enemies[i].unit;
      if (!u.alive || u.dying) continue;
      aliveAirCount++;

      const dx = u.position.x - this.flight.position.x;
      const dz = u.position.z - this.flight.position.z;
      const dist = u.position.distanceTo(this.flight.position);
      if (isAirObjective) {
        primaryObjectiveRemaining++;
        if (dist < nearestPrimaryDist) nearestPrimaryDist = dist;
      }

      const relRight = (dx * rx + dz * rz) / RADAR_RANGE;
      const relFwd = (dx * fx + dz * fz) / RADAR_RANGE;
      const radLen = Math.hypot(relRight, relFwd);
      const clampScale = radLen > 0.94 ? 0.94 / radLen : 1;

      const isLocked = this.lockTargetId === u.id && this.lockProgress >= 1;
      radarBlips.push({
        id: u.id,
        x: relRight * clampScale,
        y: relFwd * clampScale,
        type: u.archetype === 'ace' ? 'ace' : 'enemy',
        isLocked,
        isPrimaryObjective: isAirObjective,
      });

      _proj.copy(u.position).project(this.camera);
      const inFront = _proj.z >= -1 && _proj.z <= 1;
      const sx = (_proj.x + 1) * 0.5;
      const sy = (1 - _proj.y) * 0.5;
      const onScreen = inFront && sx >= 0.04 && sx <= 0.96 && sy >= 0.06 && sy <= 0.94;

      let leadX = sx;
      let leadY = sy;
      let leadVisible = false;
      if (inFront && dist < 1150) {
        computeLeadPosition(
          this.flight.position,
          u.position,
          u.velocity,
          bulletSpeed,
          _leadPos,
        );
        _proj.set(_leadPos.x, _leadPos.y, _leadPos.z).project(this.camera);
        if (_proj.z >= -1 && _proj.z <= 1) {
          leadX = (_proj.x + 1) * 0.5;
          leadY = (1 - _proj.y) * 0.5;
          leadVisible = leadX >= 0.02 && leadX <= 0.98 && leadY >= 0.02 && leadY <= 0.98;
        }
      }

      targets.push({
        id: u.id,
        archetype: u.archetype,
        category: 'air',
        nameFa: u.nameFa,
        screenX: sx,
        screenY: sy,
        inFront,
        onScreen,
        distance: Math.round(dist),
        hpRatio: Math.max(0, u.hp / u.maxHp),
        isLockCandidate: this.lockTargetId === u.id,
        isLocked,
        lockProgress: this.lockTargetId === u.id ? this.lockProgress : 0,
        leadX,
        leadY,
        leadVisible,
        isPrimaryObjective: isAirObjective,
      });
    }

    // Project Ground SAM Sites, Command Bunkers & Naval Warships onto Radar & 3D HUD
    let aliveSurfaceCount = 0;
    for (let i = 0; i < this.surfaceUnits.length; i++) {
      const su = this.surfaceUnits[i].unit;
      if (!su.alive) continue;
      aliveSurfaceCount++;

      const dx = su.position.x - this.flight.position.x;
      const dz = su.position.z - this.flight.position.z;
      _v1.set(su.position.x, su.position.y + 8, su.position.z);
      const dist = _v1.distanceTo(this.flight.position);
      const isPrimary = Boolean(su.isPrimaryObjective);
      if (isPrimary) {
        primaryObjectiveRemaining++;
        if (dist < nearestPrimaryDist) nearestPrimaryDist = dist;
      }

      const relRight = (dx * rx + dz * rz) / RADAR_RANGE;
      const relFwd = (dx * fx + dz * fz) / RADAR_RANGE;
      const radLen = Math.hypot(relRight, relFwd);
      const clampScale = radLen > 0.94 ? 0.94 / radLen : 1;

      const isLocked = this.lockTargetId === su.id && this.lockProgress >= 1;
      radarBlips.push({
        id: su.id,
        x: relRight * clampScale,
        y: relFwd * clampScale,
        type: su.type,
        isLocked,
        isPrimaryObjective: isPrimary,
      });

      _proj.copy(_v1).project(this.camera);
      const inFront = _proj.z >= -1 && _proj.z <= 1;
      const sx = (_proj.x + 1) * 0.5;
      const sy = (1 - _proj.y) * 0.5;
      const onScreen = inFront && sx >= 0.04 && sx <= 0.96 && sy >= 0.06 && sy <= 0.94;

      // Always project primary Strike Mission objectives so player can navigate to them from any range
      if (onScreen || dist < 1550 || isLocked || isPrimary) {
        targets.push({
          id: su.id,
          archetype: su.type,
          category: su.type,
          nameFa: su.nameFa,
          screenX: sx,
          screenY: sy,
          inFront,
          onScreen,
          distance: Math.round(dist),
          hpRatio: Math.max(0, su.hp / su.maxHp),
          isLockCandidate: this.lockTargetId === su.id,
          isLocked,
          lockProgress: this.lockTargetId === su.id ? this.lockProgress : 0,
          leadX: sx,
          leadY: sy,
          leadVisible: false,
          isPrimaryObjective: isPrimary,
        });
      }
    }

    const strikeObjective: StrikeObjectiveInfo | null =
      this.jetSubMode === 'strike' && this.currentStrikeMission
        ? {
            wave: this.wave,
            titleFa: this.currentStrikeMission.objectiveTitleFa,
            targetLabelFa: this.currentStrikeMission.targetLabelFa,
            remaining: primaryObjectiveRemaining,
            total: Math.max(1, this.strikeObjectiveTotal),
            distanceM: Number.isFinite(nearestPrimaryDist)
              ? Math.round(nearestPrimaryDist)
              : null,
          }
        : null;

    // Add incoming enemy/SAM/warship missiles to Radar AND 3D HUD Missile Trackers
    for (let i = 0; i < MISSILE_POOL_SIZE; i++) {
      const m = this.missiles[i];
      if (!m.active || m.fromPlayer) continue;
      const dx = m.pos.x - this.flight.position.x;
      const dz = m.pos.z - this.flight.position.z;
      const dist = m.pos.distanceTo(this.flight.position);
      const relRight = (dx * rx + dz * rz) / RADAR_RANGE;
      const relFwd = (dx * fx + dz * fz) / RADAR_RANGE;
      const radLen = Math.hypot(relRight, relFwd);
      const clampScale = radLen > 0.94 ? 0.94 / radLen : 1;
      radarBlips.push({
        id: 10000 + i,
        x: relRight * clampScale,
        y: relFwd * clampScale,
        type: 'missile',
        isLocked: false,
      });

      if (m.decoyFlareIndex === -1) {
        _proj.copy(m.pos).project(this.camera);
        const inFront = _proj.z >= -1 && _proj.z <= 1;
        const sx = (_proj.x + 1) * 0.5;
        const sy = (1 - _proj.y) * 0.5;
        const onScreen = inFront && sx >= 0.04 && sx <= 0.96 && sy >= 0.06 && sy <= 0.94;
        incomingMissiles.push({
          id: 20000 + i,
          screenX: sx,
          screenY: sy,
          inFront,
          onScreen,
          distance: Math.round(dist),
          sourceLabelFa: m.sourceLabelFa,
        });
      }
    }

    const diffProfile = DIFFICULTY_PROFILES[this.difficulty];
    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      jetSubMode: this.jetSubMode,
      strikeObjective,
      speedKmh: Math.round(this.flight.speed * 3.6),
      altitudeM: Math.max(0, Math.round(this.flight.position.y)),
      aglM: Math.round(aglM),
      headingDeg: Math.round(headingDeg) % 360,
      pitchDeg: Math.round(pitchDeg),
      rollDeg: Math.round(rollDeg),
      hp: Math.round(this.playerHp),
      maxHp: this.playerMaxHp,
      ghostHp: Math.round(this.ghostHp),
      score: this.score,
      highScore: this.highScore,
      kills: this.kills,
      wave: this.wave,
      enemiesRemaining: aliveAirCount,
      surfaceThreatsRemaining: aliveSurfaceCount,
      afterburnerHeat: Math.round(this.flight.afterburnerHeat),
      afterburnerOverheated: this.flight.afterburnerOverheated,
      afterburnerActive: this.flight.afterburnerActive,
      missilesReady: this.missilesReady,
      missilesMax: this.missilesMax,
      missileReloadProgress: Math.min(1, this.missileReloadTimer / diffProfile.missileReloadSec),
      flaresReady: this.flaresReady,
      flaresMax: this.flaresMax,
      flareReloadProgress: Math.min(1, this.flareReloadTimer / diffProfile.flareReloadSec),
      lockTargetId: this.lockTargetId,
      lockProgress: this.lockProgress,
      isLocked: this.lockProgress >= 1,
      gpwsWarning,
      missileLockWarning,
      missileIncomingWarning,
      samLockWarning,
      samMaskNoticeTimer: this.samMaskNoticeTimer,
      hitMarkerTimer: this.hitMarkerTimer,
      hitMarkerCritical: this.hitMarkerCritical,
      damageFlashTimer: this.damageFlashTimer,
      flareSuccessTimer: this.flareSuccessTimer,
      enemyFlareNoticeTimer: this.enemyFlareNoticeTimer,
      defeatReason: this.defeatReason,
      survivalTimeSec: Math.round(this.survivalTimeSec),
      waveBanner: this.waveBanner,
      killFeed: this.killFeed,
      radarBlips,
      targets,
      incomingMissiles,
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

    resetSharedMeshAssets();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
