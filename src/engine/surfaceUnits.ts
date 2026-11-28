import * as THREE from 'three';
import { DIFFICULTY_PROFILES } from './enemyAI';
import { getCoastlineX, getRiverCenterX, getTerrainHeight } from './terrain';
import type { DifficultyLevel, EnemyArchetype, SurfaceUnitType, Vec3 } from './types';

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
  isRiverPatrol?: boolean;
  riverZMin?: number;
  riverZMax?: number;
  riverDir?: number;
  isPrimaryObjective?: boolean;
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

export interface StrikeMissionDef {
  wave: number;
  titleFa: string;
  subtitleFa: string;
  objectiveTitleFa: string;
  targetLabelFa: string;
  objectiveKind: 'command' | 'sam' | 'warship' | 'air';
  airUnits: EnemyArchetype[];
  commandCount: number;
  samCount: number;
  warshipCount: number;
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
  isRiver?: boolean;
  zMin?: number;
  zMax?: number;
}

// Strategic mainland high-ground ridges & valley overlooks across the continent
const SAM_SITES: ReadonlyArray<SamPlacementSite> = [
  { x: -420, z: -960 }, // West Ridge overlooking the Northern Gorge
  { x: 465, z: -1210 }, // Northeast Twin Peak Battery
  { x: -1160, z: -480 }, // Western Mountain Overlook
  { x: 640, z: -380 }, // Eastern Mainland Bluff
  { x: -860, z: 890 }, // Southwest Plateau Ridge
  { x: 520, z: 1120 }, // Southeast Highland Battery
];

// Fortified Radar Command Bunkers placed on prominent continental plateaus
const COMMAND_SITES: ReadonlyArray<SamPlacementSite> = [
  { x: -560, z: -840 }, // Central-North Command Ridge (directly ahead-left of spawn)
  { x: -1240, z: -240 }, // Western Cordillera Radar Fortress
  { x: 420, z: -1180 }, // Northeast High Plateau Command Bunker
  { x: -540, z: 1080 }, // Southern Mainland Relay Command
];

// Enemy Naval Destroyer patrol zones: wide winding river channel + eastern coastal sea
const WARSHIP_ZONES: ReadonlyArray<WarshipPatrolZone> = [
  // River Destroyer patrolling the wide winding central river channel
  { cx: 0, cz: -460, radius: 75, startAngle: 0.4, isRiver: true, zMin: -950, zMax: 340 },
  // Eastern Coastal Sea Destroyer patrolling off the eastern continental coastline
  { cx: 1540, cz: -380, radius: 145, startAngle: 1.2 },
  // Southeastern Coastal Bay Destroyer
  { cx: 1480, cz: 680, radius: 140, startAngle: 2.6 },
  // Northern River Mouth / Strait Destroyer
  { cx: 1580, cz: -1280, radius: 135, startAngle: 0.9 },
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
  command: {
    nameFa: 'مقر راداری دشمن',
    maxHp: 240,
    hitRadius: 21,
    capsuleHalfLength: 0,
    scoreValue: 850,
    radarRange: 1650,
    lockDurationSec: 3.6,
    missileCooldownSec: 13.5,
  },
};

/**
 * Returns the objective-driven Strike Mission definition for Jet Sub-Mode 2 (عملیات تهاجمی).
 */
export function getStrikeMissionDefinition(wave: number): StrikeMissionDef {
  const cycle = ((wave - 1) % 4) + 1;
  const faWave = wave.toString().replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const extraEscort = wave > 4 ? 1 : 0;

  if (cycle === 1) {
    const commandCount = wave > 4 ? 2 : 1;
    return {
      wave,
      titleFa: `عملیات موج ${faWave} — انهدام مقر راداری`,
      subtitleFa: 'مقر فرماندهی راداری دشمن روی ارتفاعات خشکی را نابود کنید',
      objectiveTitleFa: 'انهدام مقر راداری دشمن',
      targetLabelFa: 'مقر راداری',
      objectiveKind: 'command',
      airUnits: extraEscort > 0 ? ['recon', 'interceptor', 'interceptor'] : ['recon', 'recon'],
      commandCount,
      samCount: 1 + extraEscort,
      warshipCount: 1,
    };
  }
  if (cycle === 2) {
    return {
      wave,
      titleFa: `عملیات موج ${faWave} — سرکوب پدافند`,
      subtitleFa: 'شبکه پدافند موشکی مستقر در دره‌ها و ارتفاعات را خنثی کنید',
      objectiveTitleFa: 'نابودی شبکه پدافند موشکی',
      targetLabelFa: 'پدافند موشکی',
      objectiveKind: 'sam',
      airUnits:
        extraEscort > 0
          ? ['interceptor', 'interceptor', 'heavy']
          : ['recon', 'interceptor', 'interceptor'],
      commandCount: 0,
      samCount: 3,
      warshipCount: 1,
    };
  }
  if (cycle === 3) {
    const warshipCount = wave > 4 ? 2 : 1;
    return {
      wave,
      titleFa: `عملیات موج ${faWave} — شکار ناو جنگی`,
      subtitleFa: 'ناو جنگی گشت‌زن در رودخانه بزرگ و دریای ساحلی را غرق کنید',
      objectiveTitleFa: 'انهدام ناو جنگی دشمن',
      targetLabelFa: 'ناو جنگی',
      objectiveKind: 'warship',
      airUnits:
        extraEscort > 0
          ? ['interceptor', 'heavy', 'heavy']
          : ['interceptor', 'interceptor', 'heavy'],
      commandCount: 0,
      samCount: 2,
      warshipCount,
    };
  }
  return {
    wave,
    titleFa: `عملیات موج ${faWave} — شکستن خط دفاعی آس`,
    subtitleFa: 'اسکادران جنگنده‌های نخبه دشمن را برای باز کردن آسمان منهدم کنید',
    objectiveTitleFa: 'شکستن خط دفاعی جنگنده‌های دشمن',
    targetLabelFa: 'جنگنده دشمن',
    objectiveKind: 'air',
    airUnits:
      extraEscort > 0
        ? ['ace', 'ace', 'heavy', 'interceptor']
        : ['ace', 'heavy', 'interceptor', 'interceptor'],
    commandCount: 0,
    samCount: 2,
    warshipCount: 1,
  };
}

