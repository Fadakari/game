import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getCoastlineX, getRiverCenterX, getTerrainHeight } from './terrain';
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
} from './flightPhysics';
import {
  createEnemyUnit,
  DIFFICULTY_PROFILES,
  getWaveDefinition,
  MIN_ENGAGEMENT_DISTANCE,
  updateEnemyAI,
  type EnemyActionEvents,
} from './enemyAI';
import {
  createStrikeSurfaceUnits,
  createSurfaceWaveUnits,
  getStrikeMissionDefinition,
  hasTerrainLineOfSight,
  updateSurfaceUnit,
  type SurfaceActionEvents,
} from './surfaceUnits';
import {
  sortAndTrimTop100,
  validateLeaderboardSubmission,
} from '../services/edgeLeaderboard';
import type { ControlInput, LeaderboardEntry } from './types';

const NEUTRAL_INPUT: ControlInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  fireGun: false,
  fireMissile: false,
  boost: false,
  flare: false,
};

test('terrain height is deterministic with open ocean at spawn bay and carved canyons between mountain ridges', () => {
  const spawnH = getTerrainHeight(0, 0);
  assert.equal(spawnH, 0, 'spawn bay at origin should be open ocean');

  // Flanking ridge walls beside the Northern Gorge (-170,-420 to -140,-1580)
  const westRidge = getTerrainHeight(-390, -980);
  const eastRidge = getTerrainHeight(90, -980);
  const westRidge2 = getTerrainHeight(-390, -980);
  assert.equal(westRidge, westRidge2, 'terrain noise must be deterministic');
  assert.ok(
    Math.max(westRidge, eastRidge) > 100,
    `expected tall landmark mountain ridge flanking northern canyon, got west=${westRidge}, east=${eastRidge}`,
  );

  // Sample across the Northern Gorge corridor at z=-980 to confirm a low fly-through canyon floor exists
  let minFloor = Infinity;
  for (let x = -280; x <= -60; x += 20) {
    minFloor = Math.min(minFloor, getTerrainHeight(x, -980));
  }
  assert.ok(
    minFloor < 35,
    `expected carved low-altitude canyon floor through Northern Gorge, got minFloor=${minFloor}`,
  );
  assert.ok(
    Math.max(westRidge, eastRidge) - minFloor > 80,
    'canyon walls must rise dramatically above the carved gorge floor',
  );
});

test('flight physics survives 5 seconds with zero input without crashing', () => {
  const state = createInitialFlightState();
  for (let i = 0; i < 150; i++) {
    stepFlightPhysics(state, NEUTRAL_INPUT, 1 / 30);
    const crash = checkTerrainCollision(state.position, state.quaternion);
    assert.equal(crash, 'none', `jet should not crash at step ${i}`);
  }
  assert.ok(state.position.y > 150, 'jet should maintain safe cruise altitude');
});

test('climb reduces speed, dive increases speed, and afterburner boosts speed with heat', () => {
  const climbState = createInitialFlightState();
  const diveState = createInitialFlightState();
  const boostState = createInitialFlightState();

  for (let i = 0; i < 40; i++) {
    stepFlightPhysics(climbState, { ...NEUTRAL_INPUT, pitch: 0.7 }, 0.03);
    stepFlightPhysics(diveState, { ...NEUTRAL_INPUT, pitch: -0.7 }, 0.03);
    stepFlightPhysics(boostState, { ...NEUTRAL_INPUT, boost: true }, 0.03);
  }

  assert.ok(
    diveState.speed > climbState.speed + 8,
    `diving (${diveState.speed}) should be faster than climbing (${climbState.speed})`,
  );
  assert.ok(
    boostState.speed > FLIGHT_CONFIG.cruiseSpeed + 30,
    `afterburner should accelerate well above cruise (${boostState.speed})`,
  );
  assert.ok(boostState.afterburnerHeat > 20, 'afterburner should build heat');
});

