import * as THREE from 'three';
import { DIFFICULTY_PROFILES } from './enemyAI';
import {
  getUrbanGroundHeight,
  hasCityLineOfSight,
  resolveCircleCityCollision,
  type CityLayout,
} from './tankCity';
import type {
  ArmorHitZone,
  CityAabb,
  DifficultyLevel,
  TankAIState,
  TankControlInput,
  TankEnemyArchetype,
  Vec3,
} from './types';

export const TANK_PHYSICS_CONFIG = {
  maxForwardSpeed: 21.5, // ~77 km/h combat dash
  maxReverseSpeed: 10.5,
  turboSpeedMultiplier: 1.52,
  accelRate: 28,
  brakeDecelRate: 38,
  dragRate: 14,
  hullTurnRate: 1.65, // rad/s
  turretTraverseRate: 2.35, // realistic heavy turret slewing speed (rad/s)
  hullRadius: 3.1,
  cannonReloadSec: 2.05,
  shellSpeed: 145,
  mgBulletSpeed: 225,
  atgmSpeed: 54,
};

export interface PlayerTankState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  speed: number; // signed forward speed
  hullYaw: number; // radians, 0 = facing -Z
  turretYaw: number; // world-space turret yaw radians, 0 = facing -Z
  barrelPitch: number; // radians
  pitchTilt: number; // suspension pitch feedback
  rollTilt: number; // suspension roll feedback
  recoilOffset: number; // 0..1 barrel recoil spring
  turboCharge: number; // 0..100
  turboActive: boolean;
  turboOverheated: boolean;
}

export interface EnemyTankUnit {
  id: number;
  archetype: TankEnemyArchetype;
  nameFa: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  hullYaw: number;
  turretYaw: number;
  recoilOffset: number;
  hp: number;
  maxHp: number;
  hitRadius: number;
  moveSpeed: number;
  turnRate: number;
  turretRate: number;
  scoreValue: number;
  state: TankAIState;
  stateTimer: number;
  waypointX: number;
  waypointZ: number;
  cannonCooldown: number;
  atgmCooldown: number;
  atgmLockProgress: number;
  smokeCharges: number;
  smokeActiveTimer: number;
  flankSide: number; // -1 or +1
  hitFlashTimer: number;
  dying: boolean;
  deathTimer: number;
  alive: boolean;
}

export interface EnemyTankActionEvents {
  firedShell: boolean;
  firedAtgm: boolean;
  deployedSmoke: boolean;
  lockingAtgm: boolean;
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
}

export interface TankWaveDef {
  wave: number;
  titleFa: string;
  subtitleFa: string;
  units: TankEnemyArchetype[];
}

export const TANK_ARCHETYPE_SPECS: Record<
  TankEnemyArchetype,
  {
    nameFa: string;
    maxHp: number;
    hitRadius: number;
    moveSpeed: number;
    turnRate: number;
    turretRate: number;
    cannonCooldown: number;
    hasAtgm: boolean;
    scoreValue: number;
  }
> = {
  buggy: {
    nameFa: 'خودرو شناسایی زرهی',
    maxHp: 68,
    hitRadius: 2.8,
    moveSpeed: 18.5,
    turnRate: 2.35,
    turretRate: 2.8,
    cannonCooldown: 1.55,
    hasAtgm: false,
    scoreValue: 220,
  },
  mbt: {
    nameFa: 'تانک نبرد اصلی',
    maxHp: 145,
    hitRadius: 3.45,
    moveSpeed: 12.8,
    turnRate: 1.45,
    turretRate: 1.85,
    cannonCooldown: 3.1,
    hasAtgm: true,
    scoreValue: 380,
  },
  siege: {
    nameFa: 'تانک محاصره سنگین (فرمانده)',
    maxHp: 280,
    hitRadius: 4.2,
    moveSpeed: 9.8,
    turnRate: 1.15,
    turretRate: 1.55,
    cannonCooldown: 2.75,
    hasAtgm: true,
    scoreValue: 760,
  },
};