/**
 * Evaluates whether a ground SAM site, command bunker, or naval destroyer has clear radar
 * line-of-sight to the player's jet. Samples terrain elevation along the 3D ray AND checks
 * canyon/valley masking so diving low inside mountain gorges breaks ground radar lock!
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
 * Finds an exact dry-land coordinate on or near a candidate mainland site using getTerrainHeight.
 */
function resolveGroundSitePosition(
  site: SamPlacementSite,
  heightSampler: (x: number, z: number) => number,
): THREE.Vector3 {
  let bestX = site.x;
  let bestZ = site.z;
  let bestH = heightSampler(site.x, site.z);
  if (bestH < 18) {
    for (let r = 110; r <= 260; r += 75) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const tx = site.x + Math.cos(ang) * r;
        const tz = site.z + Math.sin(ang) * r;
        const th = heightSampler(tx, tz);
        if (th > bestH) {
          bestH = th;
          bestX = tx;
          bestZ = tz;
        }
      }
      if (bestH >= 22) break;
    }
  }
  return new THREE.Vector3(bestX, Math.max(12, bestH), bestZ);
}

/**
 * Resolves a verified open-water coordinate inside either the wide river channel
 * or the eastern coastal sea (guarantees h <= 0.1).
 */
function resolveWaterPoint(
  zone: WarshipPatrolZone,
  heightSampler: (x: number, z: number) => number,
): { x: number; z: number } {
  if (zone.isRiver) {
    const rx = getRiverCenterX(zone.cz);
    if (heightSampler(rx, zone.cz) <= 0.1) {
      return { x: rx, z: zone.cz };
    }
  }
  const x = zone.cx + Math.cos(zone.startAngle) * zone.radius;
  const z = zone.cz + Math.sin(zone.startAngle) * zone.radius;
  if (heightSampler(x, z) <= 0.1) {
    return { x, z };
  }
  if (heightSampler(zone.cx, zone.cz) <= 0.1) {
    return { x: zone.cx, z: zone.cz };
  }
  // Safe eastern sea fallback well offshore of coastline
  const safeSeaX = getCoastlineX(zone.cz) + 360;
  return { x: safeSeaX, z: zone.cz };
}

function buildSurfaceUnitRecord(
  id: number,
  type: SurfaceUnitType,
  pos: THREE.Vector3,
  wave: number,
  difficulty: DifficultyLevel,
  indexOffset: number,
  isPrimaryObjective: boolean,
  zone?: WarshipPatrolZone,
): SurfaceUnit {
  const spec = SURFACE_SPECS[type];
  const diff = DIFFICULTY_PROFILES[difficulty];
  const hpScale = 1 + Math.min(0.4, (wave - 1) * 0.08);
  const maxHp = Math.round(spec.maxHp * hpScale);

  return {
    id,
    type,
    nameFa: spec.nameFa,
    position: pos,
    velocity: new THREE.Vector3(0, 0, 0),
    headingRad: zone ? zone.startAngle + Math.PI * 0.5 : (indexOffset * 1.4) % (Math.PI * 2),
    radarAngle: indexOffset * 0.9,
    hp: maxHp,
    maxHp,
    hitRadius: spec.hitRadius,
    capsuleHalfLength: spec.capsuleHalfLength,
    scoreValue: spec.scoreValue,
    lockProgress: 0,
    missileCooldown: (5.8 + indexOffset * 2.4) * diff.enemyFireCooldownScale,
    wasLockingPlayer: false,
    patrolCenterX: zone ? zone.cx : pos.x,
    patrolCenterZ: zone ? zone.cz : pos.z,
    patrolRadius: zone ? zone.radius : 0,
    patrolAngle: zone ? zone.startAngle : 0,
    patrolSpeed: type === 'warship' ? 12 : 0,
    isRiverPatrol: Boolean(zone?.isRiver),
    riverZMin: zone?.zMin,
    riverZMax: zone?.zMax,
    riverDir: indexOffset % 2 === 0 ? -1 : 1,
    isPrimaryObjective,
    hitFlashTimer: 0,
    alive: true,
  };
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
  const warshipCount = Math.min(
    WARSHIP_ZONES.length,
    wave === 1 ? 1 : Math.min(3, Math.ceil(wave / 2)),
  );

  for (let i = 0; i < samCount; i++) {
    const site = SAM_SITES[(i + (wave - 1)) % SAM_SITES.length];
    const pos = resolveGroundSitePosition(site, heightSampler);
    units.push(buildSurfaceUnitRecord(nextId++, 'sam', pos, wave, difficulty, i, false));
  }

  for (let i = 0; i < warshipCount; i++) {
    const zone = WARSHIP_ZONES[(i + (wave - 1)) % WARSHIP_ZONES.length];
    const pt = resolveWaterPoint(zone, heightSampler);
    units.push(
      buildSurfaceUnitRecord(
        nextId++,
        'warship',
        new THREE.Vector3(pt.x, 0, pt.z),
        wave,
        difficulty,
        i,
        false,
        zone,
      ),
    );
  }

  return units;
}

