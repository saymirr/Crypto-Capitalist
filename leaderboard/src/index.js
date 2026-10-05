/**
 * Crypto Capitalist — global leaderboard (Cloudflare Worker + D1).
 *
 * Players may optionally connect a Solana wallet. The wallet is used ONLY to prove
 * identity: the game asks it to sign a short plain-text message containing the
 * player's score, and this Worker checks the ed25519 signature against the wallet's
 * public key (a Solana address is the base58 encoding of that 32-byte key).
 * No transactions, no funds, no tokens are ever involved.
 *
 * Routes
 *   GET  /leaderboard?limit=N   top N wallets (default 50, clamped to 1..100)
 *   GET  /rank?wallet=<base58>  one wallet's rank and entry (null if unknown)
 *   POST /submit                {wallet, message, signature} → store best score
 *   OPTIONS *                   CORS preflight
 *
 * Every response is JSON. Errors look like {"ok":false,"error":"<reason>"}.
 * This file has no dependencies; it only uses Web APIs available in Workers.
 */

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 2048;               // POST /submit body size cap
const THROTTLE_MS = 20_000;                // min gap between accepted submissions per wallet
const IP_WINDOW_MS = 60 * 60_000;          // per-network limit: at most IP_MAX_SUBMITS validly signed
const IP_MAX_SUBMITS = 30;                 // submissions per IP address (IPv6: per /64) per hour
const MAX_SIGNATURE_AGE_MS = 10 * 60_000;  // "Issued at" may be at most 10 minutes old…
const MAX_CLOCK_SKEW_MS = 2 * 60_000;      // …and at most 2 minutes in the future
const MAX_LIFETIME = 1e100;                // upper bound for lifetime earnings
const MAX_COUNTER = 1e9;                   // upper bound for Diamond Hands and hard forks
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_ALLOWED_ORIGINS = 'https://saymirr.github.io';

// The signed message, line by line. Lines are joined with "\n", no trailing newline.
const MESSAGE_TITLE = 'Crypto Capitalist leaderboard score';
const MESSAGE_FOOTER =
  'This signature only proves you own this wallet. It does not move funds or approve any transaction.';
const MESSAGE_PREFIXES = {
  wallet: 'Wallet: ',
  lifetime: 'Lifetime earnings: ',
  diamonds: 'Diamond Hands: ',
  forks: 'Hard forks: ',
  issuedAt: 'Issued at: ',
};
const MESSAGE_LINE_COUNT = 7;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    try {
      if (request.method === 'OPTIONS') return preflight(cors);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const route = ROUTES[path];
      if (!route) throw new HttpError(404, `Not found: ${path}`);
      if (request.method !== route.method) {
        throw new HttpError(405, `Method ${request.method} not allowed on ${path}; use ${route.method}.`, {
          Allow: `${route.method}, OPTIONS`,
        });
      }
      return await route.handler({ request, env, ctx, url, cors });
    } catch (err) {
      return errorResponse(err, cors);
    }
  },
};