export function normalizeAngle(a: number): number {
  let out = a;
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

export function createInitialTankState(spawn: { x: number; z: number; yaw: number }): PlayerTankState {
  return {
    x: spawn.x,
    y: getUrbanGroundHeight(spawn.x, spawn.z),
    z: spawn.z,
    vx: 0,
    vz: 0,
    speed: 0,
    hullYaw: spawn.yaw,
    turretYaw: spawn.yaw,
    barrelPitch: 0,
    pitchTilt: 0,
    rollTilt: 0,
    recoilOffset: 0,
    turboCharge: 100,
    turboActive: false,
    turboOverheated: false,
  };
}

// Reusable scratch struct for zero-allocation collision checks
const _colOut = { x: 0, z: 0, collided: false };
const _losA: Vec3 = { x: 0, y: 2.1, z: 0 };
const _losB: Vec3 = { x: 0, y: 2.1, z: 0 };

/**
 * Advances player tank hull kinematics: smooth forward/reverse gear, hull steering,
 * turbo surge with cooldown, suspension rubble tilt, and smooth sliding building collision.
 */
export function stepTankHullPhysics(
  state: PlayerTankState,
  input: TankControlInput,
  dt: number,
  aabbs: ReadonlyArray<CityAabb>,
): void {
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);

  // Turbo drive energy & overheat management
  if (input.boost && !state.turboOverheated && state.turboCharge > 4 && Math.abs(input.throttle) > 0.1) {
    state.turboActive = true;
    state.turboCharge = Math.max(0, state.turboCharge - 42 * clampedDt);
    if (state.turboCharge <= 0) {
      state.turboOverheated = true;
      state.turboActive = false;
    }
  } else {
    state.turboActive = false;
    state.turboCharge = Math.min(100, state.turboCharge + 22 * clampedDt);
    if (state.turboOverheated && state.turboCharge >= 35) {
      state.turboOverheated = false;
    }
  }

  // Hull steering (reverses steering direction naturally when backing up, supports neutral pivot turns)
  const steerDir = state.speed < -1.5 ? -1 : 1;
  const turnBoost = Math.abs(state.speed) < 2.5 ? 1.18 : 1.0;
  state.hullYaw = normalizeAngle(
    state.hullYaw - input.steer * TANK_PHYSICS_CONFIG.hullTurnRate * turnBoost * steerDir * clampedDt,
  );

  // Target speed & smooth acceleration / braking
  const maxFwd =
    TANK_PHYSICS_CONFIG.maxForwardSpeed *
    (state.turboActive ? TANK_PHYSICS_CONFIG.turboSpeedMultiplier : 1);
  const maxRev = TANK_PHYSICS_CONFIG.maxReverseSpeed;

  if (input.throttle > 0.04) {
    const accel = state.speed < 0 ? TANK_PHYSICS_CONFIG.brakeDecelRate : TANK_PHYSICS_CONFIG.accelRate * (state.turboActive ? 1.45 : 1);
    state.speed = Math.min(maxFwd * input.throttle, state.speed + accel * clampedDt);
  } else if (input.throttle < -0.04) {
    const accel = state.speed > 0 ? TANK_PHYSICS_CONFIG.brakeDecelRate : TANK_PHYSICS_CONFIG.accelRate * 0.85;
    state.speed = Math.max(maxRev * input.throttle, state.speed - accel * clampedDt);
  } else {
    // Natural rolling track resistance
    if (state.speed > 0) {
      state.speed = Math.max(0, state.speed - TANK_PHYSICS_CONFIG.dragRate * clampedDt);
    } else if (state.speed < 0) {
      state.speed = Math.min(0, state.speed + TANK_PHYSICS_CONFIG.dragRate * clampedDt);
    }
  }

  const fwdX = -Math.sin(state.hullYaw);
  const fwdZ = -Math.cos(state.hullYaw);
  const nextX = state.x + fwdX * state.speed * clampedDt;
  const nextZ = state.z + fwdZ * state.speed * clampedDt;

  resolveCircleCityCollision(nextX, nextZ, TANK_PHYSICS_CONFIG.hullRadius, aabbs, _colOut);
  if (clampedDt > 1e-4) {
    state.vx = (_colOut.x - state.x) / clampedDt;
    state.vz = (_colOut.z - state.z) / clampedDt;
  }
  state.x = _colOut.x;
  state.z = _colOut.z;
  state.y = getUrbanGroundHeight(state.x, state.z);

  // Subtle suspension pitch & roll feedback from urban rubble bumps + acceleration squat
  const hFront = getUrbanGroundHeight(state.x + fwdX * 2.6, state.z + fwdZ * 2.6);
  const hBack = getUrbanGroundHeight(state.x - fwdX * 2.6, state.z - fwdZ * 2.6);
  const rightX = Math.cos(state.hullYaw);
  const rightZ = -Math.sin(state.hullYaw);
  const hRight = getUrbanGroundHeight(state.x + rightX * 1.8, state.z + rightZ * 1.8);
  const hLeft = getUrbanGroundHeight(state.x - rightX * 1.8, state.z - rightZ * 1.8);

  const accelSquat = input.throttle * 0.032 * (state.turboActive ? 1.5 : 1);
  const targetPitch = Math.atan2(hFront - hBack, 5.2) + accelSquat - state.recoilOffset * 0.055;
  const targetRoll = Math.atan2(hLeft - hRight, 3.6) + input.steer * (state.speed / maxFwd) * 0.055;
  const tiltAlpha = 1 - Math.exp(-9 * clampedDt);
  state.pitchTilt += (targetPitch - state.pitchTilt) * tiltAlpha;
  state.rollTilt += (targetRoll - state.rollTilt) * tiltAlpha;

  // Barrel recoil spring decay
  if (state.recoilOffset > 0) {
    state.recoilOffset = Math.max(0, state.recoilOffset - clampedDt * 2.8);
  }
}