test('sustained banking carves a tight horizontal turn without flipping upside down, and auto-levels when released', () => {
  const state = createInitialFlightState();
  const prevFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(state.quaternion);
  let prevHeading = Math.atan2(prevFwd.x, -prevFwd.z);
  let cumulativeTurnRad = 0;

  // Hold right turn for 1.8 seconds (60 steps * 0.03s)
  let minUpY = Infinity;
  for (let i = 0; i < 60; i++) {
    stepFlightPhysics(state, { ...NEUTRAL_INPUT, roll: 1 }, 0.03);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(state.quaternion);
    minUpY = Math.min(minUpY, up.y);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(state.quaternion);
    const h = Math.atan2(fwd.x, -fwd.z);
    let stepDelta = h - prevHeading;
    while (stepDelta < -Math.PI) stepDelta += Math.PI * 2;
    while (stepDelta > Math.PI) stepDelta -= Math.PI * 2;
    cumulativeTurnRad += stepDelta;
    prevHeading = h;
  }

  assert.ok(
    minUpY > 0.25,
    `holding turn must clamp combat bank angle and never spin upside down (minUpY=${minUpY})`,
  );

  const turnDeg = (cumulativeTurnRad * 180) / Math.PI;
  assert.ok(
    turnDeg >= 120 && turnDeg <= 220,
    `1.8s sustained right turn should carve a smooth ~160 deg combat turn (120..220 deg), got ${turnDeg.toFixed(1)} deg`,
  );

  const rightBeforeLevel = new THREE.Vector3(1, 0, 0).applyQuaternion(state.quaternion);
  const bankBefore = Math.abs(rightBeforeLevel.y);

  // Release controls for 1.5s to verify auto-level assist
  for (let i = 0; i < 50; i++) {
    stepFlightPhysics(state, NEUTRAL_INPUT, 0.03);
  }
  const rightAfterLevel = new THREE.Vector3(1, 0, 0).applyQuaternion(state.quaternion);
  assert.ok(
    Math.abs(rightAfterLevel.y) < bankBefore * 0.35,
    'auto-level should cleanly return wings toward level after releasing stick',
  );
});

test('exact ocean and terrain collision + GPWS warning trigger properly', () => {
  const q = new THREE.Quaternion();
  assert.equal(checkTerrainCollision(new THREE.Vector3(0, 0.4, 0), q), 'ocean');
  const peakH = getTerrainHeight(460, -1250);
  assert.ok(peakH > 80, `expected tall island peak at (460,-1250), got ${peakH}`);
  assert.equal(
    checkTerrainCollision(new THREE.Vector3(460, peakH - 5, -1250), q),
    'terrain',
  );

  const gpwsHigh = evaluateGPWS(new THREE.Vector3(0, 220, 0), new THREE.Vector3(0, 0, -120));
  assert.equal(gpwsHigh.warning, false);

  const gpwsLow = evaluateGPWS(new THREE.Vector3(0, 28, 0), new THREE.Vector3(0, -10, -120));
  assert.equal(gpwsLow.warning, true);
});

test('predictive lead indicator computes exact moving-target intercept', () => {
  const shooter = { x: 0, y: 200, z: 0 };
  const target = { x: 0, y: 200, z: -500 };
  const targetVel = { x: 100, y: 0, z: 0 };
  const bulletSpeed = 500;

  const lead = computeLeadPosition(shooter, target, targetVel, bulletSpeed);
  assert.ok(lead.x > 95 && lead.x < 110, `lead X should be ~102m ahead, got ${lead.x}`);

  // Verify bullet flight time equals target travel time to lead point
  const distToLead = Math.hypot(lead.x - shooter.x, lead.y - shooter.y, lead.z - shooter.z);
  const bulletFlightT = distToLead / bulletSpeed;
  assert.ok(
    Math.abs(bulletFlightT - lead.timeToImpact) < 0.02,
    'bullet flight time must match intercept time',
  );
});