/**
 * Spawns surface units tailored for a Tactical Strike Mission wave, tagging primary objective targets.
 */
export function createStrikeSurfaceUnits(
  mission: StrikeMissionDef,
  startId: number,
  difficulty: DifficultyLevel = 'normal',
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): SurfaceUnit[] {
  const units: SurfaceUnit[] = [];
  let nextId = startId;

  for (let i = 0; i < mission.commandCount; i++) {
    const site = COMMAND_SITES[(i + (mission.wave - 1)) % COMMAND_SITES.length];
    const pos = resolveGroundSitePosition(site, heightSampler);
    units.push(
      buildSurfaceUnitRecord(
        nextId++,
        'command',
        pos,
        mission.wave,
        difficulty,
        i,
        mission.objectiveKind === 'command',
      ),
    );
  }

  for (let i = 0; i < mission.samCount; i++) {
    const site = SAM_SITES[(i + (mission.wave - 1)) % SAM_SITES.length];
    const pos = resolveGroundSitePosition(site, heightSampler);
    units.push(
      buildSurfaceUnitRecord(
        nextId++,
        'sam',
        pos,
        mission.wave,
        difficulty,
        i + 2,
        mission.objectiveKind === 'sam',
      ),
    );
  }

  for (let i = 0; i < mission.warshipCount; i++) {
    const zone = WARSHIP_ZONES[i % WARSHIP_ZONES.length];
    const pt = resolveWaterPoint(zone, heightSampler);
    units.push(
      buildSurfaceUnitRecord(
        nextId++,
        'warship',
        new THREE.Vector3(pt.x, 0, pt.z),
        mission.wave,
        difficulty,
        i + 4,
        mission.objectiveKind === 'warship',
        zone,
      ),
    );
  }

  return units;
}

/**
 * Updates a single SAM battery, Command Bunker, or Naval Warship (zero allocations inside loop).
 * Handles river-channel and coastal-sea patrolling, rotating radar dish, terrain-masked radar lock-on,
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

  unit.radarAngle =
    (unit.radarAngle + clampedDt * (unit.type === 'warship' ? 1.7 : 2.35)) % (Math.PI * 2);
  unit.missileCooldown = Math.max(0, unit.missileCooldown - clampedDt);

  // Naval warship smooth river-channel OR open-sea patrol (staying strictly in deep water)
  if (unit.type === 'warship' && unit.patrolSpeed !== 0) {
    if (unit.isRiverPatrol && unit.riverZMin !== undefined && unit.riverZMax !== undefined) {
      const dir = unit.riverDir ?? -1;
      const prevX = unit.position.x;
      const prevZ = unit.position.z;
      let nextZ = prevZ + dir * Math.abs(unit.patrolSpeed) * clampedDt;
      if (nextZ < unit.riverZMin) {
        nextZ = unit.riverZMin;
        unit.riverDir = 1;
      } else if (nextZ > unit.riverZMax) {
        nextZ = unit.riverZMax;
        unit.riverDir = -1;
      }
      const nextX = getRiverCenterX(nextZ);
      if (heightSampler(nextX, nextZ) <= 0.1) {
        unit.position.set(nextX, 0, nextZ);
        if (clampedDt > 1e-4) {
          unit.velocity.set((nextX - prevX) / clampedDt, 0, (nextZ - prevZ) / clampedDt);
        }
        unit.headingRad = Math.atan2(nextX - prevX, nextZ - prevZ);
      } else {
        unit.riverDir = -dir;
        unit.velocity.set(0, 0, 0);
      }
    } else if (unit.patrolRadius > 0) {
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
        unit.patrolSpeed = -unit.patrolSpeed;
        unit.velocity.set(0, 0, 0);
      }
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
