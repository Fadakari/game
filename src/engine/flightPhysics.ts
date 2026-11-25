import * as THREE from 'three';
import { getTerrainHeight, PLAYABLE_RADIUS } from './terrain';
import type { ControlInput, Vec3 } from './types';

export interface FlightState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  speed: number; // world units/sec (1 unit = 1 meter; 120 m/s = 432 km/h)
  pitchRate: number;
  rollRate: number;
  yawRate: number;
  afterburnerHeat: number; // 0..100
  afterburnerOverheated: boolean;
  afterburnerActive: boolean;
  throttle: number; // 0..1
}

export const FLIGHT_CONFIG = {
  minSpeed: 72,
  cruiseSpeed: 128,
  maxBoostSpeed: 215,
  pitchTorque: 1.95,
  rollTorque: 3.1,
  maxBankRad: 1.18, // ~67.5 degrees — crisp combat bank without flipping upside down
  coupledYawFactor: 1.15,
  directTurnYawFactor: 0.65,
  manualYawRate: 0.85,
  autoLevelStrength: 2.6,
  gravityAccel: 26,
  boostAccel: 78,
  dragDecel: 28,
  heatRate: 30,
  coolRate: 21,
  overheatRecoverThreshold: 32,
  ceilingAltitude: 1150,
  gpwsAltitudeThreshold: 48,
  gpwsDiveRateThreshold: -22,
};

// Reusable scratch math objects (zero GC per frame)
const _localPitchQuat = new THREE.Quaternion();
const _localRollQuat = new THREE.Quaternion();
const _worldYawQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

export function createInitialFlightState(): FlightState {
  const state: FlightState = {
    position: new THREE.Vector3(0, 225, 360),
    quaternion: new THREE.Quaternion(), // facing -Z toward twin mountain islands
    velocity: new THREE.Vector3(0, 0, -FLIGHT_CONFIG.cruiseSpeed),
    speed: FLIGHT_CONFIG.cruiseSpeed,
    pitchRate: 0,
    rollRate: 0,
    yawRate: 0,
    afterburnerHeat: 0,
    afterburnerOverheated: false,
    afterburnerActive: false,
    throttle: 0.65,
  };
  return state;
}

/**
 * Steps smooth 6-DOF arcade-sim hybrid flight physics.
 * - Holding Left/Right banks cleanly up to ~68° and carves a tight, responsive fighter turn
 *   (instead of spinning uncontrollably in place).
 * - Auto-levels smoothly when stick is released.
 * - Climbing bleeds speed; diving builds speed; afterburner adds thrust with heat/cooldown.
 */
