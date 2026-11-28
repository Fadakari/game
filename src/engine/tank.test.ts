import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWarTornCityLayout,
  hasCityLineOfSight,
  resolveCircleCityCollision,
  segmentAabbIntersect,
  segmentCityImpact,
} from './tankCity';
import {
  computeDirectionalArmorHit,
  computeTankBallisticFireDir,
  createEnemyTankUnit,
  createInitialTankState,
  getTankWaveDefinition,
  stepTankHullPhysics,
  stepTurretAim,
  TANK_PHYSICS_CONFIG,
  updateEnemyTankAI,
  type EnemyTankActionEvents,
} from './tankPhysics';
import { validateLeaderboardSubmission } from '../services/edgeLeaderboard';
import type { TankControlInput } from './types';

const NEUTRAL_TANK_INPUT: TankControlInput = {
  throttle: 0,
  steer: 0,
  fireCannon: false,
  fireMg: false,
  boost: false,
  smoke: false,
};

test('war-torn city spawns player cleanly on an open avenue with navigable streets and clear sightline', () => {
  const layout = createWarTornCityLayout();
  assert.ok(layout.buildings.length >= 25, 'expected dense procedural city blocks');
  assert.ok(layout.barricades.length >= 12, 'expected street concrete barricades');
  assert.ok(layout.smokeAnchors.length >= 6, 'expected atmospheric smoke plume anchors');

  // Verify spawn point does not collide with any building or barricade
  const col = { x: 0, z: 0, collided: false };
  resolveCircleCityCollision(
    layout.playerSpawn.x,
    layout.playerSpawn.z,
    TANK_PHYSICS_CONFIG.hullRadius,
    layout.aabbs,
    col,
  );
  assert.equal(col.collided, false, 'player spawn must sit cleanly inside an open avenue');

  // Verify clear forward sightline down the central boulevard from spawn
  const clearAhead = hasCityLineOfSight(
    { x: layout.playerSpawn.x, y: 2.2, z: layout.playerSpawn.z },
    { x: layout.playerSpawn.x, y: 2.2, z: layout.playerSpawn.z - 120 },
    layout.aabbs,
  );
  assert.equal(clearAhead, true, 'central avenue ahead of spawn must have clear sightline');
});

test('circle-vs-AABB collision smoothly slides tank along building walls without penetrating or snagging', () => {
  const layout = createWarTornCityLayout();
  // Pick the building at (32, 32)
  const b = layout.aabbs.find((a) => a.kind === 'building' && a.minX > 10 && a.minZ > 10);
  assert.ok(b, 'expected southeast central building AABB');

  const r = TANK_PHYSICS_CONFIG.hullRadius;
  // Drive diagonally into the west wall of the building
  const targetX = b.minX + 1.2; // inside wall
  const targetZ = (b.minZ + b.maxZ) * 0.5 + 2.5;
  const out = { x: 0, z: 0, collided: false };
  resolveCircleCityCollision(targetX, targetZ, r, layout.aabbs, out);

  assert.equal(out.collided, true, 'wall penetration must report collision');
  assert.ok(
    out.x <= b.minX - r + 0.01,
    `tank hull must be pushed cleanly outside west wall (${b.minX - r}), got ${out.x}`,
  );
  assert.ok(
    Math.abs(out.z - targetZ) < 0.05,
    'sliding tangent coordinate Z must remain unobstructed along the wall',
  );
});