const ROUTES = {
  '/': { method: 'GET', handler: handleIndex },
  '/leaderboard': { method: 'GET', handler: handleLeaderboard },
  '/rank': { method: 'GET', handler: handleRank },
  '/submit': { method: 'POST', handler: handleSubmit },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET / — tiny self-description, handy for checking a deploy in the browser. */
async function handleIndex({ cors }) {
  return json(
    {
      ok: true,
      service: 'Crypto Capitalist leaderboard',
      endpoints: ['GET /leaderboard?limit=N', 'GET /rank?wallet=<address>', 'POST /submit'],
    },
    200,
    cors,
  );
}

/** GET /leaderboard?limit=N — top wallets by lifetime earnings. */
async function handleLeaderboard({ env, url, cors }) {
  const limit = parseLimit(url.searchParams.get('limit'));
  const [top, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT wallet, all_time, diamonds, forks, updated_at
         FROM scores
        ORDER BY all_time DESC, updated_at ASC, wallet ASC
        LIMIT ?1`,
    ).bind(limit),
    totalStatement(env),
  ]);

  // Competition ranking ("1, 2, 2, 4"): rank = 1 + number of wallets with a higher score.
  // The list starts at the very top, so a row that is not tied with the row above it
  // has exactly `index` strictly-higher rows before it.
  const entries = [];
  top.results.forEach((row, index) => {
    const previous = entries[index - 1];
    const rank = previous && previous.allTime === row.all_time ? previous.rank : index + 1;
    entries.push(toEntry(row, rank));
  });

  return json({ entries, total: await totalFrom(env, count) }, 200, cors, {
    'Cache-Control': 'public, max-age=15',
  });
}

/** GET /rank?wallet=<base58> — one wallet's standing. */
async function handleRank({ env, url, cors }) {
  const wallet = url.searchParams.get('wallet') ?? '';
  parseWallet(wallet);
  const standing = await getStanding(env, wallet);
  return json(standing, 200, cors);
}

/** POST /submit — verify a signed score and keep it if it beats the wallet's best. */
async function handleSubmit({ request, env, ctx, cors }) {
  // 1. Only JSON is accepted (this also keeps "simple" cross-site form posts out), size-capped.
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
  const text = await readBodyText(request, MAX_BODY_BYTES);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  const { wallet, message, signature } = body;
  for (const [name, value] of Object.entries({ wallet, message, signature })) {
    if (typeof value !== 'string' || value === '') {
      throw new HttpError(400, `"${name}" must be a non-empty string.`);
    }
  }

  // 2. Validate every input before touching crypto or the database.
  const publicKey = parseWallet(wallet);
  if (!isSigningKey(publicKey)) {
    // Small-order or non-canonical keys would let anyone "sign" for them (e.g. R = identity, S = 0),
    // and off-curve addresses (program-derived) have no private key at all.
    throw new HttpError(400, 'This address is not a wallet that can sign messages, so it cannot post scores.');
  }
  const score = parseMessage(message, wallet, Date.now());
  const signatureBytes = decodeSignature(signature);

  // 3. The signature must be the wallet's ed25519 signature over the exact message bytes.
  const signedBytes = new TextEncoder().encode(message);
  if (!(await verifyEd25519(publicKey, signatureBytes, signedBytes))) {
    throw new HttpError(401, 'Signature verification failed: it was not made by this wallet for this exact message.');
  }

  // 4. Per-network throttle, so that minting fresh wallets can't burn through the database's
  //    free daily quota. Same race-free claim pattern as the per-wallet throttle below.
  const now = Date.now();
  const ipKey = await ipBucketHash(request.headers.get('CF-Connecting-IP') || 'unknown');
  const ipClaim = await env.DB.prepare(
    `INSERT INTO ip_throttle (ip_hash, window_start, hits) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash) DO UPDATE SET
       window_start = CASE WHEN ip_throttle.window_start <= ?3 THEN excluded.window_start ELSE ip_throttle.window_start END,
       hits = CASE WHEN ip_throttle.window_start <= ?3 THEN 1 ELSE ip_throttle.hits + 1 END
      WHERE ip_throttle.window_start <= ?3 OR ip_throttle.hits < ?4`,
  )
    .bind(ipKey, now, now - IP_WINDOW_MS, IP_MAX_SUBMITS)
    .run();
  if (ipClaim.meta.changes === 0) {
    const start = await env.DB.prepare('SELECT window_start FROM ip_throttle WHERE ip_hash = ?1')
      .bind(ipKey)
      .first('window_start');
    const waitSeconds = Math.max(1, Math.ceil(((start ?? now) + IP_WINDOW_MS - now) / 1000));
    throw new HttpError(
      429,
      `Too many score submissions from this network. Try again in ${Math.ceil(waitSeconds / 60)} min.`,
      { 'Retry-After': String(waitSeconds) },
    );
  }
  // Expired per-network rows are cleaned up now and then, off the response path.
  if (ctx && typeof ctx.waitUntil === 'function' && Math.random() < 0.02) {
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM ip_throttle WHERE window_start <= ?1')
        .bind(now - IP_WINDOW_MS)
        .run()
        .catch(() => {}),
    );
  }

  // 5. Per-wallet throttle. This upsert only writes when the previous accepted submission
  //    is at least THROTTLE_MS old, so it is a race-free "claim" (changes = 0 → throttled).
  const claim = await env.DB.prepare(
    `INSERT INTO submit_throttle (wallet, last_submit_at) VALUES (?1, ?2)
     ON CONFLICT(wallet) DO UPDATE SET last_submit_at = excluded.last_submit_at
      WHERE submit_throttle.last_submit_at <= ?3`,
  )
    .bind(wallet, now, now - THROTTLE_MS)
    .run();
  if (claim.meta.changes === 0) {
    const last = await env.DB.prepare('SELECT last_submit_at FROM submit_throttle WHERE wallet = ?1')
      .bind(wallet)
      .first('last_submit_at');
    const waitSeconds = Math.max(1, Math.ceil(((last ?? now) + THROTTLE_MS - now) / 1000));
    throw new HttpError(429, `Too many submissions for this wallet. Try again in ${waitSeconds} s.`, {
      'Retry-After': String(waitSeconds),
    });
  }

  // 6. Keep only the best score: the row is written only when the new lifetime is strictly higher.
  //    The batch is one transaction, so a brand-new wallet bumps the stored wallet count exactly
  //    once (this keeps COUNT(*) scans off every request).
  const [, upsert] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE meta SET value = value + 1
        WHERE key = 'wallets' AND NOT EXISTS (SELECT 1 FROM scores WHERE wallet = ?1)`,
    ).bind(wallet),
    env.DB.prepare(
      `INSERT INTO scores (wallet, all_time, diamonds, forks, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(wallet) DO UPDATE SET
         all_time = excluded.all_time,
         diamonds = excluded.diamonds,
         forks = excluded.forks,
         updated_at = excluded.updated_at
        WHERE excluded.all_time > scores.all_time`,
    ).bind(wallet, score.lifetime, score.diamonds, score.forks, now),
  ]);
  const improved = upsert.meta.changes > 0;

  const standing = await getStanding(env, wallet);
  return json({ ok: true, improved, ...standing }, 200, cors);
}

