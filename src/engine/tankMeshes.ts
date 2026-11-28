import * as THREE from 'three';
import type { TankEnemyArchetype } from './types';

export interface TankFlashEntry {
  mesh: THREE.Mesh;
  baseMaterial: THREE.Material;
}

export interface TankVisualRig {
  group: THREE.Group;
  hullGroup: THREE.Group;
  turretPivot: THREE.Group;
  barrelPivot: THREE.Group;
  muzzleFlash: THREE.Mesh;
  flashEntries: TankFlashEntry[];
  isFlashing: boolean;
}

interface SharedTankGeoBank {
  mbtHullGeo: THREE.ExtrudeGeometry;
  mbtTrackGeo: THREE.BoxGeometry;
  mbtSkirtGeo: THREE.BoxGeometry;
  mbtEngineDeckGeo: THREE.BoxGeometry;
  mbtTurretGeo: THREE.ExtrudeGeometry;
  mbtCupolaGeo: THREE.CylinderGeometry;
  mbtBarrelGeo: THREE.CylinderGeometry;
  mbtMuzzleBrakeGeo: THREE.CylinderGeometry;
  mbtCoaxGeo: THREE.CylinderGeometry;
  mbtSmokePodGeo: THREE.BoxGeometry;
  mbtOpticGeo: THREE.BoxGeometry;
  // Recon buggy geometries
  buggyHullGeo: THREE.BoxGeometry;
  buggyWheelGeo: THREE.CylinderGeometry;
  buggyTurretGeo: THREE.BoxGeometry;
  buggyGunGeo: THREE.CylinderGeometry;
  // Siege boss extras
  siegePodGeo: THREE.BoxGeometry;
  // Shared contact shadow, muzzle flash & enemy rear IFF beacon
  shadowDiscGeo: THREE.PlaneGeometry;
  muzzleFlashGeo: THREE.ConeGeometry;
  iffBeaconGeo: THREE.BoxGeometry;
  iffStalkGeo: THREE.CylinderGeometry;
}

interface TankMaterialPalette {
  hullMat: THREE.MeshStandardMaterial;
  turretMat: THREE.MeshStandardMaterial;
  trackMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  opticMat: THREE.MeshStandardMaterial;
  barrelMat: THREE.MeshStandardMaterial;
  muzzleMat: THREE.MeshBasicMaterial;
  shadowMat: THREE.MeshBasicMaterial;
  iffBeaconMat: THREE.MeshBasicMaterial;
}

let sharedTankGeo: SharedTankGeoBank | null = null;
let sharedTankMats: Record<'player' | TankEnemyArchetype, TankMaterialPalette> | null = null;
let sharedTankFlashMat: THREE.MeshStandardMaterial | null = null;

function createSlopedHullGeometry(): THREE.ExtrudeGeometry {
  // Side profile of a modern sloped-glacis Main Battle Tank hull (faces -Z)
  const s = new THREE.Shape();
  s.moveTo(-3.2, 0.35);
  s.lineTo(2.4, 0.35);
  s.lineTo(3.35, 0.92); // sloped front glacis
  s.lineTo(2.2, 1.48);
  s.lineTo(-2.75, 1.48);
  s.lineTo(-3.3, 1.05);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 3.1,
    bevelEnabled: true,
    bevelThickness: 0.14,
    bevelSize: 0.1,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -1.55);
  geo.rotateY(Math.PI / 2); // align +X profile nose -> -Z forward
  return geo;
}

function createAngularTurretGeometry(): THREE.ExtrudeGeometry {
  // Composite angular wedge turret (top-down silhouette extruded vertically)
  const s = new THREE.Shape();
  s.moveTo(-1.15, -1.75); // rear bustle left
  s.lineTo(1.15, -1.75); // rear bustle right
  s.lineTo(1.48, 0.15);
  s.lineTo(0.88, 1.55); // angled composite front cheeks
  s.lineTo(-0.88, 1.55);
  s.lineTo(-1.48, 0.15);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.88,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.1,
    bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2); // extrude upward along +Y, nose faces -Z
  return geo;
}

