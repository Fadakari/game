import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Crosshair,
  Flame,
  ShieldAlert,
  CloudFog,
  Target,
  Radio,
  Zap,
  Shield,
} from 'lucide-react';
import { CITY_PLAYABLE_HALF } from '../engine/tankCity';
import type {
  EdgeTelemetryInfo,
  ProjectedTankTarget,
  TankHudSnapshot,
} from '../engine/types';
import { formatScoreFa, toFaNum } from '../utils/formatFa';

export interface BuildingFootprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface TankHUDProps {
  hud: TankHudSnapshot;
  buildingFootprints: BuildingFootprint[];
  edgeTelemetry: EdgeTelemetryInfo | null;
  muted: boolean;
  isFullscreen: boolean;
  showOnboarding: boolean;
  showTouchControls: boolean;
  onTogglePause: () => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onTankStick: (throttle: number, steer: number) => void;
  onTankAimDelta: (deltaYawRad: number, deltaPitchRad: number) => void;
  onTankButton: (btn: 'fireCannon' | 'fireMg' | 'boost', active: boolean) => void;
  onFireCannon: () => void;
  onDeploySmoke: () => void;
  onTargetSnap: () => void;
}

const STICK_MAX_RADIUS = 52;
const STICK_DEADZONE = 0.1;

function applyStickCurve(raw: number): number {
  const mag = Math.abs(raw);
  if (mag < STICK_DEADZONE) return 0;
  const norm = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return Math.sign(raw) * Math.pow(norm, 1.3);
}

const ARCHETYPE_COLORS: Record<ProjectedTankTarget['archetype'], string> = {
  buggy: '#38bdf8',
  mbt: '#f59e0b',
  siege: '#f87171',
};

