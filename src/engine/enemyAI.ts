import * as THREE from 'three';
import { getTerrainHeight, PLAYABLE_RADIUS } from './terrain';
import type { AIState, DifficultyLevel, EnemyArchetype } from './types';

export interface DifficultyProfile {
  labelFa: string;
  descFa: string;
  enemySpeedScale: number;
  enemyTurnScale: number;
  enemyDamageScale: number;
  enemyFireCooldownScale: number;
  enemyFlareChance: number; // probability of popping flares against incoming missile
  lockConeDeg: number;
  lockDurationSec: number;
  missileReloadSec: number;
  flareReloadSec: number;
  maxConcurrentAttackers: number;
}

export const DIFFICULTY_PROFILES: Record<DifficultyLevel, DifficultyProfile> = {
  easy: {
    labelFa: 'آسان',
    descFa: 'قفل راداری سریع‌تر و دشمنان ملایم‌تر برای شروع راحت',
    enemySpeedScale: 0.86,
    enemyTurnScale: 0.82,
    enemyDamageScale: 0.65,
    enemyFireCooldownScale: 1.35,
    enemyFlareChance: 0,
    lockConeDeg: 22.5,
    lockDurationSec: 1.05,
    missileReloadSec: 4.0,
    flareReloadSec: 5.2,
    maxConcurrentAttackers: 2,
  },
  normal: {
    labelFa: 'متوسط',
    descFa: 'نبرد هوایی متعادل با مانورهای تاکتیکی و منور دشمن',
    enemySpeedScale: 1.0,
    enemyTurnScale: 1.0,
    enemyDamageScale: 1.0,
    enemyFireCooldownScale: 1.0,
    enemyFlareChance: 0.38,
    lockConeDeg: 18.5,
    lockDurationSec: 1.35,
    missileReloadSec: 4.8,
    flareReloadSec: 6.4,
    maxConcurrentAttackers: 3,
  },
  hard: {
    labelFa: 'حرفه‌ای',
    descFa: 'خلبانان تهاجمی، جاخالی سریع و دفاع حرارتی هوشمند',
    enemySpeedScale: 1.12,
    enemyTurnScale: 1.18,
    enemyDamageScale: 1.28,
    enemyFireCooldownScale: 0.82,
    enemyFlareChance: 0.68,
    lockConeDeg: 16.0,
    lockDurationSec: 1.55,
    missileReloadSec: 5.4,
    flareReloadSec: 7.2,
    maxConcurrentAttackers: 4,
  },
};

export interface ArchetypeSpec {
  type: EnemyArchetype;
  nameFa: string;
  maxHp: number;
  speed: number;
  turnRate: number; // rad/sec
  scoreValue: number;
  canFireMissiles: boolean;
  maxFlares: number;
  fireCooldown: number;
  missileLockDuration: number;
  hitRadius: number;
}

export const ARCHETYPE_SPECS: Record<EnemyArchetype, ArchetypeSpec> = {
  recon: {
    type: 'recon',
    nameFa: 'پهپاد شناسایی',
    maxHp: 55,
    speed: 96,
    turnRate: 1.05,
    scoreValue: 150,
    canFireMissiles: false,
    maxFlares: 0,
    fireCooldown: 2.1,
    missileLockDuration: 99,
    hitRadius: 8.8,
  },
  interceptor: {
    type: 'interceptor',
    nameFa: 'رهگیر چابک',
    maxHp: 88,
    speed: 120,
    turnRate: 1.48,
    scoreValue: 260,
    canFireMissiles: true,
    maxFlares: 1,
    fireCooldown: 1.38,
    missileLockDuration: 3.1,
    hitRadius: 9.0,
  },
  heavy: {
    type: 'heavy',
    nameFa: 'جنگنده سنگین',
    maxHp: 150,
    speed: 108,
    turnRate: 1.12,
    scoreValue: 380,
    canFireMissiles: true,
    maxFlares: 2,
    fireCooldown: 1.2,
    missileLockDuration: 2.6,
    hitRadius: 10.4,
  },
  ace: {
    type: 'ace',
    nameFa: 'جنگنده آس',
    maxHp: 185,
    speed: 132,
    turnRate: 1.72,
    scoreValue: 550,
    canFireMissiles: true,
    maxFlares: 2,
    fireCooldown: 1.0,
    missileLockDuration: 2.2,
    hitRadius: 9.4,
  },
};

