import * as THREE from 'three';
import { DIFFICULTY_PROFILES } from './enemyAI';
import { getTerrainHeight } from './terrain';
import type { DifficultyLevel, SurfaceUnitType, Vec3 } from './types';

export interface SurfaceUnit {
  id: number;
  type: SurfaceUnitType;
  nameFa: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  headingRad: number;
  radarAngle: number;
  hp: number;
  maxHp: number;
  hitRadius: number;
  capsuleHalfLength: number; // > 0 for elongated naval destroyers
  scoreValue: number;
  lockProgress: number; // 0..1 radar lock on player
  missileCooldown: number;
  wasLockingPlayer: boolean;
  patrolCenterX: number;
  patrolCenterZ: number;
  patrolRadius: number;
  patrolAngle: number;
  patrolSpeed: number;
  hitFlashTimer: number;
  alive: boolean;
}

export interface SurfaceActionEvents {
  firedMissile: boolean;
  launchOrigin: THREE.Vector3;
  launchDir: THREE.Vector3;
  lockingPlayer: boolean;
  lockBrokenByTerrain: boolean;
}

interface SamPlacementSite {
  x: number;
  z: number;
}

interface WarshipPatrolZone {
  cx: number;
  cz: number;
  radius: number;
  startAngle: number;
}

// Strategic high-ground island ridges & valley overlooks around the combat archipelago
const SAM_SITES: ReadonlyArray<SamPlacementSite> = [
  { x: -355, z: -960 }, // West Ridge overlooking the Northern Gorge
  { x: 465, z: -1210 }, // Northeast Twin Peak Battery
  { x: -1120, z: -480 }, // Western Mountain Overlook
  { x: 1040, z: -380 }, // Eastern Volcanic Overlook
  { x: -720, z: 890 }, // Southwest Ridge
  { x: 820, z: 980 }, // Southeast Island Battery
];

// Open-ocean patrol circuits verified clear of island coastlines (360-degree deep water)
const WARSHIP_ZONES: ReadonlyArray<WarshipPatrolZone> = [
  { cx: 280, cz: -460, radius: 115, startAngle: 0.4 },
  { cx: -320, cz: 320, radius: 120, startAngle: 1.2 },
  { cx: 340, cz: 340, radius: 125, startAngle: 2.8 },
  { cx: -480, cz: -1580, radius: 130, startAngle: 0.9 },
];

export const SURFACE_SPECS: Record<
  SurfaceUnitType,
  {
    nameFa: string;
    maxHp: number;
    hitRadius: number;
    capsuleHalfLength: number;
    scoreValue: number;
    radarRange: number;
    lockDurationSec: number;
    missileCooldownSec: number;
  }
> = {
  sam: {
    nameFa: 'پدافند موشکی',
    maxHp: 110,
    hitRadius: 15,
    capsuleHalfLength: 0,
    scoreValue: 450,
    radarRange: 1450,
    lockDurationSec: 3.1,
    missileCooldownSec: 11.5,
  },
  warship: {
    nameFa: 'ناو جنگی',
    maxHp: 210,
    hitRadius: 18,
    capsuleHalfLength: 24,
    scoreValue: 650,
    radarRange: 1600,
    lockDurationSec: 3.4,
    missileCooldownSec: 12.5,
  },
};

/**
 * Evaluates whether a ground SAM site or naval destroyer has clear radar line-of-sight
 * to the player's jet. Samples terrain elevation along the 3D ray AND checks canyon/valley
 * masking so diving low inside mountain gorges breaks ground radar lock!
 */
