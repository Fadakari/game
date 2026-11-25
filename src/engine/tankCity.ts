import * as THREE from 'three';
import type { CityAabb, Vec3 } from './types';

export const CITY_PLAYABLE_HALF = 186;
export const CITY_GRID_STEP = 64; // 34m city block + 30m navigable avenue

export interface BuildingSpec {
  id: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  baseH: number;
  upperH: number;
  ruinTiltX: number;
  ruinTiltZ: number;
  variant: 0 | 1 | 2;
  hasSmokeAnchor: boolean;
}

export interface BarricadeSpec {
  x: number;
  z: number;
  length: number;
  width: number;
  rotated: boolean;
}

export interface WreckSpec {
  x: number;
  z: number;
  yaw: number;
}

export interface CityLayout {
  buildings: BuildingSpec[];
  barricades: BarricadeSpec[];
  wrecks: WreckSpec[];
  aabbs: CityAabb[];
  buildingFootprints: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  intersections: Array<{ x: number; z: number }>;
  smokeAnchors: Array<{ x: number; y: number; z: number }>;
  playerSpawn: { x: number; z: number; yaw: number };
  enemySpawns: Array<{ x: number; z: number }>;
}

// Deterministic fast LCG so the ruined city is 100% consistent across runs & tests
function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generates a grid-based war-torn urban battlefield with wide 30m avenues,
 * clear intersections, flanking side alleys, concrete barricades, and burned-out wrecks.
 * Guarantees open sightlines down central boulevards and zero spawn-box traps.
 */