function getSharedTankGeometries(): SharedTankGeoBank {
  if (sharedTankGeo) return sharedTankGeo;

  const mbtHullGeo = createSlopedHullGeometry();
  const mbtTrackGeo = new THREE.BoxGeometry(0.92, 1.05, 6.2);
  const mbtSkirtGeo = new THREE.BoxGeometry(0.18, 0.72, 6.35);
  const mbtEngineDeckGeo = new THREE.BoxGeometry(2.35, 0.24, 1.85);
  const mbtTurretGeo = createAngularTurretGeometry();
  const mbtCupolaGeo = new THREE.CylinderGeometry(0.45, 0.52, 0.34, 8);

  const mbtBarrelGeo = new THREE.CylinderGeometry(0.13, 0.17, 4.9, 8);
  mbtBarrelGeo.rotateX(Math.PI / 2);
  mbtBarrelGeo.translate(0, 0, -2.45);

  const mbtMuzzleBrakeGeo = new THREE.CylinderGeometry(0.22, 0.2, 0.55, 8);
  mbtMuzzleBrakeGeo.rotateX(Math.PI / 2);
  mbtMuzzleBrakeGeo.translate(0, 0, -4.95);

  const mbtCoaxGeo = new THREE.CylinderGeometry(0.05, 0.06, 1.9, 6);
  mbtCoaxGeo.rotateX(Math.PI / 2);
  mbtCoaxGeo.translate(0.46, 0.02, -1.0);

  const mbtSmokePodGeo = new THREE.BoxGeometry(0.32, 0.28, 0.52);
  const mbtOpticGeo = new THREE.BoxGeometry(0.54, 0.24, 0.35);

  // Recon Buggy
  const buggyHullGeo = new THREE.BoxGeometry(2.45, 0.95, 4.4);
  const buggyWheelGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.45, 10);
  buggyWheelGeo.rotateZ(Math.PI / 2);
  const buggyTurretGeo = new THREE.BoxGeometry(1.35, 0.58, 1.55);
  const buggyGunGeo = new THREE.CylinderGeometry(0.075, 0.095, 2.5, 6);
  buggyGunGeo.rotateX(Math.PI / 2);
  buggyGunGeo.translate(0, 0, -1.25);

  // Heavy Siege ATGM Pod
  const siegePodGeo = new THREE.BoxGeometry(0.62, 0.56, 1.45);

  // Soft hull-proportioned contact shadow plane grounded under vehicle
  const shadowDiscGeo = new THREE.PlaneGeometry(5.4, 8.2);
  shadowDiscGeo.rotateX(-Math.PI / 2);

  // Muzzle blast cone
  const muzzleFlashGeo = new THREE.ConeGeometry(0.68, 2.3, 7);
  muzzleFlashGeo.rotateX(-Math.PI / 2);
  muzzleFlashGeo.translate(0, 0, -1.15);

  // Glowing red enemy tactical IFF rear turret beacon
  const iffBeaconGeo = new THREE.BoxGeometry(0.56, 0.24, 0.24);
  const iffStalkGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.34, 6);

  sharedTankGeo = {
    mbtHullGeo,
    mbtTrackGeo,
    mbtSkirtGeo,
    mbtEngineDeckGeo,
    mbtTurretGeo,
    mbtCupolaGeo,
    mbtBarrelGeo,
    mbtMuzzleBrakeGeo,
    mbtCoaxGeo,
    mbtSmokePodGeo,
    mbtOpticGeo,
    buggyHullGeo,
    buggyWheelGeo,
    buggyTurretGeo,
    buggyGunGeo,
    siegePodGeo,
    shadowDiscGeo,
    muzzleFlashGeo,
    iffBeaconGeo,
    iffStalkGeo,
  };
  return sharedTankGeo;
}

function getSharedTankFlashMaterial(): THREE.MeshStandardMaterial {
  if (!sharedTankFlashMat) {
    sharedTankFlashMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffe4b5,
      emissiveIntensity: 0.95,
      roughness: 0.3,
      metalness: 0.25,
    });
  }
  return sharedTankFlashMat;
}