test('independent tank hull kinematics, turbo surge, and finite turret traverse behave realistically', () => {
  const layout = createWarTornCityLayout();
  const tank = createInitialTankState(layout.playerSpawn);
  const startZ = tank.z;

  // Drive forward with Turbo for 1s (25 * 0.04s)
  for (let i = 0; i < 25; i++) {
    stepTankHullPhysics(tank, { ...NEUTRAL_TANK_INPUT, throttle: 1, boost: true }, 0.04, layout.aabbs);
  }
  assert.ok(tank.z < startZ - 15, 'tank should drive swiftly forward down -Z avenue');
  assert.ok(tank.speed > TANK_PHYSICS_CONFIG.maxForwardSpeed, 'turbo must exceed standard top speed');
  assert.ok(tank.turboCharge < 80, 'turbo must consume charge');

  // Independent turret traverse slews smoothly toward 90-degree right aim without teleporting
  const targetYaw = -Math.PI / 2;
  const errAfterOneStep = stepTurretAim(tank, targetYaw, 0.05, 0.04);
  assert.ok(errAfterOneStep > 1.2, 'heavy turret should slew at finite traverse rate, not snap instantly');

  for (let i = 0; i < 40; i++) {
    stepTurretAim(tank, targetYaw, 0.05, 0.04);
  }
  const finalErr = stepTurretAim(tank, targetYaw, 0.05, 0.04);
  assert.ok(finalErr < 0.02, `turret should converge onto target yaw within 1.6s, got err=${finalErr}`);
});

test('directional armor reduces frontal damage and rewards side/rear flanking with critical bonus', () => {
  // Enemy tank facing North (-Z, hullYaw = 0)
  const hullYaw = 0;
  const baseDamage = 100;

  // Shell travelling South (+Z) hits enemy squarely in the front glacis
  const frontHit = computeDirectionalArmorHit({ x: 0, z: 1 }, hullYaw, baseDamage);
  assert.equal(frontHit.zone, 'front');
  assert.equal(frontHit.isFlankCritical, false);
  assert.ok(frontHit.damage < baseDamage, `front armor must reduce damage (${frontHit.damage})`);

  // Shell travelling East (+X) hits enemy in the side flank
  const sideHit = computeDirectionalArmorHit({ x: 1, z: 0 }, hullYaw, baseDamage);
  assert.equal(sideHit.zone, 'side');
  assert.equal(sideHit.isFlankCritical, true);
  assert.ok(sideHit.damage > baseDamage * 1.25, `side flank must deal bonus damage (${sideHit.damage})`);

  // Shell travelling North (-Z) hits enemy in the rear engine deck
  const rearHit = computeDirectionalArmorHit({ x: 0, z: -1 }, hullYaw, baseDamage);
  assert.equal(rearHit.zone, 'rear');
  assert.equal(rearHit.isFlankCritical, true);
  assert.ok(rearHit.damage > sideHit.damage, `rear hit (${rearHit.damage}) must exceed side hit (${sideHit.damage})`);
});

test('swept CCD ray-AABB intersection catches high-speed shells without tunneling through buildings', () => {
  const layout = createWarTornCityLayout();
  const building = layout.aabbs.find((a) => a.kind === 'building' && a.maxY > 8)!;
  const midZ = (building.minZ + building.maxZ) * 0.5;

  // High-speed shell traversing 80m in one frame across the building
  const hitT = segmentAabbIntersect(
    { x: building.minX - 30, y: 2.0, z: midZ },
    { x: building.maxX + 30, y: 2.0, z: midZ },
    building,
  );
  assert.ok(hitT >= 0 && hitT <= 1, 'high-speed shell crossing building AABB must register CCD hit');

  const highOverT = segmentCityImpact(
    { x: building.minX - 30, y: building.maxY + 12, z: midZ },
    { x: building.maxX + 30, y: building.maxY + 12, z: midZ },
    layout.aabbs,
    true,
  );
  assert.equal(highOverT, -1, 'projectile flying well above rooftop should not hit building');
});