// ---------------------------------------------------------------------------
// Database helpers (prepared statements only)
// ---------------------------------------------------------------------------

/** {rank, entry, total} for one wallet; rank and entry are null if it has no score. */
async function getStanding(env, wallet) {
  // The "higher" count walks idx_scores_all_time over the wallets ranked above this one only
  // (zero rows when the wallet has no score); the total comes from the stored count.
  const [row, higher, count] = await env.DB.batch([
    env.DB.prepare('SELECT wallet, all_time, diamonds, forks, updated_at FROM scores WHERE wallet = ?1').bind(wallet),
    env.DB.prepare(
      'SELECT COUNT(*) AS higher FROM scores WHERE all_time > (SELECT all_time FROM scores WHERE wallet = ?1)',
    ).bind(wallet),
    totalStatement(env),
  ]);
  const total = await totalFrom(env, count);
  const found = row.results[0];
  if (!found) return { rank: null, entry: null, total };
  const rank = 1 + higher.results[0].higher;
  return { rank, entry: toEntry(found, rank), total };
}

/** Number of wallets on the board, kept in `meta` so requests don't run COUNT(*) over every row. */
function totalStatement(env) {
  return env.DB.prepare("SELECT value AS total FROM meta WHERE key = 'wallets'");
}

/** Total from a totalStatement() result; recounts once if the stored value is missing. */
async function totalFrom(env, result) {
  const stored = result.results[0];
  if (stored && Number.isInteger(stored.total)) return stored.total;
  await env.DB.prepare(
    `INSERT INTO meta (key, value) SELECT 'wallets', COUNT(*) FROM scores
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  return (await totalStatement(env).first('total')) ?? 0;
}

/** Database row → API entry. */
function toEntry(row, rank) {
  return {
    rank,
    wallet: row.wallet,
    allTime: row.all_time,
    diamonds: row.diamonds,
    forks: row.forks,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Input parsing and validation
// ---------------------------------------------------------------------------

/** ?limit= → integer in 1..MAX_LIMIT (anything unparseable → DEFAULT_LIMIT). */
function parseLimit(raw) {
  if (raw === null || raw.trim() === '') return DEFAULT_LIMIT;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** A Solana address must be canonical base58 that decodes to exactly 32 bytes. Returns the bytes. */
function parseWallet(wallet) {
  const bytes = typeof wallet === 'string' && wallet.length >= 32 && wallet.length <= 44 ? base58Decode(wallet) : null;
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== wallet) {
    throw new HttpError(400, 'Wallet must be a base58 Solana address (32-byte public key).');
  }
  return bytes;
}

/**
 * Strictly parse the signed message. Expected format (7 lines, "\n"-separated):
 *
 *   Crypto Capitalist leaderboard score
 *   Wallet: <base58 wallet>
 *   Lifetime earnings: <String(Math.floor(allTime)), e.g. 123456 or 1.234e+25>
 *   Diamond Hands: <integer>
 *   Hard forks: <integer>
 *   Issued at: <Date.prototype.toISOString()>
 *   This signature only proves you own this wallet. It does not move funds or approve any transaction.
 */
function parseMessage(message, wallet, now) {
  const lines = message.split('\n');
  if (lines.length !== MESSAGE_LINE_COUNT) {
    throw new HttpError(400, `Message must have exactly ${MESSAGE_LINE_COUNT} lines (got ${lines.length}).`);
  }
  if (lines[0] !== MESSAGE_TITLE) throw new HttpError(400, `Message line 1 must be "${MESSAGE_TITLE}".`);
  if (lines[6] !== MESSAGE_FOOTER) throw new HttpError(400, 'Message line 7 must be the standard notice.');

  const walletText = lineValue(lines, 1, MESSAGE_PREFIXES.wallet);
  const lifetimeText = lineValue(lines, 2, MESSAGE_PREFIXES.lifetime);
  const diamondsText = lineValue(lines, 3, MESSAGE_PREFIXES.diamonds);
  const forksText = lineValue(lines, 4, MESSAGE_PREFIXES.forks);
  const issuedText = lineValue(lines, 5, MESSAGE_PREFIXES.issuedAt);

  if (walletText !== wallet) throw new HttpError(400, 'The "Wallet:" line does not match the submitted wallet.');

  const lifetime = parseLifetime(lifetimeText);
  const diamonds = parseCounter(diamondsText, 'Diamond Hands');
  const forks = parseCounter(forksText, 'Hard forks');

  // Same formula the game uses to award Diamond Hands, so a real save always passes. The game
  // awards them from its unrounded lifetime but signs Math.floor() of it, so allow that last
  // fraction of a dollar (+1): a save forked just past a threshold must not be turned away.
  const maxDiamonds = Math.floor(150 * Math.sqrt((lifetime + 1) / 1e12));
  if (diamonds > maxDiamonds) {
    throw new HttpError(
      400,
      `Diamond Hands (${diamonds}) is more than lifetime earnings allow (at most ${maxDiamonds}).`,
    );
  }

  const issuedAt = parseIssuedAt(issuedText);
  if (now - issuedAt > MAX_SIGNATURE_AGE_MS) {
    throw new HttpError(400, 'Signed message is too old (issued more than 10 minutes ago). Please sign again.');
  }
  if (issuedAt - now > MAX_CLOCK_SKEW_MS) {
    throw new HttpError(400, 'Signed message is dated in the future. Check your device clock and sign again.');
  }

  return { lifetime, diamonds, forks, issuedAt };
}

/** Value after an exact prefix on line `index` (0-based), or a 400 naming the expected prefix. */
function lineValue(lines, index, prefix) {
  const line = lines[index];
  if (!line.startsWith(prefix)) {
    throw new HttpError(400, `Message line ${index + 1} must start with "${prefix}".`);
  }
  return line.slice(prefix.length);
}

/** String(Math.floor(x)) of a non-negative number: plain digits, or exponent form like 1.234e+25. */
const LIFETIME_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e\+\d{1,3})?$/;

function parseLifetime(text) {
  const value = Number(text);
  if (text.length > 40 || !LIFETIME_PATTERN.test(text) || !Number.isFinite(value)) {
    throw new HttpError(400, 'Lifetime earnings must be a non-negative finite number.');
  }
  if (!Number.isInteger(value)) throw new HttpError(400, 'Lifetime earnings must be a whole number.');
  if (value > MAX_LIFETIME) throw new HttpError(400, 'Lifetime earnings are larger than 1e100.');
  // Exactly one spelling per value, the one String() gives (so "1e+5", "5.0" or "1.50e+25" are refused).
  if (String(value) !== text) {
    throw new HttpError(400, `Lifetime earnings must be written as the game writes them (${String(value)}).`);
  }
  return value;
}

const COUNTER_PATTERN = /^(?:0|[1-9]\d{0,9})$/;

function parseCounter(text, name) {
  const value = Number(text);
  if (!COUNTER_PATTERN.test(text) || value > MAX_COUNTER) {
    throw new HttpError(400, `${name} must be a whole number from 0 to ${MAX_COUNTER}.`);
  }
  return value;
}

/** Must be exactly what Date.prototype.toISOString() produces, e.g. 2026-10-05T12:34:56.789Z. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseIssuedAt(text) {
  const time = ISO_PATTERN.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new HttpError(400, 'Issued at must be an ISO timestamp like 2026-10-05T12:34:56.789Z.');
  }
  return time;
}

/** Standard base64 (padding optional) of exactly 64 bytes → Uint8Array. */
function decodeSignature(signature) {
  if (/^[A-Za-z0-9+/]{86}(?:==)?$/.test(signature)) {
    const padded = signature.length === 86 ? `${signature}==` : signature;
    const binary = atob(padded);
    if (binary.length === 64) return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  throw new HttpError(400, 'Signature must be base64 of a 64-byte ed25519 signature.');
}

/** Read the request body as UTF-8 text, refusing anything larger than maxBytes. */
async function readBodyText(request, maxBytes) {
  const tooLarge = () => new HttpError(413, `Request body must be at most ${maxBytes} bytes.`);
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > maxBytes) throw tooLarge();
  if (!request.body) return '';

  // Stream the body so a missing or wrong Content-Length cannot make us buffer more than the cap.
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'Request body must be UTF-8 JSON.');
  }
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification (WebCrypto)
// ---------------------------------------------------------------------------

// Standard WebCrypto name first; older Workers runtimes only know the NODE-ED25519 alias.
const ED25519_ALGORITHMS = [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }];

/** true if `signature` is a valid ed25519 signature of `data` by the 32-byte `publicKey`. */
async function verifyEd25519(publicKey, signature, data) {
  let importError;
  for (const algorithm of ED25519_ALGORITHMS) {
    let key;
    try {
      key = await crypto.subtle.importKey('raw', publicKey, algorithm, false, ['verify']);
    } catch (err) {
      importError = err; // unsupported algorithm name, or bytes that are not a valid key
      continue;
    }
    try {
      return await crypto.subtle.verify(algorithm, key, signature, data);
    } catch {
      return false;
    }
  }
  // A key the runtime understands but rejects is simply "not a valid signer".
  if (importError && importError.name === 'DataError') return false;
  throw new Error(`Ed25519 is not available in this runtime: ${importError}`);
}

// Curve25519 field and twisted Edwards constants (RFC 8032, section 5.1).
const P = 2n ** 255n - 19n;
const CURVE_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

const mod = (a) => ((a % P) + P) % P;
function powMod(base, exp) {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}

/**
 * true if the 32 bytes are the canonical encoding of a curve point that is NOT of small order.
 *
 * WebCrypto's ed25519 verify (cofactorless, RFC 8032) accepts any decodable key. With a
 * small-order key A, [k]A is the identity for a predictable share of messages, so the forged
 * signature R = identity, S = 0 "verifies" for addresses nobody owns (e.g. the System Program,
 * 11111111111111111111111111111111). Real wallet keys are never small-order, so refuse them,
 * along with non-canonical encodings (y >= p, or x = 0 with the sign bit set) and off-curve bytes.
 */
function isSigningKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  // Decode (RFC 8032, 5.1.3): little-endian y with the top bit holding the sign of x.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const sign = bytes[31] >> 7;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(CURVE_D * y2 + 1n);
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * powMod(u * v7, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return false; // not on the curve
    x = (x * SQRT_M1) % P;
  }
  if (x === 0n && sign === 1) return false;
  if (Number(x & 1n) !== sign) x = P - x;

  // Small order means [8]A is the identity: double three times in projective coordinates
  // (a = -1, dbl-2008-hwcd) and compare with (0 : 1 : 1).
  let X = x;
  let Y = y;
  let Z = 1n;
  for (let i = 0; i < 3; i++) {
    const A = (X * X) % P;
    const B = (Y * Y) % P;
    const C = (2n * Z * Z) % P;
    const H = mod(-A - B);            // D - B with D = a·A = -A
    const E = mod((X + Y) * (X + Y) - A - B);
    const G = mod(B - A);             // D + B
    const F = mod(G - C);
    X = (E * F) % P;
    Y = (G * H) % P;
    Z = (F * G) % P;
  }
  return !(X === 0n && Y === Z);
}

// ---------------------------------------------------------------------------
// Per-network throttle key
// ---------------------------------------------------------------------------

/**
 * SHA-256 (hex) of the client's address bucket: the full IPv4 address, or the /64 prefix of
 * an IPv6 address (one home or phone usually gets a whole /64). Only the hash is stored, and
 * rows are dropped once their one-hour window has passed.
 */
async function ipBucketHash(ip) {
  const text = String(ip).trim().toLowerCase();
  let bucket = text;
  const mapped = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (text.includes(':') && mapped && /^[0:]*:ffff:/.test(text)) {
    bucket = mapped[1]; // IPv4-mapped IPv6 (::ffff:1.2.3.4)
  } else if (text.includes(':')) {
    const [head, tail] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    bucket = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`crypto-capitalist:${bucket}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Base58 (Bitcoin/Solana alphabet)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, i) => [char, i]));

