import type {
  DifficultyLevel,
  EdgeTelemetryInfo,
  GameMode,
  LeaderboardEntry,
} from '../engine/types';

const LOCAL_LEADERBOARD_KEY = 'sky_hunter_top100_v2';
const LOCAL_CALLSIGN_KEY = 'sky_hunter_callsign_v1';
const MAX_LEADERBOARD_ENTRIES = 100;

export interface ScoreSubmissionPayload {
  callsign: string;
  score: number;
  wave: number;
  kills: number;
  survivalTimeSec: number;
  difficulty: DifficultyLevel;
  mode?: GameMode;
}

export interface ScoreValidationResult {
  valid: boolean;
  reasonFa?: string;
  sanitized?: Omit<LeaderboardEntry, 'id' | 'timestamp'>;
}

const VALID_DIFFICULTIES = new Set<DifficultyLevel>(['easy', 'normal', 'hard']);

export function normalizeGameMode(raw: unknown): GameMode {
  if (raw === 'tank' || raw === 'تانک') return 'tank';
  return 'jet';
}

const SEED_PILOTS: ReadonlyArray<LeaderboardEntry> = [
  {
    id: 'seed-1',
    callsign: 'عقاب شمال',
    score: 9450,
    wave: 6,
    kills: 24,
    survivalTimeSec: 342,
    difficulty: 'hard',
    mode: 'jet',
    timestamp: 1732400000000,
  },
  {
    id: 'seed-2',
    callsign: 'زرهپوش کاوه',
    score: 8120,
    wave: 5,
    kills: 21,
    survivalTimeSec: 295,
    difficulty: 'hard',
    mode: 'tank',
    timestamp: 1732395000000,
  },
  {
    id: 'seed-3',
    callsign: 'شاهین تیزپرواز',
    score: 7280,
    wave: 5,
    kills: 19,
    survivalTimeSec: 278,
    difficulty: 'normal',
    mode: 'jet',
    timestamp: 1732390000000,
  },
  {
    id: 'seed-4',
    callsign: 'رستم زرهی',
    score: 5980,
    wave: 4,
    kills: 16,
    survivalTimeSec: 228,
    difficulty: 'normal',
    mode: 'tank',
    timestamp: 1732385000000,
  },
  {
    id: 'seed-5',
    callsign: 'آرش خلبان',
    score: 5640,
    wave: 4,
    kills: 15,
    survivalTimeSec: 214,
    difficulty: 'normal',
    mode: 'jet',
    timestamp: 1732380000000,
  },
  {
    id: 'seed-6',
    callsign: 'تیپ فولادی ۰۹',
    score: 4350,
    wave: 3,
    kills: 12,
    survivalTimeSec: 174,
    difficulty: 'easy',
    mode: 'tank',
    timestamp: 1732372000000,
  },
];

/**
 * Pure anti-cheat & input sanitization shared by client and mirrored in edge-worker.js.
 * Validates score plausibility against wave count, kills, and survival duration.
 */
export function validateLeaderboardSubmission(
  payload: Partial<ScoreSubmissionPayload>,
): ScoreValidationResult {
  const rawCallsign = typeof payload.callsign === 'string' ? payload.callsign : '';
  // Strip control characters and angle brackets, keep Persian/Latin letters, digits, spaces, dashes
  const callsign = rawCallsign
    .replace(/[<>"'`\\\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);

  if (callsign.length < 2) {
    return { valid: false, reasonFa: 'نام خلبان باید حداقل ۲ کاراکتر باشد.' };
  }

  const score = Math.floor(Number(payload.score));
  const wave = Math.floor(Number(payload.wave));
  const kills = Math.floor(Number(payload.kills));
  const survivalTimeSec = Math.floor(Number(payload.survivalTimeSec));
  const difficulty: DifficultyLevel = VALID_DIFFICULTIES.has(payload.difficulty as DifficultyLevel)
    ? (payload.difficulty as DifficultyLevel)
    : 'normal';
  const mode: GameMode = normalizeGameMode(payload.mode);

  if (
    !Number.isFinite(score) ||
    !Number.isFinite(wave) ||
    !Number.isFinite(kills) ||
    !Number.isFinite(survivalTimeSec) ||
    score < 0 ||
    wave < 1 ||
    wave > 200 ||
    kills < 0 ||
    kills > 1500 ||
    survivalTimeSec < 0 ||
    survivalTimeSec > 86400
  ) {
    return { valid: false, reasonFa: 'مقادیر امتیاز نامعتبر است.' };
  }

  // Anti-cheat plausibility bounds:
  // 1) Non-zero scores require actual combat time
  if (score > 0 && survivalTimeSec < 3) {
    return { valid: false, reasonFa: 'زمان عملیات برای ثبت امتیاز کافی نیست.' };
  }
  // 2) Higher waves require minimum survival duration (~8s per cleared wave)
  if (wave > 1 && survivalTimeSec < (wave - 1) * 8) {
    return { valid: false, reasonFa: 'تطابق موج و مدت عملیات نامعتبر است.' };
  }
  // 3) Score ceiling consistent with air/tank kills + boss bonuses
  const maxPlausibleScore = wave * 6500 + kills * 1200 + 2500;
  const maxScoreByTime = Math.max(3500, survivalTimeSec * 145);
  if (score > maxPlausibleScore || score > maxScoreByTime) {
    return { valid: false, reasonFa: 'امتیاز ارسال‌شده خارج از محدوده مجاز عملیات است.' };
  }

  return {
    valid: true,
    sanitized: {
      callsign,
      score,
      wave,
      kills,
      survivalTimeSec,
      difficulty,
      mode,
    },
  };
}

export function sortAndTrimTop100(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.wave !== a.wave) return b.wave - a.wave;
      return a.timestamp - b.timestamp;
    })
    .slice(0, MAX_LEADERBOARD_ENTRIES);
}

function readLocalLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_LEADERBOARD_KEY);
    if (!raw) return sortAndTrimTop100([...SEED_PILOTS]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return sortAndTrimTop100([...SEED_PILOTS]);
    return sortAndTrimTop100(parsed);
  } catch {
    return sortAndTrimTop100([...SEED_PILOTS]);
  }
}

function writeLocalLeaderboard(entries: LeaderboardEntry[]): void {
  try {
    window.localStorage.setItem(
      LOCAL_LEADERBOARD_KEY,
      JSON.stringify(sortAndTrimTop100(entries)),
    );
  } catch {
    // ignore storage quota errors
  }
}

export function getSavedCallsign(): string {
  try {
    return window.localStorage.getItem(LOCAL_CALLSIGN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveCallsign(callsign: string): void {
  try {
    window.localStorage.setItem(LOCAL_CALLSIGN_KEY, callsign);
  } catch {
    // ignore
  }
}

/**
 * Fetches ArvanCloud Edge PoP node telemetry from /api/telemetry with live RTT ping.
 * Automatically falls back to local preview mode when running offline without Edge Worker.
 */
export async function fetchEdgeTelemetry(): Promise<EdgeTelemetryInfo> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2200);
    const res = await fetch('/api/telemetry', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const pingMs = Math.max(1, Math.round(performance.now() - start));

    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      return {
        connected: true,
        popNameFa: typeof data.popNameFa === 'string' ? data.popNameFa : 'لبه آروان',
        popCode: typeof data.popCode === 'string' ? data.popCode : 'IR-THR',
        pingMs,
        source: 'arvan-edge',
      };
    }
  } catch {
    // Offline or static local dev server without /api/telemetry route
  }

  const localPing = Math.max(4, Math.min(28, Math.round(performance.now() - start) + 12));
  return {
    connected: true,
    popNameFa: 'تهران (حالت محلی)',
    popCode: 'LOCAL',
    pingMs: localPing,
    source: 'local',
  };
}

/**
 * Loads the Top-100 Leaderboard from ArvanCloud Edge Worker (/api/leaderboard)
 * with graceful fallback to localStorage.
 */
export async function fetchLeaderboard(): Promise<{
  entries: LeaderboardEntry[];
  source: 'arvan-edge' | 'local';
}> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2800);
    const res = await fetch('/api/leaderboard', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      if (Array.isArray(data.entries)) {
        return {
          entries: sortAndTrimTop100(data.entries),
          source: 'arvan-edge',
        };
      }
    }
  } catch {
    // Fall back to localStorage seamlessly
  }

  return {
    entries: readLocalLeaderboard(),
    source: 'local',
  };
}

/**
 * Submits a player's score to /api/leaderboard (ArvanCloud S3 Object Storage via Edge Worker)
 * with automatic validation and localStorage fallback when offline.
 */
export async function submitLeaderboardScore(
  payload: ScoreSubmissionPayload,
): Promise<{
  ok: boolean;
  reasonFa?: string;
  entries: LeaderboardEntry[];
  submittedId?: string;
  source: 'arvan-edge' | 'local';
}> {
  const check = validateLeaderboardSubmission(payload);
  if (!check.valid || !check.sanitized) {
    return {
      ok: false,
      reasonFa: check.reasonFa || 'اطلاعات نامعتبر است.',
      entries: readLocalLeaderboard(),
      source: 'local',
    };
  }

  saveCallsign(check.sanitized.callsign);

  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3200);
    const res = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(check.sanitized),
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (res.ok && Array.isArray(data.entries)) {
        writeLocalLeaderboard(data.entries);
        return {
          ok: true,
          entries: sortAndTrimTop100(data.entries),
          submittedId: typeof data.submittedId === 'string' ? data.submittedId : undefined,
          source: 'arvan-edge',
        };
      }
      if (res.status >= 400 && res.status < 500 && typeof data.errorFa === 'string') {
        return {
          ok: false,
          reasonFa: data.errorFa,
          entries: readLocalLeaderboard(),
          source: 'arvan-edge',
        };
      }
    }
  } catch {
    // Offline fallback below
  }

  const localEntries = readLocalLeaderboard();
  const newEntry: LeaderboardEntry = {
    id: `local-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    ...check.sanitized,
    timestamp: Date.now(),
  };
  const updated = sortAndTrimTop100([...localEntries, newEntry]);
  writeLocalLeaderboard(updated);
  return {
    ok: true,
    entries: updated,
    submittedId: newEntry.id,
    source: 'local',
  };
}