export function stepFlightPhysics(
  state: FlightState,
  input: ControlInput,
  dt: number,
): void {
  const clampedDt = Math.min(Math.max(dt, 0), 0.05);
  if (clampedDt <= 0) return;

  // 1. Afterburner heat & overheat management
  const wantsBoost = input.boost && !state.afterburnerOverheated;
  state.afterburnerActive = wantsBoost;
  if (wantsBoost) {
    state.afterburnerHeat = Math.min(
      100,
      state.afterburnerHeat + FLIGHT_CONFIG.heatRate * clampedDt,
    );
    if (state.afterburnerHeat >= 100) {
      state.afterburnerOverheated = true;
      state.afterburnerActive = false;
    }
  } else {
    state.afterburnerHeat = Math.max(
      0,
      state.afterburnerHeat - FLIGHT_CONFIG.coolRate * clampedDt,
    );
    if (
      state.afterburnerOverheated &&
      state.afterburnerHeat <= FLIGHT_CONFIG.overheatRecoverThreshold
    ) {
      state.afterburnerOverheated = false;
    }
  }

  // 2. Extract current orientation basis
  _forward.set(0, 0, -1).applyQuaternion(state.quaternion).normalize();
  _right.set(1, 0, 0).applyQuaternion(state.quaternion).normalize();
  _up.set(0, 1, 0).applyQuaternion(state.quaternion).normalize();

  // Compute current signed bank angle (right wing down = negative angle)
  const currentBank = Math.atan2(_right.y, Math.max(0.08, _up.y));
  const pitchCos = Math.sqrt(Math.max(0.12, 1 - _forward.y * _forward.y));

  // Smooth pitch control with soft ceiling/nosedive guard
  const dampRate = 1 - Math.exp(-9.5 * clampedDt);
  let targetPitchRate = input.pitch * FLIGHT_CONFIG.pitchTorque;
  // Soft pitch clamp near ±76° so jet never gimbal-flips awkwardly during dogfights
  if (_forward.y > 0.94 && targetPitchRate > 0) targetPitchRate = 0;
  if (_forward.y < -0.94 && targetPitchRate < 0) targetPitchRate = 0;
  state.pitchRate += (targetPitchRate - state.pitchRate) * dampRate;

  // Responsive target-bank roll steering: holds a dramatic ~68° combat bank while turning sharply
  const desiredBank = -input.roll * FLIGHT_CONFIG.maxBankRad;
  const bankError = desiredBank - currentBank;
  const bankStiffness = Math.abs(input.roll) > 0.06 ? 5.2 : FLIGHT_CONFIG.autoLevelStrength;
  const targetRollRate = THREE.MathUtils.clamp(
    bankError * bankStiffness,
    -FLIGHT_CONFIG.rollTorque,
    FLIGHT_CONFIG.rollTorque,
  );
  state.rollRate += (targetRollRate - state.rollRate) * dampRate;

  // Apply local pitch (X) and controlled local roll (Z)
  _localPitchQuat.setFromAxisAngle(_axisX, state.pitchRate * clampedDt);
  _localRollQuat.setFromAxisAngle(_axisZ, state.rollRate * clampedDt);
  state.quaternion.multiply(_localPitchQuat);
  state.quaternion.multiply(_localRollQuat);

  // Re-extract basis after pitch/roll
  _forward.set(0, 0, -1).applyQuaternion(state.quaternion).normalize();
  _right.set(1, 0, 0).applyQuaternion(state.quaternion).normalize();
  _up.set(0, 1, 0).applyQuaternion(state.quaternion).normalize();

  // 3. Agile Coupled + Direct Yaw Turn so left/right immediately carves a crisp combat turn
  const bankSin = THREE.MathUtils.clamp(-_right.y, -1, 1);
  const coupledYaw = -bankSin * FLIGHT_CONFIG.coupledYawFactor * pitchCos;
  const directTurnYaw = -input.roll * FLIGHT_CONFIG.directTurnYawFactor * pitchCos;
  const manualYaw = -input.yaw * FLIGHT_CONFIG.manualYawRate;
  state.yawRate += (coupledYaw + directTurnYaw + manualYaw - state.yawRate) * dampRate;

  _worldYawQuat.setFromAxisAngle(_worldUp, state.yawRate * clampedDt);
  state.quaternion.premultiply(_worldYawQuat);

  // Soft pitch ceiling guard near altitude cap
  if (state.position.y > FLIGHT_CONFIG.ceilingAltitude && _forward.y > 0) {
    const pushDown = -(_forward.y * 1.4) * clampedDt;
    _localPitchQuat.setFromAxisAngle(_axisX, pushDown);
    state.quaternion.multiply(_localPitchQuat);
  }

  // Soft outer boundary turnback so player stays in combat theater
  const radialDist = Math.hypot(state.position.x, state.position.z);
  if (radialDist > PLAYABLE_RADIUS) {
    const toCenterX = -state.position.x / radialDist;
    const toCenterZ = -state.position.z / radialDist;
    const crossY = _forward.z * toCenterX - _forward.x * toCenterZ;
    const turnStrength = Math.min(1, (radialDist - PLAYABLE_RADIUS) / 420) * 1.35;
    _worldYawQuat.setFromAxisAngle(_worldUp, crossY * turnStrength * clampedDt);
    state.quaternion.premultiply(_worldYawQuat);
  }

  state.quaternion.normalize();

  // 5. Recompute forward & airspeed dynamics (climb slows, dive accelerates)
  _forward.set(0, 0, -1).applyQuaternion(state.quaternion).normalize();
  const baseSpeed = state.afterburnerActive
    ? FLIGHT_CONFIG.maxBoostSpeed
    : FLIGHT_CONFIG.cruiseSpeed;
  // Energy equilibrium shifts downward when climbing (+forward.y) and upward when diving (-forward.y)
  const energyTargetSpeed = baseSpeed - _forward.y * 46;

  // Immediate gravitational energy exchange + smooth aerodynamic thrust/drag response
  state.speed += -_forward.y * FLIGHT_CONFIG.gravityAccel * clampedDt;
  const speedResp = state.afterburnerActive ? 2.6 : 1.35;
  state.speed += (energyTargetSpeed - state.speed) * (1 - Math.exp(-speedResp * clampedDt));

  state.speed = THREE.MathUtils.clamp(
    state.speed,
    FLIGHT_CONFIG.minSpeed,
    FLIGHT_CONFIG.maxBoostSpeed + 32,
  );

  // 6. Integrate position
  state.velocity.copy(_forward).multiplyScalar(state.speed);
  state.position.addScaledVector(state.velocity, clampedDt);
}

