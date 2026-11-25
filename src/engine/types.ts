export type GameMode = 'jet' | 'tank';

export type GamePhase = 'title' | 'playing' | 'paused' | 'gameover';

export type DifficultyLevel = 'easy' | 'normal' | 'hard';

export type DefeatReason = 'ocean' | 'terrain' | 'combat' | 'none';

export type EnemyArchetype = 'recon' | 'interceptor' | 'heavy' | 'ace';

export type SurfaceUnitType = 'sam' | 'warship';

export type TargetType = EnemyArchetype | SurfaceUnitType;

export type TankEnemyArchetype = 'buggy' | 'mbt' | 'siege';

export type TankAIState = 'PATROL' | 'FLANK_AND_COVER' | 'ENGAGE' | 'RETREAT_SMOKE';

export type ArmorHitZone = 'front' | 'side' | 'rear';

export type AIState =
  | 'PATROL'
  | 'PURSUIT'
  | 'ATTACK'
  | 'BREAKAWAY'
  | 'EVADE'
  | 'TERRAIN_AVOIDANCE';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ControlInput {
  pitch: number; // -1 (nose down) to +1 (nose up)
  roll: number; // -1 (bank left) to +1 (bank right)
  yaw: number; // optional manual rudder -1 to +1
  fireGun: boolean;
  fireMissile: boolean; // edge-triggered or buffered
  boost: boolean;
  flare: boolean; // edge-triggered
}

export interface TankControlInput {
  throttle: number; // -1 (reverse) to +1 (forward)
  steer: number; // -1 (left) to +1 (right)
  fireCannon: boolean;
  fireMg: boolean;
  boost: boolean;
  smoke: boolean;
}

export interface CityAabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
  kind: 'building' | 'barricade' | 'wreck';
}

export interface RadarBlip {
  id: number;
  x: number; // normalized -1..1 relative to player right
  y: number; // normalized -1..1 relative to player forward (positive = ahead)
  type: 'enemy' | 'missile' | 'ace' | 'sam' | 'warship';
  isLocked: boolean;
}

export interface TankMinimapBlip {
  id: number;
  x: number; // normalized -1..1 relative to city extent
  z: number; // normalized -1..1 relative to city extent
  type: 'buggy' | 'mbt' | 'siege' | 'atgm';
  isLocked: boolean;
}

export interface ProjectedTarget {
  id: number;
  archetype: TargetType;
  category: 'air' | 'sam' | 'warship';
  nameFa: string;
  screenX: number; // 0..1 viewport fraction
  screenY: number; // 0..1 viewport fraction
  inFront: boolean;
  onScreen: boolean;
  distance: number;
  hpRatio: number;
  isLockCandidate: boolean;
  isLocked: boolean;
  lockProgress: number; // 0..1
  leadX: number; // 0..1
  leadY: number; // 0..1
  leadVisible: boolean;
}

export interface ProjectedTankTarget {
  id: number;
  archetype: TankEnemyArchetype;
  nameFa: string;
  screenX: number;
  screenY: number;
  inFront: boolean;
  onScreen: boolean;
  distance: number;
  hpRatio: number;
  isLocked: boolean;
  leadX: number;
  leadY: number;
  leadVisible: boolean;
}

export interface ProjectedIncomingMissile {
  id: number;
  screenX: number; // 0..1
  screenY: number; // 0..1
  inFront: boolean;
  onScreen: boolean;
  distance: number; // meters
  sourceLabelFa: string;
}

export interface WaveAnnouncement {
  wave: number;
  titleFa: string;
  subtitleFa: string;
  remaining: number;
}

export interface KillFeedItem {
  id: number;
  textFa: string;
  points: number;
}

export interface EdgeTelemetryInfo {
  connected: boolean;
  popNameFa: string;
  popCode: string;
  pingMs: number;
  source: 'arvan-edge' | 'local';
}

export interface LeaderboardEntry {
  id: string;
  callsign: string;
  score: number;
  wave: number;
  kills: number;
  survivalTimeSec: number;
  difficulty: DifficultyLevel;
  mode?: GameMode;
  timestamp: number;
}

export interface HudSnapshot {
  phase: GamePhase;
  difficulty: DifficultyLevel;
  speedKmh: number;
  altitudeM: number;
  aglM: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  hp: number;
  maxHp: number;
  ghostHp: number;
  score: number;
  highScore: number;
  kills: number;
  wave: number;
  enemiesRemaining: number;
  surfaceThreatsRemaining: number;
  afterburnerHeat: number; // 0..100
  afterburnerOverheated: boolean;
  afterburnerActive: boolean;
  missilesReady: number;
  missilesMax: number;
  missileReloadProgress: number; // 0..1
  flaresReady: number;
  flaresMax: number;
  flareReloadProgress: number; // 0..1
  lockTargetId: number | null;
  lockProgress: number; // 0..1
  isLocked: boolean;
  gpwsWarning: boolean;
  missileLockWarning: boolean;
  missileIncomingWarning: boolean;
  samLockWarning: boolean;
  samMaskNoticeTimer: number;
  hitMarkerTimer: number;
  hitMarkerCritical: boolean;
  damageFlashTimer: number;
  flareSuccessTimer: number;
  enemyFlareNoticeTimer: number;
  defeatReason: DefeatReason;
  survivalTimeSec: number;
  waveBanner: WaveAnnouncement | null;
  killFeed: KillFeedItem | null;
  radarBlips: RadarBlip[];
  targets: ProjectedTarget[];
  incomingMissiles: ProjectedIncomingMissile[];
  isTouchDevice: boolean;
}

export interface TankHudSnapshot {
  phase: GamePhase;
  difficulty: DifficultyLevel;
  speedKmh: number;
  hullHeadingDeg: number;
  turretHeadingDeg: number;
  hp: number;
  maxHp: number;
  ghostHp: number;
  score: number;
  highScore: number;
  kills: number;
  wave: number;
  enemiesRemaining: number;
  // Dual reticles: player aim intent vs heavy barrel current alignment
  aimReticleX: number; // 0..1
  aimReticleY: number; // 0..1
  barrelReticleX: number; // 0..1
  barrelReticleY: number; // 0..1
  barrelAligned: boolean;
  // Weapons & systems
  cannonReloadProgress: number; // 0..1 (1 = ready)
  cannonReady: boolean;
  mgHeat: number; // 0..100
  mgOverheated: boolean;
  turboCharge: number; // 0..100
  turboActive: boolean;
  turboOverheated: boolean;
  smokeReady: number;
  smokeMax: number;
  smokeReloadProgress: number; // 0..1
  smokeActiveTimer: number;
  // Tactical alerts & combat feedback
  lockedTargetId: number | null;
  atgmLockWarning: boolean;
  atgmIncomingWarning: boolean;
  flankNoticeTimer: number;
  smokeSuccessTimer: number;
  armorDeflectTimer: number;
  hitMarkerTimer: number;
  hitMarkerCritical: boolean;
  damageFlashTimer: number;
  defeatReason: DefeatReason;
  survivalTimeSec: number;
  waveBanner: WaveAnnouncement | null;
  killFeed: KillFeedItem | null;
  // Urban minimap & 3D screen projections
  playerMapX: number; // -1..1
  playerMapZ: number; // -1..1
  minimapBlips: TankMinimapBlip[];
  targets: ProjectedTankTarget[];
  incomingAtgms: ProjectedIncomingMissile[];
  isTouchDevice: boolean;
}

