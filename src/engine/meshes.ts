import * as THREE from 'three';
import type { EnemyArchetype } from './types';

export interface FlashableMeshEntry {
  mesh: THREE.Mesh;
  baseMaterial: THREE.Material;
}

export interface JetVisualRig {
  group: THREE.Group;
  afterburners: THREE.Mesh[];
  flashEntries: FlashableMeshEntry[];
  isFlashing: boolean;
}

export interface SurfaceVisualRig {
  group: THREE.Group;
  radarDish: THREE.Object3D;
  flashEntries: FlashableMeshEntry[];
  isFlashing: boolean;
}

function createSweptWingGeometry(
  rootChord: number,
  tipChord: number,
  span: number,
  sweep: number,
  thickness: number,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -rootChord * 0.5);
  shape.lineTo(span, -tipChord * 0.5 + sweep);
  shape.lineTo(span, tipChord * 0.5 + sweep);
  shape.lineTo(0, rootChord * 0.5);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.35,
    bevelSize: 0.08,
    bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, thickness * 0.5, 0);
  return geo;
}

function createVerticalFinGeometry(
  baseChord: number,
  tipChord: number,
  height: number,
  sweep: number,
  thickness: number,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(baseChord, 0);
  shape.lineTo(baseChord - sweep * 0.3, height);
  shape.lineTo(baseChord - sweep - tipChord, height);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 1,
  });
  geo.translate(-baseChord * 0.5, 0, -thickness * 0.5);
  geo.rotateY(Math.PI / 2);
  return geo;
}

// Single shared hit-flash material swapped cleanly on impact (zero per-unit material clones!)
let sharedHitFlashMat: THREE.MeshStandardMaterial | null = null;
export function getSharedHitFlashMaterial(): THREE.MeshStandardMaterial {
  if (!sharedHitFlashMat) {
    sharedHitFlashMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.2,
    });
  }
  return sharedHitFlashMat;
}

export function setRigHitFlash(
  rig: { flashEntries: FlashableMeshEntry[]; isFlashing: boolean },
  flashing: boolean,
): void {
  if (rig.isFlashing === flashing) return;
  rig.isFlashing = flashing;
  const flashMat = flashing ? getSharedHitFlashMaterial() : null;
  for (let i = 0; i < rig.flashEntries.length; i++) {
    const entry = rig.flashEntries[i];
    entry.mesh.material = flashMat || entry.baseMaterial;
  }
}

// Shared reusable geometries & materials for minimal memory, draw calls & mobile GPU overhead
interface SharedGeometryBank {
  playerWingRight: THREE.ExtrudeGeometry;
  playerTailPlane: THREE.ExtrudeGeometry;
  playerFin: THREE.ExtrudeGeometry;
  noseCone: THREE.ConeGeometry;
  fuselageCore: THREE.CylinderGeometry;
  canopyGeo: THREE.CapsuleGeometry;
  nozzleGeo: THREE.CylinderGeometry;
  afterburnerGeo: THREE.ConeGeometry;
  intakeGeo: THREE.BoxGeometry;
  missileRailGeo: THREE.CylinderGeometry;
  droneWingGeo: THREE.ExtrudeGeometry;
  playerTipGeo: THREE.BoxGeometry;
  enemyBandGeo: THREE.BoxGeometry;
  // SAM battery shared geometries
  samBaseGeo: THREE.CylinderGeometry;
  samTurretGeo: THREE.BoxGeometry;
  samTubeGeo: THREE.CylinderGeometry;
  samMastGeo: THREE.CylinderGeometry;
  samDishGeo: THREE.BoxGeometry;
  samBeaconGeo: THREE.SphereGeometry;
  // Naval destroyer shared geometries
  shipHullGeo: THREE.BoxGeometry;
  shipBowGeo: THREE.ConeGeometry;
  shipDeckHouseGeo: THREE.BoxGeometry;
  shipBridgeGeo: THREE.BoxGeometry;
  shipRadarBarGeo: THREE.BoxGeometry;
  shipVlsGeo: THREE.BoxGeometry;
  shipTurretGeo: THREE.CylinderGeometry;
  shipWakeGeo: THREE.PlaneGeometry;
}

interface EnemySharedMaterials {
  hullMat: THREE.MeshStandardMaterial;
  trimMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  canopyMat: THREE.MeshStandardMaterial;
  flameMat: THREE.MeshBasicMaterial;
  scale: number;
}