export interface EnemyUnit {
  id: number;
  archetype: EnemyArchetype;
  nameFa: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  speed: number;
  hp: number;
  maxHp: number;
  hitRadius: number;
  scoreValue: number;
  state: AIState;
  stateTimer: number;
  patrolCenter: THREE.Vector3;
  patrolAngle: number;
  patrolRadius: number;
  patrolAltitude: number;
  flankSide: number; // -1 or +1 tactical wingman side
  gunCooldown: number;
  missileCooldown: number;
  missileLockOnPlayer: number; // 0..1 telegraph before launching enemy missile
  flaresLeft: number;
  flareCooldown: number;
  evadeDirection: number; // -1 or +1
  evadeRollPhase: number;
  hitFlashTimer: number;
  dying: boolean;
  deathTimer: number;
  deathSpinAxis: THREE.Vector3;
  alive: boolean;
}

export interface EnemyActionEvents {
  firedCannon: boolean;
  cannonOrigin: THREE.Vector3;
  cannonDir: THREE.Vector3;
  firedMissile: boolean;
  lockingPlayer: boolean;
  deployedFlare: boolean;
}

export interface WaveDefinition {
  wave: number;
  titleFa: string;
  subtitleFa: string;
  units: EnemyArchetype[];
}

export function getWaveDefinition(wave: number): WaveDefinition {
  if (wave === 1) {
    return {
      wave,
      titleFa: 'موج ۱ — گشت شناسایی',
      subtitleFa: 'پهپادهای شناسایی دشمن در منطقه رؤیت شدند',
      units: ['recon', 'recon', 'recon'],
    };
  }
  if (wave === 2) {
    return {
      wave,
      titleFa: 'موج ۲ — اسکادران رهگیر',
      subtitleFa: 'رهگیرهای چابک مسلح به موشک وارد آسمان شدند',
      units: ['recon', 'interceptor', 'interceptor', 'interceptor'],
    };
  }
  if (wave === 3) {
    return {
      wave,
      titleFa: 'موج ۳ — تهاجم سنگین',
      subtitleFa: 'جنگنده‌های سنگین و رهگیرها در حال نزدیک شدن‌اند',
      units: ['interceptor', 'interceptor', 'heavy', 'heavy'],
    };
  }

  // Endless escalating waves (Wave 4+: Heavy Fighters + Ace Squadrons)
  const extraCount = Math.min(4, Math.floor((wave - 3) / 2));
  const units: EnemyArchetype[] = ['ace', 'heavy', 'interceptor', 'interceptor'];
  for (let i = 0; i < extraCount; i++) {
    units.push(i % 2 === 0 ? 'ace' : 'heavy');
  }
  const persianDigits = wave.toString().replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  return {
    wave,
    titleFa: `موج ${persianDigits} — اسکادران آس`,
    subtitleFa: 'خلبانان نخبه دشمن با مانورهای رزمی وارد نبرد شدند',
    units,
  };
}

export function createEnemyUnit(
  id: number,
  archetype: EnemyArchetype,
  spawnPos: THREE.Vector3,
  patrolAngle: number,
  waveScale: number,
  difficulty: DifficultyLevel = 'normal',
): EnemyUnit {
  const spec = ARCHETYPE_SPECS[archetype];
  const diff = DIFFICULTY_PROFILES[difficulty];
  const speedScale = (1 + Math.min(0.24, (waveScale - 1) * 0.035)) * diff.enemySpeedScale;
  const hpScale = 1 + Math.min(0.45, (waveScale - 1) * 0.07);
  const maxHp = Math.round(spec.maxHp * hpScale);

  const unit: EnemyUnit = {
    id,
    archetype,
    nameFa: spec.nameFa,
    position: spawnPos.clone(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, spec.speed * speedScale),
    speed: spec.speed * speedScale,
    hp: maxHp,
    maxHp,
    hitRadius: spec.hitRadius,
    scoreValue: spec.scoreValue,
    state: 'PATROL',
    stateTimer: 1.5 + (id % 3) * 0.8,
    patrolCenter: new THREE.Vector3(
      Math.cos(patrolAngle) * 560,
      0,
      Math.sin(patrolAngle) * 560 - 450,
    ),
    patrolAngle,
    patrolRadius: 380 + (id % 3) * 90,
    patrolAltitude: 235 + (id % 4) * 55,
    flankSide: id % 2 === 0 ? 1 : -1,
    gunCooldown: 1.4 + (id % 3) * 0.4,
    missileCooldown: 6.5 + (id % 4) * 2,
    missileLockOnPlayer: 0,
    flaresLeft: diff.enemyFlareChance > 0 ? spec.maxFlares : 0,
    flareCooldown: 0,
    evadeDirection: id % 2 === 0 ? 1 : -1,
    evadeRollPhase: 0,
    hitFlashTimer: 0,
    dying: false,
    deathTimer: 0,
    deathSpinAxis: new THREE.Vector3(0.4, 0.2, 1).normalize(),
    alive: true,
  };

  // Orient initially toward spawn origin
  const lookMat = new THREE.Matrix4().lookAt(
    unit.position,
    new THREE.Vector3(0, 220, 0),
    new THREE.Vector3(0, 1, 0),
  );
  unit.quaternion.setFromRotationMatrix(lookMat);
  unit.velocity.set(0, 0, -1).applyQuaternion(unit.quaternion).multiplyScalar(unit.speed);
  return unit;
}

