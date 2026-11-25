/**
 * ArvanCloud Edge Computing Worker — «شکارچی آسمان»
 * Zero-dependency Web Fetch API worker for:
 *   - GET  /api/telemetry   : Returns connected ArvanCloud Edge PoP & GeoIP info
 *   - GET  /api/leaderboard : Reads Top-100 leaderboard.json from ArvanCloud S3 Object Storage
 *   - POST /api/leaderboard : Anti-cheat validated score submission stored in S3 (Top 100)
 *
 * Required Environment Variables (configure in ArvanCloud Edge Worker Secrets):
 *   S3_ENDPOINT   (e.g. https://s3.ir-thr-at1.arvanstorage.ir)
 *   S3_BUCKET     (e.g. sky-hunter-leaderboard)
 *   S3_ACCESS_KEY
 *   S3_SECRET_KEY
 */

const LEADERBOARD_OBJECT_KEY = 'leaderboard.json';
const MAX_LEADERBOARD_ENTRIES = 100;
const MAX_BODY_BYTES = 2048;
const VALID_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
const VALID_MODES = new Map([
  ['jet', 'jet'],
  ['جنگنده', 'jet'],
  ['tank', 'tank'],
  ['تانک', 'tank'],
]);

const POP_NAMES_FA = {
  THR: 'تهران',
  'IR-THR': 'تهران',
  MHD: 'مشهد',
  IFN: 'اصفهان',
  SYZ: 'شیراز',
  TBZ: 'تبریز',
  AWZ: 'اهواز',
  FRA: 'فرانکفورت',
  AMS: 'آمستردام',
  DXB: 'دبی',
  IST: 'استانبول',
  LON: 'لندن',
  SIN: 'سنگاپور',
};

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(hash);
}

async function hmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function getEnv(env, key) {
  if (env && typeof env[key] === 'string' && env[key].trim()) return env[key].trim();
  if (typeof globalThis !== 'undefined' && typeof globalThis[key] === 'string') {
    return globalThis[key].trim();
  }
  return '';
}