export function TankHUD({
  hud,
  buildingFootprints,
  edgeTelemetry,
  muted,
  isFullscreen,
  showOnboarding,
  showTouchControls,
  onTogglePause,
  onToggleMute,
  onToggleFullscreen,
  onTankStick,
  onTankAimDelta,
  onTankButton,
  onFireCannon,
  onDeploySmoke,
  onTargetSnap,
}: TankHUDProps) {
  // Left thumb dynamic virtual joystick for tank hull driving
  const stickPointerId = useRef<number | null>(null);
  const [stickOrigin, setStickOrigin] = useState<{ x: number; y: number } | null>(null);
  const [stickKnob, setStickKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Right-half invisible touch drag zone for independent turret aiming
  const aimPointerId = useRef<number | null>(null);
  const aimLastPos = useRef<{ x: number; y: number } | null>(null);

  const [cannonPressed, setCannonPressed] = useState(false);
  const [mgPressed, setMgPressed] = useState(false);
  const [boostPressed, setBoostPressed] = useState(false);

  const handleStickDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerId.current !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stickPointerId.current = e.pointerId;
    const rect = e.currentTarget.getBoundingClientRect();
    setStickOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setStickKnob({ x: 0, y: 0 });
    onTankStick(0, 0);
  };

  const handleStickMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerId.current !== e.pointerId || !stickOrigin) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - rect.left - stickOrigin.x;
    const dy = e.clientY - rect.top - stickOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, STICK_MAX_RADIUS);
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * clampedDist;
    const ky = Math.sin(angle) * clampedDist;
    setStickKnob({ x: kx, y: ky });

    const steer = applyStickCurve(kx / STICK_MAX_RADIUS);
    const throttle = applyStickCurve(-ky / STICK_MAX_RADIUS);
    onTankStick(throttle, steer);
  };

  const handleStickUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerId.current !== e.pointerId) return;
    stickPointerId.current = null;
    setStickOrigin(null);
    setStickKnob({ x: 0, y: 0 });
    onTankStick(0, 0);
  };

  const handleAimDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (aimPointerId.current !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    aimPointerId.current = e.pointerId;
    aimLastPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleAimMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (aimPointerId.current !== e.pointerId || !aimLastPos.current) return;
    const dx = e.clientX - aimLastPos.current.x;
    const dy = e.clientY - aimLastPos.current.y;
    aimLastPos.current = { x: e.clientX, y: e.clientY };
    // Right drag turns turret right (negative yaw delta in Three.js Y-up), up drag elevates
    onTankAimDelta(-dx * 0.0054, -dy * 0.0024);
  };

  const handleAimUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (aimPointerId.current !== e.pointerId) return;
    aimPointerId.current = null;
    aimLastPos.current = null;
  };

  const hpPct = Math.max(0, Math.min(100, (hud.hp / hud.maxHp) * 100));
  const ghostPct = Math.max(hpPct, Math.min(100, (hud.ghostHp / hud.maxHp) * 100));
  const lowHp = hpPct <= 30;
  const atgmThreat = hud.atgmIncomingWarning || hud.atgmLockWarning;

  // Cannon reload ring SVG math (radius 24 -> circumference ~150.8)
  const reloadRadius = 24;
  const reloadCircumference = 2 * Math.PI * reloadRadius;
  const reloadDashOffset =
    reloadCircumference * (1 - Math.max(0, Math.min(1, hud.cannonReloadProgress)));

  // Primary predictive lead pip on locked target
  const leadTarget: ProjectedTankTarget | undefined =
    hud.targets.find((t) => t.isLocked && t.leadVisible) ||
    hud.targets.find((t) => t.onScreen && t.leadVisible);

  // Minimap coordinate converter (-CITY_PLAYABLE_HALF..+CITY_PLAYABLE_HALF -> 8..116)
  const mapExtent = CITY_PLAYABLE_HALF;
  const toMapCoord = (v: number) => 62 + (v / mapExtent) * 54;
  const playerSvgX = 62 + hud.playerMapX * 54;
  const playerSvgY = 62 + hud.playerMapZ * 54;

  // Turret & hull SVG heading angles (0° = North/-Z)
  const turretRad = ((hud.turretHeadingDeg - 90) * Math.PI) / 180;
  const coneHalf = 0.34;
  const coneLen = 28;
  const coneX1 = playerSvgX + Math.cos(turretRad - coneHalf) * coneLen;
  const coneY1 = playerSvgY + Math.sin(turretRad - coneHalf) * coneLen;
  const coneX2 = playerSvgX + Math.cos(turretRad + coneHalf) * coneLen;
  const coneY2 = playerSvgY + Math.sin(turretRad + coneHalf) * coneLen;

  return (
    <div
      dir="rtl"
      data-testid="tank-hud"
      className="pointer-events-none fixed inset-0 z-20 overflow-hidden select-none"
    >
      {/* Peripheral Low-Armor / Damage Hit Vignette */}
      {(lowHp || hud.damageFlashTimer > 0) && (
        <div
          className="fixed inset-0 transition-opacity duration-150"
          style={{
            boxShadow:
              hud.damageFlashTimer > 0
                ? 'inset 0 0 115px rgba(239, 68, 68, 0.72)'
                : 'inset 0 0 85px rgba(220, 38, 38, 0.42)',
          }}
        />
      )}

      {/* 3D PROJECTED ENEMY TANK MARKERS */}
      {hud.targets.map((target) => {
        const accent = ARCHETYPE_COLORS[target.archetype];
        if (target.onScreen) {
          return (
            <div
              key={target.id}
              className="fixed -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${target.screenX * 100}%`,
                top: `${target.screenY * 100}%`,
              }}
            >
              <div className="flex flex-col items-center gap-0.5">
                <div
                  className="hud-text-shadow flex items-center gap-1 whitespace-nowrap text-[10px] font-bold"
                  style={{ color: target.isLocked ? '#fef08a' : accent }}
                >
                  <span>{target.nameFa}</span>
                  <span className="tabular-nums opacity-90">{toFaNum(target.distance)}م</span>
                </div>

                {/* Target Bracket */}
                <div
                  className="relative flex items-center justify-center"
                  style={{
                    width: target.archetype === 'siege' ? 42 : 34,
                    height: target.archetype === 'siege' ? 36 : 30,
                  }}
                >
                  <div
                    className="h-full w-full rounded-[4px] border-2"
                    style={{
                      borderColor: target.isLocked ? '#fbbf24' : accent,
                      boxShadow: target.isLocked
                        ? '0 0 10px rgba(251, 191, 36, 0.6)'
                        : undefined,
                    }}
                  />
                  {target.isLocked && (
                    <div className="absolute -bottom-3.5 whitespace-nowrap rounded bg-amber-500/90 px-1 py-px text-[9px] font-black text-slate-950">
                      قفل
                    </div>
                  )}
                </div>

                {/* Enemy Armor Bar */}
                <div className="mt-0.5 h-1.5 w-11 overflow-hidden rounded-full bg-slate-950/85 border border-slate-200/20">
                  <div
                    className="h-full transition-all duration-100"
                    style={{
                      width: `${Math.max(4, target.hpRatio * 100)}%`,
                      backgroundColor: target.hpRatio > 0.45 ? accent : '#ef4444',
                    }}
                  />
                </div>
              </div>
            </div>
          );
        }

        // Off-screen edge directional arrow
        const edgeX = Math.max(0.05, Math.min(0.95, target.screenX));
        const edgeY = Math.max(0.11, Math.min(0.84, target.screenY));
        const angleRad = Math.atan2(target.screenY - 0.5, target.screenX - 0.5);
        const angleDeg = (angleRad * 180) / Math.PI;

        return (
          <div
            key={target.id}
            className="fixed -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${edgeX * 100}%`,
              top: `${edgeY * 100}%`,
            }}
          >
            <div className="flex flex-col items-center">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                style={{ transform: `rotate(${angleDeg}deg)` }}
                aria-hidden="true"
              >
                <polygon
                  points="18,10 5,4 8,10 5,16"
                  fill={target.isLocked ? '#fbbf24' : accent}
                  stroke="#090d0b"
                  strokeWidth="1.2"
                />
              </svg>
              <span className="hud-text-shadow tabular-nums text-[9px] font-bold text-slate-100">
                {toFaNum(target.distance)}م
              </span>
            </div>
          </div>
        );
      })}

      {/* PREDICTIVE LEAD PIP ON LOCKED TARGET */}
      {leadTarget && (
        <div
          className="fixed -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${leadTarget.leadX * 100}%`,
            top: `${leadTarget.leadY * 100}%`,
          }}
        >
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <circle
              cx="13"
              cy="13"
              r="7.5"
              fill="none"
              stroke="#facc15"
              strokeWidth="1.8"
              strokeDasharray="3 2"
            />
            <circle cx="13" cy="13" r="2.2" fill="#facc15" />
          </svg>
        </div>
      )}

      {/* HIGH-VISIBILITY PULSING RED INCOMING ATGM TRACKERS */}
      {hud.incomingAtgms.map((atgm) => {
        const edgeX = atgm.onScreen
          ? atgm.screenX
          : Math.max(0.06, Math.min(0.94, atgm.screenX));
        const edgeY = atgm.onScreen
          ? atgm.screenY
          : Math.max(0.12, Math.min(0.84, atgm.screenY));
        const angleRad = Math.atan2(atgm.screenY - 0.5, atgm.screenX - 0.5);
        const angleDeg = (angleRad * 180) / Math.PI;

        return (
          <div
            key={atgm.id}
            className="animate-alert-flash fixed -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${edgeX * 100}%`,
              top: `${edgeY * 100}%`,
            }}
          >
            <div className="flex flex-col items-center gap-0.5">
              {atgm.onScreen ? (
                <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                  <polygon
                    points="14,2 26,14 14,26 2,14"
                    fill="rgba(239, 68, 68, 0.28)"
                    stroke="#ef4444"
                    strokeWidth="2.4"
                  />
                  <circle cx="14" cy="14" r="3" fill="#fef08a" />
                </svg>
              ) : (
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 26 26"
                  style={{ transform: `rotate(${angleDeg}deg)` }}
                  aria-hidden="true"
                >
                  <polygon
                    points="24,13 6,4 10,13 6,22"
                    fill="#ef4444"
                    stroke="#fef08a"
                    strokeWidth="1.5"
                  />
                </svg>
              )}
              <div className="whitespace-nowrap rounded border border-red-400/80 bg-red-950/92 px-1.5 py-0.5 text-[10px] font-black text-red-100 shadow-lg">
                <span className="tabular-nums">موشک ضدتانک: {toFaNum(atgm.distance)}م</span>
              </div>
            </div>
          </div>
        );
      })}

      {/* DUAL TANK RETICLES */}
      {/* 1. Outer Commander Aim Reticle (where mouse / right thumb points) */}
      <div
        className="fixed -translate-x-1/2 -translate-y-1/2"
        style={{
          left: `${hud.aimReticleX * 100}%`,
          top: `${hud.aimReticleY * 100}%`,
        }}
      >
        <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
          <circle
            cx="23"
            cy="23"
            r="16"
            fill="none"
            stroke="rgba(254, 240, 138, 0.55)"
            strokeWidth="1.2"
            strokeDasharray="4 4"
          />
          <line x1="23" y1="2" x2="23" y2="9" stroke="rgba(254, 240, 138, 0.72)" strokeWidth="1.4" />
          <line x1="23" y1="37" x2="23" y2="44" stroke="rgba(254, 240, 138, 0.72)" strokeWidth="1.4" />
          <line x1="2" y1="23" x2="9" y2="23" stroke="rgba(254, 240, 138, 0.72)" strokeWidth="1.4" />
          <line x1="37" y1="23" x2="44" y2="23" stroke="rgba(254, 240, 138, 0.72)" strokeWidth="1.4" />
        </svg>
      </div>

      {/* 2. Heavy Barrel Alignment Reticle + Circular Cannon Reload Ring */}
      <div
        className="fixed -translate-x-1/2 -translate-y-1/2"
        style={{
          left: `${hud.barrelReticleX * 100}%`,
          top: `${hud.barrelReticleY * 100}%`,
        }}
      >
        <svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true">
          {/* Reload background track */}
          <circle
            cx="37"
            cy="37"
            r={reloadRadius}
            fill="none"
            stroke="rgba(15, 23, 20, 0.58)"
            strokeWidth="3.2"
          />
          {/* Reload progress arc */}
          <circle
            cx="37"
            cy="37"
            r={reloadRadius}
            fill="none"
            stroke={hud.cannonReady ? '#34d399' : '#f59e0b'}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={reloadCircumference}
            strokeDashoffset={reloadDashOffset}
            transform="rotate(-90 37 37)"
          />
          {/* Heavy gunnery T-chevron & center dot */}
          <line
            x1="21"
            y1="37"
            x2="31"
            y2="37"
            stroke={hud.barrelAligned ? '#34d399' : '#fbbf24'}
            strokeWidth="2"
          />
          <line
            x1="43"
            y1="37"
            x2="53"
            y2="37"
            stroke={hud.barrelAligned ? '#34d399' : '#fbbf24'}
            strokeWidth="2"
          />
          <line
            x1="37"
            y1="43"
            x2="37"
            y2="51"
            stroke={hud.barrelAligned ? '#34d399' : '#fbbf24'}
            strokeWidth="1.8"
          />
          <circle
            cx="37"
            cy="37"
            r="2.4"
            fill={hud.cannonReady ? '#34d399' : '#fbbf24'}
          />

          {/* Hit Confirmation X-Marker */}
          {hud.hitMarkerTimer > 0 && (
            <g
              stroke={hud.hitMarkerCritical ? '#f87171' : '#fbbf24'}
              strokeWidth={hud.hitMarkerCritical ? '3' : '2.3'}
              strokeLinecap="round"
            >
              <line x1="25" y1="25" x2="32" y2="32" />
              <line x1="49" y1="25" x2="42" y2="32" />
              <line x1="25" y1="49" x2="32" y2="42" />
              <line x1="49" y1="49" x2="42" y2="42" />
            </g>
          )}
        </svg>
      </div>

      {/* TOP BAR: TOP-RIGHT SCORE/WAVE + UTILITY | CENTER ALERTS | TOP-LEFT URBAN MINIMAP */}
      <div className="fixed inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4">
        {/* Top-Right (RTL Start): Score, Wave, Enemies + Utility Buttons + Edge Ping */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 rounded-lg border border-amber-300/18 bg-[#121614]/84 px-3.5 py-2">
            <div>
              <div className="text-[10px] font-medium text-stone-400">امتیاز</div>
              <div className="tabular-nums text-xl font-black leading-none text-amber-400">
                {formatScoreFa(hud.score)}
              </div>
            </div>
            <div className="h-7 w-px bg-stone-200/15" />
            <div>
              <div className="text-[10px] font-medium text-stone-400">موج</div>
              <div className="tabular-nums text-xl font-black leading-none text-white">
                {toFaNum(hud.wave)}
              </div>
            </div>
            <div className="h-7 w-px bg-stone-200/15" />
            <div>
              <div className="text-[10px] font-medium text-stone-400">زرهی دشمن</div>
              <div className="tabular-nums text-xl font-black leading-none text-emerald-300">
                {toFaNum(hud.enemiesRemaining)}
              </div>
            </div>
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onTogglePause();
              }}
              tabIndex={-1}
              aria-label="توقف بازی"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200/18 bg-[#121614]/84 text-stone-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
            >
              <Pause className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onToggleMute();
              }}
              tabIndex={-1}
              aria-label={muted ? 'وصل صدا' : 'قطع صدا'}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200/18 bg-[#121614]/84 text-stone-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onToggleFullscreen();
              }}
              tabIndex={-1}
              aria-label={isFullscreen ? 'خروج از تمام‌صفحه' : 'نمایش تمام‌صفحه'}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200/18 bg-[#121614]/84 text-stone-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </div>

          {edgeTelemetry && (
            <div
              data-testid="arvan-edge-badge"
              className="flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-[#121614]/82 px-2.5 py-1 text-[10px] font-bold text-emerald-200"
            >
              <Radio className="h-3 w-3 shrink-0 text-emerald-400" />
              <span className="tabular-nums whitespace-nowrap">
                اتصال به لبه آروان | پینگ: {toFaNum(edgeTelemetry.pingMs)}ms
              </span>
            </div>
          )}
        </div>

        {/* Center-Top Alerts, Flanking Crit, Smoke Defense & Wave Banner */}
        <div className="flex max-w-md flex-col items-center gap-2 pt-1 text-center">
          {atgmThreat && (
            <div className="animate-alert-flash flex items-center gap-2 rounded-lg border border-red-400 bg-red-950/94 px-4 py-1.5 text-xs font-black text-amber-200 shadow-lg sm:text-sm">
              <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
              <span>هشدار قفل ضدتانک! از دود استفاده کنید</span>
            </div>
          )}

          {hud.flankNoticeTimer > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-amber-400/80 bg-[#2b1507]/92 px-3.5 py-1 text-xs font-black text-amber-300 shadow-lg">
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              <span>ضربه مرگبار به جناح!</span>
            </div>
          )}

          {hud.smokeSuccessTimer > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/70 bg-emerald-950/90 px-3.5 py-1 text-xs font-bold text-emerald-200 shadow-lg">
              <CloudFog className="h-3.5 w-3.5 text-emerald-300" />
              <span>پرده دود فعال — قفل ضدتانک شکسته شد</span>
            </div>
          )}

          {hud.armorDeflectTimer > 0 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-sky-400/60 bg-slate-900/90 px-3 py-1 text-xs font-bold text-sky-200 shadow-lg">
              <Shield className="h-3.5 w-3.5 text-sky-300" />
              <span>انحراف ضربه با زره جلو</span>
            </div>
          )}

          {hud.waveBanner && (
            <div className="rounded-lg border border-amber-400/50 bg-[#141714]/90 px-5 py-2 shadow-xl">
              <div className="text-base font-black text-amber-400">
                {hud.waveBanner.titleFa}
              </div>
              <div className="text-xs font-medium text-stone-200">
                {hud.waveBanner.subtitleFa}
              </div>
            </div>
          )}

          {hud.killFeed && (
            <div className="rounded-md border border-emerald-400/35 bg-[#121614]/86 px-3 py-1 text-xs font-bold text-emerald-300">
              {hud.killFeed.textFa} (+{formatScoreFa(hud.killFeed.points)})
            </div>
          )}
        </div>

        {/* Top-Left (RTL End): Urban Tactical Minimap */}
        <div className="flex flex-col items-center gap-1">
          <div className="relative rounded-lg border border-amber-300/25 bg-[#101513]/88 p-1.5 shadow-xl">
            <svg
              width="124"
              height="124"
              viewBox="0 0 124 124"
              className="block"
              aria-label="نقشه تاکتیکی شهر"
            >
              {/* Street grid background */}
              <rect
                x="4"
                y="4"
                width="116"
                height="116"
                rx="4"
                fill="#171d1a"
                stroke="rgba(245, 158, 11, 0.25)"
                strokeWidth="1"
              />
              {/* Subtle tactical grid lines */}
              <line x1="62" y1="6" x2="62" y2="118" stroke="rgba(148, 163, 184, 0.14)" strokeWidth="1" />
              <line x1="6" y1="62" x2="118" y2="62" stroke="rgba(148, 163, 184, 0.14)" strokeWidth="1" />

              {/* Building footprints */}
              {buildingFootprints.map((b, i) => {
                const x1 = toMapCoord(b.minX);
                const y1 = toMapCoord(b.minZ);
                const w = Math.max(2, toMapCoord(b.maxX) - x1);
                const h = Math.max(2, toMapCoord(b.maxZ) - y1);
                return (
                  <rect
                    key={i}
                    x={x1}
                    y={y1}
                    width={w}
                    height={h}
                    rx="1"
                    fill="#3a3d38"
                    stroke="rgba(214, 211, 209, 0.22)"
                    strokeWidth="0.6"
                  />
                );
              })}

              {/* Player Turret Sight Cone */}
              <polygon
                points={`${playerSvgX},${playerSvgY} ${coneX1},${coneY1} ${coneX2},${coneY2}`}
                fill="rgba(52, 211, 153, 0.24)"
              />

              {/* Enemy & ATGM Blips */}
              {hud.minimapBlips.map((blip) => {
                const bx = 62 + blip.x * 54;
                const by = 62 + blip.z * 54;
                if (blip.type === 'atgm') {
                  return (
                    <circle
                      key={`atgm-${blip.id}`}
                      cx={bx}
                      cy={by}
                      r="3.2"
                      fill="#ef4444"
                      stroke="#fef08a"
                      strokeWidth="0.9"
                    />
                  );
                }
                const blipColor =
                  blip.type === 'siege'
                    ? '#f87171'
                    : blip.type === 'buggy'
                    ? '#38bdf8'
                    : '#f59e0b';
                return (
                  <g key={`e-${blip.id}`}>
                    {blip.isLocked && (
                      <circle
                        cx={bx}
                        cy={by}
                        r="5.5"
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth="1.2"
                      />
                    )}
                    <rect
                      x={bx - 2.6}
                      y={by - 2.6}
                      width="5.2"
                      height="5.2"
                      rx="1"
                      fill={blipColor}
                      stroke="#0a0d0b"
                      strokeWidth="0.7"
                    />
                  </g>
                );
              })}

              {/* Player Tank Hull Indicator */}
              <g
                transform={`translate(${playerSvgX} ${playerSvgY}) rotate(${hud.hullHeadingDeg})`}
              >
                <rect
                  x="-3"
                  y="-4.5"
                  width="6"
                  height="9"
                  rx="1"
                  fill="#34d399"
                  stroke="#052e16"
                  strokeWidth="1"
                />
                <polygon points="0,-6.5 -2.2,-3.5 2.2,-3.5" fill="#fef08a" />
              </g>
            </svg>
          </div>
          <div className="hud-text-shadow tabular-nums text-[10px] font-bold text-stone-200">
            برجک {toFaNum(hud.turretHeadingDeg)}° · بدنه {toFaNum(hud.hullHeadingDeg)}°
          </div>
        </div>
      </div>

      {/* 3-SECOND TANK ONBOARDING HINT (Fades out automatically or on first input) */}
      {showOnboarding && (
        <div className="fixed inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <div className="rounded-lg border border-amber-400/45 bg-[#121614]/92 px-4 py-2 text-center text-xs font-bold text-amber-100 shadow-xl sm:text-sm">
            {showTouchControls
              ? 'شست چپ: حرکت تانک · کشیدن انگشت راست: چرخش برجک · دکمه‌ها: توپ، تیربار و پرده دود'
              : 'حرکت: WASD · برجک: ماوس · توپ اصلی: کلیک چپ · تیربار: راست‌کلیک یا Space · پرده دود: F · توربو: Shift · قفل: Q'}
          </div>
        </div>
      )}

      {/* BOTTOM ARMORED TELEMETRY STRIP (Desktop & Compact Landscape) */}
      <div className="fixed inset-x-0 bottom-3 flex justify-center px-3">
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border border-stone-200/15 bg-[#121614]/84 px-4 py-2 text-xs text-stone-100 shadow-2xl">
          {/* Speed */}
          <div className="flex flex-col items-center min-w-[54px]">
            <span className="text-[10px] text-stone-400">سرعت</span>
            <span className="tabular-nums text-base font-black text-white">
              {toFaNum(hud.speedKmh)}{' '}
              <span className="text-[10px] font-medium text-stone-400">کم/س</span>
            </span>
          </div>

          <div className="h-7 w-px bg-stone-200/15" />

          {/* Armor Health Bar with Ghost Damage Trail */}
          <div className="flex flex-col gap-1 min-w-[116px]">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-semibold text-stone-300">سلامت زره</span>
              <span
                className={`tabular-nums font-black ${
                  lowHp ? 'text-red-400' : 'text-emerald-300'
                }`}
              >
                {toFaNum(Math.round(hpPct))}٪
              </span>
            </div>
            <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-stone-900 border border-stone-200/15">
              <div
                className="absolute inset-y-0 right-0 bg-stone-200/75 transition-all duration-300"
                style={{ width: `${ghostPct}%` }}
              />
              <div
                className={`absolute inset-y-0 right-0 transition-all duration-100 ${
                  lowHp ? 'bg-red-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${hpPct}%` }}
              />
            </div>
          </div>

          <div className="h-7 w-px bg-stone-200/15" />

          {/* 120mm Cannon Reload */}
          <div className="flex flex-col gap-1 min-w-[92px]">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-semibold text-stone-300">توپ ۱۲۰م‌م</span>
              <span
                className={`tabular-nums font-black ${
                  hud.cannonReady ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                {hud.cannonReady
                  ? 'آماده'
                  : `${toFaNum(Math.round(hud.cannonReloadProgress * 100))}٪`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-900">
              <div
                className={`h-full transition-all duration-75 ${
                  hud.cannonReady ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                style={{ width: `${Math.round(hud.cannonReloadProgress * 100)}%` }}
              />
            </div>
          </div>

          <div className="hidden h-7 w-px bg-stone-200/15 sm:block" />

          {/* Coaxial Machine Gun Heat */}
          <div className="hidden flex-col gap-1 min-w-[78px] sm:flex">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-stone-400">تیربار</span>
              <span
                className={`tabular-nums font-bold ${
                  hud.mgOverheated ? 'text-red-400' : 'text-stone-200'
                }`}
              >
                {hud.mgOverheated ? 'داغ!' : `${toFaNum(Math.round(hud.mgHeat))}٪`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-900">
              <div
                className={`h-full ${hud.mgOverheated ? 'bg-red-500' : 'bg-sky-400'}`}
                style={{ width: `${Math.min(100, Math.round(hud.mgHeat))}%` }}
              />
            </div>
          </div>

          <div className="hidden h-7 w-px bg-stone-200/15 sm:block" />

          {/* Turbo Drive */}
          <div className="hidden flex-col gap-1 min-w-[78px] sm:flex">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-stone-400">توربو</span>
              <span
                className={`tabular-nums font-bold ${
                  hud.turboActive
                    ? 'text-amber-300'
                    : hud.turboOverheated
                    ? 'text-red-400'
                    : 'text-stone-200'
                }`}
              >
                {toFaNum(Math.round(hud.turboCharge))}٪
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-900">
              <div
                className={`h-full ${
                  hud.turboOverheated
                    ? 'bg-red-500'
                    : hud.turboActive
                    ? 'bg-amber-400'
                    : 'bg-amber-500/80'
                }`}
                style={{ width: `${Math.min(100, Math.round(hud.turboCharge))}%` }}
              />
            </div>
          </div>

          <div className="h-7 w-px bg-stone-200/15" />

          {/* Smoke Screen Counter (pulses on ATGM warning) */}
          <div
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 ${
              atgmThreat && hud.smokeReady > 0
                ? 'animate-alert-flash border-amber-400 bg-red-950/90 text-amber-200'
                : 'border-stone-200/15 bg-stone-900/80 text-stone-200'
            }`}
          >
            <CloudFog className="h-4 w-4 text-emerald-300" />
            <div className="flex flex-col leading-tight">
              <span className="text-[10px] text-stone-300">پرده دود [F]</span>
              <span className="tabular-nums text-xs font-black">
                {toFaNum(hud.smokeReady)} / {toFaNum(hud.smokeMax)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* MOBILE TWO-THUMB TOUCH CONTROLS */}
      {showTouchControls && (
        <>
          {/* Left-Half Floating Virtual Joystick (Hull Drive & Steer) */}
          <div
            className="pointer-events-auto fixed bottom-0 left-0 top-24 w-[44%]"
            onPointerDown={handleStickDown}
            onPointerMove={handleStickMove}
            onPointerUp={handleStickUp}
            onPointerCancel={handleStickUp}
          >
            {stickOrigin ? (
              <div
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400/60 bg-[#121614]/50"
                style={{
                  left: stickOrigin.x,
                  top: stickOrigin.y,
                  width: STICK_MAX_RADIUS * 2,
                  height: STICK_MAX_RADIUS * 2,
                }}
              >
                <div
                  className="absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-300 bg-amber-500/85 shadow-lg"
                  style={{
                    transform: `translate(calc(-50% + ${stickKnob.x}px), calc(-50% + ${stickKnob.y}px))`,
                  }}
                />
              </div>
            ) : (
              <div className="pointer-events-none absolute bottom-16 left-8 flex h-24 w-24 items-center justify-center rounded-full border border-dashed border-stone-200/30 bg-[#121614]/38 text-[11px] font-bold text-stone-200/75">
                حرکت بدنه
              </div>
            )}
          </div>

          {/* Right-Half Invisible Touch Drag Zone (Independent Turret Aiming) */}
          <div
            className="pointer-events-auto fixed bottom-0 right-0 top-24 w-[52%]"
            onPointerDown={handleAimDown}
            onPointerMove={handleAimMove}
            onPointerUp={handleAimUp}
            onPointerCancel={handleAimUp}
          />

          {/* Ergonomic Right-Bottom Tank Action Buttons */}
          <div className="pointer-events-auto fixed bottom-16 right-4 z-30 flex flex-col items-end gap-2">
            {/* Upper Tactical Row: Target Snap + Turbo + Smoke */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onTargetSnap();
                }}
                className="flex h-11 items-center gap-1 rounded-xl border border-amber-400/50 bg-[#151a17]/90 px-3 text-xs font-bold text-amber-200 active:scale-95"
              >
                <Target className="h-4 w-4" />
                <span>قفل هدف</span>
              </button>

              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setBoostPressed(true);
                  onTankButton('boost', true);
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  setBoostPressed(false);
                  onTankButton('boost', false);
                }}
                onPointerCancel={() => {
                  setBoostPressed(false);
                  onTankButton('boost', false);
                }}
                className={`flex h-11 items-center gap-1 rounded-xl border px-3 text-xs font-bold active:scale-95 ${
                  boostPressed
                    ? 'border-amber-300 bg-amber-500 text-slate-950'
                    : 'border-stone-200/25 bg-[#151a17]/90 text-stone-100'
                }`}
              >
                <Flame className="h-4 w-4" />
                <span>توربو</span>
              </button>

              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onDeploySmoke();
                }}
                className={`flex h-11 items-center gap-1 rounded-xl border px-3 text-xs font-black active:scale-95 ${
                  atgmThreat && hud.smokeReady > 0
                    ? 'animate-alert-flash border-amber-300 bg-red-600 text-white'
                    : 'border-emerald-400/55 bg-emerald-950/90 text-emerald-200'
                }`}
              >
                <CloudFog className="h-4 w-4" />
                <span>پرده دود ({toFaNum(hud.smokeReady)})</span>
              </button>
            </div>

            {/* Primary Fire Row: Coaxial MG + Main 120mm Cannon */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setMgPressed(true);
                  onTankButton('fireMg', true);
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  setMgPressed(false);
                  onTankButton('fireMg', false);
                }}
                onPointerCancel={() => {
                  setMgPressed(false);
                  onTankButton('fireMg', false);
                }}
                className={`flex h-14 w-20 flex-col items-center justify-center rounded-2xl border-2 text-xs font-black active:scale-95 ${
                  mgPressed
                    ? 'border-sky-300 bg-sky-400 text-slate-950'
                    : 'border-sky-400/55 bg-[#13202b]/92 text-sky-200'
                }`}
              >
                <Crosshair className="h-4 w-4 mb-0.5" />
                <span>تیربار</span>
              </button>

              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setCannonPressed(true);
                  onFireCannon();
                  onTankButton('fireCannon', true);
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  setCannonPressed(false);
                  onTankButton('fireCannon', false);
                }}
                onPointerCancel={() => {
                  setCannonPressed(false);
                  onTankButton('fireCannon', false);
                }}
                className={`flex h-16 w-24 flex-col items-center justify-center rounded-2xl border-2 text-xs font-black shadow-xl active:scale-95 ${
                  cannonPressed
                    ? 'border-amber-200 bg-amber-400 text-slate-950'
                    : hud.cannonReady
                    ? 'border-amber-400 bg-amber-500/95 text-slate-950'
                    : 'border-amber-500/40 bg-[#2b2011]/90 text-amber-300'
                }`}
              >
                <span>شلیک توپ</span>
                <span className="tabular-nums text-[10px] opacity-85">
                  {hud.cannonReady
                    ? 'آماده'
                    : `${toFaNum(Math.round(hud.cannonReloadProgress * 100))}٪`}
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