// Jet bounding probe offsets in local jet space (nose, belly, left/right wingtips, tail)
const JET_PROBE_POINTS: ReadonlyArray<[number, number, number]> = [
  [0, -0.9, 0], // belly
  [0, 0, -6.2], // nose cone
  [-5.2, -0.2, 1.2], // left wingtip
  [5.2, -0.2, 1.2], // right wingtip
  [0, -0.5, 4.8], // tail exhaust
];

const _probeWorld = new THREE.Vector3();

/**
 * Exact bounding-point check against ocean (y <= 0) and procedural terrain (y <= getTerrainHeight(x, z)).
 */
export function checkTerrainCollision(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): 'none' | 'ocean' | 'terrain' {
  for (let i = 0; i < JET_PROBE_POINTS.length; i++) {
    const pt = JET_PROBE_POINTS[i];
    _probeWorld.set(pt[0], pt[1], pt[2]).applyQuaternion(quaternion).add(position);
    if (_probeWorld.y <= 0.5) {
      return 'ocean';
    }
    const groundY = heightSampler(_probeWorld.x, _probeWorld.z);
    if (groundY > 0.2 && _probeWorld.y <= groundY + 1.2) {
      return 'terrain';
    }
  }
  return 'none';
}

/**
 * Ground Proximity Warning System (GPWS) evaluation using current AGL & forward look-ahead.
 */
export function evaluateGPWS(
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
): { warning: boolean; agl: number } {
  const groundNow = heightSampler(position.x, position.z);
  const agl = Math.max(0, position.y - Math.max(0, groundNow));

  // Predict position 1.4 seconds ahead along velocity vector
  const predX = position.x + velocity.x * 1.4;
  const predY = position.y + velocity.y * 1.4;
  const predZ = position.z + velocity.z * 1.4;
  const groundAhead = heightSampler(predX, predZ);
  const aglAhead = predY - Math.max(0, groundAhead);

  const lowNow = agl < FLIGHT_CONFIG.gpwsAltitudeThreshold;
  const divingLow =
    agl < 95 && velocity.y < FLIGHT_CONFIG.gpwsDiveRateThreshold;
  const terrainAheadDanger = aglAhead < 22;

  return {
    warning: lowNow || divingLow || terrainAheadDanger,
    agl,
  };
}

/**
 * Computes exact 3D predictive lead intercept point for an autocannon projectile.
 * Solves |P_t + V_t * t - P_s| = v_b * t for smallest positive t.
 */
