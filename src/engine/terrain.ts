import * as THREE from 'three';

// Deterministic 2D Simplex Noise (Stefan Gustavson algorithm) for zero-dependency procedural islands
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD3: ReadonlyArray<[number, number]> = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0, 1],
  [0, -1],
];

// Deterministic permutation table seeded with fixed LCG
const PERM = new Uint8Array(512);
const PERM_MOD12 = new Uint8Array(512);
(function initPermutation() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let seed = 133742;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) {
    PERM[i] = p[i & 255];
    PERM_MOD12[i] = PERM[i] % 12;
  }
})();

export function simplex2D(xin: number, yin: number): number {
  let n0 = 0;
  let n1 = 0;
  let n2 = 0;

  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const X0 = i - t;
  const Y0 = j - t;
  const x0 = xin - X0;
  const y0 = yin - Y0;

  let i1: number;
  let j1: number;
  if (x0 > y0) {
    i1 = 1;
    j1 = 0;
  } else {
    i1 = 0;
    j1 = 1;
  }

  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  const ii = i & 255;
  const jj = j & 255;
  const gi0 = PERM_MOD12[ii + PERM[jj]];
  const gi1 = PERM_MOD12[ii + i1 + PERM[jj + j1]];
  const gi2 = PERM_MOD12[ii + 1 + PERM[jj + 1]];

  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) {
    t0 *= t0;
    n0 = t0 * t0 * (GRAD3[gi0][0] * x0 + GRAD3[gi0][1] * y0);
  }

  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) {
    t1 *= t1;
    n1 = t1 * t1 * (GRAD3[gi1][0] * x1 + GRAD3[gi1][1] * y1);
  }

  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) {
    t2 *= t2;
    n2 = t2 * t2 * (GRAD3[gi2][0] * x2 + GRAD3[gi2][1] * y2);
  }

  return 70 * (n0 + n1 + n2);
}

export const WORLD_RADIUS = 3800;
export const PLAYABLE_RADIUS = 2900;

interface IslandCenter {
  x: number;
  z: number;
  radius: number;
  peakHeight: number;
}

// Curated dramatic archipelago layout around an open spawn bay at (0, 0)
// Guarantees a clear spawn runway over water with dramatic mountain silhouettes visible immediately ahead
const ISLANDS: ReadonlyArray<IslandCenter> = [
  // Iconic twin-peak landmark directly ahead (-Z) for dramatic spawn vista
  { x: -160, z: -980, radius: 620, peakHeight: 315 },
  { x: 460, z: -1250, radius: 520, peakHeight: 265 },
  // Flanking western mountain chain
  { x: -1180, z: -260, radius: 720, peakHeight: 340 },
  { x: -940, z: 960, radius: 590, peakHeight: 255 },
  // Eastern volcanic archipelago
  { x: 1120, z: -180, radius: 680, peakHeight: 330 },
  { x: 860, z: 1080, radius: 640, peakHeight: 280 },
  // Southern atoll & distant outer peaks
  { x: -120, z: 1420, radius: 560, peakHeight: 230 },
  { x: -1950, z: -1600, radius: 760, peakHeight: 370 },
  { x: 1850, z: -1750, radius: 720, peakHeight: 350 },
  { x: 1920, z: 1620, radius: 700, peakHeight: 310 },
  { x: -1880, z: 1750, radius: 690, peakHeight: 325 },
];

interface CanyonCorridor {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  floorHeight: number;
}

// Flyable tactical mountain canyons & river gorges slicing cleanly through major islands
// Lets pilots weave between towering cliffs to break enemy sightlines or ambush pursuers
const CANYONS: ReadonlyArray<CanyonCorridor> = [
  // Primary Northern Gorge slicing straight between the twin landmark peaks ahead of spawn
  { ax: -170, az: -420, bx: -140, bz: -1580, halfWidth: 92, floorHeight: 16 },
  // Western Ridge Valley Pass
  { ax: -1780, az: -220, bx: -540, bz: -310, halfWidth: 98, floorHeight: 22 },
  // Eastern Volcanic Split Canyon
  { ax: 620, az: -700, bx: 1580, bz: 340, halfWidth: 95, floorHeight: 18 },
  // Southern Coastal Strait
  { ax: -620, az: 1120, bx: 480, bz: 1680, halfWidth: 96, floorHeight: 8 },
];

function pointToSegmentDist(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const lenSq = vx * vx + vz * vz;
  const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / lenSq)) : 0;
  const dx = px - (ax + vx * t);
  const dz = pz - (az + vz * t);
  return Math.hypot(dx, dz);
}

/**
 * Deterministic multi-octave island terrain height in meters.
 * Returns 0 for open ocean and positive values for land/mountains,
 * with carved tactical canyons & mountain passes for low-altitude maneuvering.
 * Shared verbatim by terrain mesh generation, player exact collision, and AI terrain avoidance.
 */