// Reusable scratch vectors (zero GC in loop)
const _forward = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();
const _targetPoint = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lookMat = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

/**
 * Updates a single enemy jet's FSM & 3D steering behavior.
 * Supports PATROL, PURSUIT (High-Yo-Yo/Flank), ATTACK, BREAKAWAY (Boom-and-Zoom standoff),
 * EVADE (Scissors/Break-turn + Flares), and TERRAIN_AVOIDANCE.
 */
export function updateEnemyAI(
  enemy: EnemyUnit,
  playerPos: THREE.Vector3,
  playerVel: THREE.Vector3,
  playerForward: THREE.Vector3,
  incomingPlayerMissileDist: number, // Infinity if no player missile targeting this enemy
  isBeingLockedByPlayer: boolean,
  canAcquireAttackToken: boolean,
  dt: number,
  outEvents: EnemyActionEvents,
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
  difficulty: DifficultyLevel = 'normal',
): void {
  outEvents.firedCannon = false;
  outEvents.firedMissile = false;
  outEvents.lockingPlayer = false;
  outEvents.deployedFlare = false;

  const clampedDt = Math.min(Math.max(dt, 0), 0.05);
  if (!enemy.alive) return;

  if (enemy.hitFlashTimer > 0) {
    enemy.hitFlashTimer = Math.max(0, enemy.hitFlashTimer - clampedDt);
  }

  // KO spiral-down sequence (0.42s readable defeat transition before final explosion)
  if (enemy.dying) {
    enemy.deathTimer -= clampedDt;
    enemy.velocity.y -= 48 * clampedDt;
    enemy.position.addScaledVector(enemy.velocity, clampedDt);
    _rollQuat.setFromAxisAngle(enemy.deathSpinAxis, 6.2 * clampedDt);
    enemy.quaternion.multiply(_rollQuat).normalize();
    if (enemy.deathTimer <= 0 || enemy.position.y <= 1) {
      enemy.alive = false;
    }
    return;
  }

  const spec = ARCHETYPE_SPECS[enemy.archetype];
  const diff = DIFFICULTY_PROFILES[difficulty];
  enemy.gunCooldown = Math.max(0, enemy.gunCooldown - clampedDt);
  enemy.missileCooldown = Math.max(0, enemy.missileCooldown - clampedDt);
  enemy.flareCooldown = Math.max(0, enemy.flareCooldown - clampedDt);
  enemy.stateTimer = Math.max(0, enemy.stateTimer - clampedDt);

  _forward.set(0, 0, -1).applyQuaternion(enemy.quaternion).normalize();
  _toPlayer.subVectors(playerPos, enemy.position);
  const distToPlayer = _toPlayer.length() || 1;
  const dirToPlayerX = _toPlayer.x / distToPlayer;
  const dirToPlayerY = _toPlayer.y / distToPlayer;
  const dirToPlayerZ = _toPlayer.z / distToPlayer;
  const alignmentToPlayer =
    _forward.x * dirToPlayerX + _forward.y * dirToPlayerY + _forward.z * dirToPlayerZ;

  // 1. Check Terrain Avoidance (Highest Priority FSM State)
  const lookAhead1 = 155;
  const lookAhead2 = 295;
  const hNow = heightSampler(enemy.position.x, enemy.position.z);
  const h1 = heightSampler(
    enemy.position.x + _forward.x * lookAhead1,
    enemy.position.z + _forward.z * lookAhead1,
  );
  const h2 = heightSampler(
    enemy.position.x + _forward.x * lookAhead2,
    enemy.position.z + _forward.z * lookAhead2,
  );
  const maxTerrainAhead = Math.max(0, hNow, h1, h2);
  const safeAltitude = maxTerrainAhead + 82;
  const needsTerrainAvoid =
    enemy.position.y < safeAltitude ||
    enemy.position.y + _forward.y * lookAhead1 < maxTerrainAhead + 45;

  const isThreatenedByPlayerMissile = incomingPlayerMissileDist < 720;

  // Enemy countermeasure flares when a player missile closes inside 290m
  if (
    incomingPlayerMissileDist < 290 &&
    enemy.flaresLeft > 0 &&
    enemy.flareCooldown <= 0 &&
    diff.enemyFlareChance > 0
  ) {
    enemy.flareCooldown = 6.5;
    if (Math.random() < diff.enemyFlareChance) {
      enemy.flaresLeft--;
      outEvents.deployedFlare = true;
    }
  }

  // 2. FSM State Transitions (with standoff BREAKAWAY so enemies never glue to player!)
  if (needsTerrainAvoid) {
    enemy.state = 'TERRAIN_AVOIDANCE';
    enemy.missileLockOnPlayer = 0;
  } else if (
    isThreatenedByPlayerMissile ||
    (isBeingLockedByPlayer && enemy.archetype !== 'recon' && enemy.stateTimer <= 0)
  ) {
    if (enemy.state !== 'EVADE') {
      enemy.state = 'EVADE';
      enemy.stateTimer = enemy.archetype === 'ace' ? 2.3 : 1.85;
      enemy.evadeDirection = Math.random() > 0.5 ? 1 : -1;
      enemy.evadeRollPhase = 0;
    }
    enemy.missileLockOnPlayer = 0;
  } else if (enemy.state === 'EVADE' && enemy.stateTimer > 0) {
    enemy.missileLockOnPlayer = 0;
  } else if (distToPlayer < 245 && enemy.state !== 'BREAKAWAY') {
    // Boom-and-Zoom Break-Off! Prevents hugging/orbiting invisibly right behind player
    enemy.state = 'BREAKAWAY';
    enemy.stateTimer = 2.8 + (enemy.id % 3) * 0.45;
    enemy.flankSide = Math.random() > 0.5 ? 1 : -1;
    enemy.missileLockOnPlayer = 0;
  } else if (enemy.state === 'BREAKAWAY' && (enemy.stateTimer > 0 || distToPlayer < 380)) {
    // Extend smoothly out to clean engagement distance before looping back
    enemy.missileLockOnPlayer = 0;
  } else {
    if (distToPlayer > 1550) {
      enemy.state = 'PATROL';
      enemy.missileLockOnPlayer = 0;
    } else if (
      distToPlayer >= 270 &&
      distToPlayer < 940 &&
      alignmentToPlayer > 0.64 &&
      canAcquireAttackToken
    ) {
      enemy.state = 'ATTACK';
    } else {
      enemy.state = 'PURSUIT';
      if (alignmentToPlayer < 0.45) {
        enemy.missileLockOnPlayer = Math.max(0, enemy.missileLockOnPlayer - clampedDt * 0.8);
      }
    }
  }

  // 3. Steering Goal Computation per FSM State
  let desiredBankRoll = 0;
  let turnMultiplier = diff.enemyTurnScale;

  if (enemy.state === 'TERRAIN_AVOIDANCE') {
    _desiredDir.set(_forward.x * 0.5, 0.88, _forward.z * 0.5).normalize();
    turnMultiplier = 1.48;
  } else if (enemy.state === 'EVADE') {
    // High-G perpendicular break turn + defensive scissors roll
    enemy.evadeRollPhase += clampedDt * 4.8;
    _right.crossVectors(_forward, _worldUp).normalize();
    _desiredDir
      .copy(_right)
      .multiplyScalar(enemy.evadeDirection * 0.86)
      .addScaledVector(_worldUp, 0.34 + Math.sin(enemy.evadeRollPhase) * 0.24)
      .addScaledVector(_forward, 0.28)
      .normalize();
    desiredBankRoll = enemy.evadeDirection * 1.1;
    turnMultiplier = 1.32 * diff.enemyTurnScale;
  } else if (enemy.state === 'BREAKAWAY') {
    // Real High-Yo-Yo / Boom-and-Zoom climb & lateral extend so player clearly sees enemy pull away
    _right.crossVectors(playerForward, _worldUp).normalize();
    _targetPoint
      .copy(playerPos)
      .addScaledVector(playerForward, 420) // Extend out ahead/flanks into player's visible arc!
      .addScaledVector(_right, enemy.flankSide * 340);
    _targetPoint.y = Math.max(
      playerPos.y + 95,
      heightSampler(_targetPoint.x, _targetPoint.z) + 120,
    );
    _desiredDir.subVectors(_targetPoint, enemy.position).normalize();
    desiredBankRoll = enemy.flankSide * 0.72;
  } else if (enemy.state === 'PATROL') {
    enemy.patrolAngle += (enemy.speed / enemy.patrolRadius) * clampedDt * 0.62;
    _targetPoint.set(
      enemy.patrolCenter.x + Math.cos(enemy.patrolAngle) * enemy.patrolRadius,
      enemy.patrolAltitude,
      enemy.patrolCenter.z + Math.sin(enemy.patrolAngle) * enemy.patrolRadius,
    );
    _desiredDir.subVectors(_targetPoint, enemy.position).normalize();
  } else if (enemy.state === 'PURSUIT') {
    // High-Yo-Yo & Flanking Approach: climb slightly higher & offset laterally rather than tailgating close
    _right.crossVectors(playerForward, _worldUp).normalize();
    const flankOffset = enemy.archetype === 'recon' ? 280 : 210;
    const heightAdvantage = enemy.archetype === 'heavy' ? 85 : 55;
    _targetPoint
      .copy(playerPos)
      .addScaledVector(_right, enemy.flankSide * flankOffset)
      .addScaledVector(playerForward, 80); // Aim for an intercept angle ahead/flank, not hugging behind!
    _targetPoint.y = Math.max(
      playerPos.y + heightAdvantage,
      heightSampler(_targetPoint.x, _targetPoint.z) + 95,
    );
    _desiredDir.subVectors(_targetPoint, enemy.position).normalize();
  } else {
    // ATTACK: Diving pass with lead gun bursts & telegraphed missiles
    const leadT = Math.min(1.15, distToPlayer / 430);
    _targetPoint.copy(playerPos).addScaledVector(playerVel, leadT);
    _desiredDir.subVectors(_targetPoint, enemy.position).normalize();

    if (distToPlayer < 680 && distToPlayer > 240 && alignmentToPlayer > 0.91 && enemy.gunCooldown <= 0) {
      outEvents.firedCannon = true;
      outEvents.cannonOrigin.copy(enemy.position).addScaledVector(_forward, 7);
      outEvents.cannonDir.copy(_desiredDir);
      enemy.gunCooldown = spec.fireCooldown * diff.enemyFireCooldownScale;
    }

    if (
      spec.canFireMissiles &&
      distToPlayer > 310 &&
      distToPlayer < 960 &&
      alignmentToPlayer > 0.85 &&
      enemy.missileCooldown <= 0
    ) {
      enemy.missileLockOnPlayer += clampedDt / (spec.missileLockDuration * diff.enemyFireCooldownScale);
      outEvents.lockingPlayer = true;
      if (enemy.missileLockOnPlayer >= 1) {
        outEvents.firedMissile = true;
        enemy.missileLockOnPlayer = 0;
        enemy.missileCooldown = (enemy.archetype === 'ace' ? 8.0 : 11.0) * diff.enemyFireCooldownScale;
      }
    } else {
      enemy.missileLockOnPlayer = Math.max(0, enemy.missileLockOnPlayer - clampedDt * 0.6);
    }
  }

  // Keep inside playable combat theater
  const radial = Math.hypot(enemy.position.x, enemy.position.z);
  if (radial > PLAYABLE_RADIUS * 0.92) {
    _desiredDir.set(-enemy.position.x, 120, -enemy.position.z).normalize();
  }

  // 4. Smoothly rotate quaternion toward desired direction with authentic banking roll
  _targetPoint.copy(enemy.position).add(_desiredDir);
  _up.copy(_worldUp);

  const crossY = _forward.z * _desiredDir.x - _forward.x * _desiredDir.z;
  const bankTilt = THREE.MathUtils.clamp(crossY * 2.2 + desiredBankRoll, -1.1, 1.1);
  _right.crossVectors(_desiredDir, _worldUp);
  if (_right.lengthSq() > 0.001) {
    _right.normalize();
    _up.addScaledVector(_right, Math.sin(bankTilt) * 0.85).normalize();
  }

  _lookMat.lookAt(enemy.position, _targetPoint, _up);
  _targetQuat.setFromRotationMatrix(_lookMat);

  const maxAngleStep = spec.turnRate * turnMultiplier * clampedDt;
  enemy.quaternion.rotateTowards(_targetQuat, maxAngleStep);
  enemy.quaternion.normalize();

  // 5. Integrate position
  _forward.set(0, 0, -1).applyQuaternion(enemy.quaternion).normalize();
  enemy.velocity.copy(_forward).multiplyScalar(enemy.speed);
  enemy.position.addScaledVector(enemy.velocity, clampedDt);

  const minFloor = Math.max(24, heightSampler(enemy.position.x, enemy.position.z) + 28);
  if (enemy.position.y < minFloor) {
    enemy.position.y = minFloor;
  }
}
