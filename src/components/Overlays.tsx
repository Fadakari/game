import { useState } from 'react';
import {
  Play,
  RotateCcw,
  Share2,
  Home,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Smartphone,
  Check,
  Trophy,
  Send,
  Radio,
  Plane,
  Shield,
  Crosshair,
  Target,
} from 'lucide-react';
import { DIFFICULTY_PROFILES } from '../engine/enemyAI';
import type {
  DefeatReason,
  DifficultyLevel,
  EdgeTelemetryInfo,
  GameMode,
  GamePhase,
  JetSubMode,
} from '../engine/types';
import { getSavedCallsign } from '../services/edgeLeaderboard';
import { formatScoreFa, formatTimeFa, toFaNum } from '../utils/formatFa';

export interface ActiveOverlayHudSummary {
  phase: GamePhase;
  score: number;
  highScore: number;
  kills: number;
  wave: number;
  survivalTimeSec: number;
  defeatReason: DefeatReason;
}

interface OverlaysProps {
  mode: GameMode;
  jetSubMode: JetSubMode;
  hud: ActiveOverlayHudSummary;
  edgeTelemetry: EdgeTelemetryInfo | null;
  difficulty: DifficultyLevel;
  muted: boolean;
  isFullscreen: boolean;
  isPortraitMobile: boolean;
  onSelectMode: (mode: GameMode) => void;
  onSelectJetSubMode: (subMode: JetSubMode) => void;
  onSelectDifficulty: (level: DifficultyLevel) => void;
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onReturnTitle: () => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onOpenLeaderboard: () => void;
  onSubmitLeaderboard: (callsign: string) => Promise<{ ok: boolean; reasonFa?: string }>;
}

const JET_DEFEAT_REASON_FA: Record<DefeatReason, string> = {
  ocean: 'سقوط جنگنده در آب‌های اقیانوس',
  terrain: 'برخورد مستقیم با ارتفاعات جزیره',
  combat: 'انهدام جنگنده بر اثر آتش دشمن',
  none: 'عملیات به پایان رسید',
};

const TANK_DEFEAT_REASON_FA: Record<DefeatReason, string> = {
  ocean: 'انهدام تانک در میدان نبرد',
  terrain: 'انهدام تانک در میدان نبرد',
  combat: 'انهدام تانک بر اثر آتش زرهی دشمن',
  none: 'عملیات زرهی به پایان رسید',
};

const TANK_DIFFICULTY_DESC_FA: Record<DifficultyLevel, string> = {
  easy: 'پیشروی آرام‌تر زرهی دشمن و فرصت بیشتر برای هدف‌گیری دقیق',
  normal: 'نبرد زرهی متعادل با جناح‌گیری تانک‌ها و هشدار موشک ضدتانک',
  hard: 'تانک‌های تهاجمی، آتش دقیق و محاصره سنگین شهری',
};

/**
 * Full-viewport Game Shell overlays: Title Screen (with Fighter Jet / Tank Mode Selector),
 * Pause Modal, Game Over Modal, and Mobile Portrait Rotation Prompt.
 * 100% Persian RTL without backdrop-filter over WebGL.
 */
