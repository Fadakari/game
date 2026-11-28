import { useCallback, useEffect, useRef, useState } from 'react';
import { GameCanvas, type EngineController } from './components/GameCanvas';
import { HUD } from './components/HUD';
import { LeaderboardModal } from './components/LeaderboardModal';
import { Overlays, type ActiveOverlayHudSummary } from './components/Overlays';
import { TankHUD, type BuildingFootprint } from './components/TankHUD';
import type { CityLayout } from './engine/tankCity';
import type {
  DifficultyLevel,
  EdgeTelemetryInfo,
  GameMode,
  HudSnapshot,
  JetSubMode,
  LeaderboardEntry,
  TankHudSnapshot,
} from './engine/types';
import {
  fetchEdgeTelemetry,
  fetchLeaderboard,
  submitLeaderboardScore,
} from './services/edgeLeaderboard';

const INITIAL_HUD: HudSnapshot = {
  phase: 'title',
  difficulty: 'normal',
  jetSubMode: 'dogfight',
  strikeObjective: null,
  speedKmh: 460,
  altitudeM: 225,
  aglM: 225,
  headingDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  hp: 100,
  maxHp: 100,
  ghostHp: 100,
  score: 0,
  highScore: 0,
  kills: 0,
  wave: 1,
  enemiesRemaining: 0,
  surfaceThreatsRemaining: 0,
  afterburnerHeat: 0,
  afterburnerOverheated: false,
  afterburnerActive: false,
  missilesReady: 4,
  missilesMax: 4,
  missileReloadProgress: 0,
  flaresReady: 3,
  flaresMax: 3,
  flareReloadProgress: 0,
  lockTargetId: null,
  lockProgress: 0,
  isLocked: false,
  gpwsWarning: false,
  missileLockWarning: false,
  missileIncomingWarning: false,
  samLockWarning: false,
  samMaskNoticeTimer: 0,
  hitMarkerTimer: 0,
  hitMarkerCritical: false,
  damageFlashTimer: 0,
  flareSuccessTimer: 0,
  enemyFlareNoticeTimer: 0,
  defeatReason: 'none',
  survivalTimeSec: 0,
  waveBanner: null,
  killFeed: null,
  radarBlips: [],
  targets: [],
  incomingMissiles: [],
  isTouchDevice: false,
};

const INITIAL_TANK_HUD: TankHudSnapshot = {
  phase: 'title',
  difficulty: 'normal',
  speedKmh: 0,
  hullHeadingDeg: 0,
  turretHeadingDeg: 0,
  hp: 100,
  maxHp: 100,
  ghostHp: 100,
  score: 0,
  highScore: 0,
  kills: 0,
  wave: 1,
  enemiesRemaining: 0,
  aimReticleX: 0.5,
  aimReticleY: 0.44,
  barrelReticleX: 0.5,
  barrelReticleY: 0.44,
  barrelAligned: true,
  cannonReloadProgress: 1,
  cannonReady: true,
  mgHeat: 0,
  mgOverheated: false,
  turboCharge: 100,
  turboActive: false,
  turboOverheated: false,
  smokeReady: 3,
  smokeMax: 3,
  smokeReloadProgress: 1,
  smokeActiveTimer: 0,
  lockedTargetId: null,
  atgmLockWarning: false,
  atgmIncomingWarning: false,
  flankNoticeTimer: 0,
  smokeSuccessTimer: 0,
  armorDeflectTimer: 0,
  hitMarkerTimer: 0,
  hitMarkerCritical: false,
  damageFlashTimer: 0,
  defeatReason: 'none',
  survivalTimeSec: 0,
  waveBanner: null,
  killFeed: null,
  playerMapX: 0,
  playerMapZ: 0,
  minimapBlips: [],
  targets: [],
  incomingAtgms: [],
  isTouchDevice: false,
};

function getInitialModeFromQuery(): GameMode {
  if (typeof window === 'undefined') return 'jet';
  const param = new URLSearchParams(window.location.search).get('mode');
  return param === 'tank' ? 'tank' : 'jet';
}