interface SurfaceSharedMaterials {
  concreteMat: THREE.MeshStandardMaterial;
  samHullMat: THREE.MeshStandardMaterial;
  samAccentMat: THREE.MeshStandardMaterial;
  samBeaconMat: THREE.MeshBasicMaterial;
  shipHullMat: THREE.MeshStandardMaterial;
  shipDeckMat: THREE.MeshStandardMaterial;
  shipBridgeMat: THREE.MeshStandardMaterial;
  shipAccentMat: THREE.MeshStandardMaterial;
  shipWakeMat: THREE.MeshBasicMaterial;
}

let sharedGeo: SharedGeometryBank | null = null;
let sharedEnemyMats: Record<EnemyArchetype, EnemySharedMaterials> | null = null;
let sharedSurfaceMats: SurfaceSharedMaterials | null = null;

function getSharedGeometries(): SharedGeometryBank {
  if (sharedGeo) return sharedGeo;

  const playerWingRight = createSweptWingGeometry(4.2, 1.35, 4.9, 1.9, 0.16);
  const playerTailPlane = createSweptWingGeometry(1.7, 0.7, 2.35, 0.9, 0.1);
  const playerFin = createVerticalFinGeometry(2.1, 0.75, 1.75, 0.85, 0.08);
  const droneWingGeo = createSweptWingGeometry(2.2, 0.9, 4.4, 0.9, 0.12);

  const noseCone = new THREE.ConeGeometry(0.68, 3.8, 8);
  noseCone.rotateX(-Math.PI / 2);

  const fuselageCore = new THREE.CylinderGeometry(0.68, 0.84, 6.2, 8);
  fuselageCore.rotateX(Math.PI / 2);

  const canopyGeo = new THREE.CapsuleGeometry(0.46, 1.75, 6, 10);
  canopyGeo.rotateX(Math.PI / 2);
  canopyGeo.scale(1.0, 0.72, 1.0);

  const nozzleGeo = new THREE.CylinderGeometry(0.32, 0.27, 1.05, 8);
  nozzleGeo.rotateX(Math.PI / 2);

  const afterburnerGeo = new THREE.ConeGeometry(0.28, 2.6, 8);
  afterburnerGeo.rotateX(Math.PI / 2);
  afterburnerGeo.translate(0, 0, 1.3);

  const intakeGeo = new THREE.BoxGeometry(0.72, 0.56, 3.1);
  const missileRailGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.8, 6);
  missileRailGeo.rotateX(Math.PI / 2);

  const playerTipGeo = new THREE.BoxGeometry(0.95, 0.14, 1.15);
  const enemyBandGeo = new THREE.BoxGeometry(1.1, 0.18, 1.4);

  // SAM Battery geometries
  const samBaseGeo = new THREE.CylinderGeometry(9.5, 11.5, 3.2, 8);
  const samTurretGeo = new THREE.BoxGeometry(7.2, 3.4, 8.2);
  const samTubeGeo = new THREE.CylinderGeometry(0.85, 0.95, 7.6, 7);
  const samMastGeo = new THREE.CylinderGeometry(0.75, 1.0, 5.2, 6);
  const samDishGeo = new THREE.BoxGeometry(7.8, 2.4, 0.7);
  const samBeaconGeo = new THREE.SphereGeometry(0.9, 8, 6);

  // Naval Warship geometries (56m destroyer silhouette)
  const shipHullGeo = new THREE.BoxGeometry(13.5, 6.2, 42);
  const shipBowGeo = new THREE.ConeGeometry(8.5, 18, 4);
  shipBowGeo.rotateX(Math.PI / 2);
  shipBowGeo.rotateZ(Math.PI / 4);
  shipBowGeo.scale(1.08, 0.52, 1.0);
  const shipDeckHouseGeo = new THREE.BoxGeometry(9.2, 6.0, 19.5);
  const shipBridgeGeo = new THREE.BoxGeometry(6.8, 6.8, 8.5);
  const shipRadarBarGeo = new THREE.BoxGeometry(9.5, 1.3, 1.1);
  const shipVlsGeo = new THREE.BoxGeometry(7.0, 1.5, 8.5);
  const shipTurretGeo = new THREE.CylinderGeometry(2.2, 2.6, 2.0, 6);
  const shipWakeGeo = new THREE.PlaneGeometry(16, 48);
  shipWakeGeo.rotateX(-Math.PI / 2);

  sharedGeo = {
    playerWingRight,
    playerTailPlane,
    playerFin,
    noseCone,
    fuselageCore,
    canopyGeo,
    nozzleGeo,
    afterburnerGeo,
    intakeGeo,
    missileRailGeo,
    droneWingGeo,
    playerTipGeo,
    enemyBandGeo,
    samBaseGeo,
    samTurretGeo,
    samTubeGeo,
    samMastGeo,
    samDishGeo,
    samBeaconGeo,
    shipHullGeo,
    shipBowGeo,
    shipDeckHouseGeo,
    shipBridgeGeo,
    shipRadarBarGeo,
    shipVlsGeo,
    shipTurretGeo,
    shipWakeGeo,
  };
  return sharedGeo;
}