export function Overlays({
  mode,
  jetSubMode,
  hud,
  edgeTelemetry,
  difficulty,
  muted,
  isFullscreen,
  isPortraitMobile,
  onSelectMode,
  onSelectJetSubMode,
  onSelectDifficulty,
  onStart,
  onResume,
  onRestart,
  onReturnTitle,
  onToggleMute,
  onToggleFullscreen,
  onOpenLeaderboard,
  onSubmitLeaderboard,
}: OverlaysProps) {
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied'>('idle');
  const [callsign, setCallsign] = useState<string>(() => getSavedCallsign());
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'saved' | 'error'>('idle');
  const [submitErrorFa, setSubmitErrorFa] = useState<string>('');

  const isTank = mode === 'tank';

  const handleLeaderboardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitState === 'submitting' || submitState === 'saved') return;
    setSubmitState('submitting');
    setSubmitErrorFa('');
    const res = await onSubmitLeaderboard(callsign);
    if (res.ok) {
      setSubmitState('saved');
    } else {
      setSubmitState('error');
      setSubmitErrorFa(res.reasonFa || 'ثبت رکورد انجام نشد.');
    }
  };

  const handleShareScore = async () => {
    const modeLabel = isTank ? 'نبرد زرهی (تانک)' : 'نبرد هوایی (جنگنده)';
    const killWord = isTank ? 'انهدام' : 'سرنگونی';
    const text = `من در بازی «شکارچی آسمان» — حالت ${modeLabel} امتیاز ${formatScoreFa(
      hud.score,
    )} کسب کردم و تا موج ${toFaNum(hud.wave)} (${toFaNum(
      hud.kills,
    )} ${killWord}) پیش رفتم! آیا می‌توانی رکوردم را بشکنی؟`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'شکارچی آسمان',
          text,
        });
        return;
      }
    } catch {
      // Fallback to clipboard
    }

    try {
      await navigator.clipboard.writeText(text);
      setShareStatus('copied');
      setTimeout(() => setShareStatus('idle'), 2600);
    } catch {
      setShareStatus('copied');
      setTimeout(() => setShareStatus('idle'), 2600);
    }
  };

  return (
    <>
      {/* Mobile Portrait Orientation Guard */}
      {isPortraitMobile && (
        <div
          dir="rtl"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#08111c] px-6 text-center text-slate-100"
          role="dialog"
          aria-modal="true"
          aria-label="چرخش صفحه به حالت افقی"
        >
          <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-2xl border border-amber-400/40 bg-amber-500/15 text-amber-400">
            <Smartphone className="h-10 w-10 -rotate-90" />
          </div>
          <h2 className="mb-2 text-2xl font-black text-white">
            لطفاً گوشی خود را به حالت افقی بچرخانید
          </h2>
          <p className="max-w-xs text-sm leading-relaxed text-slate-300">
            برای کنترل دقیق {isTank ? 'تانک و برجک' : 'جنگنده'} با دو شست و دید کامل رادار، بازی در حالت افقی طراحی شده است.
          </p>
        </div>
      )}

      {/* TITLE SCREEN */}
      {hud.phase === 'title' && !isPortraitMobile && (
        <div
          dir="rtl"
          className="pointer-events-none fixed inset-0 z-30 flex flex-col justify-between p-4 sm:p-8 [@media(max-height:540px)]:p-2.5"
        >
          {/* Top bar: ArvanCloud Edge PoP Telemetry + subtle utility buttons */}
          <div className="flex shrink-0 items-start justify-between gap-2">
            <div>
              {edgeTelemetry && (
                <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-emerald-400/25 bg-[#0b1624]/86 px-2.5 py-1 text-[11px] font-bold text-emerald-200 sm:px-3 sm:py-1.5 sm:text-xs">
                  <Radio className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  <span className="tabular-nums whitespace-nowrap">
                    اتصال به لبه آروان | پینگ: {toFaNum(edgeTelemetry.pingMs)}ms
                  </span>
                </div>
              )}
            </div>
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onToggleMute();
                }}
                tabIndex={-1}
                aria-label={muted ? 'وصل صدا' : 'قطع صدا'}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200/20 bg-[#0b1624]/86 text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer [@media(max-height:540px)]:h-8 [@media(max-height:540px)]:w-8"
              >
                {muted ? <VolumeX className="h-4 w-4 sm:h-5 sm:w-5" /> : <Volume2 className="h-4 w-4 sm:h-5 sm:w-5" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  onToggleFullscreen();
                }}
                tabIndex={-1}
                aria-label={isFullscreen ? 'خروج از تمام‌صفحه' : 'نمایش تمام‌صفحه'}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200/20 bg-[#0b1624]/86 text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer [@media(max-height:540px)]:h-8 [@media(max-height:540px)]:w-8"
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4 sm:h-5 sm:w-5" />
                ) : (
                  <Maximize2 className="h-4 w-4 sm:h-5 sm:w-5" />
                )}
              </button>
            </div>
          </div>

          {/* Asymmetric Right-Anchored Title Lockup — switches to compact 2-column horizontal grid on mobile landscape so Start CTA never clips */}
          <div className="flex min-h-0 flex-1 items-center justify-start [@media(max-height:540px)]:justify-center">
            <div
              className={`pointer-events-auto w-full max-w-md max-h-[calc(100dvh-56px)] overflow-y-auto rounded-xl border px-5 py-5 shadow-2xl [@media(max-height:540px)]:max-w-2xl [@media(max-height:540px)]:px-4 [@media(max-height:540px)]:py-3 ${
                isTank
                  ? 'border-amber-300/25 bg-[#121614]/88'
                  : 'border-slate-100/15 bg-[#09131f]/86'
              }`}
            >
              <div className="flex flex-col [@media(max-height:540px)]:grid [@media(max-height:540px)]:grid-cols-2 [@media(max-height:540px)]:items-center [@media(max-height:540px)]:gap-4">
                {/* COLUMN 1 (RTL Right): Brand Emblem, Main Mode Selector & Jet Sub-Mode Selector */}
                <div>
                  {/* Bespoke Inline SVG Emblem + Title Lockup */}
                  <div className="mb-3.5 flex items-center gap-3.5 [@media(max-height:540px)]:mb-2.5 [@media(max-height:540px)]:gap-2.5">
                    {isTank ? (
                      <svg
                        viewBox="0 0 64 64"
                        className="h-12 w-12 shrink-0 sm:h-14 sm:w-14 [@media(max-height:540px)]:h-10 [@media(max-height:540px)]:w-10"
                        aria-hidden="true"
                      >
                        <polygon
                          points="32,4 58,18 58,46 32,60 6,46 6,18"
                          fill="#1c221d"
                          stroke="#f59e0b"
                          strokeWidth="2.5"
                        />
                        <rect x="14" y="34" width="36" height="10" rx="4" fill="#d6d3d1" />
                        <rect x="21" y="25" width="20" height="9" rx="2" fill="#f8fafc" />
                        <rect x="39" y="27.5" width="14" height="3.2" rx="1" fill="#f59e0b" />
                        <circle cx="20" cy="40" r="2.2" fill="#1c221d" />
                        <circle cx="28" cy="40" r="2.2" fill="#1c221d" />
                        <circle cx="36" cy="40" r="2.2" fill="#1c221d" />
                        <circle cx="44" cy="40" r="2.2" fill="#1c221d" />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 64 64"
                        className="h-12 w-12 shrink-0 sm:h-14 sm:w-14 [@media(max-height:540px)]:h-10 [@media(max-height:540px)]:w-10"
                        aria-hidden="true"
                      >
                        <polygon
                          points="32,4 58,18 58,46 32,60 6,46 6,18"
                          fill="#102033"
                          stroke="#f59e0b"
                          strokeWidth="2.5"
                        />
                        <path
                          d="M32 13 L37 28 L52 34 L36 37 L34 48 L40 52 L32 50 L24 52 L30 48 L28 37 L12 34 L27 28 Z"
                          fill="#f8fafc"
                          stroke="#09131f"
                          strokeWidth="1.2"
                        />
                        <circle cx="32" cy="31" r="2.2" fill="#f59e0b" />
                      </svg>
                    )}
                    <div>
                      <h1 className="hud-stroke-title text-2xl font-black tracking-tight text-white sm:text-4xl [@media(max-height:540px)]:text-xl">
                        شکارچی آسمان
                      </h1>
                      <p className="mt-0.5 text-xs font-semibold text-amber-300/95 sm:text-sm [@media(max-height:540px)]:text-[11px]">
                        {isTank
                          ? 'نبرد زرهی شهری سه‌بعدی'
                          : jetSubMode === 'strike'
                            ? 'عملیات تهاجمی و انهدام اهداف راهبردی'
                            : 'نبرد هوایی تاکتیکی سه‌بعدی'}
                      </p>
                    </div>
                  </div>

                  {/* 2-MODE SELECTOR: Fighter Jet vs Armored Tank */}
                  <div className="mb-3 [@media(max-height:540px)]:mb-2">
                    <div className="mb-1 text-xs font-semibold text-slate-300 [@media(max-height:540px)]:text-[11px]">
                      انتخاب حالت عملیات
                    </div>
                    <div
                      role="group"
                      aria-label="حالت بازی"
                      className="grid grid-cols-2 gap-2"
                    >
                      <button
                        type="button"
                        data-mode-btn="jet"
                        aria-pressed={mode === 'jet'}
                        onClick={(e) => {
                          e.currentTarget.blur();
                          onSelectMode('jet');
                        }}
                        className={`flex flex-col items-center gap-1 rounded-lg border px-2.5 py-2 text-center transition-colors cursor-pointer [@media(max-height:540px)]:py-1.5 ${
                          mode === 'jet'
                            ? 'border-amber-400 bg-amber-500/20 text-white shadow-md'
                            : 'border-slate-200/15 bg-[#0e1b2a]/80 text-slate-300 hover:border-slate-200/35 hover:text-white'
                        }`}
                      >
                        <Plane
                          className={`h-4 w-4 ${
                            mode === 'jet' ? 'text-amber-400' : 'text-sky-300'
                          }`}
                        />
                        <span className="text-xs font-black whitespace-nowrap [@media(max-height:540px)]:text-[11px]">
                          نبرد هوایی (جنگنده)
                        </span>
                      </button>

                      <button
                        type="button"
                        data-mode-btn="tank"
                        aria-pressed={mode === 'tank'}
                        onClick={(e) => {
                          e.currentTarget.blur();
                          onSelectMode('tank');
                        }}
                        className={`flex flex-col items-center gap-1 rounded-lg border px-2.5 py-2 text-center transition-colors cursor-pointer [@media(max-height:540px)]:py-1.5 ${
                          mode === 'tank'
                            ? 'border-amber-400 bg-amber-500/20 text-white shadow-md'
                            : 'border-slate-200/15 bg-[#191d1a]/80 text-slate-300 hover:border-slate-200/35 hover:text-white'
                        }`}
                      >
                        <Shield
                          className={`h-4 w-4 ${
                            mode === 'tank' ? 'text-amber-400' : 'text-emerald-300'
                          }`}
                        />
                        <span className="text-xs font-black whitespace-nowrap [@media(max-height:540px)]:text-[11px]">
                          نبرد زرهی (تانک)
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* JET SUB-MODE SELECTOR: Free Dogfight vs Tactical Strike Missions */}
                  {mode === 'jet' && (
                    <div className="mb-3 [@media(max-height:540px)]:mb-0">
                      <div className="mb-1 text-xs font-semibold text-slate-300 [@media(max-height:540px)]:text-[11px]">
                        نوع مأموریت هوایی
                      </div>
                      <div
                        role="group"
                        aria-label="نوع مأموریت جنگنده"
                        className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-200/12 bg-[#0d1826]/85 p-1"
                      >
                        <button
                          type="button"
                          data-submode-btn="dogfight"
                          aria-pressed={jetSubMode === 'dogfight'}
                          onClick={(e) => {
                            e.currentTarget.blur();
                            onSelectJetSubMode('dogfight');
                          }}
                          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap [@media(max-height:540px)]:py-1 [@media(max-height:540px)]:text-[11px] ${
                            jetSubMode === 'dogfight'
                              ? 'bg-sky-500/25 text-sky-200 ring-1 ring-sky-400/60'
                              : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                          }`}
                        >
                          <Crosshair className="h-3.5 w-3.5 shrink-0" />
                          <span>نبرد آزاد</span>
                        </button>
                        <button
                          type="button"
                          data-submode-btn="strike"
                          aria-pressed={jetSubMode === 'strike'}
                          onClick={(e) => {
                            e.currentTarget.blur();
                            onSelectJetSubMode('strike');
                          }}
                          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap [@media(max-height:540px)]:py-1 [@media(max-height:540px)]:text-[11px] ${
                            jetSubMode === 'strike'
                              ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/70'
                              : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                          }`}
                        >
                          <Target className="h-3.5 w-3.5 shrink-0" />
                          <span>عملیات تهاجمی</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* COLUMN 2 (RTL Left): High Score, Difficulty, Start CTA & Leaderboard */}
                <div>
                  {hud.highScore > 0 && (
                    <div className="mb-3 flex items-center justify-between border-y border-slate-200/12 py-1.5 text-xs sm:text-sm [@media(max-height:540px)]:mb-2 [@media(max-height:540px)]:py-1">
                      <span className="text-slate-300">
                        بهترین رکورد ({isTank ? 'تانک' : 'جنگنده'})
                      </span>
                      <span className="tabular-nums text-sm font-bold text-amber-400 sm:text-base">
                        {formatScoreFa(hud.highScore)}
                      </span>
                    </div>
                  )}

                  {/* 3-Tier Difficulty Segmented Selector */}
                  <div className="mb-3.5 [@media(max-height:540px)]:mb-2.5">
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-300 [@media(max-height:540px)]:text-[11px]">
                      <span>درجه سختی نبرد</span>
                      <span className="text-amber-300/90">
                        {DIFFICULTY_PROFILES[difficulty].labelFa}
                      </span>
                    </div>
                    <div
                      role="group"
                      aria-label="درجه سختی"
                      className="grid grid-cols-3 gap-1.5 rounded-lg border border-slate-200/12 bg-[#0d1826]/85 p-1"
                    >
                      {(['easy', 'normal', 'hard'] as const).map((level) => {
                        const active = difficulty === level;
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={active}
                            onClick={(e) => {
                              e.currentTarget.blur();
                              onSelectDifficulty(level);
                            }}
                            className={`rounded-md py-1.5 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap [@media(max-height:540px)]:py-1 [@media(max-height:540px)]:text-[11px] ${
                              active
                                ? 'bg-amber-500 text-slate-950 shadow-sm'
                                : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                            }`}
                          >
                            {DIFFICULTY_PROFILES[level].labelFa}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-300/90 [@media(max-height:500px)]:hidden">
                      {isTank
                        ? TANK_DIFFICULTY_DESC_FA[difficulty]
                        : DIFFICULTY_PROFILES[difficulty].descFa}
                    </p>
                  </div>

                  <button
                    type="button"
                    data-start="true"
                    onClick={(e) => {
                      e.currentTarget.blur();
                      setSubmitState('idle');
                      setSubmitErrorFa('');
                      onStart();
                    }}
                    className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-amber-500 px-6 py-3 text-base font-black text-slate-950 shadow-lg transition-transform hover:bg-amber-400 active:scale-[0.98] cursor-pointer whitespace-nowrap sm:text-lg [@media(max-height:540px)]:py-2.5 [@media(max-height:540px)]:text-base"
                  >
                    <Play className="h-5 w-5 fill-slate-950" />
                    <span>شروع عملیات</span>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.currentTarget.blur();
                      onOpenLeaderboard();
                    }}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200/18 bg-[#122236]/90 px-4 py-2 text-xs font-bold text-slate-100 transition-colors hover:border-amber-400/60 hover:text-amber-300 cursor-pointer whitespace-nowrap sm:mt-2.5 sm:py-2.5 sm:text-sm [@media(max-height:540px)]:py-1.5"
                  >
                    <Trophy className="h-4 w-4 text-amber-400" />
                    <span>جدول ۱۰۰ خلبان و فرمانده برتر</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Single Flat Control-Hint Line in Bottom Safe Margin (hidden on short mobile landscape) */}
          <div className="flex shrink-0 justify-center [@media(max-height:540px)]:hidden">
            <p className="hud-text-shadow text-center text-xs font-medium text-slate-100/95 sm:text-sm">
              {isTank
                ? 'حرکت بدنه: WASD · برجک: ماوس · توپ ۱۲۰م‌م: کلیک چپ · تیربار: راست‌کلیک یا Space · پرده دود: F · توربو: Shift · قفل: Q'
                : 'هدایت: WASD یا کلیدهای جهت‌نما · تیربار: Space · موشک: E یا Enter · توربو: Shift · منور: F · توقف: P'}
            </p>
          </div>
        </div>
      )}

      {/* PAUSE MODAL */}
      {hud.phase === 'paused' && !isPortraitMobile && (
        <div
          dir="rtl"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#060d17]/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="توقف بازی"
        >
          <div className="w-full max-w-sm max-h-[calc(100dvh-24px)] overflow-y-auto rounded-xl border border-slate-200/20 bg-[#0d1929] p-5 text-slate-100 shadow-2xl sm:p-6">
            <h2 className="mb-1 text-center text-2xl font-black text-white">توقف عملیات</h2>
            <p className="mb-5 text-center text-xs text-slate-400">
              {isTank ? 'نبرد زرهی' : 'نبرد هوایی'} · موج {toFaNum(hud.wave)} · امتیاز فعلی{' '}
              {formatScoreFa(hud.score)}
            </p>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={onResume}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-5 py-3 text-base font-bold text-slate-950 transition-colors hover:bg-amber-400 cursor-pointer"
              >
                <Play className="h-4 w-4 fill-slate-950" />
                <span>{isTank ? 'ادامه نبرد' : 'ادامه پرواز'}</span>
              </button>

              <button
                type="button"
                onClick={onRestart}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200/20 bg-[#15253a] px-5 py-2.5 text-sm font-bold text-slate-100 transition-colors hover:border-amber-400/50 cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" />
                <span>شروع مجدد</span>
              </button>

              <button
                type="button"
                onClick={onReturnTitle}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200/15 bg-transparent px-5 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800/70 hover:text-white cursor-pointer"
              >
                <Home className="h-4 w-4" />
                <span>بازگشت به منوی اصلی</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GAME OVER MODAL */}
      {hud.phase === 'gameover' && !isPortraitMobile && (
        <div
          dir="rtl"
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#060d17]/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="پایان عملیات"
        >
          <div className="w-full max-w-md max-h-[calc(100dvh-24px)] overflow-y-auto rounded-xl border border-red-400/30 bg-[#0d1826] p-5 text-slate-100 shadow-2xl sm:p-6">
            <div className="mb-5 text-center">
              <h2 className="text-3xl font-black text-red-400">پایان عملیات</h2>
              <p className="mt-1.5 text-sm font-medium text-slate-300">
                {isTank
                  ? TANK_DEFEAT_REASON_FA[hud.defeatReason]
                  : JET_DEFEAT_REASON_FA[hud.defeatReason]}
              </p>
            </div>

            {/* 3 Tabular Stat Tiles */}
            <div className="mb-6 grid grid-cols-3 gap-2.5 text-center">
              <div className="rounded-lg border border-slate-200/12 bg-[#132235] px-3 py-3">
                <div className="text-xs text-slate-400">امتیاز نهایی</div>
                <div className="tabular-nums mt-1 text-xl font-black text-amber-400">
                  {formatScoreFa(hud.score)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200/12 bg-[#132235] px-3 py-3">
                <div className="text-xs text-slate-400">بهترین رکورد</div>
                <div className="tabular-nums mt-1 text-xl font-black text-white">
                  {formatScoreFa(hud.highScore)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200/12 bg-[#132235] px-3 py-3">
                <div className="text-xs text-slate-400">
                  {isTank ? 'موج / انهدام' : 'موج / سرنگونی'}
                </div>
                <div className="tabular-nums mt-1 text-xl font-black text-emerald-400">
                  {toFaNum(hud.wave)} / {toFaNum(hud.kills)}
                </div>
              </div>
            </div>

            <div className="mb-4 flex items-center justify-between border-y border-slate-200/10 py-2 text-xs text-slate-300">
              <span>{isTank ? 'مدت نبرد زرهی' : 'مدت پرواز'}</span>
              <span className="tabular-nums font-bold text-slate-100">
                {formatTimeFa(hud.survivalTimeSec)}
              </span>
            </div>

            {/* Inline Top-100 Score Submission Form */}
            <form onSubmit={handleLeaderboardSubmit} className="mb-4">
              <label
                htmlFor="pilot-callsign-input"
                className="mb-1.5 block text-xs font-bold text-slate-300"
              >
                ثبت رکورد ({isTank ? 'حالت تانک' : 'حالت جنگنده'}) در جدول ۱۰۰ نفر برتر
              </label>
              <div className="flex gap-2">
                <input
                  id="pilot-callsign-input"
                  type="text"
                  maxLength={24}
                  value={callsign}
                  disabled={submitState === 'saved'}
                  onChange={(e) => {
                    setCallsign(e.target.value);
                    if (submitState === 'error') {
                      setSubmitState('idle');
                      setSubmitErrorFa('');
                    }
                  }}
                  placeholder={isTank ? 'نام یا کد فرمانده تانک...' : 'نام یا کد خلبانی شما...'}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200/18 bg-[#132235] px-3 py-2 text-xs font-medium text-white placeholder:text-slate-400 focus:border-amber-400 focus:outline-none disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={submitState === 'submitting' || submitState === 'saved'}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-600/90 px-3.5 py-2 text-xs font-black text-white transition-colors hover:bg-emerald-500 disabled:opacity-60 cursor-pointer whitespace-nowrap"
                >
                  {submitState === 'saved' ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>ثبت شد</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>ثبت رکورد</span>
                    </>
                  )}
                </button>
              </div>
              {submitErrorFa && (
                <p className="mt-1 text-[11px] font-medium text-red-400">{submitErrorFa}</p>
              )}
            </form>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                data-start="true"
                onClick={(e) => {
                  e.currentTarget.blur();
                  setSubmitState('idle');
                  setSubmitErrorFa('');
                  onRestart();
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-base font-black text-slate-950 transition-colors hover:bg-amber-400 cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" />
                <span>{isTank ? 'نبرد مجدد' : 'پرواز مجدد'}</span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onOpenLeaderboard}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-400/35 bg-[#152437] px-3 py-2 text-xs font-bold text-amber-300 transition-colors hover:border-amber-300 hover:text-amber-200 cursor-pointer whitespace-nowrap"
                >
                  <Trophy className="h-3.5 w-3.5" />
                  <span>جدول برترین‌ها</span>
                </button>

                <button
                  type="button"
                  onClick={handleShareScore}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-sky-400/35 bg-[#12263d] px-3 py-2 text-xs font-bold text-sky-200 transition-colors hover:border-sky-300 hover:text-white cursor-pointer whitespace-nowrap"
                >
                  {shareStatus === 'copied' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-emerald-300">کپی شد!</span>
                    </>
                  ) : (
                    <>
                      <Share2 className="h-3.5 w-3.5" />
                      <span>اشتراک‌گذاری</span>
                    </>
                  )}
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSubmitState('idle');
                  setSubmitErrorFa('');
                  onReturnTitle();
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200/12 px-5 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800/70 hover:text-white cursor-pointer"
              >
                <Home className="h-3.5 w-3.5" />
                <span>منوی اصلی</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