export function createWarTornCityLayout(): CityLayout {
  const rand = createRng(904217);
  const buildings: BuildingSpec[] = [];
  const barricades: BarricadeSpec[] = [];
  const wrecks: WreckSpec[] = [];
  const aabbs: CityAabb[] = [];
  const buildingFootprints: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
  const smokeAnchors: Array<{ x: number; y: number; z: number }> = [];

  // City blocks centered at ±32, ±96, ±160 -> avenues run cleanly along x/z = 0, ±64, ±128
  const blockCenters = [-160, -96, -32, 32, 96, 160];
  let bId = 1;

  for (let gx = 0; gx < blockCenters.length; gx++) {
    for (let gz = 0; gz < blockCenters.length; gz++) {
      const cx = blockCenters[gx];
      const cz = blockCenters[gz];
      const distFromCenter = Math.hypot(cx, cz);

      // Keep one inner plaza quadrant slightly more open for a dramatic central square
      if (Math.abs(cx) === 32 && Math.abs(cz) === 32 && gx === 2 && gz === 2) {
        // Ruined low fountain plaza rubble instead of tall tower
        const w = 13;
        const d = 13;
        const baseH = 3.2;
        buildings.push({
          id: bId++,
          cx,
          cz,
          w,
          d,
          baseH,
          upperH: 0,
          ruinTiltX: 0.08,
          ruinTiltZ: -0.06,
          variant: 2,
          hasSmokeAnchor: true,
        });
        aabbs.push({
          minX: cx - w * 0.5,
          maxX: cx + w * 0.5,
          minZ: cz - d * 0.5,
          maxZ: cz + d * 0.5,
          maxY: baseH + 1,
          kind: 'building',
        });
        buildingFootprints.push({
          minX: cx - w * 0.5,
          maxX: cx + w * 0.5,
          minZ: cz - d * 0.5,
          maxZ: cz + d * 0.5,
        });
        smokeAnchors.push({ x: cx, y: baseH + 1.2, z: cz });
        continue;
      }

      // Tall landmark ruined clocktower / citadel framing the spawn boulevard ahead (-Z)
      const isLandmark = (cx === -32 && cz === -96) || (cx === 32 && cz === -96);
      const w = isLandmark ? 24 : 20 + rand() * 8;
      const d = isLandmark ? 24 : 20 + rand() * 8;
      const baseH = isLandmark ? 18 + rand() * 5 : 8 + rand() * 9;
      const upperH = isLandmark ? 12 + rand() * 6 : distFromCenter < 130 ? 5 + rand() * 8 : 3 + rand() * 6;
      const variant = (Math.floor(rand() * 3) % 3) as 0 | 1 | 2;
      const hasSmokeAnchor = isLandmark || (distFromCenter < 145 && rand() < 0.34);

      buildings.push({
        id: bId++,
        cx,
        cz,
        w,
        d,
        baseH,
        upperH,
        ruinTiltX: (rand() - 0.5) * 0.24,
        ruinTiltZ: (rand() - 0.5) * 0.24,
        variant,
        hasSmokeAnchor,
      });

      const minX = cx - w * 0.5;
      const maxX = cx + w * 0.5;
      const minZ = cz - d * 0.5;
      const maxZ = cz + d * 0.5;
      aabbs.push({
        minX,
        maxX,
        minZ,
        maxZ,
        maxY: baseH + upperH,
        kind: 'building',
      });
      buildingFootprints.push({ minX, maxX, minZ, maxZ });

      if (hasSmokeAnchor) {
        smokeAnchors.push({
          x: cx + (rand() - 0.5) * w * 0.35,
          y: baseH + upperH * 0.55,
          z: cz + (rand() - 0.5) * d * 0.35,
        });
      }
    }
  }

  // Navigable street intersection graph (avenues at -128, -64, 0, 64, 128)
  const avenueCoords = [-128, -64, 0, 64, 128];
  const intersections: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < avenueCoords.length; i++) {
    for (let j = 0; j < avenueCoords.length; j++) {
      intersections.push({ x: avenueCoords[i], z: avenueCoords[j] });
    }
  }

  // Concrete street barricades (سنگر بتنی) tucked neatly along avenue edges (never blocking street center)
  const barricadeSites: Array<{ x: number; z: number; rotated: boolean }> = [
    { x: -11, z: -26, rotated: false },
    { x: 11, z: -48, rotated: false },
    { x: -11, z: 32, rotated: false },
    { x: 11, z: -102, rotated: false },
    { x: -53, z: -26, rotated: false },
    { x: 75, z: -30, rotated: false },
    { x: -75, z: 34, rotated: false },
    { x: 53, z: 38, rotated: false },
    { x: -28, z: -53, rotated: true },
    { x: 32, z: -75, rotated: true },
    { x: -30, z: 53, rotated: true },
    { x: 30, z: 75, rotated: true },
    { x: -96, z: -11, rotated: true },
    { x: 96, z: 11, rotated: true },
    { x: -96, z: -75, rotated: true },
    { x: 96, z: -53, rotated: true },
    { x: -11, z: -144, rotated: false },
    { x: 11, z: 96, rotated: false },
  ];

  for (let i = 0; i < barricadeSites.length; i++) {
    const s = barricadeSites[i];
    const length = 6.2;
    const width = 1.6;
    barricades.push({
      x: s.x,
      z: s.z,
      length,
      width,
      rotated: s.rotated,
    });
    const hx = s.rotated ? width * 0.5 : length * 0.5;
    const hz = s.rotated ? length * 0.5 : width * 0.5;
    aabbs.push({
      minX: s.x - hx,
      maxX: s.x + hx,
      minZ: s.z - hz,
      maxZ: s.z + hz,
      maxY: 1.85,
      kind: 'barricade',
    });
  }

  // Burned-out armored wrecks parked near curbs for warzone atmosphere & low tactical cover
  const wreckSites: WreckSpec[] = [
    { x: 10.5, z: -18, yaw: 0.35 },
    { x: -10.8, z: -84, yaw: -0.45 },
    { x: 54, z: -8, yaw: 1.4 },
    { x: -54, z: 12, yaw: -1.35 },
    { x: 74, z: -88, yaw: 0.2 },
    { x: -74, z: -78, yaw: 2.8 },
    { x: -26, z: 74, yaw: 1.7 },
    { x: 34, z: 54, yaw: -1.1 },
    { x: 118, z: -10, yaw: 0.6 },
    { x: -118, z: 10, yaw: 2.3 },
  ];

  for (let i = 0; i < wreckSites.length; i++) {
    const w = wreckSites[i];
    wrecks.push(w);
    aabbs.push({
      minX: w.x - 2.4,
      maxX: w.x + 2.4,
      minZ: w.z - 2.4,
      maxZ: w.z + 2.4,
      maxY: 2.1,
      kind: 'wreck',
    });
  }

  // Enemy spawn intersections on outer/mid avenues with clear streets
  const enemySpawns: Array<{ x: number; z: number }> = [
    { x: 0, z: -128 },
    { x: -64, z: -128 },
    { x: 64, z: -128 },
    { x: -128, z: -64 },
    { x: 128, z: -64 },
    { x: -128, z: 0 },
    { x: 128, z: 0 },
    { x: -64, z: 128 },
    { x: 64, z: 128 },
    { x: 0, z: 128 },
  ];

  return {
    buildings,
    barricades,
    wrecks,
    aabbs,
    buildingFootprints,
    intersections,
    smokeAnchors,
    // Player spawns on the wide central avenue facing North (-Z) toward twin ruined landmarks
    playerSpawn: { x: 0, z: 64, yaw: 0 },
    enemySpawns,
  };
}