function getSharedEnemyMaterials(): Record<EnemyArchetype, EnemySharedMaterials> {
  if (sharedEnemyMats) return sharedEnemyMats;

  const defs: Record<
    EnemyArchetype,
    { primary: number; secondary: number; accent: number; flame: number; canopy: number; scale: number }
  > = {
    recon: {
      primary: 0x5c6862,
      secondary: 0x3b4440,
      accent: 0xd99b26,
      flame: 0xffa63d,
      canopy: 0x6b1e1e,
      scale: 0.92,
    },
    interceptor: {
      primary: 0x4b5362,
      secondary: 0x2d333d,
      accent: 0xd93838,
      flame: 0xff6238,
      canopy: 0x6b1e1e,
      scale: 1.0,
    },
    heavy: {
      primary: 0x3d434a,
      secondary: 0x262b30,
      accent: 0xe65327,
      flame: 0xff7729,
      canopy: 0x6b1e1e,
      scale: 1.22,
    },
    ace: {
      primary: 0x1b2029,
      secondary: 0x11151c,
      accent: 0xf0b429,
      flame: 0xff3b3b,
      canopy: 0xd99216,
      scale: 1.08,
    },
  };

  const result = {} as Record<EnemyArchetype, EnemySharedMaterials>;
  (Object.keys(defs) as EnemyArchetype[]).forEach((arch) => {
    const p = defs[arch];
    result[arch] = {
      hullMat: new THREE.MeshStandardMaterial({
        color: p.primary,
        roughness: 0.68,
        metalness: 0.34,
        flatShading: true,
      }),
      trimMat: new THREE.MeshStandardMaterial({
        color: p.secondary,
        roughness: 0.56,
        metalness: 0.46,
        flatShading: true,
      }),
      accentMat: new THREE.MeshStandardMaterial({
        color: p.accent,
        roughness: 0.36,
        metalness: 0.3,
      }),
      canopyMat: new THREE.MeshStandardMaterial({
        color: p.canopy,
        roughness: 0.16,
        metalness: 0.72,
      }),
      flameMat: new THREE.MeshBasicMaterial({
        color: p.flame,
        transparent: true,
        opacity: 0.9,
      }),
      scale: p.scale,
    };
  });

  sharedEnemyMats = result;
  return sharedEnemyMats;
}

function getSharedSurfaceMaterials(): SurfaceSharedMaterials {
  if (sharedSurfaceMats) return sharedSurfaceMats;
  sharedSurfaceMats = {
    concreteMat: new THREE.MeshStandardMaterial({
      color: 0x5d646b,
      roughness: 0.88,
      metalness: 0.08,
      flatShading: true,
    }),
    samHullMat: new THREE.MeshStandardMaterial({
      color: 0x4a5743,
      roughness: 0.72,
      metalness: 0.28,
      flatShading: true,
    }),
    samAccentMat: new THREE.MeshStandardMaterial({
      color: 0xdc3c32,
      roughness: 0.42,
      metalness: 0.25,
    }),
    samBeaconMat: new THREE.MeshBasicMaterial({
      color: 0xff4433,
    }),
    shipHullMat: new THREE.MeshStandardMaterial({
      color: 0x3b4856,
      roughness: 0.62,
      metalness: 0.42,
      flatShading: true,
    }),
    shipDeckMat: new THREE.MeshStandardMaterial({
      color: 0x28323d,
      roughness: 0.74,
      metalness: 0.3,
      flatShading: true,
    }),
    shipBridgeMat: new THREE.MeshStandardMaterial({
      color: 0x4b5c6e,
      roughness: 0.54,
      metalness: 0.44,
      flatShading: true,
    }),
    shipAccentMat: new THREE.MeshStandardMaterial({
      color: 0xe65b2e,
      roughness: 0.38,
      metalness: 0.28,
    }),
    shipWakeMat: new THREE.MeshBasicMaterial({
      color: 0xdff5ff,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    }),
  };
  return sharedSurfaceMats;
}