export function hasTerrainLineOfSight(
  radarOrigin: Vec3,
  playerPos: Vec3,
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): boolean {
  const ox = radarOrigin.x;
  const oy = radarOrigin.y + 11; // radar mast elevation
  const oz = radarOrigin.z;
  const dx = playerPos.x - ox;
  const dy = playerPos.y - oy;
  const dz = playerPos.z - oz;
  const horizDist = Math.hypot(dx, dz);

  // 1. Direct terrain ridge ray occlusion (10 intermediate ray samples)
  const samples = 10;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const sx = ox + dx * t;
    const sy = oy + dy * t;
    const sz = oz + dz * t;
    const groundY = heightSampler(sx, sz);
    if (groundY > sy + 2.5) {
      return false;
    }
  }

  // 2. Canyon / Valley Terrain Masking:
  // If player is flying low (AGL < 95m) tucked below nearby flanking cliff ridges,
  // ground clutter & canyon walls mask the radar return!
  if (horizDist > 260) {
    const playerGround = heightSampler(playerPos.x, playerPos.z);
    const agl = playerPos.y - playerGround;
    if (agl < 95) {
      let maxNearbyRidge = playerGround;
      const probeDist = 175;
      const hN = heightSampler(playerPos.x, playerPos.z - probeDist);
      const hS = heightSampler(playerPos.x, playerPos.z + probeDist);
      const hE = heightSampler(playerPos.x + probeDist, playerPos.z);
      const hW = heightSampler(playerPos.x - probeDist, playerPos.z);
      if (hN > maxNearbyRidge) maxNearbyRidge = hN;
      if (hS > maxNearbyRidge) maxNearbyRidge = hS;
      if (hE > maxNearbyRidge) maxNearbyRidge = hE;
      if (hW > maxNearbyRidge) maxNearbyRidge = hW;

      // Masked if surrounded by canyon cliffs rising well above the jet
      if (maxNearbyRidge > playerPos.y + 16) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Finds an exact dry-land coordinate on or near a candidate SAM site using getTerrainHeight.
 */
function resolveSamPosition(
  site: SamPlacementSite,
  heightSampler: (x: number, z: number) => number,
): THREE.Vector3 {
  let bestX = site.x;
  let bestZ = site.z;
  let bestH = heightSampler(site.x, site.z);
  if (bestH < 18) {
    // Search nearby ring for elevated dry ridge
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const tx = site.x + Math.cos(ang) * 95;
      const tz = site.z + Math.sin(ang) * 95;
      const th = heightSampler(tx, tz);
      if (th > bestH) {
        bestH = th;
        bestX = tx;
        bestZ = tz;
      }
    }
  }
  return new THREE.Vector3(bestX, Math.max(12, bestH), bestZ);
}

/**
 * Resolves an open-ocean coordinate for a warship patrol zone (guarantees h === 0).
 */
function resolveOceanPoint(
  cx: number,
  cz: number,
  radius: number,
  angle: number,
  heightSampler: (x: number, z: number) => number,
): { x: number; z: number } {
  const x = cx + Math.cos(angle) * radius;
  const z = cz + Math.sin(angle) * radius;
  if (heightSampler(x, z) <= 0.1) {
    return { x, z };
  }
  return { x: cx, z: cz };
}

export function createSurfaceWaveUnits(
  wave: number,
  startId: number,
  difficulty: DifficultyLevel = 'normal',
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): SurfaceUnit[] {
  const units: SurfaceUnit[] = [];
  let nextId = startId;

  const samCount = Math.min(SAM_SITES.length, wave === 1 ? 2 : Math.min(4, 1 + wave));
  const warshipCount = Math.min(WARSHIP_ZONES.length, wave === 1 ? 1 : Math.min(3, Math.ceil(wave / 2)));

  const diff = DIFFICULTY_PROFILES[difficulty];
  const hpScale = 1 + Math.min(0.4, (wave - 1) * 0.08);

  for (let i = 0; i < samCount; i++) {
    const site = SAM_SITES[(i + (wave - 1)) % SAM_SITES.length];
    const pos = resolveSamPosition(site, heightSampler);
    const spec = SURFACE_SPECS.sam;
    const maxHp = Math.round(spec.maxHp * hpScale);
    units.push({
      id: nextId++,
      type: 'sam',
      nameFa: spec.nameFa,
      position: pos,
      velocity: new THREE.Vector3(0, 0, 0),
      headingRad: (i * 1.4) % (Math.PI * 2),
      radarAngle: i * 1.1,
      hp: maxHp,
      maxHp,
      hitRadius: spec.hitRadius,
      capsuleHalfLength: spec.capsuleHalfLength,
      scoreValue: spec.scoreValue,
      lockProgress: 0,
      missileCooldown: (5.5 + i * 2.4) * diff.enemyFireCooldownScale,
      wasLockingPlayer: false,
      patrolCenterX: pos.x,
      patrolCenterZ: pos.z,
      patrolRadius: 0,
      patrolAngle: 0,
      patrolSpeed: 0,
      hitFlashTimer: 0,
      alive: true,
    });
  }

  for (let i = 0; i < warshipCount; i++) {
    const zone = WARSHIP_ZONES[(i + (wave - 1)) % WARSHIP_ZONES.length];
    const spec = SURFACE_SPECS.warship;
    const pt = resolveOceanPoint(zone.cx, zone.cz, zone.radius, zone.startAngle, heightSampler);
    const maxHp = Math.round(spec.maxHp * hpScale);
    units.push({
      id: nextId++,
      type: 'warship',
      nameFa: spec.nameFa,
      position: new THREE.Vector3(pt.x, 0, pt.z),
      velocity: new THREE.Vector3(0, 0, 0),
      headingRad: zone.startAngle + Math.PI * 0.5,
      radarAngle: i * 0.8,
      hp: maxHp,
      maxHp,
      hitRadius: spec.hitRadius,
      capsuleHalfLength: spec.capsuleHalfLength,
      scoreValue: spec.scoreValue,
      lockProgress: 0,
      missileCooldown: (7.5 + i * 2.8) * diff.enemyFireCooldownScale,
      wasLockingPlayer: false,
      patrolCenterX: zone.cx,
      patrolCenterZ: zone.cz,
      patrolRadius: zone.radius,
      patrolAngle: zone.startAngle,
      patrolSpeed: 12, // ~43 km/h naval destroyer cruise
      hitFlashTimer: 0,
      alive: true,
    });
  }

  return units;
}

/**
 * Updates a single SAM battery or Naval Warship (zero allocations inside loop).
 * Handles warship ocean patrolling, rotating radar dish, terrain-masked radar lock-on,
 * and surface-to-air missile launches.
 */
export function updateSurfaceUnit(
  unit: SurfaceUnit,
  playerPos: THREE.Vector3,
  dt: number,
  outEvents: SurfaceActionEvents,
  difficulty: DifficultyLevel = 'normal',
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): void {
  outEvents.firedMissile = false;
  outEvents.lockingPlayer = false;
  outEvents.lockBrokenByTerrain = false;

  if (!unit.alive) return;
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);

  if (unit.hitFlashTimer > 0) {
    unit.hitFlashTimer = Math.max(0, unit.hitFlashTimer - clampedDt);
  }

  unit.radarAngle = (unit.radarAngle + clampedDt * (unit.type === 'sam' ? 2.4 : 1.7)) % (Math.PI * 2);
  unit.missileCooldown = Math.max(0, unit.missileCooldown - clampedDt);

  // Naval warship smooth circular ocean patrol (avoiding land)
  if (unit.type === 'warship' && unit.patrolRadius > 0) {
    const angularSpeed = unit.patrolSpeed / unit.patrolRadius;
    const nextAngle = unit.patrolAngle + angularSpeed * clampedDt;
    const nx = unit.patrolCenterX + Math.cos(nextAngle) * unit.patrolRadius;
    const nz = unit.patrolCenterZ + Math.sin(nextAngle) * unit.patrolRadius;
    if (heightSampler(nx, nz) <= 0.1) {
      const prevX = unit.position.x;
      const prevZ = unit.position.z;
      unit.patrolAngle = nextAngle;
      unit.position.set(nx, 0, nz);
      if (clampedDt > 1e-4) {
        unit.velocity.set((nx - prevX) / clampedDt, 0, (nz - prevZ) / clampedDt);
      }
      unit.headingRad = Math.atan2(nx - prevX, nz - prevZ);
    } else {
      // Reverse patrol direction gracefully if touching shoal
      unit.patrolSpeed = -unit.patrolSpeed;
      unit.velocity.set(0, 0, 0);
    }
  }

  const spec = SURFACE_SPECS[unit.type];
  const diff = DIFFICULTY_PROFILES[difficulty];
  const dx = playerPos.x - unit.position.x;
  const dy = playerPos.y - unit.position.y;
  const dz = playerPos.z - unit.position.z;
  const dist = Math.hypot(dx, dy, dz);

  if (dist > spec.radarRange || dist < 130) {
    unit.lockProgress = Math.max(0, unit.lockProgress - clampedDt * 0.8);
    unit.wasLockingPlayer = false;
    return;
  }

  // Terrain Line-of-Sight & Canyon Masking check!
  const hasLos = hasTerrainLineOfSight(unit.position, playerPos, heightSampler);
  if (!hasLos) {
    if (unit.wasLockingPlayer && unit.lockProgress >= 0.25) {
      outEvents.lockBrokenByTerrain = true;
    }
    unit.lockProgress = 0;
    unit.wasLockingPlayer = false;
    return;
  }

  // Acquire radar lock and launch surface-to-air missile when cooldown ready
  if (unit.missileCooldown <= 0) {
    const lockDur = spec.lockDurationSec * diff.enemyFireCooldownScale;
    unit.lockProgress = Math.min(1, unit.lockProgress + clampedDt / lockDur);
    unit.wasLockingPlayer = true;
    outEvents.lockingPlayer = unit.lockProgress >= 0.2;

    if (unit.lockProgress >= 1) {
      outEvents.firedMissile = true;
      outEvents.launchOrigin.set(
        unit.position.x,
        unit.position.y + (unit.type === 'warship' ? 14 : 11),
        unit.position.z,
      );
      // Launch sharply upward-angled toward the player jet (classic SAM arc!)
      const invLen = 1 / (Math.hypot(dx, Math.max(120, dy + 160), dz) || 1);
      outEvents.launchDir.set(
        dx * invLen,
        Math.max(120, dy + 160) * invLen,
        dz * invLen,
      );
      unit.lockProgress = 0;
      unit.wasLockingPlayer = false;
      unit.missileCooldown = spec.missileCooldownSec * diff.enemyFireCooldownScale;
    }
  } else {
    unit.lockProgress = Math.max(0, unit.lockProgress - clampedDt * 0.6);
    unit.wasLockingPlayer = false;
  }
}