test('proportional navigation guides missile smoothly to intercept moving target', () => {
  const mPos = new THREE.Vector3(0, 200, 0);
  const mVel = new THREE.Vector3(0, 0, -300);
  const tPos = new THREE.Vector3(120, 230, -520);
  const tVel = new THREE.Vector3(85, 10, -40);

  let hit = false;
  for (let i = 0; i < 120; i++) {
    const dt = 0.025;
    stepProportionalNavigation(mPos, mVel, tPos, tVel, 300, 250, 4.2, dt);
    mPos.addScaledVector(mVel, dt);
    tPos.addScaledVector(tVel, dt);
    if (mPos.distanceTo(tPos) < 16) {
      hit = true;
      break;
    }
  }
  assert.equal(hit, true, 'PN missile must intercept moving maneuvering target');
});

test('ray-segment vs sphere intersection catches high-speed bullet without tunneling', () => {
  const hit = segmentSphereIntersect(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: -100 },
    { x: 3, y: 2, z: -50 },
    6,
  );
  assert.equal(hit, true);

  const miss = segmentSphereIntersect(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: -100 },
    { x: 25, y: 0, z: -50 },
    6,
  );
  assert.equal(miss, false);
});

test('enemy AI FSM handles EVADE, BREAKAWAY standoff, TERRAIN_AVOIDANCE, and difficulty profiles', () => {
  const w1 = getWaveDefinition(1);
  const w2 = getWaveDefinition(2);
  const w4 = getWaveDefinition(4);
  assert.ok(w1.units.includes('recon'));
  assert.ok(w2.units.includes('interceptor'));
  assert.ok(w4.units.includes('ace'));

  // Difficulty profiles scale smoothly from easy to hard
  assert.equal(DIFFICULTY_PROFILES.easy.enemyFlareChance, 0);
  assert.ok(DIFFICULTY_PROFILES.hard.enemyFlareChance > DIFFICULTY_PROFILES.normal.enemyFlareChance);
  assert.ok(DIFFICULTY_PROFILES.easy.lockDurationSec < DIFFICULTY_PROFILES.hard.lockDurationSec);
  assert.ok(DIFFICULTY_PROFILES.easy.enemyDamageScale < DIFFICULTY_PROFILES.normal.enemyDamageScale);

  const unit = createEnemyUnit(1, 'interceptor', new THREE.Vector3(0, 240, -500), 0, 1, 'normal');
  const events: EnemyActionEvents = {
    firedCannon: false,
    cannonOrigin: new THREE.Vector3(),
    cannonDir: new THREE.Vector3(),
    firedMissile: false,
    lockingPlayer: false,
    deployedFlare: false,
  };

  // Trigger EVADE when threatened by incoming player missile (200m away)
  updateEnemyAI(
    unit,
    new THREE.Vector3(0, 220, 0),
    new THREE.Vector3(0, 0, -120),
    new THREE.Vector3(0, 0, -1),
    200,
    true,
    true,
    0.03,
    events,
    getTerrainHeight,
    'normal',
  );
  assert.equal(unit.state, 'EVADE');

  // Trigger BREAKAWAY when enemy gets too close (< 245m) so it never glues to the player
  const closeUnit = createEnemyUnit(2, 'interceptor', new THREE.Vector3(40, 240, -160), 0, 1, 'normal');
  updateEnemyAI(
    closeUnit,
    new THREE.Vector3(0, 220, 0),
    new THREE.Vector3(0, 0, -120),
    new THREE.Vector3(0, 0, -1),
    Infinity,
    false,
    true,
    0.03,
    events,
    getTerrainHeight,
    'normal',
  );
  assert.equal(closeUnit.state, 'BREAKAWAY');

  // Trigger TERRAIN_AVOIDANCE when flying dangerously low over mountain peak
  const peakH = getTerrainHeight(460, -1250);
  unit.stateTimer = 0;
  unit.position.set(460, peakH + 25, -1250);
  updateEnemyAI(
    unit,
    new THREE.Vector3(0, 220, 0),
    new THREE.Vector3(0, 0, -120),
    new THREE.Vector3(0, 0, -1),
    Infinity,
    false,
    true,
    0.03,
    events,
    getTerrainHeight,
    'normal',
  );
  assert.equal(unit.state, 'TERRAIN_AVOIDANCE');
});

