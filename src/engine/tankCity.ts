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
 * Procedural dark cracked asphalt (#1f2429) with faded road lane markings, dirt shoulders,
 * intersection wear & surface cracks (SRGBColorSpace, zero external assets).
 */
function createUrbanGroundTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base dark cracked urban asphalt (#1f2429)
  ctx.fillStyle = '#1f2429';
  ctx.fillRect(0, 0, size, size);

  const rand = createRng(77123);
  // Subtle aggregate asphalt speckle & worn tire-track oil patches
  for (let i = 0; i < 2200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 4.5;
    const shade = Math.floor(24 + rand() * 34);
    ctx.fillStyle = `rgba(${shade}, ${shade + 3}, ${shade + 7}, 0.28)`;
    ctx.fillRect(x, y, r, r);
  }

  // Warm dusty dirt shoulders & curb grime along block edges
  ctx.fillStyle = 'rgba(116, 102, 86, 0.24)';
  ctx.fillRect(0, 0, size, 26);
  ctx.fillRect(0, size - 26, size, 26);
  ctx.fillRect(0, 0, 26, size);
  ctx.fillRect(size - 26, 0, 26, size);

  // Subtle scattered concrete dust patches near curbs
  for (let i = 0; i < 120; i++) {
    const edge = i % 4;
    const x = edge < 2 ? rand() * size : edge === 2 ? rand() * 48 : size - rand() * 48;
    const y = edge >= 2 ? rand() * size : edge === 0 ? rand() * 48 : size - rand() * 48;
    const rad = 6 + rand() * 18;
    ctx.fillStyle = 'rgba(138, 126, 110, 0.14)';
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Faded yellow/off-white urban avenue center lane markings
  ctx.strokeStyle = 'rgba(218, 202, 162, 0.34)';
  ctx.lineWidth = 4.5;
  ctx.setLineDash([28, 24]);
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size * 0.5, size);
  ctx.moveTo(0, size * 0.5);
  ctx.lineTo(size, size * 0.5);
  ctx.stroke();

  // Faded white road shoulder guide stripes
  ctx.strokeStyle = 'rgba(210, 214, 218, 0.16)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  ctx.strokeRect(34, 34, size - 68, size - 68);

  // Deep dark jagged asphalt cracks & shell scars
  ctx.strokeStyle = 'rgba(8, 10, 13, 0.58)';
  ctx.lineWidth = 1.8;
  for (let i = 0; i < 34; i++) {
    let cx = rand() * size;
    let cy = rand() * size;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 5; s++) {
      cx += (rand() - 0.5) * 38;
      cy += (rand() - 0.5) * 38;
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

  // 1. Extended weathered arid wasteland outer terrain (frames the ruined city cleanly)
  const outerGroundMat = new THREE.MeshStandardMaterial({
    color: 0x5c5347,
    roughness: 0.96,
    metalness: 0.02,
  });
  const outerGround = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), outerGroundMat);
  outerGround.rotation.x = -Math.PI / 2;
  outerGround.position.y = -0.06;
  root.add(outerGround);

  // 2. Main urban district dark cracked asphalt floor (#1f2429) contrasting against warm concrete buildings
  const roadTex = createUrbanGroundTexture(maxAnisotropy);
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: roadTex,
    roughness: 0.88,
    metalness: 0.08,
  });
  const cityGround = new THREE.Mesh(
    new THREE.PlaneGeometry(CITY_PLAYABLE_HALF * 2 + 40, CITY_PLAYABLE_HALF * 2 + 40),
    roadMat,
  );
  cityGround.rotation.x = -Math.PI / 2;
  cityGround.position.y = 0;
  cityGround.receiveShadow = true;
  root.add(cityGround);

  // Shared urban architectural materials: warm weathered concrete/sandstone (#8c8275 / #6e655b) + charred frames
  const concreteMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x8c8275, roughness: 0.88, metalness: 0.04 }),
    new THREE.MeshStandardMaterial({ color: 0x6e655b, roughness: 0.92, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x9b8f7e, roughness: 0.86, metalness: 0.04 }),
  ];
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x524c45,
    roughness: 0.86,
    metalness: 0.1,
  });
  const windowVoidMat = new THREE.MeshStandardMaterial({
    color: 0x131619,
    roughness: 0.42,
    metalness: 0.28,
  });
  const scorchedMat = new THREE.MeshStandardMaterial({
    color: 0x262422,
    roughness: 0.95,
    metalness: 0.06,
  });
  const rebarMat = new THREE.MeshStandardMaterial({
    color: 0x4b3b2f,
    roughness: 0.52,
    metalness: 0.68,
  });

  // Shared unit primitives scaled cleanly per building (minimal unique geometries!)
  const unitBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  const sidewalkGeo = new THREE.BoxGeometry(1, 0.3, 1);
  const monumentBaseGeo = new THREE.CylinderGeometry(5.6, 6.4, 1.3, 12);
  const monumentPillarGeo = new THREE.CylinderGeometry(1.5, 2.2, 4.4, 8);

  // 3. Varied Multi-Wing Stepped War-Torn City Buildings & Central Ruined Plaza
  for (let i = 0; i < layout.buildings.length; i++) {
    const b = layout.buildings[i];
    const bGroup = new THREE.Group();
    bGroup.position.set(b.cx, 0, b.cz);

    const wallMat = concreteMaterials[b.variant];

    // Special central ruined plaza monument (breaks up grid repetition cleanly)
    if (b.upperH === 0 && b.baseH < 5) {
      const plazaPad = new THREE.Mesh(sidewalkGeo, trimMat);
      plazaPad.scale.set(b.w + 7.5, 0.9, b.d + 7.5);
      plazaPad.position.y = 0.14;
      plazaPad.receiveShadow = true;
      bGroup.add(plazaPad);

      const fountainBase = new THREE.Mesh(monumentBaseGeo, concreteMaterials[0]);
      fountainBase.position.y = 0.72;
      fountainBase.castShadow = true;
      fountainBase.receiveShadow = true;
      bGroup.add(fountainBase);

      const brokenPillar = new THREE.Mesh(monumentPillarGeo, concreteMaterials[2]);
      brokenPillar.position.set(0.3, 2.4, -0.2);
      brokenPillar.rotation.set(0.14, 0.4, -0.18);
      brokenPillar.castShadow = true;
      bGroup.add(brokenPillar);

      root.add(bGroup);
      continue;
    }

    // Raised weathered concrete sidewalk curb plinth contrasting with dark #1f2429 asphalt
    const plinth = new THREE.Mesh(sidewalkGeo, trimMat);
    plinth.scale.set(b.w + 3.8, 1, b.d + 3.8);
    plinth.position.y = 0.15;
    plinth.receiveShadow = true;
    bGroup.add(plinth);

    // Lower reinforced concrete structure
    const lower = new THREE.Mesh(unitBoxGeo, wallMat);
    lower.scale.set(b.w, b.baseH, b.d);
    lower.position.y = b.baseH * 0.5;
    lower.castShadow = true;
    lower.receiveShadow = true;
    bGroup.add(lower);

    // Architectural cornice ledge & corner pilasters to eliminate flat toy-box walls
    const cornice = new THREE.Mesh(unitBoxGeo, trimMat);
    cornice.scale.set(b.w + 0.55, 0.52, b.d + 0.55);
    cornice.position.y = b.baseH - 0.2;
    bGroup.add(cornice);

    // Corner concrete piers (2 diagonal paired ribs forming 4 vertical corner framing columns)
    const pierX = new THREE.Mesh(unitBoxGeo, trimMat);
    pierX.scale.set(b.w + 0.34, b.baseH, b.d * 0.16);
    pierX.position.set(0, b.baseH * 0.5, b.d * 0.42);
    bGroup.add(pierX);

    const pierX2 = new THREE.Mesh(unitBoxGeo, trimMat);
    pierX2.scale.set(b.w + 0.34, b.baseH, b.d * 0.16);
    pierX2.position.set(0, b.baseH * 0.5, -b.d * 0.42);
    bGroup.add(pierX2);

    // Charred recessed dark interior window bands across lower story facades
    const floors = Math.max(1, Math.min(4, Math.floor(b.baseH / 4.0)));
    for (let f = 0; f < floors; f++) {
      const wy = 2.5 + f * 3.75;
      if (wy > b.baseH - 1.5) break;
      const bandX = new THREE.Mesh(unitBoxGeo, windowVoidMat);
      bandX.scale.set(b.w + 0.16, 1.45, b.d * 0.72);
      bandX.position.y = wy;
      bGroup.add(bandX);

      const bandZ = new THREE.Mesh(unitBoxGeo, windowVoidMat);
      bandZ.scale.set(b.w * 0.72, 1.45, b.d + 0.16);
      bandZ.position.y = wy;
      bGroup.add(bandZ);
    }

    // Asymmetric stepped wing / annex on side of building for real city-block massing
    if (b.upperH > 1) {
      const wingW = b.w * (b.variant === 0 ? 0.68 : 0.82);
      const wingD = b.d * (b.variant === 1 ? 0.64 : 0.78);
      const uOffX = (b.variant === 0 ? -1 : b.variant === 2 ? 1 : 0) * (b.w - wingW) * 0.42;
      const uOffZ = (b.variant === 1 ? -1 : 1) * (b.d - wingD) * 0.36;

      const upper = new THREE.Mesh(unitBoxGeo, concreteMaterials[(b.variant + 1) % 3]);
      upper.scale.set(wingW, b.upperH, wingD);
      upper.position.set(uOffX, b.baseH + b.upperH * 0.46, uOffZ);
      upper.rotation.set(b.ruinTiltX * 0.22, 0, b.ruinTiltZ * 0.22);
      upper.castShadow = true;
      upper.receiveShadow = true;
      bGroup.add(upper);

      // Charred window band on stepped upper floor
      if (b.upperH >= 5) {
        const upWinX = new THREE.Mesh(unitBoxGeo, windowVoidMat);
        upWinX.scale.set(wingW + 0.16, 1.4, wingD * 0.68);
        upWinX.position.set(uOffX, b.baseH + b.upperH * 0.5, uOffZ);
        bGroup.add(upWinX);

        const upWinZ = new THREE.Mesh(unitBoxGeo, windowVoidMat);
        upWinZ.scale.set(wingW * 0.68, 1.4, wingD + 0.16);
        upWinZ.position.set(uOffX, b.baseH + b.upperH * 0.5, uOffZ);
        bGroup.add(upWinZ);
      }

      // Jagged broken parapet walls & scorched collapsed roof slab
      const roofY = b.baseH + b.upperH * 0.94;
      const brokenSlab = new THREE.Mesh(unitBoxGeo, scorchedMat);
      brokenSlab.scale.set(wingW * 0.88, 0.7, wingD * 0.88);
      brokenSlab.position.set(uOffX, roofY, uOffZ);
      brokenSlab.rotation.set(b.ruinTiltX * 0.55, 0, b.ruinTiltZ * 0.55);
      bGroup.add(brokenSlab);

      const parapetA = new THREE.Mesh(unitBoxGeo, wallMat);
      parapetA.scale.set(wingW * 0.58, 1.9 + (b.id % 3) * 0.7, 0.95);
      parapetA.position.set(uOffX - wingW * 0.14, roofY + 0.92, uOffZ + wingD * 0.45);
      parapetA.rotation.z = b.ruinTiltZ * 0.4;
      bGroup.add(parapetA);

      const parapetB = new THREE.Mesh(unitBoxGeo, trimMat);
      parapetB.scale.set(0.95, 1.5 + ((b.id + 1) % 3) * 0.65, wingD * 0.56);
      parapetB.position.set(uOffX + wingW * 0.45, roofY + 0.78, uOffZ - wingD * 0.14);
      parapetB.rotation.x = b.ruinTiltX * 0.4;
      bGroup.add(parapetB);

      // Exposed rusted steel I-beam protruding from bombed upper story
      const rib = new THREE.Mesh(unitBoxGeo, rebarMat);
      rib.scale.set(wingW * 0.48, 0.28, 0.34);
      rib.position.set(uOffX + 0.5, roofY + 1.15, uOffZ);
      rib.rotation.set(0.18, b.id * 0.5, -0.32);
      bGroup.add(rib);
    }

    root.add(bGroup);
  }

  // 4. Distant Perimeter Ruined Skyline Silhouettes (fades naturally into dusty urban horizon)
  const outskirtGeo = new THREE.BoxGeometry(1, 1, 1);
  const outskirtCount = 48;
  const outskirtInst = new THREE.InstancedMesh(outskirtGeo, concreteMaterials[1], outskirtCount);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < outskirtCount; i++) {
    const angle = (i / outskirtCount) * Math.PI * 2;
    const dist = CITY_PLAYABLE_HALF + 38 + (i % 3) * 28;
    const h = 15 + rand() * 38;
    const w = 18 + rand() * 22;
    const d = 18 + rand() * 22;
    dummy.position.set(Math.cos(angle) * dist, h * 0.5, Math.sin(angle) * dist);
    dummy.rotation.set((rand() - 0.5) * 0.1, angle + rand() * 0.35, (rand() - 0.5) * 0.1);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    outskirtInst.setMatrixAt(i, dummy.matrix);
    col.setHex(i % 2 === 0 ? 0x7d7468 : 0x675f55);
    outskirtInst.setColorAt(i, col);
  }
  outskirtInst.instanceMatrix.needsUpdate = true;
  if (outskirtInst.instanceColor) outskirtInst.instanceColor.needsUpdate = true;
  outskirtInst.computeBoundingSphere();
  root.add(outskirtInst);

  // 5. InstancedMesh Jersey Concrete Barricades + Stacked Sandbag Bunkers along street corners
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
    color: 0xa4998a,
    roughness: 0.88,
    metalness: 0.05,
  });
  const barrierInst = new THREE.InstancedMesh(barrierGeo, barrierMat, layout.barricades.length);
  for (let i = 0; i < layout.barricades.length; i++) {
    const bar = layout.barricades[i];
    dummy.position.set(bar.x, 0, bar.z);
    dummy.rotation.set(0, bar.rotated ? 0 : Math.PI * 0.5, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    barrierInst.setMatrixAt(i, dummy.matrix);
    col.setHex(i % 3 === 0 ? 0xb0a391 : 0x8e8579);
    barrierInst.setColorAt(i, col);
  }
  barrierInst.instanceMatrix.needsUpdate = true;
  if (barrierInst.instanceColor) barrierInst.instanceColor.needsUpdate = true;
  barrierInst.computeBoundingSphere();
  root.add(barrierInst);

  // Sandbag stacks organically tucked behind Jersey barriers & building corners (InstancedMesh)
  const sandbagGeo = new THREE.CylinderGeometry(0.42, 0.48, 1.35, 7);
  sandbagGeo.rotateZ(Math.PI / 2);
  const sandbagMat = new THREE.MeshStandardMaterial({
    color: 0xa99674,
    roughness: 0.96,
    metalness: 0.02,
  });
  const sandbagCount = layout.barricades.length * 3;
  const sandbagInst = new THREE.InstancedMesh(sandbagGeo, sandbagMat, sandbagCount);
  let sbIdx = 0;
  for (let i = 0; i < layout.barricades.length; i++) {
    const bar = layout.barricades[i];
    const yaw = bar.rotated ? 0 : Math.PI * 0.5;
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 1.45;
      const ox = bar.rotated ? 1.05 : off;
      const oz = bar.rotated ? off : 1.05;
      dummy.position.set(bar.x + ox, k === 1 ? 0.72 : 0.34, bar.z + oz);
      dummy.rotation.set(0, yaw + (rand() - 0.5) * 0.25, 0);
      dummy.scale.set(1, 0.72, 1);
      dummy.updateMatrix();
      sandbagInst.setMatrixAt(sbIdx++, dummy.matrix);
    }
  }
  sandbagInst.instanceMatrix.needsUpdate = true;
  sandbagInst.computeBoundingSphere();
  root.add(sandbagInst);

  // 6. InstancedMesh Concrete Rubble Mounds (~280 chunks) + Broken Angular Concrete Slabs (~90)
  const rubbleCount = 280;
  const rubbleGeo = new THREE.DodecahedronGeometry(0.95, 0);
  const rubbleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.04,
  });
  const rubbleInst = new THREE.InstancedMesh(rubbleGeo, rubbleMat, rubbleCount);
  const rubblePalette = [0x8c8275, 0x6e655b, 0x9c907f, 0x565049, 0x45403a];
  for (let i = 0; i < rubbleCount; i++) {
    const b = layout.buildings[i % layout.buildings.length];
    const side = i % 4;
    let rx = b.cx;
    let rz = b.cz;
    // Cluster organically near corners and collapsed walls (keeping wide street centers navigable)
    if (side === 0) {
      rx = b.cx + (rand() - 0.5) * (b.w + 4.5);
      rz = b.cz + b.d * 0.5 + 1.1 + rand() * 3.6;
    } else if (side === 1) {
      rx = b.cx + (rand() - 0.5) * (b.w + 4.5);
      rz = b.cz - b.d * 0.5 - 1.1 - rand() * 3.6;
    } else if (side === 2) {
      rx = b.cx + b.w * 0.5 + 1.1 + rand() * 3.6;
      rz = b.cz + (rand() - 0.5) * (b.d + 4.5);
    } else {
      rx = b.cx - b.w * 0.5 - 1.1 - rand() * 3.6;
      rz = b.cz + (rand() - 0.5) * (b.d + 4.5);
    }
    const sx = 0.55 + rand() * 1.45;
    const sy = 0.28 + rand() * 0.85;
    const sz = 0.55 + rand() * 1.45;
    dummy.position.set(rx, sy * 0.4, rz);
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

  // Broken fallen concrete wall slabs leaning against building curbs
  const slabCount = 96;
  const slabGeo = new THREE.BoxGeometry(2.8, 0.34, 1.9);
  const slabInst = new THREE.InstancedMesh(slabGeo, rubbleMat, slabCount);
  for (let i = 0; i < slabCount; i++) {
    const b = layout.buildings[i % layout.buildings.length];
    const cornerX = i % 2 === 0 ? 1 : -1;
    const cornerZ = i % 4 < 2 ? 1 : -1;
    const sx = b.cx + cornerX * (b.w * 0.5 + 1.4 + rand() * 1.8);
    const sz = b.cz + cornerZ * (b.d * 0.5 + 1.2 + rand() * 1.6);
    dummy.position.set(sx, 0.42 + rand() * 0.45, sz);
    dummy.rotation.set(
      (rand() - 0.5) * 0.55,
      rand() * Math.PI,
      (rand() - 0.5) * 0.55,
    );
    const scale = 0.75 + rand() * 0.75;
    dummy.scale.set(scale, 1, scale);
    dummy.updateMatrix();
    slabInst.setMatrixAt(i, dummy.matrix);
    col.setHex(rubblePalette[(i + 1) % rubblePalette.length]);
    slabInst.setColorAt(i, col);
  }
  slabInst.instanceMatrix.needsUpdate = true;
  if (slabInst.instanceColor) slabInst.instanceColor.needsUpdate = true;
  slabInst.computeBoundingSphere();
  root.add(slabInst);

  // 7. InstancedMesh Blast Craters on Dark Asphalt Streets (offset +0.03m with polygonOffset)
  const craterCount = 28;
  const craterGeo = new THREE.CircleGeometry(3.4, 12);
  craterGeo.rotateX(-Math.PI / 2);
  const craterMat = new THREE.MeshStandardMaterial({
    color: 0x0f1215,
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

  // 8. Burned-Out Car & Utility Vehicle Husks along curbs (distinct low-profile charred silhouettes)
  const wreckHullGeo = new THREE.BoxGeometry(2.15, 0.88, 4.55);
  const wreckCabGeo = new THREE.BoxGeometry(1.9, 0.68, 2.05);
  const wreckWheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 8);
  wreckWheelGeo.rotateZ(Math.PI / 2);
  const wreckMat = new THREE.MeshStandardMaterial({
    color: 0x2b2522,
    roughness: 0.88,
    metalness: 0.44,
  });
  const wreckRustMat = new THREE.MeshStandardMaterial({
    color: 0x573624,
    roughness: 0.8,
    metalness: 0.36,
  });
  for (let i = 0; i < layout.wrecks.length; i++) {
    const w = layout.wrecks[i];
    const wg = new THREE.Group();
    wg.position.set(w.x, 0, w.z);
    wg.rotation.y = w.yaw;

    const hull = new THREE.Mesh(wreckHullGeo, wreckMat);
    hull.position.y = 0.58;
    hull.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.07;
    hull.castShadow = true;
    wg.add(hull);

    const cab = new THREE.Mesh(wreckCabGeo, wreckRustMat);
    cab.position.set(0, 1.24, -0.2);
    cab.rotation.set(0.05, 0.04, (i % 2 === 0 ? -1 : 1) * 0.11);
    cab.castShadow = true;
    wg.add(cab);

    // 4 charred wheel stubs grounding the car husk on asphalt
    const wheelOffsets: ReadonlyArray<[number, number]> = [
      [-1.08, -1.35],
      [1.08, -1.35],
      [-1.08, 1.35],
      [1.08, 1.35],
    ];
    for (let wi = 0; wi < wheelOffsets.length; wi++) {
      const wh = new THREE.Mesh(wreckWheelGeo, scorchedMat);
      wh.position.set(wheelOffsets[wi][0], 0.36, wheelOffsets[wi][1]);
      wg.add(wh);
    }

    root.add(wg);
  }

  return root;
}