/**
 * Builds the player's hero composite stealth fighter jet (THREE.Group)
 * with calibrated material roughness/metalness contrast.
 */
export function buildPlayerJetMesh(): JetVisualRig {
  const geo = getSharedGeometries();
  const group = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x3b4d63,
    roughness: 0.64,
    metalness: 0.38,
    flatShading: true,
  });
  const wingAccentMat = new THREE.MeshStandardMaterial({
    color: 0x263547,
    roughness: 0.58,
    metalness: 0.45,
    flatShading: true,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xe68a2e,
    roughness: 0.42,
    metalness: 0.25,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x1a3852,
    emissive: 0x0b2238,
    emissiveIntensity: 0.35,
    roughness: 0.12,
    metalness: 0.78,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x202730,
    roughness: 0.28,
    metalness: 0.86,
  });
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0x45c8ff,
    transparent: true,
    opacity: 0.88,
  });

  const fuselage = new THREE.Mesh(geo.fuselageCore, hullMat);
  fuselage.scale.set(1.22, 0.68, 1.0);
  fuselage.position.set(0, 0, 0.6);
  fuselage.castShadow = true;
  group.add(fuselage);

  const nose = new THREE.Mesh(geo.noseCone, wingAccentMat);
  nose.scale.set(1.16, 0.68, 1.0);
  nose.position.set(0, -0.02, -4.35);
  nose.castShadow = true;
  group.add(nose);

  const canopy = new THREE.Mesh(geo.canopyGeo, canopyMat);
  canopy.position.set(0, 0.48, -1.35);
  group.add(canopy);

  const intakeL = new THREE.Mesh(geo.intakeGeo, wingAccentMat);
  intakeL.position.set(-0.95, -0.1, 0.35);
  group.add(intakeL);
  const intakeR = new THREE.Mesh(geo.intakeGeo, wingAccentMat);
  intakeR.position.set(0.95, -0.1, 0.35);
  group.add(intakeR);

  const wingR = new THREE.Mesh(geo.playerWingRight, hullMat);
  wingR.position.set(0.65, -0.08, 0.75);
  wingR.castShadow = true;
  group.add(wingR);

  const wingL = new THREE.Mesh(geo.playerWingRight, hullMat);
  wingL.scale.x = -1;
  wingL.position.set(-0.65, -0.08, 0.75);
  wingL.castShadow = true;
  group.add(wingL);

  const tipL = new THREE.Mesh(geo.playerTipGeo, stripeMat);
  tipL.position.set(-4.75, -0.06, 2.35);
  group.add(tipL);
  const tipR = new THREE.Mesh(geo.playerTipGeo, stripeMat);
  tipR.position.set(4.75, -0.06, 2.35);
  group.add(tipR);

  const stabR = new THREE.Mesh(geo.playerTailPlane, wingAccentMat);
  stabR.position.set(0.6, -0.05, 3.6);
  group.add(stabR);
  const stabL = new THREE.Mesh(geo.playerTailPlane, wingAccentMat);
  stabL.scale.x = -1;
  stabL.position.set(-0.6, -0.05, 3.6);
  group.add(stabL);

  const finL = new THREE.Mesh(geo.playerFin, wingAccentMat);
  finL.position.set(-0.88, 0.18, 3.1);
  finL.rotation.z = 0.34;
  group.add(finL);
  const finR = new THREE.Mesh(geo.playerFin, wingAccentMat);
  finR.position.set(0.88, 0.18, 3.1);
  finR.rotation.z = -0.34;
  group.add(finR);

  const nozzleL = new THREE.Mesh(geo.nozzleGeo, metalMat);
  nozzleL.position.set(-0.46, -0.04, 3.95);
  group.add(nozzleL);
  const nozzleR = new THREE.Mesh(geo.nozzleGeo, metalMat);
  nozzleR.position.set(0.46, -0.04, 3.95);
  group.add(nozzleR);

  const burnL = new THREE.Mesh(geo.afterburnerGeo, flameMat);
  burnL.position.set(-0.46, -0.04, 4.4);
  group.add(burnL);
  const burnR = new THREE.Mesh(geo.afterburnerGeo, flameMat);
  burnR.position.set(0.46, -0.04, 4.4);
  group.add(burnR);

  const railL = new THREE.Mesh(geo.missileRailGeo, metalMat);
  railL.position.set(-2.6, -0.3, 1.25);
  group.add(railL);
  const railR = new THREE.Mesh(geo.missileRailGeo, metalMat);
  railR.position.set(2.6, -0.3, 1.25);
  group.add(railR);

  return {
    group,
    afterburners: [burnL, burnR],
    flashEntries: [
      { mesh: fuselage, baseMaterial: hullMat },
      { mesh: nose, baseMaterial: wingAccentMat },
    ],
    isFlashing: false,
  };
}