test('SAM sites spawn on elevated dry ridges and Naval Warships patrol open ocean with valid heights', () => {
  const units = createSurfaceWaveUnits(2, 500, 'normal', getTerrainHeight);
  const sams = units.filter((u) => u.type === 'sam');
  const ships = units.filter((u) => u.type === 'warship');

  assert.ok(sams.length >= 2, 'wave 2 should spawn at least 2 SAM batteries');
  assert.ok(ships.length >= 1, 'wave 2 should spawn at least 1 naval warship');

  for (const sam of sams) {
    assert.ok(
      sam.position.y >= 12,
      `SAM ${sam.id} should be placed on elevated island terrain, got y=${sam.position.y}`,
    );
  }

  for (const ship of ships) {
    assert.equal(ship.position.y, 0, 'warship must float at ocean surface y=0');
    assert.ok(
      getTerrainHeight(ship.position.x, ship.position.z) <= 0.1,
      `warship ${ship.id} must be in open water`,
    );
    const prevX = ship.position.x;
    const prevZ = ship.position.z;
    const ev: SurfaceActionEvents = {
      firedMissile: false,
      launchOrigin: new THREE.Vector3(),
      launchDir: new THREE.Vector3(),
      lockingPlayer: false,
      lockBrokenByTerrain: false,
    };
    updateSurfaceUnit(ship, new THREE.Vector3(0, 260, 0), 0.05, ev, 'normal', getTerrainHeight);
    const movedDist = Math.hypot(ship.position.x - prevX, ship.position.z - prevZ);
    assert.ok(movedDist > 0.1, 'warship should smoothly patrol along ocean circuit');
  }
});

test('canyon terrain masking breaks SAM radar lock when player dives low into a gorge', () => {
  const samOrigin = new THREE.Vector3(465, getTerrainHeight(465, -1210), -1210);
  // High altitude over Northern Gorge has clear radar LOS
  const highJet = new THREE.Vector3(-155, 360, -980);
  assert.equal(
    hasTerrainLineOfSight(samOrigin, highJet, getTerrainHeight),
    true,
    'high-altitude aircraft should be visible to SAM radar',
  );

  // Diving low inside the Northern Gorge canyon between tall ridges masks radar LOS
  const lowCanyonJet = new THREE.Vector3(-155, 48, -980);
  assert.equal(
    hasTerrainLineOfSight(samOrigin, lowCanyonJet, getTerrainHeight),
    false,
    'low-altitude jet tucked in mountain canyon must break SAM radar line-of-sight',
  );

  // Verify updateSurfaceUnit emits lockBrokenByTerrain when player drops into canyon mid-lock
  const [sam] = createSurfaceWaveUnits(1, 700, 'normal', getTerrainHeight).filter(
    (u) => u.type === 'sam',
  );
  sam.position.copy(samOrigin);
  sam.missileCooldown = 0;
  sam.lockProgress = 0.6;
  sam.wasLockingPlayer = true;
  const ev: SurfaceActionEvents = {
    firedMissile: false,
    launchOrigin: new THREE.Vector3(),
    launchDir: new THREE.Vector3(),
    lockingPlayer: false,
    lockBrokenByTerrain: false,
  };
  updateSurfaceUnit(sam, lowCanyonJet, 0.04, ev, 'normal', getTerrainHeight);
  assert.equal(ev.lockBrokenByTerrain, true, 'canyon dive should trigger terrain lock-break event');
  assert.equal(sam.lockProgress, 0, 'SAM radar lock progress should reset when terrain-masked');
});

