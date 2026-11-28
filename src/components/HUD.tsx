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
  Rocket,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import type { EdgeTelemetryInfo, HudSnapshot, ProjectedTarget } from '../engine/types';
import { formatScoreFa, toFaNum } from '../utils/formatFa';

interface HUDProps {
  hud: HudSnapshot;
  edgeTelemetry: EdgeTelemetryInfo | null;
  muted: boolean;
  isFullscreen: boolean;
  showOnboarding: boolean;
  showTouchControls: boolean;
  onTogglePause: () => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onTouchStick: (pitch: number, roll: number) => void;
  onTouchButton: (btn: 'fireGun' | 'boost', active: boolean) => void;
  onLaunchMissile: () => void;
  onDeployFlare: () => void;
}

const STICK_MAX_RADIUS = 52;
const STICK_DEADZONE = 0.1;

function applyStickCurve(raw: number): number {
  const mag = Math.abs(raw);
  if (mag < STICK_DEADZONE) return 0;
  const norm = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return Math.sign(raw) * Math.pow(norm, 1.35);
}

export function HUD({
  hud,
  edgeTelemetry,
  muted,
  isFullscreen,
  showOnboarding,
  showTouchControls,
  onTogglePause,
  onToggleMute,
  onToggleFullscreen,
  onTouchStick,
  onTouchButton,
  onLaunchMissile,
  onDeployFlare,
}: HUDProps) {
  // Dynamic floating virtual joystick state (left thumb zone)
  const stickPointerId = useRef<number | null>(null);
  const [stickOrigin, setStickOrigin] = useState<{ x: number; y: number } | null>(null);
  const [stickKnob, setStickKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [gunPressed, setGunPressed] = useState(false);
  const [boostPressed, setBoostPressed] = useState(false);

  const handleStickDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerId.current !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stickPointerId.current = e.pointerId;
    const rect = e.currentTarget.getBoundingClientRect();
    setStickOrigin({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setStickKnob({ x: 0, y: 0 });
    onTouchStick(0, 0);
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

    const roll = applyStickCurve(kx / STICK_MAX_RADIUS);
    // Upward thumb drag = pitch up (+1), downward = nose down (-1)
    const pitch = applyStickCurve(-ky / STICK_MAX_RADIUS);
    onTouchStick(pitch, roll);
  };

  const handleStickUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointerId.current !== e.pointerId) return;
    stickPointerId.current = null;
    setStickOrigin(null);
    setStickKnob({ x: 0, y: 0 });
    onTouchStick(0, 0);
  };

  const hpPct = Math.max(0, Math.min(100, (hud.hp / hud.maxHp) * 100));
  const ghostPct = Math.max(hpPct, Math.min(100, (hud.ghostHp / hud.maxHp) * 100));
  const lowHp = hpPct <= 30;

  // Choose primary lead target (locked target, or closest on-screen enemy)
  const primaryLeadTarget: ProjectedTarget | undefined =
    hud.targets.find((t) => t.isLockCandidate && t.leadVisible) ||
    hud.targets.find((t) => t.onScreen && t.leadVisible);

  return (
    <div
      dir="rtl"
      className="pointer-events-none fixed inset-0 z-20 overflow-hidden select-none"
    >
      {/* Peripheral Low-HP / Damage Vignette */}
      {(lowHp || hud.damageFlashTimer > 0) && (
        <div
          className="fixed inset-0 transition-opacity duration-150"
          style={{
            boxShadow:
              hud.damageFlashTimer > 0
                ? 'inset 0 0 110px rgba(239, 68, 68, 0.65)'
                : 'inset 0 0 85px rgba(220, 38, 38, 0.36)',
          }}
        />
      )}

      {/* WORLD-PROJECTED TARGET DIAMONDS, LEAD INDICATOR & OFF-SCREEN ARROWS */}
      <div className="fixed inset-0" dir="ltr">
        {/* Predictive Lead Indicator Line (SVG) */}
        {primaryLeadTarget && primaryLeadTarget.onScreen && primaryLeadTarget.leadVisible && (
          <svg className="fixed inset-0 h-full w-full" aria-hidden="true">
            <line
              x1={`${primaryLeadTarget.screenX * 100}%`}
              y1={`${primaryLeadTarget.screenY * 100}%`}
              x2={`${primaryLeadTarget.leadX * 100}%`}
              y2={`${primaryLeadTarget.leadY * 100}%`}
              stroke="rgba(251, 191, 36, 0.65)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          </svg>
        )}

        {hud.targets.map((t) => {
          const isSurface =
            t.category === 'sam' || t.category === 'warship' || t.category === 'command';
          if (t.onScreen) {
            const diamondScale = t.isLockCandidate
              ? 1.75 - t.lockProgress * 0.75
              : 1;
            const strokeColor = t.isLocked
              ? '#ef4444'
              : t.isPrimaryObjective
              ? '#fbbf24'
              : t.isLockCandidate
              ? '#f59e0b'
              : t.category === 'command'
              ? '#f59e0b'
              : t.category === 'sam'
              ? '#fb923c'
              : t.category === 'warship'
              ? '#22d3ee'
              : t.archetype === 'ace'
              ? '#fbbf24'
              : '#38bdf8';

            return (
              <div key={t.id}>
                {/* Target Box / Shrinking Lock Diamond */}
                <div
                  className="fixed -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${t.screenX * 100}%`,
                    top: `${t.screenY * 100}%`,
                  }}
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 44 44"
                    style={{
                      transform: `scale(${diamondScale})`,
                      transition: 'transform 60ms linear',
                    }}
                  >
                    {t.isLockCandidate ? (
                      <polygon
                        points="22,3 41,22 22,41 3,22"
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={t.isLocked ? '2.6' : '2'}
                      />
                    ) : isSurface ? (
                      <polygon
                        points="22,6 37,15 37,29 22,38 7,29 7,15"
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth="1.9"
                      />
                    ) : (
                      <g stroke={strokeColor} strokeWidth="1.8" fill="none">
                        <path d="M8 14 L8 8 L14 8" />
                        <path d="M30 8 L36 8 L36 14" />
                        <path d="M36 30 L36 36 L30 36" />
                        <path d="M14 36 L8 36 L8 30" />
                      </g>
                    )}
                  </svg>

                  {/* Target HP mini-bar + type tag (Primary Objective / Command / SAM / Warship) + distance */}
                  <div
                    dir="rtl"
                    className="mt-0.5 flex flex-col items-center whitespace-nowrap"
                  >
                    {t.isPrimaryObjective && (
                      <span className="hud-text-shadow mb-0.5 rounded bg-amber-500/90 px-1.5 py-0.2 text-[9px] font-black text-slate-950">
                        هدف اصلی
                      </span>
                    )}
                    {isSurface && (
                      <span
                        className="hud-text-shadow mb-0.5 text-[10px] font-black"
                        style={{ color: strokeColor }}
                      >
                        {t.category === 'command'
                          ? 'مقر راداری'
                          : t.category === 'sam'
                          ? 'پدافند'
                          : 'ناو جنگی'}
                      </span>
                    )}
                    <div className="h-1 w-9 overflow-hidden rounded-full bg-slate-950/80">
                      <div
                        className="h-full transition-all duration-100"
                        style={{
                          width: `${Math.round(t.hpRatio * 100)}%`,
                          backgroundColor: strokeColor,
                        }}
                      />
                    </div>
                    <span className="hud-text-shadow tabular-nums mt-0.5 text-[10px] font-bold text-slate-100">
                      {toFaNum(t.distance)}م
                    </span>
                    {t.isLocked && (
                      <span className="hud-text-shadow mt-0.5 text-[10px] font-black text-red-400">
                        قفل راداری انجام شد
                      </span>
                    )}
                  </div>
                </div>

                {/* Predictive Lead Indicator Circle */}
                {primaryLeadTarget?.id === t.id && t.leadVisible && (
                  <div
                    className="fixed -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: `${t.leadX * 100}%`,
                      top: `${t.leadY * 100}%`,
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 26 26">
                      <circle
                        cx="13"
                        cy="13"
                        r="9.5"
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth="1.8"
                      />
                      <circle cx="13" cy="13" r="2.2" fill="#fbbf24" />
                    </svg>
                  </div>
                )}
              </div>
            );
          }

          // Render off-screen rim arrows for airborne enemies AND Strike Mission primary objectives
          if (isSurface && !t.isPrimaryObjective) return null;

          let dx = t.screenX - 0.5;
          let dy = t.screenY - 0.5;
          if (!t.inFront) {
            dx = -dx;
            dy = -dy;
          }
          const angle = Math.atan2(dy, dx);
          const rx = 0.5 + Math.cos(angle) * 0.43;
          const ry = 0.5 + Math.sin(angle) * 0.41;
          const leftPct = Math.max(0.06, Math.min(0.94, rx)) * 100;
          const topPct = Math.max(0.09, Math.min(0.89, ry)) * 100;

          return (
            <div
              key={t.id}
              className="fixed -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            >
              <svg
                width={t.isPrimaryObjective ? '24' : '20'}
                height={t.isPrimaryObjective ? '24' : '20'}
                viewBox="0 0 18 18"
                style={{ transform: `rotate(${angle}rad)` }}
              >
                <polygon
                  points="17,9 2,2.5 5.5,9 2,15.5"
                  fill={
                    t.isPrimaryObjective
                      ? '#fbbf24'
                      : t.archetype === 'ace'
                      ? '#fbbf24'
                      : '#ef4444'
                  }
                  stroke="#09131f"
                  strokeWidth="1.2"
                />
              </svg>
              <span
                dir="rtl"
                className={`hud-text-shadow tabular-nums text-[10px] font-bold whitespace-nowrap ${
                  t.isPrimaryObjective ? 'text-amber-300' : 'text-amber-200'
                }`}
              >
                {t.isPrimaryObjective ? `هدف · ${toFaNum(t.distance)}م` : `${toFaNum(t.distance)}م`}
              </span>
            </div>
          );
        })}

        {/* HIGH-VISIBILITY PULSING RED 3D TRACKER OVER EVERY INCOMING ENEMY / SAM MISSILE */}
        {hud.incomingMissiles.map((m) => {
          if (m.onScreen) {
            return (
              <div
                key={m.id}
                className="animate-alert-flash fixed -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                style={{
                  left: `${m.screenX * 100}%`,
                  top: `${m.screenY * 100}%`,
                }}
              >
                <svg width="34" height="34" viewBox="0 0 34 34">
                  <polygon
                    points="17,2 32,17 17,32 2,17"
                    fill="rgba(239, 68, 68, 0.22)"
                    stroke="#ef4444"
                    strokeWidth="2.4"
                  />
                  <circle cx="17" cy="17" r="3.2" fill="#fde047" />
                </svg>
                <span
                  dir="rtl"
                  className="hud-text-shadow tabular-nums mt-0.5 rounded bg-red-950/90 px-1.5 py-0.5 text-[10px] font-black text-red-100 ring-1 ring-red-400/70 whitespace-nowrap"
                >
                  {m.sourceLabelFa}: {toFaNum(m.distance)}م
                </span>
              </div>
            );
          }

          let dx = m.screenX - 0.5;
          let dy = m.screenY - 0.5;
          if (!m.inFront) {
            dx = -dx;
            dy = -dy;
          }
          const angle = Math.atan2(dy, dx);
          const rx = 0.5 + Math.cos(angle) * 0.42;
          const ry = 0.5 + Math.sin(angle) * 0.4;
          const leftPct = Math.max(0.07, Math.min(0.93, rx)) * 100;
          const topPct = Math.max(0.11, Math.min(0.87, ry)) * 100;

          return (
            <div
              key={m.id}
              className="animate-alert-flash fixed -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 22 22"
                style={{ transform: `rotate(${angle}rad)` }}
              >
                <polygon
                  points="21,11 3,3 7,11 3,19"
                  fill="#ef4444"
                  stroke="#fef08a"
                  strokeWidth="1.5"
                />
              </svg>
              <span
                dir="rtl"
                className="hud-text-shadow tabular-nums rounded bg-red-950/92 px-1.5 py-0.5 text-[10px] font-black text-amber-200 ring-1 ring-red-500/80 whitespace-nowrap"
              >
                {m.sourceLabelFa}: {toFaNum(m.distance)}م
              </span>
            </div>
          );
        })}
      </div>

      {/* EXACT CENTER BORESIGHT CROSSHAIR & ARTIFICIAL HORIZON */}
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        dir="ltr"
        aria-hidden="true"
      >
        <svg width="164" height="164" viewBox="0 0 164 164">
          {/* Outer conical radar lock acquisition circle */}
          <circle
            cx="82"
            cy="82"
            r="68"
            fill="none"
            stroke={
              hud.isLocked
                ? 'rgba(239, 68, 68, 0.8)'
                : hud.lockProgress > 0
                ? 'rgba(245, 158, 11, 0.7)'
                : 'rgba(226, 232, 240, 0.25)'
            }
            strokeWidth={hud.isLocked ? '2' : '1.2'}
            strokeDasharray={hud.isLocked ? 'none' : '8 6'}
          />

          {/* Roll-stabilized artificial horizon bars */}
          <g transform={`rotate(${-hud.rollDeg} 82 82)`}>
            <line
              x1="34"
              y1={82 + Math.max(-24, Math.min(24, hud.pitchDeg * 0.45))}
              x2="60"
              y2={82 + Math.max(-24, Math.min(24, hud.pitchDeg * 0.45))}
              stroke="rgba(167, 243, 208, 0.62)"
              strokeWidth="1.6"
            />
            <line
              x1="104"
              y1={82 + Math.max(-24, Math.min(24, hud.pitchDeg * 0.45))}
              x2="130"
              y2={82 + Math.max(-24, Math.min(24, hud.pitchDeg * 0.45))}
              stroke="rgba(167, 243, 208, 0.62)"
              strokeWidth="1.6"
            />
          </g>

          {/* Center Jet Boresight Reticle */}
          <path
            d="M70 82 L77 82 L82 86 L87 82 L94 82"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="82" cy="82" r="2" fill="#34d399" />

          {/* Hit Confirmation X-Marker (crisp golden on hit, expanded bright crimson on critical/kill) */}
          {hud.hitMarkerTimer > 0 && (
            <g
              stroke={hud.hitMarkerCritical ? '#f87171' : '#fbbf24'}
              strokeWidth={hud.hitMarkerCritical ? '3' : '2.4'}
              strokeLinecap="round"
            >
              <line
                x1={hud.hitMarkerCritical ? '68' : '72'}
                y1={hud.hitMarkerCritical ? '68' : '72'}
                x2="77"
                y2="77"
              />
              <line
                x1={hud.hitMarkerCritical ? '96' : '92'}
                y1={hud.hitMarkerCritical ? '68' : '72'}
                x2="87"
                y2="77"
              />
              <line
                x1={hud.hitMarkerCritical ? '68' : '72'}
                y1={hud.hitMarkerCritical ? '96' : '92'}
                x2="77"
                y2="87"
              />
              <line
                x1={hud.hitMarkerCritical ? '96' : '92'}
                y1={hud.hitMarkerCritical ? '96' : '92'}
                x2="87"
                y2="87"
              />
            </g>
          )}
        </svg>
      </div>

      {/* TOP BAR: TOP-RIGHT SCORE/WAVE + UTILITY BUTTONS | TOP-LEFT TACTICAL RADAR */}
      <div className="fixed inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4">
        {/* Right Corner (RTL Start): Compact Mission Telemetry & Utility Controls */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 rounded-lg border border-slate-200/15 bg-[#09131f]/78 px-3.5 py-2">
            <div>
              <div className="text-[10px] font-medium text-slate-400">امتیاز</div>
              <div className="tabular-nums text-xl font-black leading-none text-amber-400">
                {formatScoreFa(hud.score)}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-200/15" />
            <div>
              <div className="text-[10px] font-medium text-slate-400">موج</div>
              <div className="tabular-nums text-xl font-black leading-none text-white">
                {toFaNum(hud.wave)}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-200/15" />
            <div>
              <div className="text-[10px] font-medium text-slate-400">دشمنان</div>
              <div className="tabular-nums text-xl font-black leading-none text-sky-300">
                {toFaNum(hud.enemiesRemaining)}
              </div>
            </div>
          </div>

          {/* Utility Icon Buttons */}
          <div className="pointer-events-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onTogglePause();
              }}
              tabIndex={-1}
              aria-label="توقف بازی"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/18 bg-[#09131f]/82 text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
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
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/18 bg-[#09131f]/82 text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
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
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/18 bg-[#09131f]/82 text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* ArvanCloud Edge Node Telemetry Badge */}
          {edgeTelemetry && (
            <div
              data-testid="arvan-edge-badge"
              className="flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-[#09131f]/78 px-2.5 py-1 text-[10px] font-bold text-emerald-200"
            >
              <Radio className="h-3 w-3 shrink-0 text-emerald-400" />
              <span className="tabular-nums whitespace-nowrap">
                اتصال به لبه آروان | پینگ: {toFaNum(edgeTelemetry.pingMs)}ms
              </span>
            </div>
          )}
        </div>

        {/* Center-Top Strike Mission Objective Banner, Alerts, Wave Announcement & Kill Feed */}
        <div className="flex max-w-md flex-col items-center gap-1.5 pt-0.5 text-center">
          {hud.strikeObjective && (
            <div
              data-testid="strike-objective-banner"
              className="flex flex-wrap items-center justify-center gap-2 rounded-lg border border-amber-400/55 bg-[#09131f]/86 px-3.5 py-1.5 shadow-lg"
            >
              <span className="rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-black text-slate-950">
                هدف عملیات
              </span>
              <span className="text-xs font-black text-amber-200 sm:text-sm">
                {hud.strikeObjective.titleFa}
              </span>
              <span className="text-slate-500">·</span>
              <span className="tabular-nums text-[11px] font-bold text-slate-100">
                باقی‌مانده: {toFaNum(hud.strikeObjective.remaining)} از{' '}
                {toFaNum(hud.strikeObjective.total)}
              </span>
              {hud.strikeObjective.distanceM !== null && (
                <>
                  <span className="text-slate-500">·</span>
                  <span className="tabular-nums text-[11px] font-black text-sky-300">
                    فاصله تا هدف: {toFaNum(hud.strikeObjective.distanceM)}م
                  </span>
                </>
              )}
            </div>
          )}

          {hud.gpwsWarning && (
            <div className="animate-alert-flash flex items-center gap-2 rounded-lg border border-red-500 bg-red-950/90 px-4 py-1.5 text-sm font-black text-red-100 shadow-lg">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <span>هشدار ارتفاع! اوج بگیرید</span>
            </div>
          )}

          {(hud.missileIncomingWarning || hud.missileLockWarning) && (
            <div className="animate-alert-flash flex items-center gap-2 rounded-lg border border-amber-400 bg-red-950/92 px-4 py-1.5 text-sm font-black text-amber-200 shadow-lg">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                {hud.missileIncomingWarning
                  ? 'هشدار! موشک در حال نزدیک شدن'
                  : hud.samLockWarning
                  ? 'هشدار! قفل رادار پدافند دشمن'
                  : 'هشدار قفل موشک دشمن!'}
              </span>
            </div>
          )}

          {hud.samMaskNoticeTimer > 0 && (
            <div className="rounded-lg border border-cyan-400/65 bg-[#07212b]/90 px-3.5 py-1 text-xs font-bold text-cyan-200 shadow-md">
              قطع قفل رادار پدافند - پنهان در دره
            </div>
          )}

          {hud.flareSuccessTimer > 0 && (
            <div className="rounded-lg border border-emerald-400/60 bg-emerald-950/88 px-3.5 py-1 text-xs font-bold text-emerald-200">
              منور حرارتی عمل کرد · موشک دشمن منحرف شد
            </div>
          )}

          {hud.enemyFlareNoticeTimer > 0 && (
            <div className="rounded-lg border border-amber-400/60 bg-[#1a1308]/90 px-3.5 py-1 text-xs font-bold text-amber-200">
              دشمن منور حرارتی رها کرد · موشک منحرف شد!
            </div>
          )}

          {hud.waveBanner && (
            <div className="rounded-lg border border-amber-400/45 bg-[#09131f]/88 px-5 py-2 shadow-xl">
              <div className="text-base font-black text-amber-400 sm:text-lg">
                {hud.waveBanner.titleFa}
              </div>
              <div className="mt-0.5 text-xs text-slate-200">
                {hud.waveBanner.subtitleFa}
              </div>
            </div>
          )}

          {hud.killFeed && !hud.waveBanner && (
            <div className="rounded-md border border-emerald-400/40 bg-[#09131f]/82 px-3.5 py-1 text-xs font-bold text-emerald-300">
              {hud.killFeed.textFa} · +{formatScoreFa(hud.killFeed.points)}
            </div>
          )}
        </div>

        {/* Left Corner (RTL End): Circular Tactical Minimap Radar */}
        <div className="flex flex-col items-center">
          <div
            dir="ltr"
            aria-label="رادار تاکتیکی"
            className="relative h-24 w-24 overflow-hidden rounded-full border-2 border-emerald-400/55 bg-[#07161e]/85 shadow-lg sm:h-28 sm:w-28"
          >
            {/* Concentric range rings & crosshairs */}
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100">
              <circle
                cx="50"
                cy="50"
                r="32"
                fill="none"
                stroke="rgba(52, 211, 153, 0.2)"
                strokeWidth="0.8"
              />
              <circle
                cx="50"
                cy="50"
                r="16"
                fill="none"
                stroke="rgba(52, 211, 153, 0.2)"
                strokeWidth="0.8"
              />
              <line
                x1="50"
                y1="2"
                x2="50"
                y2="98"
                stroke="rgba(52, 211, 153, 0.16)"
                strokeWidth="0.7"
              />
              <line
                x1="2"
                y1="50"
                x2="98"
                y2="50"
                stroke="rgba(52, 211, 153, 0.16)"
                strokeWidth="0.7"
              />
              {/* Forward radar cone */}
              <path
                d="M50 50 L36 6 A48 48 0 0 1 64 6 Z"
                fill="rgba(52, 211, 153, 0.11)"
              />
            </svg>

            {/* Sweeping radar line */}
            <div className="animate-radar-sweep absolute inset-0">
              <div
                className="absolute left-1/2 top-1/2 h-1/2 w-0.5 origin-top bg-emerald-400/60"
                style={{ transform: 'translateX(-50%) rotate(180deg)' }}
              />
            </div>

            {/* Blips */}
            {hud.radarBlips.map((b) => {
              const px = 50 + b.x * 43;
              const py = 50 - b.y * 43;
              return (
                <div
                  key={b.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${px}%`, top: `${py}%` }}
                >
                  {b.type === 'missile' ? (
                    <div className="h-2.5 w-2.5 rotate-45 bg-red-500 ring-1 ring-amber-200" />
                  ) : b.type === 'command' ? (
                    <div
                      className={`h-2.5 w-2.5 rounded-[2px] ${
                        b.isLocked
                          ? 'bg-red-500 ring-2 ring-red-300'
                          : 'bg-amber-400 ring-2 ring-amber-200'
                      }`}
                    />
                  ) : b.type === 'sam' ? (
                    <div
                      className={`h-2 w-2 rounded-[2px] ${
                        b.isLocked
                          ? 'bg-red-500 ring-2 ring-red-300'
                          : b.isPrimaryObjective
                          ? 'bg-amber-400 ring-2 ring-amber-200'
                          : 'bg-orange-400 ring-1 ring-orange-200/70'
                      }`}
                    />
                  ) : b.type === 'warship' ? (
                    <div
                      className={`h-2.5 w-1.5 rounded-[1px] ${
                        b.isLocked
                          ? 'bg-red-500 ring-2 ring-red-300'
                          : b.isPrimaryObjective
                          ? 'bg-amber-400 ring-2 ring-amber-200'
                          : 'bg-cyan-400 ring-1 ring-cyan-200/70'
                      }`}
                    />
                  ) : (
                    <div
                      className={`h-2 w-2 rounded-full ${
                        b.isLocked
                          ? 'bg-red-500 ring-2 ring-red-300'
                          : b.isPrimaryObjective || b.type === 'ace'
                          ? 'bg-amber-400 ring-1 ring-amber-200'
                          : 'bg-rose-400'
                      }`}
                    />
                  )}
                </div>
              );
            })}

            {/* Player center chevron */}
            <svg
              className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2"
              viewBox="0 0 16 16"
            >
              <polygon points="8,1 14,13 8,10 2,13" fill="#34d399" />
            </svg>
          </div>
          <div className="hud-text-shadow tabular-nums mt-1 text-[11px] font-bold text-emerald-300">
            سمت {toFaNum(hud.headingDeg)}°
          </div>
        </div>
      </div>

      {/* BOTTOM COMPACT TELEMETRY CLUSTER (SPEED, ALTITUDE, HULL, AFTERBURNER, WEAPONS) */}
      <div
        className={`fixed inset-x-0 bottom-2.5 flex items-end justify-center sm:bottom-4 ${
          showTouchControls ? 'px-48' : 'px-3'
        }`}
      >
        <div
          className={`flex items-center justify-center rounded-xl border border-slate-200/15 bg-[#09131f]/84 shadow-xl ${
            showTouchControls
              ? 'gap-2.5 px-3 py-2'
              : 'flex-wrap gap-3 px-4 py-2.5 sm:gap-5'
          }`}
        >
          {/* Speed */}
          <div className={showTouchControls ? 'min-w-[50px] text-center' : 'min-w-[66px] text-center'}>
            <div className="text-[10px] font-medium text-slate-400">سرعت</div>
            <div
              className={`tabular-nums font-black leading-tight text-white ${
                showTouchControls ? 'text-sm' : 'text-lg'
              }`}
            >
              {toFaNum(hud.speedKmh)}
              {!showTouchControls && (
                <span className="mr-0.5 text-[10px] font-normal text-slate-400">کم/س</span>
              )}
            </div>
          </div>

          <div className="h-6 w-px bg-slate-200/15" />

          {/* Altitude */}
          <div className={showTouchControls ? 'min-w-[46px] text-center' : 'min-w-[60px] text-center'}>
            <div className="text-[10px] font-medium text-slate-400">ارتفاع</div>
            <div
              className={`tabular-nums font-black leading-tight ${
                showTouchControls ? 'text-sm' : 'text-lg'
              } ${hud.gpwsWarning ? 'text-red-400' : 'text-sky-300'}`}
            >
              {toFaNum(hud.altitudeM)}
              <span className="mr-0.5 text-[10px] font-normal text-slate-400">م</span>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-200/15" />

          {/* Hull Integrity Bar with Delayed Ghost Damage Trail */}
          <div className={showTouchControls ? 'w-20' : 'w-28 sm:w-36'}>
            <div className="mb-1 flex items-center justify-between text-[10px]">
              <span className="font-medium text-slate-300">
                {showTouchControls ? 'بدنه' : 'سلامت بدنه'}
              </span>
              <span
                className={`tabular-nums font-bold ${
                  lowHp ? 'text-red-400' : 'text-emerald-300'
                }`}
              >
                ٪{toFaNum(Math.round(hpPct))}
              </span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-900 ring-1 ring-slate-200/15 sm:h-2.5">
              {/* Trailing Ghost Bar */}
              <div
                className="absolute inset-y-0 right-0 bg-amber-300/75 transition-all duration-150"
                style={{ width: `${ghostPct}%` }}
              />
              {/* Live Hull Bar */}
              <div
                className={`absolute inset-y-0 right-0 transition-all duration-100 ${
                  lowHp ? 'bg-red-500' : hpPct < 60 ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
                style={{ width: `${hpPct}%` }}
              />
            </div>
          </div>

          <div className="h-6 w-px bg-slate-200/15" />

          {/* Afterburner Heat Gauge */}
          <div className={showTouchControls ? 'w-16' : 'w-24 sm:w-28'}>
            <div className="mb-1 flex items-center justify-between text-[10px]">
              <span className="font-medium text-slate-300">توربو</span>
              <span
                className={`tabular-nums font-bold ${
                  hud.afterburnerOverheated
                    ? 'text-red-400'
                    : hud.afterburnerActive
                    ? 'text-amber-300'
                    : 'text-slate-300'
                }`}
              >
                {hud.afterburnerOverheated
                  ? 'داغ'
                  : `٪${toFaNum(hud.afterburnerHeat)}`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-900 ring-1 ring-slate-200/15 sm:h-2.5">
              <div
                className={`h-full transition-all duration-75 ${
                  hud.afterburnerOverheated
                    ? 'bg-red-500'
                    : hud.afterburnerHeat > 72
                    ? 'bg-orange-400'
                    : 'bg-sky-400'
                }`}
                style={{ width: `${hud.afterburnerHeat}%` }}
              />
            </div>
          </div>

          {/* Desktop Keyboard Stock Readout with Live Auto-Recharge Bars */}
          {!showTouchControls && (
            <>
              <div className="hidden h-7 w-px bg-slate-200/15 sm:block" />
              <div className="flex items-center gap-3.5">
                <div className="w-16 text-center">
                  <div className="text-[10px] text-slate-400">موشک [E]</div>
                  <div
                    className={`tabular-nums text-sm font-black leading-tight ${
                      hud.isLocked ? 'text-red-400' : 'text-white'
                    }`}
                  >
                    {toFaNum(hud.missilesReady)}/{toFaNum(hud.missilesMax)}
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-900">
                    <div
                      className="h-full bg-amber-400 transition-all duration-100"
                      style={{
                        width: `${
                          hud.missilesReady >= hud.missilesMax
                            ? 100
                            : Math.round(hud.missileReloadProgress * 100)
                        }%`,
                      }}
                    />
                  </div>
                </div>
                <div
                  className={`w-16 rounded-md px-1 py-0.5 text-center transition-colors ${
                    hud.missileIncomingWarning
                      ? 'animate-alert-flash bg-amber-500/25 ring-1 ring-amber-300'
                      : ''
                  }`}
                >
                  <div
                    className={`text-[10px] ${
                      hud.missileIncomingWarning ? 'font-bold text-amber-200' : 'text-slate-400'
                    }`}
                  >
                    منور [F]
                  </div>
                  <div
                    className={`tabular-nums text-sm font-black leading-tight ${
                      hud.missileIncomingWarning ? 'text-amber-300' : 'text-white'
                    }`}
                  >
                    {toFaNum(hud.flaresReady)}/{toFaNum(hud.flaresMax)}
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-900">
                    <div
                      className="h-full bg-emerald-400 transition-all duration-100"
                      style={{
                        width: `${
                          hud.flaresReady >= hud.flaresMax
                            ? 100
                            : Math.round(hud.flareReloadProgress * 100)
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ERGONOMIC TWO-THUMB MOBILE TOUCH CONTROLS (LEFT FLOATING JOYSTICK + 4 RIGHT BUTTONS) */}
      {showTouchControls && (
        <div className="fixed inset-0" dir="ltr">
          {/* Left Thumb Zone: Dynamic Floating Virtual Joystick */}
          <div
            data-testid="touch-joystick-zone"
            onPointerDown={handleStickDown}
            onPointerMove={handleStickMove}
            onPointerUp={handleStickUp}
            onPointerCancel={handleStickUp}
            className="pointer-events-auto fixed bottom-2.5 left-2.5 h-40 w-40 touch-none sm:h-44 sm:w-44"
          >
            {/* Resting anchor hint or active floating ring */}
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-100/40 bg-[#09131f]/55"
              style={{
                width: STICK_MAX_RADIUS * 2,
                height: STICK_MAX_RADIUS * 2,
                left: stickOrigin ? stickOrigin.x : 74,
                top: stickOrigin ? stickOrigin.y : 78,
              }}
            >
              <div
                className="absolute left-1/2 top-1/2 h-11 w-11 rounded-full border-2 border-amber-300/95 bg-amber-400/40 shadow-md"
                style={{
                  transform: `translate(calc(-50% + ${stickKnob.x}px), calc(-50% + ${stickKnob.y}px))`,
                }}
              />
            </div>
            <div
              dir="rtl"
              className="hud-text-shadow pointer-events-none absolute bottom-0.5 left-4 text-[11px] font-bold text-slate-100/90"
            >
              هدایت جنگنده
            </div>
          </div>

          {/* Right Thumb Zone: 4 Ergonomically Spaced Persian Action Buttons */}
          <div
            dir="rtl"
            data-testid="touch-action-zone"
            className="pointer-events-auto fixed bottom-2.5 right-2.5 grid grid-cols-2 gap-2"
          >
            {/* Secondary: Missile (Glows/Pulses when Radar Lock Active + Live Recharge Bar) */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                onLaunchMissile();
              }}
              aria-label="شلیک موشک"
              className={`relative flex h-14 w-20 flex-col items-center justify-center overflow-hidden rounded-xl border-2 text-xs font-black shadow-lg transition-transform active:scale-95 ${
                hud.isLocked
                  ? 'animate-alert-flash border-red-400 bg-red-600/90 text-white'
                  : hud.missilesReady > 0
                  ? 'border-amber-400/55 bg-[#0c1a2b]/88 text-amber-200'
                  : 'border-slate-500/35 bg-[#09131f]/75 text-slate-400'
              }`}
            >
              <Rocket className="mb-0.5 h-4 w-4" />
              <span>موشک ({toFaNum(hud.missilesReady)})</span>
              {hud.missilesReady < hud.missilesMax && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-900">
                  <div
                    className="h-full bg-amber-400"
                    style={{ width: `${Math.round(hud.missileReloadProgress * 100)}%` }}
                  />
                </div>
              )}
            </button>

            {/* Tactical: Flare (Flashes when Enemy Missile Incoming + Live Recharge Bar) */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                onDeployFlare();
              }}
              aria-label="پرتاب منور حرارتی"
              className={`relative flex h-14 w-20 flex-col items-center justify-center overflow-hidden rounded-xl border-2 text-xs font-black shadow-lg transition-transform active:scale-95 ${
                hud.missileIncomingWarning || hud.missileLockWarning
                  ? 'animate-alert-flash border-amber-300 bg-amber-500 text-slate-950'
                  : hud.flaresReady > 0
                  ? 'border-emerald-400/50 bg-[#0c1a2b]/88 text-emerald-200'
                  : 'border-slate-500/35 bg-[#09131f]/75 text-slate-400'
              }`}
            >
              <ShieldAlert className="mb-0.5 h-4 w-4" />
              <span>منور ({toFaNum(hud.flaresReady)})</span>
              {hud.flaresReady < hud.flaresMax && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-900">
                  <div
                    className="h-full bg-emerald-400"
                    style={{ width: `${Math.round(hud.flareReloadProgress * 100)}%` }}
                  />
                </div>
              )}
            </button>

            {/* Action: Afterburner Boost (Hold) */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setBoostPressed(true);
                onTouchButton('boost', true);
              }}
              onPointerUp={() => {
                setBoostPressed(false);
                onTouchButton('boost', false);
              }}
              onPointerCancel={() => {
                setBoostPressed(false);
                onTouchButton('boost', false);
              }}
              onPointerLeave={() => {
                if (boostPressed) {
                  setBoostPressed(false);
                  onTouchButton('boost', false);
                }
              }}
              aria-label="توربو"
              className={`flex h-16 w-20 flex-col items-center justify-center rounded-xl border-2 text-xs font-black shadow-lg transition-transform active:scale-95 ${
                boostPressed || hud.afterburnerActive
                  ? 'border-sky-300 bg-sky-500/90 text-slate-950'
                  : hud.afterburnerOverheated
                  ? 'border-red-500/60 bg-red-950/80 text-red-300'
                  : 'border-sky-400/50 bg-[#0c1a2b]/88 text-sky-200'
              }`}
            >
              <Flame className="mb-0.5 h-5 w-5" />
              <span>توربو</span>
            </button>

            {/* Primary Large Button: Fire Autocannon (Hold) */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                setGunPressed(true);
                onTouchButton('fireGun', true);
              }}
              onPointerUp={() => {
                setGunPressed(false);
                onTouchButton('fireGun', false);
              }}
              onPointerCancel={() => {
                setGunPressed(false);
                onTouchButton('fireGun', false);
              }}
              onPointerLeave={() => {
                if (gunPressed) {
                  setGunPressed(false);
                  onTouchButton('fireGun', false);
                }
              }}
              aria-label="تیربار"
              className={`flex h-16 w-24 flex-col items-center justify-center rounded-xl border-2 text-sm font-black shadow-xl transition-transform active:scale-95 ${
                gunPressed
                  ? 'border-amber-200 bg-amber-400 text-slate-950'
                  : 'border-amber-400 bg-amber-500/90 text-slate-950'
              }`}
            >
              <Crosshair className="mb-0.5 h-5 w-5" />
              <span>تیربار</span>
            </button>
          </div>
        </div>
      )}

      {/* 3-SECOND INSTANT ONBOARDING OVERLAY (AUTO-FADES ON TOUCH/INPUT OR AFTER 3S) */}
      {showOnboarding && (
        <div
          dir="ltr"
          className="pointer-events-none fixed inset-0 z-30 flex items-center justify-between px-6 sm:px-14"
        >
          <div
            dir="rtl"
            className="rounded-xl border border-amber-400/50 bg-[#09131f]/86 px-4 py-3 text-right shadow-xl"
          >
            <div className="text-sm font-black text-amber-300">هدایت و پیچیدن سریع</div>
            <div className="mt-0.5 text-xs text-slate-200">
              {showTouchControls
                ? 'شست چپ: چپ/راست برای پیچ تیز، بالا/پایین برای ارتفاع'
                : 'کلیدهای WASD یا جهت‌نما · فلش‌های حاشیه مسیر دشمن را نشان می‌دهند'}
            </div>
          </div>

          <div
            dir="rtl"
            className="rounded-xl border border-sky-400/50 bg-[#09131f]/86 px-4 py-3 text-right shadow-xl"
          >
            <div className="text-sm font-black text-sky-300">قفل راداری و دفاع</div>
            <div className="mt-0.5 text-xs text-slate-200">
              {showTouchControls
                ? 'دشمن در دایره مرکزی = قفل موشک · مهمات خودکار شارژ می‌شوند'
                : 'Space تیربار · E موشک · Shift توربو · F منور (شارژ خودکار)'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