/** base58 string → Uint8Array, or null if it contains a character outside the alphabet. */
function base58Decode(text) {
  const bytes = []; // little-endian accumulator
  for (const char of text) {
    let carry = BASE58_INDEX.get(char);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" encodes one leading zero byte.
  for (const char of text) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Uint8Array → base58 string. */
function base58Encode(bytes) {
  const digits = []; // little-endian base-58 digits
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let text = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    text += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) text += BASE58_ALPHABET[digits[i]];
  return text;
}

// ---------------------------------------------------------------------------
// HTTP helpers: CORS, JSON responses, errors
// ---------------------------------------------------------------------------

/** An error that becomes a {"ok":false,"error":message} response with the given status. */
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Allowed origins from env.ALLOWED_ORIGINS (comma-separated); "*" allows any origin. */
function allowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS;
  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

/** CORS headers for this request. Disallowed (or missing) origins get no Access-Control-Allow-Origin. */
function corsHeaders(request, env) {
  const headers = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  if (origin && (allowed.has(origin) || allowed.has('*'))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  return headers;
}

function preflight(cors) {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function json(data, status, cors, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
      ...extraHeaders,
    },
  });
}

function errorResponse(err, cors) {
  if (err instanceof HttpError) {
    return json({ ok: false, error: err.message }, err.status, cors, err.headers);
  }
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  const missingTable = /no such table/i.test(String(err && err.message));
  const message = missingTable
    ? 'Leaderboard database is not initialised yet (apply schema.sql).'
    : 'Internal server error.';
  return json({ ok: false, error: message }, 500, cors);
}