/**
 * Subtle deterministic urban road crown & rubble surface micro-height for tank suspension tilt.
 */
export function getUrbanGroundHeight(x: number, z: number): number {
  const wave =
    Math.sin(x * 0.095) * Math.cos(z * 0.085) * 0.14 +
    Math.sin(x * 0.23 + z * 0.19) * 0.06;
  return wave;
}

/**
 * Smooth circle-vs-expanded-AABB sliding collision resolution (zero allocations).
 * Tanks smoothly glide along building walls and concrete barricades without snagging or clipping.
 */
export function resolveCircleCityCollision(
  x: number,
  z: number,
  radius: number,
  aabbs: ReadonlyArray<CityAabb>,
  out: { x: number; z: number; collided: boolean },
): void {
  let px = Math.max(-CITY_PLAYABLE_HALF + radius, Math.min(CITY_PLAYABLE_HALF - radius, x));
  let pz = Math.max(-CITY_PLAYABLE_HALF + radius, Math.min(CITY_PLAYABLE_HALF - radius, z));
  let collided = px !== x || pz !== z;
  const rSq = radius * radius;

  // Two passes handle corner intersections cleanly without oscillation
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < aabbs.length; i++) {
      const b = aabbs[i];
      // Fast reject outside expanded AABB
      if (
        px < b.minX - radius ||
        px > b.maxX + radius ||
        pz < b.minZ - radius ||
        pz > b.maxZ + radius
      ) {
        continue;
      }

      // Closest point on AABB to circle center
      const cx = px < b.minX ? b.minX : px > b.maxX ? b.maxX : px;
      const cz = pz < b.minZ ? b.minZ : pz > b.maxZ ? b.maxZ : pz;
      const dx = px - cx;
      const dz = pz - cz;
      const distSq = dx * dx + dz * dz;

      if (distSq < rSq) {
        collided = true;
        if (distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const push = radius - dist;
          px += (dx / dist) * push;
          pz += (dz / dist) * push;
        } else {
          // Circle center fell strictly inside AABB: push out along shallowest penetration axis
          const penLeft = px - b.minX;
          const penRight = b.maxX - px;
          const penTop = pz - b.minZ;
          const penBot = b.maxZ - pz;
          const minPen = Math.min(penLeft, penRight, penTop, penBot);
          if (minPen === penLeft) px = b.minX - radius;
          else if (minPen === penRight) px = b.maxX + radius;
          else if (minPen === penTop) pz = b.minZ - radius;
          else pz = b.maxZ + radius;
        }
      }
    }
  }

  out.x = px;
  out.z = pz;
  out.collided = collided;
}

/**
 * Exact 3D swept ray-segment vs AABB intersection (Kay-Kajiya slab method, zero allocations).
 * Returns normalized t in [0, 1] on hit, or -1 if no intersection.
 */