/**
 * Builds distinct multi-part composite enemy aircraft reusing shared geometries & shared materials.
 */
export function buildEnemyJetMesh(archetype: EnemyArchetype): JetVisualRig {
  const geo = getSharedGeometries();
  const mats = getSharedEnemyMaterials()[archetype];
  const group = new THREE.Group();

  const fuselage = new THREE.Mesh(geo.fuselageCore, mats.hullMat);
  fuselage.scale.set(archetype === 'heavy' ? 1.45 : 1.05, 0.7, 0.95);
  fuselage.position.set(0, 0, 0.4);
  group.add(fuselage);

  const nose = new THREE.Mesh(geo.noseCone, mats.trimMat);
  nose.scale.set(1.05, 0.68, 0.95);
  nose.position.set(0, -0.02, -4.1);
  group.add(nose);

  const canopy = new THREE.Mesh(geo.canopyGeo, mats.canopyMat);
  canopy.position.set(0, 0.42, -1.25);
  group.add(canopy);

  const wingGeo = archetype === 'recon' ? geo.droneWingGeo : geo.playerWingRight;
  const wingR = new THREE.Mesh(wingGeo, mats.hullMat);
  wingR.position.set(0.55, -0.06, 0.5);
  if (archetype === 'interceptor') wingR.rotation.y = -0.14;
  group.add(wingR);

  const wingL = new THREE.Mesh(wingGeo, mats.hullMat);
  wingL.scale.x = -1;
  wingL.position.set(-0.55, -0.06, 0.5);
  if (archetype === 'interceptor') wingL.rotation.y = 0.14;
  group.add(wingL);

  const bandL = new THREE.Mesh(geo.enemyBandGeo, mats.accentMat);
  bandL.position.set(-3.3, 0.02, 1.5);
  group.add(bandL);
  const bandR = new THREE.Mesh(geo.enemyBandGeo, mats.accentMat);
  bandR.position.set(3.3, 0.02, 1.5);
  group.add(bandR);

  if (archetype === 'recon') {
    const fin = new THREE.Mesh(geo.playerFin, mats.accentMat);
    fin.position.set(0, 0.16, 2.8);
    group.add(fin);
  } else {
    const finL = new THREE.Mesh(geo.playerFin, mats.trimMat);
    finL.position.set(-0.85, 0.16, 2.85);
    finL.rotation.z = 0.3;
    group.add(finL);
    const finR = new THREE.Mesh(geo.playerFin, mats.trimMat);
    finR.position.set(0.85, 0.16, 2.85);
    finR.rotation.z = -0.3;
    group.add(finR);
  }

  const afterburners: THREE.Mesh[] = [];
  if (archetype === 'heavy' || archetype === 'ace') {
    const bL = new THREE.Mesh(geo.afterburnerGeo, mats.flameMat);
    bL.position.set(-0.48, 0, 3.8);
    group.add(bL);
    const bR = new THREE.Mesh(geo.afterburnerGeo, mats.flameMat);
    bR.position.set(0.48, 0, 3.8);
    group.add(bR);
    afterburners.push(bL, bR);
  } else {
    const bC = new THREE.Mesh(geo.afterburnerGeo, mats.flameMat);
    bC.position.set(0, 0, 3.8);
    group.add(bC);
    afterburners.push(bC);
  }

  group.scale.setScalar(mats.scale);

  return {
    group,
    afterburners,
    flashEntries: [
      { mesh: fuselage, baseMaterial: mats.hullMat },
      { mesh: wingL, baseMaterial: mats.hullMat },
      { mesh: wingR, baseMaterial: mats.hullMat },
      { mesh: nose, baseMaterial: mats.trimMat },
    ],
    isFlashing: false,
  };
}