test('enemy tank AI FSM transitions cleanly across ENGAGE, RETREAT_SMOKE, and escalating waves', () => {
  const layout = createWarTornCityLayout();
  const w1 = getTankWaveDefinition(1);
  const w3 = getTankWaveDefinition(3);
  assert.ok(w1.units.includes('buggy') && w1.units.includes('mbt'));
  assert.ok(w3.units.includes('siege'), 'wave 3 must introduce Heavy Siege Tank boss');

  const player = createInitialTankState(layout.playerSpawn);
  const enemy = createEnemyTankUnit(1, 'mbt', 0, -10, 1, 'normal');
  const ev: EnemyTankActionEvents = {
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

  // Clear LOS down central avenue -> should enter ENGAGE
  updateEnemyTankAI(enemy, player, false, true, 0.04, layout, 'normal', ev);
  assert.equal(enemy.state, 'ENGAGE', 'enemy with clear LOS in range should enter ENGAGE');

  // Heavily damage enemy (<36% HP) -> should pop defensive smoke and enter RETREAT_SMOKE
  enemy.hp = Math.round(enemy.maxHp * 0.25);
  updateEnemyTankAI(enemy, player, false, true, 0.04, layout, 'normal', ev);
  assert.equal(enemy.state, 'RETREAT_SMOKE', 'heavily damaged enemy tank must trigger RETREAT_SMOKE');
  assert.equal(ev.deployedSmoke, true, 'RETREAT_SMOKE must emit defensive smoke deployment event');
});

test('leaderboard validation accepts tank and jet modes safely', () => {
  const tankSub = validateLeaderboardSubmission({
    callsign: 'فرمانده زرهی',
    score: 5200,
    wave: 3,
    kills: 14,
    survivalTimeSec: 210,
    difficulty: 'normal',
    mode: 'tank',
  });
  assert.equal(tankSub.valid, true);
  assert.equal(tankSub.sanitized?.mode, 'tank');

  const jetSub = validateLeaderboardSubmission({
    callsign: 'خلبان شکاری',
    score: 4100,
    wave: 3,
    kills: 10,
    survivalTimeSec: 175,
    difficulty: 'hard',
    mode: 'jet',
  });
  assert.equal(jetSub.valid, true);
  assert.equal(jetSub.sanitized?.mode, 'jet');
});

test('close-range tank barrel depression aims steeply downward and hits enemy hull without overshooting turret', () => {
  assert.ok(
    TANK_PHYSICS_CONFIG.minBarrelPitch <= -0.32,
    `expected deep gun depression <= -0.32 rad, got ${TANK_PHYSICS_CONFIG.minBarrelPitch}`,
  );

  const layout = createWarTornCityLayout();
  const tank = createInitialTankState(layout.playerSpawn);

  // Command deep downward barrel depression (-0.30 rad) and confirm turret converges cleanly
  for (let i = 0; i < 30; i++) {
    stepTurretAim(tank, 0, -0.3, 0.04);
  }
  assert.ok(
    tank.barrelPitch <= -0.29,
    `barrel must depress smoothly to <= -0.29 rad, got ${tank.barrelPitch}`,
  );

  // Verify ballistic solver aims downward from high muzzle (y=2.06) to close enemy hull (16m away, y=1.22)
  const muzzle = { x: 0, y: 2.06, z: 0 };
  const closeEnemyHull = { x: 0, y: 1.22, z: -16 };
  const fireDir = { x: 0, y: 0, z: 0 };
  computeTankBallisticFireDir(
    muzzle,
    closeEnemyHull,
    TANK_PHYSICS_CONFIG.shellSpeed,
    TANK_PHYSICS_CONFIG.shellGravity,
    fireDir,
  );

  assert.ok(
    fireDir.y < -0.03,
    `close-range ballistic trajectory must depress downward (fireDir.y=${fireDir.y})`,
  );

  // Simulate shell flight to z = -16 and verify height intersects enemy hull cleanly
  const speed = TANK_PHYSICS_CONFIG.shellSpeed;
  const t = 16 / Math.abs(fireDir.z * speed);
  const impactY =
    muzzle.y + fireDir.y * speed * t - 0.5 * TANK_PHYSICS_CONFIG.shellGravity * t * t;
  assert.ok(
    Math.abs(impactY - closeEnemyHull.y) < 0.08,
    `close-range shell must impact enemy hull center (${closeEnemyHull.y}m), got ${impactY.toFixed(3)}m`,
  );
});