export function computeLeadPosition(
  shooterPos: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  bulletSpeed: number,
  out?: Vec3,
): { x: number; y: number; z: number; timeToImpact: number } {
  const rx = targetPos.x - shooterPos.x;
  const ry = targetPos.y - shooterPos.y;
  const rz = targetPos.z - shooterPos.z;

  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;

  const a = vx * vx + vy * vy + vz * vz - bulletSpeed * bulletSpeed;
  const b = 2 * (rx * vx + ry * vy + rz * vz);
  const c = rx * rx + ry * ry + rz * rz;

  let t = Math.sqrt(c) / Math.max(bulletSpeed, 1);

  if (Math.abs(a) < 1e-4) {
    if (Math.abs(b) > 1e-4) {
      const linearT = -c / b;
      if (linearT > 0) t = linearT;
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t1 = (-b - sqrtDisc) / (2 * a);
      const t2 = (-b + sqrtDisc) / (2 * a);
      if (t1 > 0 && t2 > 0) {
        t = Math.min(t1, t2);
      } else if (t1 > 0) {
        t = t1;
      } else if (t2 > 0) {
        t = t2;
      }
    }
  }

  // Clamp lead prediction horizon to realistic gun engagement range
  t = Math.min(Math.max(t, 0), 3.2);
  const lx = targetPos.x + vx * t;
  const ly = targetPos.y + vy * t;
  const lz = targetPos.z + vz * t;

  if (out) {
    out.x = lx;
    out.y = ly;
    out.z = lz;
  }
  return { x: lx, y: ly, z: lz, timeToImpact: t };
}

/**
 * True 3D Proportional Navigation (PN) guidance law for radar-guided missiles.
 * Computes LOS rotation vector Omega = (R x V_rel) / |R|^2
 * and commanded lateral acceleration a_cmd = N * V_c * (Omega x u_los),
 * steering missile velocity smoothly onto a collision triangle.
 */
export function stepProportionalNavigation(
  missilePos: THREE.Vector3,
  missileVel: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  missileSpeed: number,
  maxLateralAccel: number,
  navConstant: number,
  dt: number,
): void {
  const rx = targetPos.x - missilePos.x;
  const ry = targetPos.y - missilePos.y;
  const rz = targetPos.z - missilePos.z;
  const rSq = rx * rx + ry * ry + rz * rz;
  if (rSq < 1e-4) return;

  const rLen = Math.sqrt(rSq);
  const ux = rx / rLen;
  const uy = ry / rLen;
  const uz = rz / rLen;

  // Relative velocity V_rel = V_target - V_missile
  const vrx = targetVel.x - missileVel.x;
  const vry = targetVel.y - missileVel.y;
  const vrz = targetVel.z - missileVel.z;

  // Closing speed V_c = -(V_rel . u_los)
  const closingSpeed = Math.max(missileSpeed * 0.45, -(vrx * ux + vry * uy + vrz * uz));

  // LOS rotation rate Omega = (R x V_rel) / |R|^2
  const ox = (ry * vrz - rz * vry) / rSq;
  const oy = (rz * vrx - rx * vrz) / rSq;
  const oz = (rx * vry - ry * vrx) / rSq;

  // Lateral acceleration command: a_cmd = N * V_c * (Omega x u_los)
  // Using (Omega x u_los) yields lateral vector turning missile velocity into LOS rotation
  let ax = navConstant * closingSpeed * (oy * uz - oz * uy);
  let ay = navConstant * closingSpeed * (oz * ux - ox * uz);
  let az = navConstant * closingSpeed * (ox * uy - oy * ux);

  // Add subtle pure-pursuit stabilizer when opening angle is wide (> 60 deg)
  const vLen = missileVel.length() || 1;
  const align = (missileVel.x * ux + missileVel.y * uy + missileVel.z * uz) / vLen;
  if (align < 0.5) {
    const boostPull = (0.5 - align) * maxLateralAccel * 0.9;
    ax += ux * boostPull;
    ay += uy * boostPull;
    az += uz * boostPull;
  }

  const aMag = Math.hypot(ax, ay, az);
  if (aMag > maxLateralAccel) {
    const scale = maxLateralAccel / aMag;
    ax *= scale;
    ay *= scale;
    az *= scale;
  }

  missileVel.x += ax * dt;
  missileVel.y += ay * dt;
  missileVel.z += az * dt;

  // Maintain constant rocket motor airspeed
  const newLen = missileVel.length();
  if (newLen > 1e-4) {
    missileVel.multiplyScalar(missileSpeed / newLen);
  }
}