/**
 * Builds a grounded Surface-to-Air Missile (SAM) Radar Battery using shared geometries & materials.
 */
export function buildSamBatteryMesh(): SurfaceVisualRig {
  const geo = getSharedGeometries();
  const mats = getSharedSurfaceMaterials();
  const group = new THREE.Group();

  // Armored concrete pad (extends slightly downward so uneven slopes never show gaps)
  const pad = new THREE.Mesh(geo.samBaseGeo, mats.concreteMat);
  pad.position.set(0, 0.4, 0);
  group.add(pad);

  // Armored launcher hull
  const turret = new THREE.Mesh(geo.samTurretGeo, mats.samHullMat);
  turret.position.set(0, 3.6, 0);
  group.add(turret);

  // Quad angled missile canisters
  const offsets: ReadonlyArray<[number, number]> = [
    [-2.2, -1.6],
    [2.2, -1.6],
    [-2.2, 1.4],
    [2.2, 1.4],
  ];
  for (let i = 0; i < offsets.length; i++) {
    const tube = new THREE.Mesh(geo.samTubeGeo, mats.samAccentMat);
    tube.position.set(offsets[i][0], 6.4, offsets[i][1]);
    tube.rotation.x = -0.58;
    group.add(tube);
  }

  // Rotating Radar Mast + Dish + Red Warning Beacon
  const radarPivot = new THREE.Group();
  radarPivot.position.set(0, 5.2, 0);

  const mast = new THREE.Mesh(geo.samMastGeo, mats.concreteMat);
  mast.position.set(0, 2.5, 0);
  radarPivot.add(mast);

  const dish = new THREE.Mesh(geo.samDishGeo, mats.samAccentMat);
  dish.position.set(0, 5.4, 0);
  radarPivot.add(dish);

  const beacon = new THREE.Mesh(geo.samBeaconGeo, mats.samBeaconMat);
  beacon.position.set(0, 7.2, 0);
  radarPivot.add(beacon);

  group.add(radarPivot);

  return {
    group,
    radarDish: radarPivot,
    flashEntries: [
      { mesh: turret, baseMaterial: mats.samHullMat },
      { mesh: dish, baseMaterial: mats.samAccentMat },
    ],
    isFlashing: false,
  };
}

/**
 * Builds an Enemy Naval Destroyer warship patrolling open water using shared geometries & materials.
 */
export function buildWarshipMesh(): SurfaceVisualRig {
  const geo = getSharedGeometries();
  const mats = getSharedSurfaceMaterials();
  const group = new THREE.Group();

  // Main stealth destroyer hull
  const hull = new THREE.Mesh(geo.shipHullGeo, mats.shipHullMat);
  hull.position.set(0, 2.6, 0);
  group.add(hull);

  // Sharp forward bow (+Z forward in warship local space)
  const bow = new THREE.Mesh(geo.shipBowGeo, mats.shipHullMat);
  bow.position.set(0, 2.7, 28.5);
  group.add(bow);

  // Midship deck superstructure
  const deckHouse = new THREE.Mesh(geo.shipDeckHouseGeo, mats.shipDeckMat);
  deckHouse.position.set(0, 8.2, -1.5);
  group.add(deckHouse);

  // Command bridge tower
  const bridge = new THREE.Mesh(geo.shipBridgeGeo, mats.shipBridgeMat);
  bridge.position.set(0, 14.0, 2.5);
  group.add(bridge);

  // Forward cannon turret
  const foreTurret = new THREE.Mesh(geo.shipTurretGeo, mats.shipAccentMat);
  foreTurret.position.set(0, 6.4, 15.5);
  group.add(foreTurret);

  // Aft VLS SAM missile launch bay
  const vls = new THREE.Mesh(geo.shipVlsGeo, mats.shipAccentMat);
  vls.position.set(0, 6.4, -15.0);
  group.add(vls);

  // Rotating shipboard phased-array radar bar
  const radarPivot = new THREE.Group();
  radarPivot.position.set(0, 18.2, 2.5);
  const radarBar = new THREE.Mesh(geo.shipRadarBarGeo, mats.shipAccentMat);
  radarPivot.add(radarBar);
  const beacon = new THREE.Mesh(geo.samBeaconGeo, mats.samBeaconMat);
  beacon.position.set(0, 1.8, 0);
  radarPivot.add(beacon);
  group.add(radarPivot);

  // Subtle white sea foam wake behind stern
  const wake = new THREE.Mesh(geo.shipWakeGeo, mats.shipWakeMat);
  wake.position.set(0, 0.35, -34);
  group.add(wake);

  return {
    group,
    radarDish: radarPivot,
    flashEntries: [
      { mesh: hull, baseMaterial: mats.shipHullMat },
      { mesh: deckHouse, baseMaterial: mats.shipDeckMat },
      { mesh: bridge, baseMaterial: mats.shipBridgeMat },
    ],
    isFlashing: false,
  };
}