function getInitialSubModeFromQuery(): JetSubMode {
  if (typeof window === 'undefined') return 'dogfight';
  const param = new URLSearchParams(window.location.search).get('submode');
  return param === 'strike' ? 'strike' : 'dogfight';
}

export default function App() {
  const controllerRef = useRef<EngineController | null>(null);
  const [mode, setMode] = useState<GameMode>(getInitialModeFromQuery);
  const [jetSubMode, setJetSubMode] = useState<JetSubMode>(getInitialSubModeFromQuery);
  const jetSubModeRef = useRef<JetSubMode>(jetSubMode);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [tankHud, setTankHud] = useState<TankHudSnapshot>(INITIAL_TANK_HUD);
  const [buildingFootprints, setBuildingFootprints] = useState<BuildingFootprint[]>([]);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>('normal');
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const hasShownJetOnboardingRef = useRef(false);
  const hasShownTankOnboardingRef = useRef(false);
  const onboardingTimerRef = useRef<number | null>(null);

  // ArvanCloud Edge PoP telemetry & Top-100 Leaderboard modal state
  const [edgeTelemetry, setEdgeTelemetry] = useState<EdgeTelemetryInfo | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>([]);
  const [leaderboardSource, setLeaderboardSource] = useState<'arvan-edge' | 'local'>('local');
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [highlightEntryId, setHighlightEntryId] = useState<string | null>(null);

  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1440,
    h: typeof window !== 'undefined' ? window.innerHeight : 900,
  }));

  const autostart =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('autostart') === '1';

  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, []);

  // Poll ArvanCloud Edge PoP telemetry on mount & every 30s for live ping indicator
  useEffect(() => {
    let active = true;
    const poll = () => {
      void fetchEdgeTelemetry().then((info) => {
        if (active) setEdgeTelemetry(info);
      });
    };
    poll();
    const id = window.setInterval(poll, 30000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    try {
      const result = await fetchLeaderboard();
      setLeaderboardEntries(result.entries);
      setLeaderboardSource(result.source);
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  const handleOpenLeaderboard = useCallback(() => {
    setLeaderboardOpen(true);
    void loadLeaderboard();
  }, [loadLeaderboard]);

  const handleCloseLeaderboard = useCallback(() => {
    setLeaderboardOpen(false);
  }, []);

  const activeHudSummary: ActiveOverlayHudSummary =
    mode === 'tank'
      ? {
          phase: tankHud.phase,
          score: tankHud.score,
          highScore: tankHud.highScore,
          kills: tankHud.kills,
          wave: tankHud.wave,
          survivalTimeSec: tankHud.survivalTimeSec,
          defeatReason: tankHud.defeatReason,
        }
      : {
          phase: hud.phase,
          score: hud.score,
          highScore: hud.highScore,
          kills: hud.kills,
          wave: hud.wave,
          survivalTimeSec: hud.survivalTimeSec,
          defeatReason: hud.defeatReason,
        };

  const activeDifficulty = mode === 'tank' ? tankHud.difficulty : hud.difficulty;

  const handleSubmitLeaderboard = useCallback(
    async (callsign: string): Promise<{ ok: boolean; reasonFa?: string }> => {
      const res = await submitLeaderboardScore({
        callsign,
        score: activeHudSummary.score,
        wave: activeHudSummary.wave,
        kills: activeHudSummary.kills,
        survivalTimeSec: activeHudSummary.survivalTimeSec,
        difficulty: activeDifficulty,
        mode,
      });
      setLeaderboardEntries(res.entries);
      setLeaderboardSource(res.source);
      if (res.ok && res.submittedId) {
        setHighlightEntryId(res.submittedId);
      }
      return { ok: res.ok, reasonFa: res.reasonFa };
    },
    [
      activeDifficulty,
      activeHudSummary.kills,
      activeHudSummary.score,
      activeHudSummary.survivalTimeSec,
      activeHudSummary.wave,
      mode,
    ],
  );

  // Detect mobile portrait orientation vs landscape touch layout
  const isPortraitMobile = viewport.w < 640 && viewport.h > viewport.w;
  const activeIsTouch = mode === 'tank' ? tankHud.isTouchDevice : hud.isTouchDevice;
  const showTouchControls =
    activeIsTouch || viewport.w <= 960 || viewport.h <= 520;

  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    if (onboardingTimerRef.current !== null) {
      window.clearTimeout(onboardingTimerRef.current);
      onboardingTimerRef.current = null;
    }
  }, []);

  const triggerOnboardingOnce = useCallback((targetMode: GameMode) => {
    const flagRef =
      targetMode === 'tank' ? hasShownTankOnboardingRef : hasShownJetOnboardingRef;
    if (flagRef.current) return;
    flagRef.current = true;
    if (onboardingTimerRef.current !== null) {
      window.clearTimeout(onboardingTimerRef.current);
    }
    setShowOnboarding(true);
    onboardingTimerRef.current = window.setTimeout(() => {
      setShowOnboarding(false);
      onboardingTimerRef.current = null;
    }, 3000);
  }, []);

  const handleControllerReady = useCallback((ctrl: EngineController) => {
    controllerRef.current = ctrl;
  }, []);

  const handleHudUpdate = useCallback(
    (snapshot: HudSnapshot) => {
      if (snapshot.phase === 'playing' && !hasShownJetOnboardingRef.current) {
        triggerOnboardingOnce('jet');
      }
      setHud(snapshot);
    },
    [triggerOnboardingOnce],
  );

  const handleTankHudUpdate = useCallback(
    (snapshot: TankHudSnapshot) => {
      if (snapshot.phase === 'playing' && !hasShownTankOnboardingRef.current) {
        triggerOnboardingOnce('tank');
      }
      setTankHud(snapshot);
    },
    [triggerOnboardingOnce],
  );

  const handleTankLayoutReady = useCallback((layout: CityLayout) => {
    setBuildingFootprints(layout.buildingFootprints);
  }, []);

  const handleSelectMode = useCallback(
    (nextMode: GameMode) => {
      if (nextMode === mode) return;
      dismissOnboarding();
      setMode(nextMode);
      // Reset active HUD phase to title while new 3D engine boots
      if (nextMode === 'tank') {
        setTankHud((prev) => ({ ...prev, phase: 'title' }));
      } else {
        setHud((prev) => ({ ...prev, phase: 'title' }));
      }
    },
    [dismissOnboarding, mode],
  );

  const handleSelectDifficulty = useCallback((level: DifficultyLevel) => {
    setDifficulty(level);
    controllerRef.current?.setDifficulty(level);
  }, []);

  const handleSelectJetSubMode = useCallback((subMode: JetSubMode) => {
    jetSubModeRef.current = subMode;
    setJetSubMode(subMode);
    controllerRef.current?.setJetSubMode(subMode);
  }, []);

  const handleStart = useCallback(() => {
    setLeaderboardOpen(false);
    controllerRef.current?.startNewGame(difficulty, jetSubModeRef.current);
    triggerOnboardingOnce(mode);
  }, [difficulty, mode, triggerOnboardingOnce]);

  const handleResume = useCallback(() => {
    controllerRef.current?.togglePause();
  }, []);

  const handleReturnTitle = useCallback(() => {
    dismissOnboarding();
    controllerRef.current?.returnToTitle();
  }, [dismissOnboarding]);

  const handleToggleMute = useCallback(() => {
    if (!controllerRef.current) return;
    const nextMuted = controllerRef.current.toggleMute();
    setMuted(nextMuted);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Fighter Jet touch handlers
  const handleTouchStick = useCallback((pitch: number, roll: number) => {
    controllerRef.current?.setTouchStick(pitch, roll);
  }, []);

  const handleTouchButton = useCallback(
    (btn: 'fireGun' | 'boost', active: boolean) => {
      controllerRef.current?.setTouchButton(btn, active);
    },
    [],
  );

  const handleLaunchMissile = useCallback(() => {
    controllerRef.current?.triggerMissile();
  }, []);

  const handleDeployFlare = useCallback(() => {
    controllerRef.current?.triggerFlare();
  }, []);

  // Tank Combat touch handlers
  const handleTankStick = useCallback((throttle: number, steer: number) => {
    controllerRef.current?.setTankTouchStick(throttle, steer);
  }, []);

  const handleTankAimDelta = useCallback(
    (deltaYawRad: number, deltaPitchRad: number) => {
      controllerRef.current?.addTankAimDelta(deltaYawRad, deltaPitchRad);
    },
    [],
  );

  const handleTankButton = useCallback(
    (btn: 'fireCannon' | 'fireMg' | 'boost', active: boolean) => {
      controllerRef.current?.setTankTouchButton(btn, active);
    },
    [],
  );

  const handleFireTankCannon = useCallback(() => {
    controllerRef.current?.triggerTankCannon();
  }, []);

  const handleDeploySmoke = useCallback(() => {
    controllerRef.current?.triggerTankSmoke();
  }, []);

  const handleTankTargetSnap = useCallback(() => {
    controllerRef.current?.triggerTankTargetSnap();
  }, []);

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#0b1521]">
      {/* Isolated 3D WebGL Engine Canvas (Jet or Tank) */}
      <GameCanvas
        mode={mode}
        jetSubMode={jetSubMode}
        difficulty={difficulty}
        onHudUpdate={handleHudUpdate}
        onTankHudUpdate={handleTankHudUpdate}
        onTankLayoutReady={handleTankLayoutReady}
        onControllerReady={handleControllerReady}
        onFirstInput={dismissOnboarding}
        autostart={autostart}
      />

      {/* Tactical Aviation HUD during active Fighter Jet flight */}
      {mode === 'jet' && hud.phase === 'playing' && !isPortraitMobile && (
        <HUD
          hud={hud}
          edgeTelemetry={edgeTelemetry}
          muted={muted}
          isFullscreen={isFullscreen}
          showOnboarding={showOnboarding}
          showTouchControls={showTouchControls}
          onTogglePause={handleResume}
          onToggleMute={handleToggleMute}
          onToggleFullscreen={handleToggleFullscreen}
          onTouchStick={handleTouchStick}
          onTouchButton={handleTouchButton}
          onLaunchMissile={handleLaunchMissile}
          onDeployFlare={handleDeployFlare}
        />
      )}

      {/* Tactical Armored HUD during active 3D Tank Combat */}
      {mode === 'tank' && tankHud.phase === 'playing' && !isPortraitMobile && (
        <TankHUD
          hud={tankHud}
          buildingFootprints={buildingFootprints}
          edgeTelemetry={edgeTelemetry}
          muted={muted}
          isFullscreen={isFullscreen}
          showOnboarding={showOnboarding}
          showTouchControls={showTouchControls}
          onTogglePause={handleResume}
          onToggleMute={handleToggleMute}
          onToggleFullscreen={handleToggleFullscreen}
          onTankStick={handleTankStick}
          onTankAimDelta={handleTankAimDelta}
          onTankButton={handleTankButton}
          onFireCannon={handleFireTankCannon}
          onDeploySmoke={handleDeploySmoke}
          onTargetSnap={handleTankTargetSnap}
        />
      )}

      {/* Title, Pause, Game Over & Portrait Rotation Overlays */}
      <Overlays
        mode={mode}
        jetSubMode={jetSubMode}
        hud={activeHudSummary}
        edgeTelemetry={edgeTelemetry}
        difficulty={difficulty}
        muted={muted}
        isFullscreen={isFullscreen}
        isPortraitMobile={isPortraitMobile}
        onSelectMode={handleSelectMode}
        onSelectJetSubMode={handleSelectJetSubMode}
        onSelectDifficulty={handleSelectDifficulty}
        onStart={handleStart}
        onResume={handleResume}
        onRestart={handleStart}
        onReturnTitle={handleReturnTitle}
        onToggleMute={handleToggleMute}
        onToggleFullscreen={handleToggleFullscreen}
        onOpenLeaderboard={handleOpenLeaderboard}
        onSubmitLeaderboard={handleSubmitLeaderboard}
      />

      {/* Persian Top-100 Pilots & Commanders Leaderboard Modal */}
      <LeaderboardModal
        open={leaderboardOpen}
        entries={leaderboardEntries}
        source={leaderboardSource}
        loading={leaderboardLoading}
        highlightId={highlightEntryId}
        onRefresh={() => void loadLeaderboard()}
        onClose={handleCloseLeaderboard}
      />
    </main>
  );
}