test('swept CCD capsule intersection, proximity fuse distance, and terrain impact prevent tunneling', () => {
  // Fast bullet crossing an elongated naval warship capsule along Z without tunneling
  const shipBow = { x: 0, y: 6, z: 24 };
  const shipStern = { x: 0, y: 6, z: -24 };
  const hitShip = segmentCapsuleIntersect(
    { x: -120, y: 8, z: 18 },
    { x: 120, y: 8, z: 18 },
    shipStern,
    shipBow,
    18,
  );
  assert.equal(hitShip, true, 'fast cross-ship bullet must hit elongated warship capsule');

  const missShip = segmentCapsuleIntersect(
    { x: -120, y: 8, z: 65 },
    { x: 120, y: 8, z: 65 },
    shipStern,
    shipBow,
    18,
  );
  assert.equal(missShip, false, 'bullet well ahead of ship bow must miss capsule');

  // Proximity fuse check: missile passing 9m from target triggers 10.5m proximity envelope
  const distSq = segmentSphereDistanceSq(
    { x: 0, y: 200, z: 0 },
    { x: 0, y: 200, z: -200 },
    { x: 9, y: 200, z: -100 },
  );
  assert.ok(Math.sqrt(distSq) <= 10.5, '9m near-miss must fall inside 10.5m proximity fuse');

  // Swept terrain impact catches projectile piercing a mountain peak between frames
  const peakH = getTerrainHeight(460, -1250);
  const hitMountain = segmentTerrainImpact(
    { x: 340, y: peakH - 25, z: -1250 },
    { x: 580, y: peakH - 25, z: -1250 },
    getTerrainHeight,
    4,
  );
  assert.equal(hitMountain, true, 'projectile tunneling through a mountain ridge must trigger swept terrain impact');
});

test('leaderboard anti-cheat validates plausible scores, rejects tampered payloads, and caps Top 100', () => {
  const validRes = validateLeaderboardSubmission({
    callsign: '  <عقاب> شمال  ',
    score: 4800,
    wave: 3,
    kills: 12,
    survivalTimeSec: 185,
    difficulty: 'normal',
  });
  assert.equal(validRes.valid, true, 'legitimate flight record should pass validation');
  assert.equal(validRes.sanitized?.callsign, 'عقاب شمال', 'HTML angle brackets must be stripped from callsign');

  const cheatedScore = validateLeaderboardSubmission({
    callsign: 'خلبان تقلبی',
    score: 999999,
    wave: 1,
    kills: 2,
    survivalTimeSec: 12,
    difficulty: 'hard',
  });
  assert.equal(cheatedScore.valid, false, 'implausibly high score must be rejected by anti-cheat');

  const shortName = validateLeaderboardSubmission({
    callsign: 'ا',
    score: 500,
    wave: 1,
    kills: 2,
    survivalTimeSec: 40,
    difficulty: 'easy',
  });
  assert.equal(shortName.valid, false, '1-char callsign must be rejected');

  // Top-100 sorting & cap check
  const many: LeaderboardEntry[] = [];
  for (let i = 0; i < 125; i++) {
    many.push({
      id: `p-${i}`,
      callsign: `خلبان ${i}`,
      score: i * 100,
      wave: 2,
      kills: 5,
      survivalTimeSec: 90,
      difficulty: 'normal',
      timestamp: 1700000000000 + i,
    });
  }
  const top100 = sortAndTrimTop100(many);
  assert.equal(top100.length, 100, 'leaderboard must trim strictly to Top 100');
  assert.equal(top100[0].score, 12400, 'highest score must rank #1');
  assert.equal(top100[99].score, 2500, '100th rank must match 25th lowest of 125');
});