/**
 * Builds a fortified Enemy Radar Command Base bunker (مقر راداری دشمن)
 * for Tactical Strike Missions using shared geometries & materials.
 */
export function buildCommandBaseMesh(): SurfaceVisualRig {
  const geo = getSharedGeometries();
  const mats = getSharedSurfaceMaterials();
  const group = new THREE.Group();

  // Wide reinforced concrete foundation pad
  const pad = new THREE.Mesh(geo.samBaseGeo, mats.concreteMat);
  pad.scale.set(1.65, 1.3, 1.65);
  pad.position.set(0, 1.2, 0);
  group.add(pad);

  // Main fortified command bunker block
  const bunker = new THREE.Mesh(geo.shipDeckHouseGeo, mats.shipDeckMat);
  bunker.scale.set(1.5, 1.15, 0.9);
  bunker.position.set(0, 6.2, 0);
  group.add(bunker);

  // Armored command tower superstructure
  const tower = new THREE.Mesh(geo.shipBridgeGeo, mats.shipBridgeMat);
  tower.scale.set(1.35, 1.25, 1.35);
  tower.position.set(0, 13.5, 0);
  group.add(tower);

  // Twin perimeter warning stripes / energy generators
  const flankL = new THREE.Mesh(geo.samTurretGeo, mats.samAccentMat);
  flankL.scale.set(1.2, 1.1, 1.2);
  flankL.position.set(-14, 4.5, 0);
  group.add(flankL);

  const flankR = new THREE.Mesh(geo.samTurretGeo, mats.samAccentMat);
  flankR.scale.set(1.2, 1.1, 1.2);
  flankR.position.set(14, 4.5, 0);
  group.add(flankR);

  // Tall rotating long-range radar array + bright red tactical beacon
  const radarPivot = new THREE.Group();
  radarPivot.position.set(0, 21.5, 0);

  const radarBar = new THREE.Mesh(geo.shipRadarBarGeo, mats.samAccentMat);
  radarBar.scale.set(1.8, 1.4, 1.4);
  radarPivot.add(radarBar);

  const beacon = new THREE.Mesh(geo.samBeaconGeo, mats.samBeaconMat);
  beacon.scale.setScalar(1.9);
  beacon.position.set(0, 3.0, 0);
  radarPivot.add(beacon);

  group.add(radarPivot);

  return {
    group,
    radarDish: radarPivot,
    flashEntries: [
      { mesh: bunker, baseMaterial: mats.shipDeckMat },
      { mesh: tower, baseMaterial: mats.shipBridgeMat },
      { mesh: flankL, baseMaterial: mats.samAccentMat },
      { mesh: flankR, baseMaterial: mats.samAccentMat },
    ],
    isFlashing: false,
  };
}

/**
 * Disposes and clears module-level shared geometries & materials so React StrictMode
 * remounts never reference disposed WebGL buffers or shaders.
 */
export function resetSharedMeshAssets(): void {
  if (sharedGeo) {
    Object.values(sharedGeo).forEach((g) => g.dispose());
    sharedGeo = null;
  }
  if (sharedEnemyMats) {
    Object.values(sharedEnemyMats).forEach((set) => {
      set.hullMat.dispose();
      set.trimMat.dispose();
      set.accentMat.dispose();
      set.canopyMat.dispose();
      set.flameMat.dispose();
    });
    sharedEnemyMats = null;
  }
  if (sharedSurfaceMats) {
    Object.values(sharedSurfaceMats).forEach((m) => m.dispose());
    sharedSurfaceMats = null;
  }
  if (sharedHitFlashMat) {
    sharedHitFlashMat.dispose();
    sharedHitFlashMat = null;
  }
}

