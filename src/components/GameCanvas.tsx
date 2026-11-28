import { useEffect, useRef } from 'react';
import { AirCombatEngine } from '../engine/gameEngine';
import type { CityLayout } from '../engine/tankCity';
import { TankCombatEngine } from '../engine/tankEngine';
import type {
  ControlInput,
  DifficultyLevel,
  GameMode,
  HudSnapshot,
  JetSubMode,
  TankControlInput,
  TankHudSnapshot,
} from '../engine/types';

export interface EngineController {
  startNewGame: (difficulty?: DifficultyLevel, jetSubMode?: JetSubMode) => void;
  setDifficulty: (level: DifficultyLevel) => void;
  setJetSubMode: (subMode: JetSubMode) => void;
  togglePause: () => void;
  returnToTitle: () => void;
  toggleMute: () => boolean;
  // Fighter Jet controls
  setTouchStick: (pitch: number, roll: number) => void;
  setTouchButton: (btn: 'fireGun' | 'boost', active: boolean) => void;
  triggerMissile: () => void;
  triggerFlare: () => void;
  // Tank Combat controls
  setTankTouchStick: (throttle: number, steer: number) => void;
  addTankAimDelta: (deltaYawRad: number, deltaPitchRad: number) => void;
  setTankTouchButton: (btn: 'fireCannon' | 'fireMg' | 'boost', active: boolean) => void;
  triggerTankCannon: () => void;
  triggerTankSmoke: () => void;
  triggerTankTargetSnap: () => void;
}

interface GameCanvasProps {
  mode: GameMode;
  jetSubMode: JetSubMode;
  difficulty: DifficultyLevel;
  onHudUpdate: (snapshot: HudSnapshot) => void;
  onTankHudUpdate: (snapshot: TankHudSnapshot) => void;
  onTankLayoutReady: (layout: CityLayout) => void;
  onControllerReady: (controller: EngineController) => void;
  onFirstInput: () => void;
  autostart: boolean;
}

/**
 * Isolated WebGL canvas mount container.
 * Mounts either AirCombatEngine ('jet') or TankCombatEngine ('tank') cleanly,
 * disposing the previous engine on mode switch so Title Screen previews the chosen world live.
 */