export function segmentAabbIntersect(p0: Vec3, p1: Vec3, aabb: CityAabb): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;

  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) < 1e-8) {
    if (p0.x < aabb.minX || p0.x > aabb.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (aabb.minX - p0.x) * inv;
    let t2 = (aabb.maxX - p0.x) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  // Y slab (ground y=0 to aabb.maxY)
  if (Math.abs(dy) < 1e-8) {
    if (p0.y < 0 || p0.y > aabb.maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (0 - p0.y) * inv;
    let t2 = (aabb.maxY - p0.y) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  // Z slab
  if (Math.abs(dz) < 1e-8) {
    if (p0.z < aabb.minZ || p0.z > aabb.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (aabb.minZ - p0.z) * inv;
    let t2 = (aabb.maxZ - p0.z) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  return tMin >= 0 && tMin <= 1 ? tMin : -1;
}

/**
 * Tests swept segment against all city structures; returns closest impact t in [0, 1] or -1.
 */
export function segmentCityImpact(
  p0: Vec3,
  p1: Vec3,
  aabbs: ReadonlyArray<CityAabb>,
  buildingsOnly = false,
): number {
  let bestT = 2;
  for (let i = 0; i < aabbs.length; i++) {
    const aabb = aabbs[i];
    if (buildingsOnly && aabb.kind !== 'building') continue;
    const t = segmentAabbIntersect(p0, p1, aabb);
    if (t >= 0 && t < bestT) {
      bestT = t;
    }
  }
  return bestT <= 1 ? bestT : -1;
}

/**
 * Checks whether a clear urban line-of-sight exists between two turret positions.
 */
export function hasCityLineOfSight(
  a: Vec3,
  b: Vec3,
  aabbs: ReadonlyArray<CityAabb>,
): boolean {
  return segmentCityImpact(a, b, aabbs, true) < 0;
}

/**
 * Pulls chase camera smoothly in front of any building wall between tank anchor & desired camera pos.
 */
export function computeCameraWallPullIn(
  anchor: Vec3,
  desired: Vec3,
  aabbs: ReadonlyArray<CityAabb>,
  out: THREE.Vector3,
): void {
  const t = segmentCityImpact(anchor, desired, aabbs, true);
  if (t >= 0) {
    const safeT = Math.max(0.24, t - 0.08);
    out.set(
      anchor.x + (desired.x - anchor.x) * safeT,
      anchor.y + (desired.y - anchor.y) * safeT,
      anchor.z + (desired.z - anchor.z) * safeT,
    );
  } else {
    out.set(desired.x, desired.y, desired.z);
  }
}

/**
 * Procedural cracked asphalt & dusty road grid CanvasTexture (SRGBColorSpace, zero external assets).
 */
function createUrbanGroundTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base dusty asphalt concrete
  ctx.fillStyle = '#5a564f';
  ctx.fillRect(0, 0, size, size);

  const rand = createRng(77123);
  // Subtle rubble & sand grain mottling
  for (let i = 0; i < 1600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 5;
    const shade = Math.floor(72 + rand() * 44);
    ctx.fillStyle = `rgba(${shade + 8}, ${shade + 2}, ${shade - 8}, 0.24)`;
    ctx.fillRect(x, y, r, r);
  }

  // Subtle weathered road lane markings & cracks
  ctx.strokeStyle = 'rgba(205, 188, 152, 0.22)';
  ctx.lineWidth = 4;
  ctx.setLineDash([24, 24]);
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size * 0.5, size);
  ctx.moveTo(0, size * 0.5);
  ctx.lineTo(size, size * 0.5);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(32, 30, 28, 0.32)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 24; i++) {
    let cx = rand() * size;
    let cy = rand() * size;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 4; s++) {
      cx += (rand() - 0.5) * 34;
      cy += (rand() - 0.5) * 34;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.anisotropy = Math.min(8, maxAnisotropy);
  return tex;
}

/**
 * Builds the ultra-optimized war-torn urban battlefield using shared geometries/materials
 * and InstancedMesh batching for rubble debris, concrete barricades, craters, and wrecks.
 */
export function buildWarTornCityScene(
  layout: CityLayout,
  maxAnisotropy: number,
): THREE.Group {
  const root = new THREE.Group();
  const rand = createRng(55189);

  // 1. Extended dusty wasteland outer terrain (prevents boxy floating void perimeter)
  const outerGroundMat = new THREE.MeshStandardMaterial({
    color: 0x877761,
    roughness: 0.96,
    metalness: 0.02,
  });
  const outerGround = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), outerGroundMat);
  outerGround.rotation.x = -Math.PI / 2;
  outerGround.position.y = -0.06;
  root.add(outerGround);

  // 2. Main urban district asphalt/concrete floor (offset slightly above outer ground to avoid Z-fighting)
  const roadTex = createUrbanGroundTexture(maxAnisotropy);
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: roadTex,
    roughness: 0.9,
    metalness: 0.05,
  });
  const cityGround = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY_PLAYABLE_HALF * 2 + 40, CITY_PLAYABLE_HALF * 2 + 40),
    roadMat,
  );
  cityGround.rotation.x = -Math.PI / 2;
  cityGround.position.y = 0;
  cityGround.receiveShadow = true;
  root.add(cityGround);

  // Shared urban architectural materials (distinct concrete/ash tones + high roughness variance)
  const concreteMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x8d8579, roughness: 0.88, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x767067, roughness: 0.92, metalness: 0.04 }),
    new THREE.MeshStandardMaterial({ color: 0x9c8e7b, roughness: 0.85, metalness: 0.06 }),
  ];
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x5c5852,
    roughness: 0.82,
    metalness: 0.12,
  });
  const windowVoidMat = new THREE.MeshStandardMaterial({
    color: 0x1b1d20,
    roughness: 0.35,
    metalness: 0.35,
  });
  const scorchedMat = new THREE.MeshStandardMaterial({
    color: 0x35322f,
    roughness: 0.94,
    metalness: 0.08,
  });
  const rebarMat = new THREE.MeshStandardMaterial({
    color: 0x4b3d33,
    roughness: 0.55,
    metalness: 0.65,
  });

  // Shared unit primitives scaled cleanly per building (minimal unique geometries!)
  const unitBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  const sidewalkGeo = new THREE.BoxGeometry(1, 0.28, 1);

  // 3. Tiered Low-Poly Ruined Buildings with jagged slanted upper stories & recessed dark window bands
  for (let i = 0; i < layout.buildings.length; i++) {
    const b = layout.buildings[i];
    const bGroup = new THREE.Group();
    bGroup.position.set(b.cx, 0, b.cz);

    const wallMat = concreteMaterials[b.variant];

    // Raised concrete sidewalk curb plinth
    const plinth = new THREE.Mesh(sidewalkGeo, trimMat);
    plinth.scale.set(b.w + 3.2, 1, b.d + 3.2);
    plinth.position.y = 0.14;
    bGroup.add(plinth);

    // Lower intact reinforced concrete structure
    const lower = new THREE.Mesh(unitBoxGeo, wallMat);
    lower.scale.set(b.w, b.baseH, b.d);
    lower.position.y = b.baseH * 0.5;
    lower.castShadow = true;
    lower.receiveShadow = true;
    bGroup.add(lower);

    // Exposed dark window bands carved across lower story facades
    const floors = Math.max(1, Math.min(4, Math.floor(b.baseH / 4.2)));
    for (let f = 0; f < floors; f++) {
      const wy = 2.4 + f * 3.8;
      if (wy > b.baseH - 1.5) break;
      const bandX = new THREE.Mesh(unitBoxGeo, windowVoidMat);
      bandX.scale.set(b.w + 0.18, 1.35, b.d * 0.76);
      bandX.position.y = wy;
      bGroup.add(bandX);

      const bandZ = new THREE.Mesh(unitBoxGeo, windowVoidMat);
      bandZ.scale.set(b.w * 0.76, 1.35, b.d + 0.18);
      bandZ.position.y = wy;
      bGroup.add(bandZ);
    }

    // Tiered jagged upper ruined story + slanted collapsed roof slab
    if (b.upperH > 1) {
      const upper = new THREE.Mesh(unitBoxGeo, concreteMaterials[(b.variant + 1) % 3]);
      upper.scale.set(b.w * 0.82, b.upperH, b.d * 0.82);
      upper.position.set(
        (b.variant - 1) * 1.1,
        b.baseH + b.upperH * 0.44,
        (1 - b.variant) * 0.9,
      );
      upper.rotation.set(b.ruinTiltX * 0.32, 0, b.ruinTiltZ * 0.32);
      upper.castShadow = true;
      bGroup.add(upper);

      // Jagged broken parapet walls & slanted collapsed roof slab flush with upper structure
      const uw = b.w * 0.82;
      const ud = b.d * 0.82;
      const roofY = b.baseH + b.upperH * 0.94;
      const uOffX = (b.variant - 1) * 1.1;
      const uOffZ = (1 - b.variant) * 0.9;

      const brokenSlab = new THREE.Mesh(unitBoxGeo, scorchedMat);
      brokenSlab.scale.set(uw * 0.86, 0.65, ud * 0.86);
      brokenSlab.position.set(uOffX, roofY, uOffZ);
      brokenSlab.rotation.set(b.ruinTiltX * 0.65, 0, b.ruinTiltZ * 0.65);
      bGroup.add(brokenSlab);

      // Two broken corner parapet walls of asymmetric heights for authentic war-torn silhouette
      const parapetA = new THREE.Mesh(unitBoxGeo, wallMat);
      parapetA.scale.set(uw * 0.56, 1.8 + (b.id % 3) * 0.65, 0.95);
      parapetA.position.set(uOffX - uw * 0.16, roofY + 0.9, uOffZ + ud * 0.44);
      parapetA.rotation.z = b.ruinTiltZ * 0.45;
      bGroup.add(parapetA);

      const parapetB = new THREE.Mesh(unitBoxGeo, trimMat);
      parapetB.scale.set(0.95, 1.4 + ((b.id + 1) % 3) * 0.6, ud * 0.54);
      parapetB.position.set(uOffX + uw * 0.44, roofY + 0.75, uOffZ - ud * 0.15);
      parapetB.rotation.x = b.ruinTiltX * 0.45;
      bGroup.add(parapetB);

      // Exposed steel beam ribs sticking out of the top ruin
      const rib = new THREE.Mesh(unitBoxGeo, rebarMat);
      rib.scale.set(uw * 0.45, 0.28, 0.32);
      rib.position.set(uOffX + 0.4, roofY + 1.1, uOffZ);
      rib.rotation.set(0.16, b.id * 0.5, -0.28);
      bGroup.add(rib);
    }

    root.add(bGroup);
  }

  // 4. Distant Perimeter Ruined Horizon Silhouettes (natural urban outskirts fading into dusty fog)
  const outskirtGeo = new THREE.BoxGeometry(1, 1, 1);
  const outskirtCount = 44;
  const outskirtInst = new THREE.InstancedMesh(outskirtGeo, concreteMaterials[1], outskirtCount);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < outskirtCount; i++) {
    const angle = (i / outskirtCount) * Math.PI * 2;
    const dist = CITY_PLAYABLE_HALF + 38 + (i % 3) * 26;
    const h = 14 + rand() * 34;
    const w = 18 + rand() * 22;
    const d = 18 + rand() * 22;
    dummy.position.set(Math.cos(angle) * dist, h * 0.5, Math.sin(angle) * dist);
    dummy.rotation.set((rand() - 0.5) * 0.12, angle + rand() * 0.4, (rand() - 0.5) * 0.12);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    outskirtInst.setMatrixAt(i, dummy.matrix);
    col.setHex(i % 2 === 0 ? 0x7c7468 : 0x6b655c);
    outskirtInst.setColorAt(i, col);
  }
  outskirtInst.instanceMatrix.needsUpdate = true;
  if (outskirtInst.instanceColor) outskirtInst.instanceColor.needsUpdate = true;
  outskirtInst.computeBoundingSphere();
  root.add(outskirtInst);

  // 5. InstancedMesh Concrete Barricades (سنگر بتنی — Jersey barriers with amber hazard stripe)
  const barrierShape = new THREE.Shape();
  barrierShape.moveTo(-0.78, 0);
  barrierShape.lineTo(0.78, 0);
  barrierShape.lineTo(0.45, 0.55);
  barrierShape.lineTo(0.28, 1.55);
  barrierShape.lineTo(-0.28, 1.55);
  barrierShape.lineTo(-0.45, 0.55);
  barrierShape.closePath();
  const barrierGeo = new THREE.ExtrudeGeometry(barrierShape, {
    depth: 6.0,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 1,
  });
  barrierGeo.translate(0, 0, -3.0);
  const barrierMat = new THREE.MeshStandardMaterial({
    color: 0x9b9284,
    roughness: 0.88,
    metalness: 0.06,
  });
  const barrierInst = new THREE.InstancedMesh(barrierGeo, barrierMat, layout.barricades.length);
  for (let i = 0; i < layout.barricades.length; i++) {
    const bar = layout.barricades[i];
    dummy.position.set(bar.x, 0, bar.z);
    dummy.rotation.set(0, bar.rotated ? 0 : Math.PI * 0.5, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    barrierInst.setMatrixAt(i, dummy.matrix);
    col.setHex(i % 3 === 0 ? 0xa59a87 : 0x8c8578);
    barrierInst.setColorAt(i, col);
  }
  barrierInst.instanceMatrix.needsUpdate = true;
  if (barrierInst.instanceColor) barrierInst.instanceColor.needsUpdate = true;
  barrierInst.computeBoundingSphere();
  root.add(barrierInst);

  // 6. InstancedMesh Concrete Rubble Chunks (~260 debris rocks clustered around building edges)
  const rubbleCount = 260;
  const rubbleGeo = new THREE.DodecahedronGeometry(0.95, 0);
  const rubbleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.04,
  });
  const rubbleInst = new THREE.InstancedMesh(rubbleGeo, rubbleMat, rubbleCount);
  const rubblePalette = [0x8b8173, 0x706a61, 0x9e8f7b, 0x5c564f, 0x675f55];
  for (let i = 0; i < rubbleCount; i++) {
    const b = layout.buildings[i % layout.buildings.length];
    const side = i % 4;
    let rx = b.cx;
    let rz = b.cz;
    if (side === 0) {
      rx = b.cx + (rand() - 0.5) * (b.w + 4);
      rz = b.cz + b.d * 0.5 + 1.2 + rand() * 3.8;
    } else if (side === 1) {
      rx = b.cx + (rand() - 0.5) * (b.w + 4);
      rz = b.cz - b.d * 0.5 - 1.2 - rand() * 3.8;
    } else if (side === 2) {
      rx = b.cx + b.w * 0.5 + 1.2 + rand() * 3.8;
      rz = b.cz + (rand() - 0.5) * (b.d + 4);
    } else {
      rx = b.cx - b.w * 0.5 - 1.2 - rand() * 3.8;
      rz = b.cz + (rand() - 0.5) * (b.d + 4);
    }
    const sx = 0.55 + rand() * 1.35;
    const sy = 0.3 + rand() * 0.75;
    const sz = 0.55 + rand() * 1.35;
    dummy.position.set(rx, sy * 0.42, rz);
    dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    rubbleInst.setMatrixAt(i, dummy.matrix);
    col.setHex(rubblePalette[i % rubblePalette.length]);
    rubbleInst.setColorAt(i, col);
  }
  rubbleInst.instanceMatrix.needsUpdate = true;
  if (rubbleInst.instanceColor) rubbleInst.instanceColor.needsUpdate = true;
  rubbleInst.computeBoundingSphere();
  root.add(rubbleInst);

  // 7. InstancedMesh Blast Craters on Streets (offset +0.03m with polygonOffset to avoid Z-fighting)
  const craterCount = 26;
  const craterGeo = new THREE.CircleGeometry(3.4, 12);
  craterGeo.rotateX(-Math.PI / 2);
  const craterMat = new THREE.MeshStandardMaterial({
    color: 0x262422,
    roughness: 0.98,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const craterInst = new THREE.InstancedMesh(craterGeo, craterMat, craterCount);
  for (let i = 0; i < craterCount; i++) {
    const inter = layout.intersections[i % layout.intersections.length];
    const ox = (rand() - 0.5) * 20;
    const oz = (rand() - 0.5) * 20;
    dummy.position.set(inter.x + ox, 0.03, inter.z + oz);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    const s = 0.65 + rand() * 0.85;
    dummy.scale.set(s, 1, s * (0.85 + rand() * 0.3));
    dummy.updateMatrix();
    craterInst.setMatrixAt(i, dummy.matrix);
  }
  craterInst.instanceMatrix.needsUpdate = true;
  craterInst.computeBoundingSphere();
  root.add(craterInst);

  // 8. Burned-Out Vehicle Hulls (shared geometries & charred rust steel material)
  const wreckHullGeo = new THREE.BoxGeometry(2.5, 1.15, 4.8);
  const wreckCabGeo = new THREE.BoxGeometry(2.1, 0.78, 2.2);
  const wreckMat = new THREE.MeshStandardMaterial({
    color: 0x3b312a,
    roughness: 0.86,
    metalness: 0.42,
  });
  const wreckRustMat = new THREE.MeshStandardMaterial({
    color: 0x5c3c28,
    roughness: 0.78,
    metalness: 0.35,
  });
  for (let i = 0; i < layout.wrecks.length; i++) {
    const w = layout.wrecks[i];
    const wg = new THREE.Group();
    wg.position.set(w.x, 0, w.z);
    wg.rotation.y = w.yaw;

    const hull = new THREE.Mesh(wreckHullGeo, wreckMat);
    hull.position.y = 0.62;
    hull.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.08;
    wg.add(hull);

    const cab = new THREE.Mesh(wreckCabGeo, wreckRustMat);
    cab.position.set(0, 1.38, -0.35);
    cab.rotation.set(0.06, 0.05, (i % 2 === 0 ? -1 : 1) * 0.12);
    wg.add(cab);

    root.add(wg);
  }

  return root;
}