/**
 * Independent turret traverse: slews turretYaw smoothly toward desired aim yaw at finite traverse rate.
 * Returns absolute angular error in radians (used for barrel alignment feedback).
 */
export function stepTurretAim(
  state: PlayerTankState,
  targetWorldYaw: number,
  targetPitch: number,
  dt: number,
): number {
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);
  const diff = normalizeAngle(targetWorldYaw - state.turretYaw);
  const maxStep = TANK_PHYSICS_CONFIG.turretTraverseRate * clampedDt;

  if (Math.abs(diff) <= maxStep) {
    state.turretYaw = normalizeAngle(targetWorldYaw);
  } else {
    state.turretYaw = normalizeAngle(state.turretYaw + Math.sign(diff) * maxStep);
  }

  const clampedPitch = Math.max(-0.14, Math.min(0.28, targetPitch));
  const pitchAlpha = 1 - Math.exp(-10 * clampedDt);
  state.barrelPitch += (clampedPitch - state.barrelPitch) * pitchAlpha;

  return Math.abs(normalizeAngle(targetWorldYaw - state.turretYaw));
}

/**
 * Directional Tank Armor Mechanics:
 * Compares the incoming projectile direction against the target hull's forward vector.
 * - Frontal arc: reduced damage (0.68x) — thick composite glacis deflects hits.
 * - Side flank: 1.35x critical flanking damage!
 * - Rear engine deck: 1.65x devastating critical flanking damage!
 */
export function computeDirectionalArmorHit(
  projectileDirXZ: { x: number; z: number },
  targetHullYaw: number,
  baseDamage: number,
): {
  damage: number;
  zone: ArmorHitZone;
  multiplier: number;
  isFlankCritical: boolean;
} {
  const len = Math.hypot(projectileDirXZ.x, projectileDirXZ.z) || 1;
  const incomingFromX = -projectileDirXZ.x / len;
  const incomingFromZ = -projectileDirXZ.z / len;

  // Target hull forward vector (-sin(yaw), -cos(yaw))
  const fwdX = -Math.sin(targetHullYaw);
  const fwdZ = -Math.cos(targetHullYaw);

  // dot > 0 means hit arrived from the front of the tank; dot < 0 means from behind!
  const dot = incomingFromX * fwdX + incomingFromZ * fwdZ;

  if (dot >= 0.48) {
    return {
      damage: Math.max(4, Math.round(baseDamage * 0.68)),
      zone: 'front',
      multiplier: 0.68,
      isFlankCritical: false,
    };
  }
  if (dot <= -0.45) {
    return {
      damage: Math.round(baseDamage * 1.65),
      zone: 'rear',
      multiplier: 1.65,
      isFlankCritical: true,
    };
  }
  return {
    damage: Math.round(baseDamage * 1.35),
    zone: 'side',
    multiplier: 1.35,
    isFlankCritical: true,
  };
}