export function getTerrainHeight(x: number, z: number): number {
  let islandInfluence = 0;

  for (let i = 0; i < ISLANDS.length; i++) {
    const isl = ISLANDS[i];
    const dx = x - isl.x;
    const dz = z - isl.z;
    const distSq = dx * dx + dz * dz;
    const rSq = isl.radius * isl.radius;
    if (distSq < rSq) {
      const t = 1 - Math.sqrt(distSq) / isl.radius;
      // Smooth dome profile
      const shaped = t * t * (3 - 2 * t);
      const contribution = shaped * isl.peakHeight;
      if (contribution > islandInfluence) {
        islandInfluence = contribution;
      }
    }
  }

  // Secondary organic archipelago scatter far from spawn bay
  const spawnDistSq = x * x + z * z;
  const spawnClearMask = spawnDistSq < 460 * 460 ? 0 : Math.min(1, (Math.sqrt(spawnDistSq) - 460) / 380);

  const n1 = simplex2D(x * 0.00085, z * 0.00085);
  const n2 = simplex2D(x * 0.0021 + 19.4, z * 0.0021 - 7.3);
  const n3 = simplex2D(x * 0.0048 - 41.2, z * 0.0048 + 23.1);

  const ridge = 1 - Math.abs(n2);
  const detail = n1 * 0.55 + ridge * 0.32 + n3 * 0.13;

  // Sculpt main islands with rugged ridges
  let h = 0;
  if (islandInfluence > 0) {
    const modulation = 0.62 + 0.52 * Math.max(0, detail + 0.35);
    h = islandInfluence * modulation - 12;
  }

  // Add subtle smaller rocky islets in outer ocean
  const scatter = (n1 * 0.65 + n2 * 0.35 - 0.56) * 210 * spawnClearMask;
  if (scatter > h) {
    h = scatter;
  }

  // Carve dramatic fly-through canyons & mountain passes with gently curved walls
  if (h > 10) {
    const meander = simplex2D(x * 0.0016 + 7.1, z * 0.0016 - 4.3) * 58;
    for (let i = 0; i < CANYONS.length; i++) {
      const c = CANYONS[i];
      const dist = pointToSegmentDist(x + meander, z - meander * 0.6, c.ax, c.az, c.bx, c.bz);
      const wallSpan = c.halfWidth * 2.15;
      if (dist < wallSpan) {
        if (dist <= c.halfWidth * 0.55) {
          h = Math.min(h, c.floorHeight);
        } else {
          const u = (dist - c.halfWidth * 0.55) / (wallSpan - c.halfWidth * 0.55);
          const smooth = u * u * (3 - 2 * u);
          h = c.floorHeight + (h - c.floorHeight) * smooth;
        }
      }
    }
  }

  // Smooth fade out toward far world horizon so ocean meets sky fog cleanly
  const distFromCenter = Math.sqrt(spawnDistSq);
  if (distFromCenter > WORLD_RADIUS * 0.82) {
    const edgeFade = Math.max(
      0,
      1 - (distFromCenter - WORLD_RADIUS * 0.82) / (WORLD_RADIUS * 0.18),
    );
    h *= edgeFade;
  }

  return h > 0 ? h : 0;
}

/**
 * Low-poly biome color for a given terrain elevation and slope.
 */
function sampleTerrainColor(height: number, noiseJitter: number, target: THREE.Color): void {
  const h = height + noiseJitter * 8;
  if (h <= 0.4) {
    // Deep seabed / submerged shoal
    target.setRGB(0.04, 0.22, 0.38);
  } else if (h < 18) {
    // Warm sunlit coastal sand
    target.setRGB(0.76, 0.65, 0.42);
  } else if (h < 82) {
    // Rich emerald coastal valley
    const t = (h - 18) / 64;
    target.setRGB(0.14 - t * 0.03, 0.41 - t * 0.09, 0.17 - t * 0.04);
  } else if (h < 165) {
    // Deep alpine pine & olive ridge
    const t = (h - 82) / 83;
    target.setRGB(0.16 + t * 0.14, 0.3 - t * 0.06, 0.15 + t * 0.1);
  } else if (h < 245) {
    // Steep volcanic basalt cliffs
    const t = (h - 165) / 80;
    target.setRGB(0.32 + t * 0.11, 0.31 + t * 0.1, 0.34 + t * 0.11);
  } else {
    // High alpine snow cap
    target.setRGB(0.92, 0.95, 0.99);
  }
}

/**
 * Builds the procedural low-poly vertex-colored island terrain mesh.
 */