function getSharedTankMaterials(): Record<'player' | TankEnemyArchetype, TankMaterialPalette> {
  if (sharedTankMats) return sharedTankMats;

  const trackMat = new THREE.MeshStandardMaterial({
    color: 0x202224,
    roughness: 0.92,
    metalness: 0.18,
  });
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x3b3f45,
    roughness: 0.38,
    metalness: 0.68,
  });
  const muzzleMat = new THREE.MeshBasicMaterial({
    color: 0xffd26a,
    transparent: true,
    opacity: 0.92,
  });
  // Soft feathered radial contact shadow texture (prevents hard dark pancake disc)
  let shadowTex: THREE.CanvasTexture | undefined;
  if (typeof document !== 'undefined') {
    const sCanvas = document.createElement('canvas');
    sCanvas.width = 64;
    sCanvas.height = 64;
    const sCtx = sCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(32, 32, 6, 32, 32, 30);
      grad.addColorStop(0, 'rgba(10, 9, 8, 0.62)');
      grad.addColorStop(0.65, 'rgba(10, 9, 8, 0.28)');
      grad.addColorStop(1, 'rgba(10, 9, 8, 0.0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 64, 64);
      shadowTex = new THREE.CanvasTexture(sCanvas);
    }
  }
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: shadowTex,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const iffBeaconMat = new THREE.MeshBasicMaterial({
    color: 0xff2b2b,
    fog: false,
  });

  const makePalette = (
    hullHex: number,
    turretHex: number,
    accentHex: number,
    opticHex: number,
    hullRoughness = 0.72,
    hullMetalness = 0.22,
    turretRoughness = 0.62,
    turretMetalness = 0.28,
  ): TankMaterialPalette => ({
    hullMat: new THREE.MeshStandardMaterial({
      color: hullHex,
      roughness: hullRoughness,
      metalness: hullMetalness,
    }),
    turretMat: new THREE.MeshStandardMaterial({
      color: turretHex,
      roughness: turretRoughness,
      metalness: turretMetalness,
    }),
    trackMat,
    accentMat: new THREE.MeshStandardMaterial({
      color: accentHex,
      roughness: 0.36,
      metalness: 0.48,
    }),
    opticMat: new THREE.MeshStandardMaterial({
      color: opticHex,
      emissive: opticHex,
      emissiveIntensity: 0.9,
      roughness: 0.16,
      metalness: 0.2,
    }),
    barrelMat,
    muzzleMat,
    shadowMat,
    iffBeaconMat,
  });

  sharedTankMats = {
    // Player: warm olive-drab NATO armor with golden trim & cyan optics
    player: makePalette(0x636b54, 0x737c61, 0xd99b26, 0x38bdf8, 0.7, 0.24, 0.6, 0.3),
    // Enemies: distinct high-contrast dark-crimson & charcoal military camo with metallic specular sheen
    buggy: makePalette(0x28262b, 0x7a1c22, 0xe11d2f, 0xff453a, 0.46, 0.42, 0.42, 0.44),
    mbt: makePalette(0x22252c, 0x6b151b, 0xef233c, 0xff2f2f, 0.44, 0.44, 0.4, 0.46),
    siege: makePalette(0x1a1d24, 0x5c1018, 0xf43f5e, 0xff2222, 0.4, 0.48, 0.38, 0.5),
  };
  return sharedTankMats;
}

export function setTankRigHitFlash(rig: TankVisualRig, flashing: boolean): void {
  if (rig.isFlashing === flashing) return;
  rig.isFlashing = flashing;
  const flashMat = flashing ? getSharedTankFlashMaterial() : null;
  for (let i = 0; i < rig.flashEntries.length; i++) {
    const entry = rig.flashEntries[i];
    entry.mesh.material = flashMat || entry.baseMaterial;
  }
}

/**
 * Builds an articulated 3-12 part composite Tank / Armored Vehicle mesh (grounded bottom-center pivot).
 * Uses 100% shared BufferGeometries & shared Materials for mobile low-end parity.
 */