/**
 * Escalating Armored Warfare Waves (endless progression).
 */
export function getTankWaveDefinition(wave: number): TankWaveDef {
  if (wave === 1) {
    return {
      wave: 1,
      titleFa: 'موج ۱ — گشت شناسایی زرهی',
      subtitleFa: 'خودروهای شناسایی و یک تانک دشمن وارد خیابان‌های شهر شدند',
      units: ['buggy', 'buggy', 'mbt'],
    };
  }
  if (wave === 2) {
    return {
      wave: 2,
      titleFa: 'موج ۲ — ستون تانک‌های تهاجمی',
      subtitleFa: 'تانک‌های نبرد اصلی در حال دور زدن و جناح‌گیری هستند',
      units: ['buggy', 'mbt', 'mbt', 'buggy'],
    };
  }
  if (wave === 3) {
    return {
      wave: 3,
      titleFa: 'موج ۳ — محاصره سنگین شهری',
      subtitleFa: 'هشدار! تانک محاصره سنگین (فرمانده) با موشک ضدتانک وارد منطقه شد',
      units: ['buggy', 'mbt', 'mbt', 'siege'],
    };
  }
  const units: TankEnemyArchetype[] = ['siege', 'mbt', 'mbt'];
  const extra = Math.min(4, wave - 2);
  for (let i = 0; i < extra; i++) {
    units.push(i % 2 === 0 ? 'buggy' : 'mbt');
  }
  return {
    wave,
    titleFa: `موج ${wave} — یورش تمام‌عیار زرهی`,
    subtitleFa: 'تیپ زرهی دشمن از چند محور شهری حمله می‌کند — از جناح ضربه بزنید!',
    units,
  };
}

export function createEnemyTankUnit(
  id: number,
  archetype: TankEnemyArchetype,
  spawnX: number,
  spawnZ: number,
  wave: number,
  difficulty: DifficultyLevel,
): EnemyTankUnit {
  const spec = TANK_ARCHETYPE_SPECS[archetype];
  const diff = DIFFICULTY_PROFILES[difficulty];
  const hpScale = 1 + Math.min(0.45, (wave - 1) * 0.08);
  const diffArmorScale =
    difficulty === 'easy' ? 0.85 : difficulty === 'hard' ? 1.18 : 1.0;
  const maxHp = Math.round(spec.maxHp * hpScale * diffArmorScale);

  return {
    id,
    archetype,
    nameFa: spec.nameFa,
    x: spawnX,
    y: getUrbanGroundHeight(spawnX, spawnZ),
    z: spawnZ,
    vx: 0,
    vz: 0,
    hullYaw: Math.atan2(-spawnX, -spawnZ),
    turretYaw: Math.atan2(-spawnX, -spawnZ),
    recoilOffset: 0,
    hp: maxHp,
    maxHp,
    hitRadius: spec.hitRadius,
    moveSpeed: spec.moveSpeed * diff.enemySpeedScale,
    turnRate: spec.turnRate,
    turretRate: spec.turretRate,
    scoreValue: spec.scoreValue,
    state: 'PATROL',
    stateTimer: 1.5,
    waypointX: spawnX,
    waypointZ: spawnZ,
    cannonCooldown: (1.8 + (id % 3) * 0.65) * diff.enemyFireCooldownScale,
    atgmCooldown: (7.5 + (id % 3) * 2.5) * diff.enemyFireCooldownScale,
    atgmLockProgress: 0,
    smokeCharges: archetype === 'buggy' ? 0 : 1,
    smokeActiveTimer: 0,
    flankSide: id % 2 === 0 ? 1 : -1,
    hitFlashTimer: 0,
    dying: false,
    deathTimer: 0,
    alive: true,
  };
}