export function GameCanvas({
  mode,
  jetSubMode,
  difficulty,
  onHudUpdate,
  onTankHudUpdate,
  onTankLayoutReady,
  onControllerReady,
  onFirstInput,
  autostart,
}: GameCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onHudRef = useRef(onHudUpdate);
  const onTankHudRef = useRef(onTankHudUpdate);
  const onTankLayoutRef = useRef(onTankLayoutReady);
  const onControllerRef = useRef(onControllerReady);
  const onFirstInputRef = useRef(onFirstInput);
  const difficultyRef = useRef(difficulty);
  const jetSubModeRef = useRef(jetSubMode);

  onHudRef.current = onHudUpdate;
  onTankHudRef.current = onTankHudUpdate;
  onTankLayoutRef.current = onTankLayoutReady;
  onControllerRef.current = onControllerReady;
  onFirstInputRef.current = onFirstInput;
  difficultyRef.current = difficulty;
  jetSubModeRef.current = jetSubMode;

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // ---------------------------------------------------------
    // MODE 1: FIGHTER JET MODE (AirCombatEngine — preserved 100%)
    // ---------------------------------------------------------
    if (mode === 'jet') {
      const engine = new AirCombatEngine(el, (snap) => {
        onHudRef.current(snap);
      });
      engine.setDifficulty(difficultyRef.current);
      engine.setJetSubMode(jetSubModeRef.current);

      const keysHeld = new Set<string>();
      const touchState = {
        pitch: 0,
        roll: 0,
        fireGun: false,
        boost: false,
      };

      const syncControls = () => {
        let keyPitch = 0;
        let keyRoll = 0;
        let keyYaw = 0;

        if (keysHeld.has('KeyW') || keysHeld.has('ArrowUp')) keyPitch += 1;
        if (keysHeld.has('KeyS') || keysHeld.has('ArrowDown')) keyPitch -= 1;
        if (keysHeld.has('KeyD') || keysHeld.has('ArrowRight')) keyRoll += 1;
        if (keysHeld.has('KeyA') || keysHeld.has('ArrowLeft')) keyRoll -= 1;
        if (keysHeld.has('KeyQ')) keyYaw -= 1;
        if (keysHeld.has('KeyC')) keyYaw += 1;

        const pitch = Math.abs(touchState.pitch) > 0.02 ? touchState.pitch : keyPitch;
        const roll = Math.abs(touchState.roll) > 0.02 ? touchState.roll : keyRoll;
        const fireGun = touchState.fireGun || keysHeld.has('Space');
        const boost =
          touchState.boost || keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight');

        const merged: Partial<ControlInput> = {
          pitch,
          roll,
          yaw: keyYaw,
          fireGun,
          boost,
        };
        engine.setInput(merged);
      };

      const controller: EngineController = {
        startNewGame: (overrideDiff?: DifficultyLevel, overrideSubMode?: JetSubMode) => {
          keysHeld.clear();
          touchState.pitch = 0;
          touchState.roll = 0;
          touchState.fireGun = false;
          touchState.boost = false;
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          engine.startNewGame(
            overrideDiff ?? difficultyRef.current,
            overrideSubMode ?? jetSubModeRef.current,
          );
        },
        setDifficulty: (level: DifficultyLevel) => {
          engine.setDifficulty(level);
        },
        setJetSubMode: (subMode: JetSubMode) => {
          engine.setJetSubMode(subMode);
        },
        togglePause: () => {
          keysHeld.clear();
          engine.togglePause();
        },
        returnToTitle: () => {
          keysHeld.clear();
          engine.returnToTitle();
        },
        toggleMute: () => {
          engine.audio.unlock();
          return engine.audio.toggleMute();
        },
        setTouchStick: (pitch: number, roll: number) => {
          engine.audio.unlock();
          touchState.pitch = pitch;
          touchState.roll = roll;
          onFirstInputRef.current();
          syncControls();
        },
        setTouchButton: (btn, active) => {
          engine.audio.unlock();
          touchState[btn] = active;
          if (active) onFirstInputRef.current();
          syncControls();
        },
        triggerMissile: () => {
          engine.audio.unlock();
          onFirstInputRef.current();
          engine.triggerMissile();
        },
        triggerFlare: () => {
          engine.audio.unlock();
          onFirstInputRef.current();
          engine.triggerFlare();
        },
        // No-ops in jet mode
        setTankTouchStick: () => {},
        addTankAimDelta: () => {},
        setTankTouchButton: () => {},
        triggerTankCannon: () => {},
        triggerTankSmoke: () => {},
        triggerTankTargetSnap: () => {},
      };

      onControllerRef.current(controller);

      const onKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          return;
        }

        const code = e.code;
        const phase = engine.getPhase();

        if (
          code === 'Space' ||
          code === 'ArrowUp' ||
          code === 'ArrowDown' ||
          code === 'ArrowLeft' ||
          code === 'ArrowRight'
        ) {
          e.preventDefault();
        }

        if (phase === 'title' && (code === 'Enter' || code === 'Space')) {
          e.preventDefault();
          controller.startNewGame();
          return;
        }

        if (phase === 'gameover' && (code === 'Enter' || code === 'Space')) {
          e.preventDefault();
          controller.startNewGame();
          return;
        }

        if ((code === 'Escape' || code === 'KeyP') && !e.repeat) {
          if (phase === 'playing' || phase === 'paused') {
            e.preventDefault();
            controller.togglePause();
            return;
          }
        }

        if (code === 'KeyM' && !e.repeat) {
          controller.toggleMute();
          return;
        }

        if (phase !== 'playing') return;

        engine.audio.unlock();
        onFirstInputRef.current();

        if (!e.repeat) {
          if (code === 'KeyE' || code === 'Enter') {
            engine.triggerMissile();
          } else if (code === 'KeyF') {
            engine.triggerFlare();
          }
        }

        keysHeld.add(code);
        syncControls();
      };

      const onKeyUp = (e: KeyboardEvent) => {
        keysHeld.delete(e.code);
        syncControls();
      };

      const clearAllHeld = () => {
        keysHeld.clear();
        touchState.pitch = 0;
        touchState.roll = 0;
        touchState.fireGun = false;
        touchState.boost = false;
        engine.clearInputs();
      };

      const onVisibility = () => {
        if (document.hidden) clearAllHeld();
      };

      window.addEventListener('keydown', onKeyDown, { passive: false });
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', clearAllHeld);
      document.addEventListener('visibilitychange', onVisibility);

      if (autostart) {
        controller.startNewGame();
      }

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', clearAllHeld);
        document.removeEventListener('visibilitychange', onVisibility);
        engine.dispose();
      };
    }

    // ---------------------------------------------------------
    // MODE 2: 3D URBAN TANK COMBAT MODE (TankCombatEngine)
    // ---------------------------------------------------------
    const tankEngine = new TankCombatEngine(el, (snap) => {
      onTankHudRef.current(snap);
    });
    tankEngine.setDifficulty(difficultyRef.current);
    onTankLayoutRef.current(tankEngine.layout);

    const keysHeld = new Set<string>();
    const mouseState = {
      leftDown: false,
      rightDown: false,
      lastX: null as number | null,
      lastY: null as number | null,
      edgeZone: 0, // -1 left edge, +1 right edge, 0 center
    };
    const touchState = {
      throttle: 0,
      steer: 0,
      fireCannon: false,
      fireMg: false,
      boost: false,
    };

    const syncTankControls = () => {
      let keyThrottle = 0;
      let keySteer = 0;

      if (keysHeld.has('KeyW') || keysHeld.has('ArrowUp')) keyThrottle += 1;
      if (keysHeld.has('KeyS') || keysHeld.has('ArrowDown')) keyThrottle -= 1;
      if (keysHeld.has('KeyD') || keysHeld.has('ArrowRight')) keySteer += 1;
      if (keysHeld.has('KeyA') || keysHeld.has('ArrowLeft')) keySteer -= 1;

      const throttle =
        Math.abs(touchState.throttle) > 0.02 ? touchState.throttle : keyThrottle;
      const steer = Math.abs(touchState.steer) > 0.02 ? touchState.steer : keySteer;
      const fireCannon = touchState.fireCannon || mouseState.leftDown;
      const fireMg =
        touchState.fireMg || mouseState.rightDown || keysHeld.has('Space');
      const boost =
        touchState.boost || keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight');

      const merged: Partial<TankControlInput> = {
        throttle,
        steer,
        fireCannon,
        fireMg,
        boost,
      };
      tankEngine.setInput(merged);
    };

    // Smooth edge-turn helper so desktop players can rotate turret 360° inside an iframe without PointerLock
    let edgePanRaf = 0;
    let lastEdgeTime = performance.now();
    const tickEdgePan = (now: number) => {
      const dt = Math.min(0.05, (now - lastEdgeTime) / 1000);
      lastEdgeTime = now;
      if (tankEngine.getPhase() === 'playing' && mouseState.edgeZone !== 0) {
        tankEngine.addAimDelta(-mouseState.edgeZone * 1.65 * dt, 0);
      }
      edgePanRaf = requestAnimationFrame(tickEdgePan);
    };
    edgePanRaf = requestAnimationFrame(tickEdgePan);

    const controller: EngineController = {
      startNewGame: (overrideDiff?: DifficultyLevel) => {
        keysHeld.clear();
        mouseState.leftDown = false;
        mouseState.rightDown = false;
        mouseState.lastX = null;
        mouseState.lastY = null;
        mouseState.edgeZone = 0;
        touchState.throttle = 0;
        touchState.steer = 0;
        touchState.fireCannon = false;
        touchState.fireMg = false;
        touchState.boost = false;
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        tankEngine.startNewGame(overrideDiff ?? difficultyRef.current);
      },
      setDifficulty: (level: DifficultyLevel) => {
        tankEngine.setDifficulty(level);
      },
      setJetSubMode: () => {},
      togglePause: () => {
        keysHeld.clear();
        mouseState.leftDown = false;
        mouseState.rightDown = false;
        mouseState.edgeZone = 0;
        tankEngine.togglePause();
      },
      returnToTitle: () => {
        keysHeld.clear();
        mouseState.leftDown = false;
        mouseState.rightDown = false;
        mouseState.edgeZone = 0;
        tankEngine.returnToTitle();
      },
      toggleMute: () => {
        tankEngine.audio.unlock();
        return tankEngine.audio.toggleMute();
      },
      // Jet no-ops
      setTouchStick: () => {},
      setTouchButton: () => {},
      triggerMissile: () => {},
      triggerFlare: () => {},
      // Tank touch & action controls
      setTankTouchStick: (throttle: number, steer: number) => {
        tankEngine.audio.unlock();
        touchState.throttle = throttle;
        touchState.steer = steer;
        onFirstInputRef.current();
        syncTankControls();
      },
      addTankAimDelta: (deltaYawRad: number, deltaPitchRad: number) => {
        tankEngine.audio.unlock();
        onFirstInputRef.current();
        tankEngine.addAimDelta(deltaYawRad, deltaPitchRad);
      },
      setTankTouchButton: (btn, active) => {
        tankEngine.audio.unlock();
        touchState[btn] = active;
        if (active) onFirstInputRef.current();
        syncTankControls();
      },
      triggerTankCannon: () => {
        tankEngine.audio.unlock();
        onFirstInputRef.current();
        tankEngine.triggerCannon();
      },
      triggerTankSmoke: () => {
        tankEngine.audio.unlock();
        onFirstInputRef.current();
        tankEngine.triggerSmoke();
      },
      triggerTankTargetSnap: () => {
        tankEngine.audio.unlock();
        onFirstInputRef.current();
        tankEngine.triggerTargetSnap();
      },
    };

    onControllerRef.current(controller);

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      const code = e.code;
      const phase = tankEngine.getPhase();

      if (
        code === 'Space' ||
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      if (phase === 'title' && (code === 'Enter' || code === 'Space')) {
        e.preventDefault();
        controller.startNewGame();
        return;
      }

      if (phase === 'gameover' && (code === 'Enter' || code === 'Space')) {
        e.preventDefault();
        controller.startNewGame();
        return;
      }

      if ((code === 'Escape' || code === 'KeyP') && !e.repeat) {
        if (phase === 'playing' || phase === 'paused') {
          e.preventDefault();
          controller.togglePause();
          return;
        }
      }

      if (code === 'KeyM' && !e.repeat) {
        controller.toggleMute();
        return;
      }

      if (phase !== 'playing') return;

      tankEngine.audio.unlock();
      onFirstInputRef.current();

      if (!e.repeat) {
        if (code === 'KeyF') {
          tankEngine.triggerSmoke();
        } else if (code === 'KeyQ' || code === 'KeyE') {
          tankEngine.triggerTargetSnap();
        }
      }

      keysHeld.add(code);
      syncTankControls();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysHeld.delete(e.code);
      syncTankControls();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (tankEngine.getPhase() !== 'playing') {
        mouseState.lastX = null;
        mouseState.lastY = null;
        mouseState.edgeZone = 0;
        return;
      }

      const w = Math.max(1, window.innerWidth);
      const normX = e.clientX / w;
      if (normX < 0.13) {
        mouseState.edgeZone = -((0.13 - normX) / 0.13);
      } else if (normX > 0.87) {
        mouseState.edgeZone = (normX - 0.87) / 0.13;
      } else {
        mouseState.edgeZone = 0;
      }

      if (mouseState.lastX !== null && mouseState.lastY !== null) {
        const dx = e.clientX - mouseState.lastX;
        const dy = e.clientY - mouseState.lastY;
        if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
          tankEngine.addAimDelta(-dx * 0.0048, -dy * 0.0022);
        }
      }
      mouseState.lastX = e.clientX;
      mouseState.lastY = e.clientY;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (tankEngine.getPhase() !== 'playing') return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('button, input, a')) return;

      tankEngine.audio.unlock();
      onFirstInputRef.current();

      if (e.button === 0) {
        mouseState.leftDown = true;
        tankEngine.triggerCannon();
        syncTankControls();
      } else if (e.button === 2) {
        mouseState.rightDown = true;
        syncTankControls();
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        mouseState.leftDown = false;
        syncTankControls();
      } else if (e.button === 2) {
        mouseState.rightDown = false;
        syncTankControls();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (tankEngine.getPhase() === 'playing') {
        e.preventDefault();
      }
    };

    const clearAllHeld = () => {
      keysHeld.clear();
      mouseState.leftDown = false;
      mouseState.rightDown = false;
      mouseState.lastX = null;
      mouseState.lastY = null;
      mouseState.edgeZone = 0;
      touchState.throttle = 0;
      touchState.steer = 0;
      touchState.fireCannon = false;
      touchState.fireMg = false;
      touchState.boost = false;
      tankEngine.clearInputs();
    };

    const onVisibility = () => {
      if (document.hidden) clearAllHeld();
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', clearAllHeld);
    document.addEventListener('visibilitychange', onVisibility);

    if (autostart) {
      controller.startNewGame();
    }

    return () => {
      cancelAnimationFrame(edgePanRaf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', clearAllHeld);
      document.removeEventListener('visibilitychange', onVisibility);
      tankEngine.dispose();
    };
  }, [mode, autostart]);

  return (
    <div
      ref={mountRef}
      data-testid="game-canvas-container"
      className="fixed inset-0 w-full h-full overflow-hidden"
      dir="ltr"
    />
  );
}