export function buildTankMesh(kind: 'player' | TankEnemyArchetype): TankVisualRig {
  const geo = getSharedTankGeometries();
  const pal = getSharedTankMaterials()[kind];

  const group = new THREE.Group();
  const hullGroup = new THREE.Group();
  const flashEntries: TankFlashEntry[] = [];

  // Ground contact shadow disc (y = 0.04)
  const shadow = new THREE.Mesh(geo.shadowDiscGeo, pal.shadowMat);
  shadow.position.y = 0.04;
  if (kind === 'buggy') shadow.scale.set(0.68, 1, 0.78);
  else if (kind === 'siege') shadow.scale.set(1.28, 1, 1.32);
  group.add(shadow);

  const turretPivot = new THREE.Group();
  const barrelPivot = new THREE.Group();
  const muzzleFlash = new THREE.Mesh(geo.muzzleFlashGeo, pal.muzzleMat);
  muzzleFlash.visible = false;

  if (kind === 'buggy') {
    // Fast 4-Wheel Recon Buggy (خودرو شناسایی سریع)
    const hull = new THREE.Mesh(geo.buggyHullGeo, pal.hullMat);
    hull.position.y = 0.92;
    hull.castShadow = true;
    hullGroup.add(hull);
    flashEntries.push({ mesh: hull, baseMaterial: pal.hullMat });

    const wheelCoords: ReadonlyArray<[number, number]> = [
      [-1.32, -1.42],
      [1.32, -1.42],
      [-1.32, 1.42],
      [1.32, 1.42],
    ];
    for (let i = 0; i < wheelCoords.length; i++) {
      const w = new THREE.Mesh(geo.buggyWheelGeo, pal.trackMat);
      w.position.set(wheelCoords[i][0], 0.56, wheelCoords[i][1]);
      hullGroup.add(w);
    }

    const trim = new THREE.Mesh(geo.mbtSmokePodGeo, pal.accentMat);
    trim.scale.set(5.4, 0.5, 0.65);
    trim.position.set(0, 1.15, -2.18);
    hullGroup.add(trim);

    turretPivot.position.set(0, 1.45, 0.1);
    const turret = new THREE.Mesh(geo.buggyTurretGeo, pal.turretMat);
    turret.position.y = 0.28;
    turretPivot.add(turret);
    flashEntries.push({ mesh: turret, baseMaterial: pal.turretMat });

    const optic = new THREE.Mesh(geo.mbtOpticGeo, pal.opticMat);
    optic.position.set(0.32, 0.45, -0.68);
    turretPivot.add(optic);

    // Glowing red tactical IFF beacon mounted on enemy turret rear
    const buggyIffStalk = new THREE.Mesh(geo.iffStalkGeo, pal.trackMat);
    buggyIffStalk.position.set(0, 0.68, 0.7);
    turretPivot.add(buggyIffStalk);
    const buggyIffLight = new THREE.Mesh(geo.iffBeaconGeo, pal.iffBeaconMat);
    buggyIffLight.position.set(0, 0.86, 0.72);
    turretPivot.add(buggyIffLight);

    barrelPivot.position.set(0, 0.32, -0.68);
    const gun = new THREE.Mesh(geo.buggyGunGeo, pal.barrelMat);
    barrelPivot.add(gun);
    muzzleFlash.position.set(0, 0, -2.55);
    muzzleFlash.scale.setScalar(0.55);
    barrelPivot.add(muzzleFlash);
    turretPivot.add(barrelPivot);
    hullGroup.add(turretPivot);
  } else {
    // Main Battle Tank / Player MBT / Heavy Siege Boss Tank
    const scale = kind === 'siege' ? 1.26 : kind === 'player' ? 1.04 : 1.0;

    // 1. Sloped Armored Hull
    const hull = new THREE.Mesh(geo.mbtHullGeo, pal.hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    hullGroup.add(hull);
    flashEntries.push({ mesh: hull, baseMaterial: pal.hullMat });

    // 2. Left & Right Armored Track Pods + Side Skirts
    const leftTrack = new THREE.Mesh(geo.mbtTrackGeo, pal.trackMat);
    leftTrack.position.set(-1.82, 0.52, 0);
    hullGroup.add(leftTrack);

    const rightTrack = new THREE.Mesh(geo.mbtTrackGeo, pal.trackMat);
    rightTrack.position.set(1.82, 0.52, 0);
    hullGroup.add(rightTrack);

    const leftSkirt = new THREE.Mesh(geo.mbtSkirtGeo, pal.turretMat);
    leftSkirt.position.set(-2.32, 0.85, 0);
    hullGroup.add(leftSkirt);
    flashEntries.push({ mesh: leftSkirt, baseMaterial: pal.turretMat });

    const rightSkirt = new THREE.Mesh(geo.mbtSkirtGeo, pal.turretMat);
    rightSkirt.position.set(2.32, 0.85, 0);
    hullGroup.add(rightSkirt);
    flashEntries.push({ mesh: rightSkirt, baseMaterial: pal.turretMat });

    // 3. Rear Engine Radiator Deck (visual cue for rear flanking weakspot!)
    const engineDeck = new THREE.Mesh(geo.mbtEngineDeckGeo, pal.trackMat);
    engineDeck.position.set(0, 1.54, 1.92);
    hullGroup.add(engineDeck);

    // Accent recognition stripe on front/rear hull
    const frontStripe = new THREE.Mesh(geo.mbtSmokePodGeo, pal.accentMat);
    frontStripe.scale.set(7.5, 0.45, 0.7);
    frontStripe.position.set(0, 1.18, -2.95);
    hullGroup.add(frontStripe);

    // 4. Independent Rotating Turret Assembly
    turretPivot.position.set(0, 1.5, -0.15);
    const turret = new THREE.Mesh(geo.mbtTurretGeo, pal.turretMat);
    turret.castShadow = true;
    turretPivot.add(turret);
    flashEntries.push({ mesh: turret, baseMaterial: pal.turretMat });

    // Commander Cupola + Glowing Optics
    const cupola = new THREE.Mesh(geo.mbtCupolaGeo, pal.hullMat);
    cupola.position.set(-0.55, 1.05, 0.35);
    turretPivot.add(cupola);

    const optic = new THREE.Mesh(geo.mbtOpticGeo, pal.opticMat);
    optic.position.set(0.62, 0.92, -1.18);
    turretPivot.add(optic);

    // Smoke Discharger Pods on turret cheeks
    const leftSmokePod = new THREE.Mesh(geo.mbtSmokePodGeo, pal.accentMat);
    leftSmokePod.position.set(-1.42, 0.62, -0.45);
    leftSmokePod.rotation.y = 0.3;
    turretPivot.add(leftSmokePod);

    const rightSmokePod = new THREE.Mesh(geo.mbtSmokePodGeo, pal.accentMat);
    rightSmokePod.position.set(1.42, 0.62, -0.45);
    rightSmokePod.rotation.y = -0.3;
    turretPivot.add(rightSmokePod);

    // Glowing red tactical IFF beacon light on enemy turret bustle rear (unmistakable visual silhouette)
    if (kind !== 'player') {
      const iffStalk = new THREE.Mesh(geo.iffStalkGeo, pal.trackMat);
      iffStalk.position.set(0, 1.06, 1.56);
      turretPivot.add(iffStalk);

      const iffBeacon = new THREE.Mesh(geo.iffBeaconGeo, pal.iffBeaconMat);
      iffBeacon.position.set(0, 1.24, 1.62);
      turretPivot.add(iffBeacon);

      // Subtle side crimson identification bars on turret bustle flanks
      const leftId = new THREE.Mesh(geo.iffBeaconGeo, pal.iffBeaconMat);
      leftId.scale.set(0.28, 0.65, 1.65);
      leftId.position.set(-1.18, 0.72, 1.15);
      turretPivot.add(leftId);

      const rightId = new THREE.Mesh(geo.iffBeaconGeo, pal.iffBeaconMat);
      rightId.scale.set(0.28, 0.65, 1.65);
      rightId.position.set(1.18, 0.72, 1.15);
      turretPivot.add(rightId);
    }

    // Extra twin ATGM launcher pods for Heavy Siege Boss Tank
    if (kind === 'siege') {
      const leftAtgmPod = new THREE.Mesh(geo.siegePodGeo, pal.accentMat);
      leftAtgmPod.position.set(-1.78, 0.92, 0.15);
      turretPivot.add(leftAtgmPod);

      const rightAtgmPod = new THREE.Mesh(geo.siegePodGeo, pal.accentMat);
      rightAtgmPod.position.set(1.78, 0.92, 0.15);
      turretPivot.add(rightAtgmPod);
    }

    // 5. Articulated Main Cannon + Muzzle Brake + Coaxial MG + Muzzle Flash
    barrelPivot.position.set(0, 0.56, -1.35);
    const mainBarrel = new THREE.Mesh(geo.mbtBarrelGeo, pal.barrelMat);
    barrelPivot.add(mainBarrel);

    const muzzleBrake = new THREE.Mesh(geo.mbtMuzzleBrakeGeo, pal.accentMat);
    barrelPivot.add(muzzleBrake);

    const coaxMg = new THREE.Mesh(geo.mbtCoaxGeo, pal.trackMat);
    barrelPivot.add(coaxMg);

    muzzleFlash.position.set(0, 0, -5.25);
    barrelPivot.add(muzzleFlash);

    turretPivot.add(barrelPivot);
    hullGroup.add(turretPivot);
    hullGroup.scale.setScalar(scale);
  }

  group.add(hullGroup);

  return {
    group,
    hullGroup,
    turretPivot,
    barrelPivot,
    muzzleFlash,
    flashEntries,
    isFlashing: false,
  };
}

/**
 * Safely disposes & clears module-level shared tank assets on engine teardown/remount.
 */
export function resetSharedTankMeshAssets(): void {
  if (sharedTankGeo) {
    Object.values(sharedTankGeo).forEach((g) => g.dispose());
    sharedTankGeo = null;
  }
  if (sharedTankMats) {
    const disposed = new Set<THREE.Material>();
    Object.values(sharedTankMats).forEach((pal) => {
      Object.values(pal).forEach((m) => {
        if (!disposed.has(m)) {
          disposed.add(m);
          m.dispose();
        }
      });
    });
    sharedTankMats = null;
  }
  if (sharedTankFlashMat) {
    sharedTankFlashMat.dispose();
    sharedTankFlashMat = null;
  }
}