function pickNearestFlankIntersection(
  unit: EnemyTankUnit,
  playerX: number,
  playerZ: number,
  layout: CityLayout,
  retreat: boolean,
): { x: number; z: number } {
  let bestX = layout.intersections[0].x;
  let bestZ = layout.intersections[0].z;
  let bestScore = -Infinity;

  const toPlayerX = playerX - unit.x;
  const toPlayerZ = playerZ - unit.z;
  const pLen = Math.hypot(toPlayerX, toPlayerZ) || 1;
  const flankDirX = (-toPlayerZ / pLen) * unit.flankSide;
  const flankDirZ = (toPlayerX / pLen) * unit.flankSide;

  for (let i = 0; i < layout.intersections.length; i++) {
    const inter = layout.intersections[i];
    const dPlayer = Math.hypot(inter.x - playerX, inter.z - playerZ);
    const dSelf = Math.hypot(inter.x - unit.x, inter.z - unit.z);
    if (dSelf < 14) continue;

    if (retreat) {
      // Maximize distance from player while preferring reachable nearby intersections
      const score = dPlayer - dSelf * 0.45;
      if (score > bestScore) {
        bestScore = score;
        bestX = inter.x;
        bestZ = inter.z;
      }
    } else {
      // Ideal tactical engagement ring (55m..110m) offset toward enemy's flank side
      const distPenalty = Math.abs(dPlayer - 78);
      const relX = (inter.x - playerX) / (dPlayer || 1);
      const relZ = (inter.z - playerZ) / (dPlayer || 1);
      const flankAlign = relX * flankDirX + relZ * flankDirZ;
      const score = flankAlign * 45 - distPenalty - dSelf * 0.28;
      if (score > bestScore) {
        bestScore = score;
        bestX = inter.x;
        bestZ = inter.z;
      }
    }
  }
  return { x: bestX, z: bestZ };
}

/**
 * Autonomous local Enemy Tank AI FSM:
 * - PATROL: navigates avenues toward combat sector.
 * - FLANK_AND_COVER: advances via street intersections to circle behind/beside the player using buildings as cover.
 * - ENGAGE: peeks into LOS, leads shots with main cannon, and locks/fires ATGMs (respecting attack token pool & player smoke).
 * - RETREAT_SMOKE: deploys defensive smoke and pulls back behind a corner when heavily damaged.
 */