const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function buildS3Target(env) {
  const endpointRaw = getEnv(env, 'S3_ENDPOINT');
  const bucket = getEnv(env, 'S3_BUCKET');
  const accessKey = getEnv(env, 'S3_ACCESS_KEY');
  const secretKey = getEnv(env, 'S3_SECRET_KEY');
  if (!endpointRaw || !bucket || !accessKey || !secretKey) {
    return null;
  }
  if (!S3_BUCKET_RE.test(bucket)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(endpointRaw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }

  const host = parsed.host;
  const canonicalUri = `/${encodeURIComponent(bucket)}/${LEADERBOARD_OBJECT_KEY}`;
  const url = `${parsed.origin}${canonicalUri}`;
  // Extract region from Arvan endpoint if present, otherwise standard S3 default
  const regionMatch = parsed.hostname.match(/s3\.([a-z0-9-]+)\.arvanstorage/i);
  const region = regionMatch ? regionMatch[1] : 'us-east-1';

  return { url, host, canonicalUri, region, accessKey, secretKey };
}

/**
 * Signs and executes an S3-compatible REST request (GET or PUT) using AWS SigV4.
 */
async function s3SignedFetch(env, method, bodyText = '') {
  const cfg = buildS3Target(env);
  if (!cfg) {
    return { configured: false, response: null };
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(bodyText);

  const canonicalHeaders =
    `host:${cfg.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    cfg.canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(cfg.secretKey, dateStamp, cfg.region, 's3');
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Host: cfg.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
  };
  if (method === 'PUT') {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  const response = await fetch(cfg.url, {
    method,
    headers,
    body: method === 'PUT' ? bodyText : undefined,
  });

  return { configured: true, response };
}

function jsonResponse(data, status = 200, requestOrigin = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (requestOrigin) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function validateScoreSubmission(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, errorFa: 'ساختار درخواست نامعتبر است.' };
  }

  const rawCallsign = typeof body.callsign === 'string' ? body.callsign : '';
  const callsign = rawCallsign
    .replace(/[<>"'`\\\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);

  if (callsign.length < 2) {
    return { valid: false, errorFa: 'نام خلبان باید حداقل ۲ کاراکتر باشد.' };
  }

  const score = Math.floor(Number(body.score));
  const wave = Math.floor(Number(body.wave));
  const kills = Math.floor(Number(body.kills));
  const survivalTimeSec = Math.floor(Number(body.survivalTimeSec));
  const difficulty = VALID_DIFFICULTIES.has(body.difficulty) ? body.difficulty : 'normal';
  const rawMode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
  const mode = VALID_MODES.get(rawMode) || 'jet';

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
    return { valid: false, errorFa: 'مقادیر امتیاز نامعتبر است.' };
  }

  // Server-side anti-cheat plausibility verification
  if (score > 0 && survivalTimeSec < 3) {
    return { valid: false, errorFa: 'زمان عملیات برای ثبت امتیاز کافی نیست.' };
  }
  if (wave > 1 && survivalTimeSec < (wave - 1) * 8) {
    return { valid: false, errorFa: 'تطابق موج و مدت عملیات معتبر نیست.' };
  }
  const maxPlausibleScore = wave * 6500 + kills * 1200 + 2500;
  const maxScoreByTime = Math.max(3500, survivalTimeSec * 145);
  if (score > maxPlausibleScore || score > maxScoreByTime) {
    return { valid: false, errorFa: 'امتیاز ارسال‌شده از سقف مجاز عملیات فراتر است.' };
  }

  return {
    valid: true,
    entry: {
      id: `edge-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      callsign,
      score,
      wave,
      kills,
      survivalTimeSec,
      difficulty,
      mode,
      timestamp: Date.now(),
    },
  };
}

function sortAndTrimTop100(entries) {
  return entries
    .filter((e) => e && typeof e.callsign === 'string' && Number.isFinite(Number(e.score)))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.wave !== a.wave) return b.wave - a.wave;
      return (a.timestamp || 0) - (b.timestamp || 0);
    })
    .slice(0, MAX_LEADERBOARD_ENTRIES);
}

async function readLeaderboardFromS3(env) {
  const result = await s3SignedFetch(env, 'GET');
  if (!result.configured || !result.response) {
    return { configured: false, entries: [] };
  }
  if (result.response.status === 404) {
    return { configured: true, entries: [] };
  }
  if (!result.response.ok) {
    throw new Error(`S3 GET failed with HTTP ${result.response.status}`);
  }
  const parsed = await result.response.json();
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.entries)
    ? parsed.entries
    : [];
  return { configured: true, entries: sortAndTrimTop100(entries) };
}

function handleTelemetry(request, origin) {
  const h = request.headers;
  const rawPop = (
    h.get('ar-edge-pop') ||
    h.get('x-arvan-pop') ||
    h.get('x-ar-pop') ||
    h.get('x-edge-location') ||
    'IR-THR'
  )
    .toUpperCase()
    .slice(0, 16);

  const country = (
    h.get('ar-geo-country') ||
    h.get('x-arvan-country') ||
    h.get('cf-ipcountry') ||
    'IR'
  )
    .toUpperCase()
    .slice(0, 8);

  const popKey = rawPop.split('-')[0];
  const popNameFa = POP_NAMES_FA[rawPop] || POP_NAMES_FA[popKey] || `گره ${rawPop}`;

  return jsonResponse(
    {
      connected: true,
      provider: 'ArvanCloud Edge',
      popCode: rawPop,
      popNameFa,
      country,
      timestamp: Date.now(),
    },
    200,
    origin,
  );
}

function resolveAllowedOrigin(request, requestUrl, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (origin === requestUrl.origin) return origin;
  const configured = getEnv(env, 'ALLOWED_ORIGIN');
  if (configured) {
    const allowedList = configured.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowedList.includes(origin)) return origin;
  }
  return null;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = resolveAllowedOrigin(request, url, env);

  if (request.method === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    return new Response(null, { status: 204, headers });
  }

  if (url.pathname === '/api/telemetry' && request.method === 'GET') {
    return handleTelemetry(request, origin);
  }

  if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
    try {
      const { configured, entries } = await readLeaderboardFromS3(env);
      if (!configured) {
        return jsonResponse(
          {
            errorFa: 'تنظیمات فضای ابری S3 روی لبه آروان تکمیل نشده است.',
            entries: [],
          },
          503,
          origin,
        );
      }
      return jsonResponse({ entries, total: entries.length }, 200, origin);
    } catch {
      return jsonResponse({ errorFa: 'خطا در خواندن جدول امتیازات از فضای ابری.' }, 502, origin);
    }
  }

  if (url.pathname === '/api/leaderboard' && request.method === 'POST') {
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return jsonResponse({ errorFa: 'حجم درخواست بیش از حد مجاز است.' }, 413, origin);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ errorFa: 'فرمت JSON درخواست معتبر نیست.' }, 400, origin);
    }

    const check = validateScoreSubmission(payload);
    if (!check.valid) {
      return jsonResponse({ errorFa: check.errorFa }, 422, origin);
    }

    try {
      const { configured, entries } = await readLeaderboardFromS3(env);
      if (!configured) {
        return jsonResponse(
          { errorFa: 'تنظیمات فضای ابری S3 روی لبه آروان تکمیل نشده است.' },
          503,
          origin,
        );
      }

      const updated = sortAndTrimTop100([...entries, check.entry]);
      const serialized = JSON.stringify({
        updatedAt: Date.now(),
        entries: updated,
      });

      const putRes = await s3SignedFetch(env, 'PUT', serialized);
      if (!putRes.response || !putRes.response.ok) {
        return jsonResponse({ errorFa: 'خطا در ذخیره‌سازی رکورد در فضای ابری.' }, 502, origin);
      }

      return jsonResponse(
        {
          ok: true,
          submittedId: check.entry.id,
          entries: updated,
        },
        201,
        origin,
      );
    } catch {
      return jsonResponse({ errorFa: 'خطا در ارتباط با فضای ابری آروان.' }, 502, origin);
    }
  }

  // Pass non-API static asset requests through to origin
  return fetch(request);
}

// Module Worker syntax (ArvanCloud Edge / Standard Fetch Handler)
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

// Compatibility fallback for Service Worker style edge runtimes
if (typeof addEventListener === 'function') {
  addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}