/**
 * Exact minimum squared distance from swept segment [p0 -> p1] to a point/center.
 * Enables zero-tunneling CCD hit detection AND proximity-fuse blast distance calculation.
 */
export function segmentSphereDistanceSq(
  p0: Vec3,
  p1: Vec3,
  center: Vec3,
): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;

  const fx = p0.x - center.x;
  const fy = p0.y - center.y;
  const fz = p0.z - center.z;

  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-8) {
    return fx * fx + fy * fy + fz * fz;
  }

  let t = -(fx * dx + fy * dy + fz * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const cx = p0.x + dx * t - center.x;
  const cy = p0.y + dy * t - center.y;
  const cz = p0.z + dz * t - center.z;

  return cx * cx + cy * cy + cz * cz;
}

/**
 * Exact ray-segment vs sphere intersection so high-velocity autocannon rounds & missiles never tunnel.
 */
export function segmentSphereIntersect(
  p0: Vec3,
  p1: Vec3,
  center: Vec3,
  radius: number,
): boolean {
  return segmentSphereDistanceSq(p0, p1, center) <= radius * radius;
}

/**
 * Swept line-segment to capsule intersection (closest distance between segment [p0,p1] and segment [capA,capB] <= radius).
 * Used for elongated naval warships & aircraft fuselages with zero allocations.
 */
export function segmentCapsuleIntersect(
  p0: Vec3,
  p1: Vec3,
  capA: Vec3,
  capB: Vec3,
  radius: number,
): boolean {
  const ux = p1.x - p0.x;
  const uy = p1.y - p0.y;
  const uz = p1.z - p0.z;

  const vx = capB.x - capA.x;
  const vy = capB.y - capA.y;
  const vz = capB.z - capA.z;

  const wx = p0.x - capA.x;
  const wy = p0.y - capA.y;
  const wz = p0.z - capA.z;

  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const denom = a * c - b * b;

  let sN: number;
  let sD = denom;
  let tN: number;
  let tD = denom;

  if (denom < 1e-6) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) {
      sN = 0;
    } else if (-d > a) {
      sN = sD;
    } else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) {
      sN = 0;
    } else if (-d + b > a) {
      sN = sD;
    } else {
      sN = -d + b;
      sD = a;
    }
  }

  const sc = Math.abs(sN) < 1e-7 ? 0 : sN / (sD || 1);
  const tc = Math.abs(tN) < 1e-7 ? 0 : tN / (tD || 1);

  const dx = wx + sc * ux - tc * vx;
  const dy = wy + sc * uy - tc * vy;
  const dz = wz + sc * uz - tc * vz;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * Swept terrain/ocean impact check along projectile segment [p0 -> p1] so fast bullets & missiles
 * never tunnel through steep canyon ridges or ocean waves.
 */
export function segmentTerrainImpact(
  p0: Vec3,
  p1: Vec3,
  heightSampler: (x: number, z: number) => number = getTerrainHeight,
  steps = 4,
): boolean {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = p0.x + dx * t;
    const y = p0.y + dy * t;
    const z = p0.z + dz * t;
    if (y <= 0.3 || y <= heightSampler(x, z)) {
      return true;
    }
  }
  return false;
}