export function buildTerrainMesh(): THREE.Mesh {
  const size = WORLD_RADIUS * 2;
  const segments = 156;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = getTerrainHeight(x, z);
    // Push seabed slightly beneath water plane (y=0) to avoid Z-fighting with ocean
    pos.setY(i, h > 0.05 ? h : -8);
  }

  // Convert to non-indexed for crisp faceted low-poly shading & clean per-face biome coloring
  const nonIndexed = geo.toNonIndexed();
  geo.dispose();
  nonIndexed.computeVertexNormals();

  const p = nonIndexed.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < p.count; i += 3) {
    const cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;

    const jitter = simplex2D(cx * 0.015, cz * 0.015);
    sampleTerrainColor(cy, jitter, tmpColor);

    // Subtle per-triangle value variation for handcrafted faceted low-poly polish
    const shade = 0.94 + (jitter * 0.5 + 0.5) * 0.12;
    const r = Math.min(1, tmpColor.r * shade);
    const g = Math.min(1, tmpColor.g * shade);
    const b = Math.min(1, tmpColor.b * shade);

    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3] = r;
      colors[(i + k) * 3 + 1] = g;
      colors[(i + k) * 3 + 2] = b;
    }
  }

  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0.04,
  });

  const mesh = new THREE.Mesh(nonIndexed, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/**
 * Builds the sunlit procedural ocean surface with subtle animated swells via onBeforeCompile.
 */
export function buildOceanMesh(): {
  mesh: THREE.Mesh;
  update: (elapsed: number) => void;
} {
  const geo = new THREE.PlaneGeometry(WORLD_RADIUS * 3.2, WORLD_RADIUS * 3.2, 72, 72);
  geo.rotateX(-Math.PI / 2);

  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x0d5c84),
    roughness: 0.22,
    metalness: 0.32,
    flatShading: true,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float waveA = sin(transformed.x * 0.012 + uTime * 1.1) * cos(transformed.z * 0.010 + uTime * 0.85);
        float waveB = sin((transformed.x + transformed.z) * 0.007 - uTime * 0.65);
        transformed.y += (waveA * 1.25 + waveB * 0.85);`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0;
  mesh.receiveShadow = true;

  return {
    mesh,
    update: (elapsed: number) => {
      uniforms.uTime.value = elapsed;
    },
  };
}

/**
 * Builds stylized multi-puff low-poly clouds using a single InstancedMesh for 1 draw call.
 */
export function buildCloudLayer(): {
  mesh: THREE.InstancedMesh;
  update: (dt: number) => void;
} {
  const clusterCount = 46;
  const puffsPerCluster = 4;
  const totalInstances = clusterCount * puffsPerCluster;

  const puffGeo = new THREE.IcosahedronGeometry(1, 1);
  const puffMat = new THREE.MeshStandardMaterial({
    color: 0xf4f8fc,
    roughness: 0.92,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    opacity: 0.88,
  });

  const mesh = new THREE.InstancedMesh(puffGeo, puffMat, totalInstances);
  mesh.frustumCulled = false;

  interface CloudCluster {
    x: number;
    y: number;
    z: number;
    speed: number;
    scale: number;
    offsets: Array<{ dx: number; dy: number; dz: number; sx: number; sy: number; sz: number }>;
  }

  const clusters: CloudCluster[] = [];
  let seed = 88421;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  let idx = 0;
  for (let c = 0; c < clusterCount; c++) {
    const angle = rand() * Math.PI * 2;
    const dist = 350 + rand() * (WORLD_RADIUS * 0.78);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const y = 390 + rand() * 340;
    const baseScale = 36 + rand() * 44;
    const speed = 5 + rand() * 7;

    const offsets: CloudCluster['offsets'] = [];
    for (let p = 0; p < puffsPerCluster; p++) {
      const dx = (p - 1.5) * baseScale * (0.55 + rand() * 0.25);
      const dy = (rand() - 0.35) * baseScale * 0.28;
      const dz = (rand() - 0.5) * baseScale * 0.55;
      const sx = baseScale * (0.75 + rand() * 0.65);
      const sy = baseScale * (0.36 + rand() * 0.22);
      const sz = baseScale * (0.65 + rand() * 0.5);
      offsets.push({ dx, dy, dz, sx, sy, sz });

      dummy.position.set(x + dx, y + dy, z + dz);
      dummy.scale.set(sx, sy, sz);
      dummy.rotation.set(0, rand() * Math.PI, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);

      const brightness = 0.92 + rand() * 0.08;
      tint.setRGB(brightness, brightness * 0.99, Math.min(1, brightness * 1.02));
      mesh.setColorAt(idx, tint);
      idx++;
    }
    clusters.push({ x, y, z, speed, scale: baseScale, offsets });
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return {
    mesh,
    update: (dt: number) => {
      let i = 0;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        cl.x += cl.speed * dt;
        if (cl.x > WORLD_RADIUS) cl.x = -WORLD_RADIUS;
        for (let p = 0; p < cl.offsets.length; p++) {
          const o = cl.offsets[p];
          dummy.position.set(cl.x + o.dx, cl.y + o.dy, cl.z + o.dz);
          dummy.scale.set(o.sx, o.sy, o.sz);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i++, dummy.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