test('continental terrain has mainland landmass, wide winding river channel, and eastern coastal sea', () => {
  const z = -900;
  const coastX = getCoastlineX(z);
  const riverX = getRiverCenterX(z);

  // Far east of coastline must be open coastal sea (height 0)
  assert.equal(
    getTerrainHeight(coastX + 350, z),
    0,
    'open sea east of coastline must be at water level y=0',
  );

  // Center of the wide navigable river channel must be water (height 0)
  assert.equal(
    getTerrainHeight(riverX, z),
    0,
    'winding continental river channel center must be open water y=0',
  );

  // Mainland continental interior well west of coastline & away from river must be elevated landmass
  const westernMainlandH = getTerrainHeight(-1200, -700);
  assert.ok(
    westernMainlandH > 18,
    `expected elevated continental mainland landmass in west, got ${westernMainlandH}`,
  );
});

test('enemy jet enforces strict >=320m standoff distance by breaking away cleanly', () => {
  assert.ok(
    MIN_ENGAGEMENT_DISTANCE >= 320,
    `MIN_ENGAGEMENT_DISTANCE must be >= 320m, got ${MIN_ENGAGEMENT_DISTANCE}`,
  );

  const unit = createEnemyUnit(
    99,
    'interceptor',
    new THREE.Vector3(0, 240, -280),
    0,
    1,
    'normal',
  );
  const events: EnemyActionEvents = {
    firedCannon: false,
    cannonOrigin: new THREE.Vector3(),
    cannonDir: new THREE.Vector3(),
    firedMissile: false,
    lockingPlayer: false,
    deployedFlare: false,
  };

  updateEnemyAI(
    unit,
    new THREE.Vector3(0, 240, 0),
    new THREE.Vector3(0, 0, -120),
    new THREE.Vector3(0, 0, -1),
    Infinity,
    false,
    true,
    0.03,
    events,
    getTerrainHeight,
    'normal',
  );

  assert.equal(
    unit.state,
    'BREAKAWAY',
    'enemy jet at 280m must immediately trigger BREAKAWAY to maintain standoff >= 320m',
  );
  assert.equal(
    events.firedCannon,
    false,
    'enemy jet inside minimum standoff radius must not fire close-range cannon',
  );
});

test('tactical strike missions define Persian objectives and tag primary targets across waves 1 to 4', () => {
  const m1 = getStrikeMissionDefinition(1);
  const m2 = getStrikeMissionDefinition(2);
  const m3 = getStrikeMissionDefinition(3);
  const m4 = getStrikeMissionDefinition(4);

  assert.equal(m1.objectiveKind, 'command');
  assert.equal(m2.objectiveKind, 'sam');
  assert.equal(m3.objectiveKind, 'warship');
  assert.equal(m4.objectiveKind, 'air');

  const wave1Surface = createStrikeSurfaceUnits(m1, 800, 'normal', getTerrainHeight);
  const wave1Primary = wave1Surface.filter((u) => u.isPrimaryObjective);
  assert.ok(wave1Primary.length >= 1, 'wave 1 strike mission must spawn primary command radar bunker');
  assert.ok(
    wave1Primary.every((u) => u.type === 'command'),
    'wave 1 primary objective targets must be command bunkers',
  );

  const wave2Surface = createStrikeSurfaceUnits(m2, 900, 'normal', getTerrainHeight);
  const wave2Primary = wave2Surface.filter((u) => u.isPrimaryObjective);
  assert.ok(wave2Primary.length >= 2, 'wave 2 strike mission must tag SAM batteries as primary');
  assert.ok(wave2Primary.every((u) => u.type === 'sam'));

  const wave3Surface = createStrikeSurfaceUnits(m3, 1000, 'normal', getTerrainHeight);
  const wave3Primary = wave3Surface.filter((u) => u.isPrimaryObjective);
  assert.ok(wave3Primary.length >= 1, 'wave 3 strike mission must tag naval warships as primary');
  assert.ok(wave3Primary.every((u) => u.type === 'warship' && u.position.y === 0));
});