export function updateEnemyTankAI(
  unit: EnemyTankUnit,
  player: PlayerTankState,
  playerSmokeActive: boolean,
  canAttack: boolean,
  dt: number,
  layout: CityLayout,
  difficulty: DifficultyLevel,
  outEvents: EnemyTankActionEvents,
): void {
  outEvents.firedShell = false;
  outEvents.firedAtgm = false;
  outEvents.deployedSmoke = false;
  outEvents.lockingAtgm = false;

  if (!unit.alive) return;
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);

  if (unit.hitFlashTimer > 0) unit.hitFlashTimer = Math.max(0, unit.hitFlashTimer - clampedDt);
  if (unit.recoilOffset > 0) unit.recoilOffset = Math.max(0, unit.recoilOffset - clampedDt * 2.5);
  if (unit.smokeActiveTimer > 0) unit.smokeActiveTimer = Math.max(0, unit.smokeActiveTimer - clampedDt);

  if (unit.dying) {
    unit.deathTimer -= clampedDt;
    if (unit.deathTimer <= 0) unit.alive = false;
    return;
  }

  const diff = DIFFICULTY_PROFILES[difficulty];
  const spec = TANK_ARCHETYPE_SPECS[unit.archetype];
  unit.cannonCooldown = Math.max(0, unit.cannonCooldown - clampedDt);
  unit.atgmCooldown = Math.max(0, unit.atgmCooldown - clampedDt);
  unit.stateTimer -= clampedDt;

  const dx = player.x - unit.x;
  const dz = player.z - unit.z;
  const distToPlayer = Math.hypot(dx, dz);

  _losA.x = unit.x;
  _losA.y = 2.0;
  _losA.z = unit.z;
  _losB.x = player.x;
  _losB.y = 1.9;
  _losB.z = player.z;
  const hasLos = !playerSmokeActive && distToPlayer < 165 && hasCityLineOfSight(_losA, _losB, layout.aabbs);

  // 1. State Transitions
  if (unit.hp / unit.maxHp < 0.36 && unit.smokeCharges > 0) {
    unit.smokeCharges--;
    unit.smokeActiveTimer = 4.2;
    unit.state = 'RETREAT_SMOKE';
    unit.stateTimer = 4.5;
    outEvents.deployedSmoke = true;
    const retreatPt = pickNearestFlankIntersection(unit, player.x, player.z, layout, true);
    unit.waypointX = retreatPt.x;
    unit.waypointZ = retreatPt.z;
  } else if (unit.state === 'RETREAT_SMOKE') {
    if (unit.stateTimer <= 0) {
      unit.state = 'FLANK_AND_COVER';
      unit.stateTimer = 4.0;
    }
  } else if (hasLos && distToPlayer < 125 && canAttack) {
    if (unit.state !== 'ENGAGE') {
      unit.state = 'ENGAGE';
      unit.stateTimer = 3.2;
    }
  } else if (distToPlayer < 155) {
    if (unit.state !== 'FLANK_AND_COVER' || unit.stateTimer <= 0) {
      unit.state = 'FLANK_AND_COVER';
      unit.stateTimer = 3.4;
      const flankPt = pickNearestFlankIntersection(unit, player.x, player.z, layout, false);
      unit.waypointX = flankPt.x;
      unit.waypointZ = flankPt.z;
    }
  } else {
    if (unit.state !== 'PATROL' || unit.stateTimer <= 0) {
      unit.state = 'PATROL';
      unit.stateTimer = 3.5;
      const patrolPt = pickNearestFlankIntersection(unit, player.x, player.z, layout, false);
      unit.waypointX = patrolPt.x;
      unit.waypointZ = patrolPt.z;
    }
  }

  // 2. Movement & Street Steering
  let goalX = unit.waypointX;
  let goalZ = unit.waypointZ;
  let desiredSpeed = unit.moveSpeed;

  if (unit.state === 'ENGAGE') {
    // Strafe/flank gently around player or hold firing stance at optimal range
    if (unit.archetype === 'buggy') {
      const perpX = (-dz / (distToPlayer || 1)) * unit.flankSide;
      const perpZ = (dx / (distToPlayer || 1)) * unit.flankSide;
      goalX = unit.x + perpX * 26;
      goalZ = unit.z + perpZ * 26;
      desiredSpeed = unit.moveSpeed * 0.88;
    } else if (distToPlayer < 36) {
      // Back off slightly so enemies don't glue to the player hull
      goalX = unit.x - (dx / (distToPlayer || 1)) * 24;
      goalZ = unit.z - (dz / (distToPlayer || 1)) * 24;
      desiredSpeed = unit.moveSpeed * 0.55;
    } else if (distToPlayer > 88) {
      goalX = player.x;
      goalZ = player.z;
      desiredSpeed = unit.moveSpeed * 0.65;
    } else {
      // Angle hull slightly (~30 deg) while creeping for realistic armor angling
      desiredSpeed = unit.moveSpeed * 0.25;
      goalX = unit.x + (-dz / (distToPlayer || 1)) * unit.flankSide * 18;
      goalZ = unit.z + (dx / (distToPlayer || 1)) * unit.flankSide * 18;
    }
  } else if (unit.state === 'RETREAT_SMOKE') {
    desiredSpeed = unit.moveSpeed * 1.12;
  }

  const moveDx = goalX - unit.x;
  const moveDz = goalZ - unit.z;
  const moveDist = Math.hypot(moveDx, moveDz);

  if (moveDist > 4) {
    const targetHullYaw = Math.atan2(-moveDx, -moveDz);
    const hullDiff = normalizeAngle(targetHullYaw - unit.hullYaw);
    const maxHullStep = unit.turnRate * clampedDt;
    if (Math.abs(hullDiff) <= maxHullStep) {
      unit.hullYaw = targetHullYaw;
    } else {
      unit.hullYaw = normalizeAngle(unit.hullYaw + Math.sign(hullDiff) * maxHullStep);
    }

    const alignFactor = Math.max(0.15, Math.cos(hullDiff));
    const stepSpeed = desiredSpeed * alignFactor;
    const fx = -Math.sin(unit.hullYaw);
    const fz = -Math.cos(unit.hullYaw);

    const nx = unit.x + fx * stepSpeed * clampedDt;
    const nz = unit.z + fz * stepSpeed * clampedDt;
    resolveCircleCityCollision(nx, nz, unit.hitRadius, layout.aabbs, _colOut);
    if (clampedDt > 1e-4) {
      unit.vx = (_colOut.x - unit.x) / clampedDt;
      unit.vz = (_colOut.z - unit.z) / clampedDt;
    }
    unit.x = _colOut.x;
    unit.z = _colOut.z;
    unit.y = getUrbanGroundHeight(unit.x, unit.z);

    // If bumped into a corner during patrol/flank, pick a fresh flanking street intersection
    if (_colOut.collided && unit.state !== 'ENGAGE') {
      unit.flankSide *= -1;
      const alt = pickNearestFlankIntersection(unit, player.x, player.z, layout, unit.state === 'RETREAT_SMOKE');
      unit.waypointX = alt.x;
      unit.waypointZ = alt.z;
    }
  } else {
    unit.vx *= 0.85;
    unit.vz *= 0.85;
    if (unit.state === 'FLANK_AND_COVER' || unit.state === 'PATROL') {
      const nextPt = pickNearestFlankIntersection(unit, player.x, player.z, layout, false);
      unit.waypointX = nextPt.x;
      unit.waypointZ = nextPt.z;
    }
  }

  // 3. Turret Aim & Lead Calculation
  const leadTime = Math.min(1.1, distToPlayer / 95);
  const aimX = player.x + player.vx * leadTime * 0.65;
  const aimZ = player.z + player.vz * leadTime * 0.65;
  const desiredTurretYaw = hasLos ? Math.atan2(-(aimX - unit.x), -(aimZ - unit.z)) : unit.hullYaw;
  const turretDiff = normalizeAngle(desiredTurretYaw - unit.turretYaw);
  const maxTurretStep = unit.turretRate * clampedDt;
  if (Math.abs(turretDiff) <= maxTurretStep) {
    unit.turretYaw = desiredTurretYaw;
  } else {
    unit.turretYaw = normalizeAngle(unit.turretYaw + Math.sign(turretDiff) * maxTurretStep);
  }

  // 4. Weapons Fire (Main Cannon + Anti-Tank Guided Missile with lock telegraph)
  if (!hasLos || playerSmokeActive) {
    unit.atgmLockProgress = 0;
    return;
  }

  const tfx = -Math.sin(unit.turretYaw);
  const tfz = -Math.cos(unit.turretYaw);
  outEvents.originX = unit.x + tfx * (unit.hitRadius + 1.2);
  outEvents.originY = unit.y + 2.05;
  outEvents.originZ = unit.z + tfz * (unit.hitRadius + 1.2);

  // Main cannon shot when barrel aligned within ~10 degrees
  if (canAttack && unit.cannonCooldown <= 0 && Math.abs(turretDiff) < 0.18 && distToPlayer < 135) {
    unit.cannonCooldown = spec.cannonCooldown * diff.enemyFireCooldownScale;
    unit.recoilOffset = 1.0;
    // Slight intentional inaccuracy on easy/normal so casual players can dodge & duel fairly
    const spread = difficulty === 'easy' ? 0.055 : difficulty === 'normal' ? 0.03 : 0.014;
    const fireYaw = unit.turretYaw + (Math.random() - 0.5) * spread;
    outEvents.firedShell = true;
    outEvents.dirX = -Math.sin(fireYaw);
    outEvents.dirY = 0.015;
    outEvents.dirZ = -Math.cos(fireYaw);
  }

  // ATGM Lock & Launch (MBT & Heavy Siege Tank) with clear 2.4s warning telegraph
  if (spec.hasAtgm && canAttack && unit.atgmCooldown <= 0 && distToPlayer > 38 && distToPlayer < 148) {
    const lockDur = (unit.archetype === 'siege' ? 2.1 : 2.6) * diff.enemyFireCooldownScale;
    unit.atgmLockProgress = Math.min(1, unit.atgmLockProgress + clampedDt / lockDur);
    outEvents.lockingAtgm = unit.atgmLockProgress >= 0.18;
    if (unit.atgmLockProgress >= 1) {
      unit.atgmLockProgress = 0;
      unit.atgmCooldown = (unit.archetype === 'siege' ? 10.5 : 14.0) * diff.enemyFireCooldownScale;
      outEvents.firedAtgm = true;
      outEvents.dirX = tfx;
      outEvents.dirY = 0.14; // slight upward loft off launcher rail
      outEvents.dirZ = tfz;
    }
  } else {
    unit.atgmLockProgress = Math.max(0, unit.atgmLockProgress - clampedDt * 0.7);
  }
}
