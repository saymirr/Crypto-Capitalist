// End-to-end tests for the leaderboard Worker. No dependencies.
//
//   npm run dev        (in another terminal; serves http://127.0.0.1:8787)
//   npm test
//
// Target another server with LB_URL=https://… npm test — but note the tests write
// throwaway wallets into whatever database that server uses, so prefer local runs.

import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const BASE = (process.env.LB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ALLOWED_ORIGIN = 'https://saymirr.github.io';
const DISALLOWED_ORIGIN = 'https://evil.example';
const FOOTER = 'This signature only proves you own this wallet. It does not move funds or approve any transaction.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  const digits = [];
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
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]];
  return out;
}

/** A fresh ed25519 keypair standing in for a Solana wallet. */
function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'); // 32 raw bytes
  return { address: base58Encode(raw), privateKey };
}

function signText(wallet, text) {
  return sign(null, Buffer.from(text, 'utf8'), wallet.privateKey).toString('base64');
}

/** The exact message the game signs. Every field can be overridden as a raw string. */
function buildMessage(wallet, fields = {}) {
  const f = {
    wallet: wallet.address,
    lifetime: '1000000',
    diamonds: '0',
    forks: '0',
    issuedAt: new Date().toISOString(),
    ...fields,
  };
  return [
    'Crypto Capitalist leaderboard score',
    `Wallet: ${f.wallet}`,
    `Lifetime earnings: ${f.lifetime}`,
    `Diamond Hands: ${f.diamonds}`,
    `Hard forks: ${f.forks}`,
    `Issued at: ${f.issuedAt}`,
    FOOTER,
  ].join('\n');
}

/**
 * A random client address from the TEST-NET ranges. Local `wrangler dev` passes a client-sent
 * CF-Connecting-IP header through (Cloudflare's edge overwrites it in production), so each
 * request gets its own address and the per-network limit only bites in the test made for it.
 */
const randomIp = () => `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

async function request(method, path, { body, headers = {} } = {}) {
  headers = { 'CF-Connecting-IP': randomIp(), ...headers };
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { unparsed: text };
  }
  return { status: res.status, headers: res.headers, data };
}

/** Sign `message` with `wallet` and POST it (submitted wallet defaults to the signer). */
function submit(wallet, message, { as = wallet.address, signature, headers } = {}) {
  return request('POST', '/submit', {
    body: { wallet: as, message, signature: signature ?? signText(wallet, message) },
    headers,
  });
}

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

// Every small-order point of edwards25519 (canonical encodings, both signs of x), plus
// non-canonical encodings (y >= p, or x = 0 with the sign bit set). None of them is a real
// wallet key, and for each one the forged signature below "verifies" for some messages.
const FF30 = 'ff'.repeat(30);
const WEAK_KEYS = {
  'identity (order 1)': '01' + '00'.repeat(31),
  'all-zero bytes = System Program 1111…1111 (order 4)': '00'.repeat(32),
  'all-zero bytes with sign bit (order 4)': '00'.repeat(31) + '80',
  'y = p - 1 (order 2)': 'ec' + FF30 + '7f',
  'order 8 (a)': '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'order 8 (a) with sign bit': '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'order 8 (b)': 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'order 8 (b) with sign bit': 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  'non-canonical y = p': 'ed' + FF30 + '7f',
  'non-canonical y = p + 1': 'ee' + FF30 + '7f',
  'non-canonical identity (x = 0, sign bit set)': '01' + '00'.repeat(30) + '80',
};
/** R = identity point (0x01 then zeros), S = 0. */
const FORGED_SIGNATURE = Buffer.from(hexBytes('01' + '00'.repeat(63))).toString('base64');

const submitScore = (wallet, fields) => submit(wallet, buildMessage(wallet, fields));

class AssertionError extends Error {}
function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}
function expectStatus(res, status) {
  assert(res.status === status, `expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`);
}
function expectRejected(res, status) {
  assert(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status} ${JSON.stringify(res.data)}`);
  if (status) expectStatus(res, status);
  assert(res.data && res.data.ok === false, `expected ok:false, got ${JSON.stringify(res.data)}`);
  assert(typeof res.data.error === 'string' && res.data.error.length > 0, 'expected a human-readable error');
  assert((res.headers.get('content-type') || '').startsWith('application/json'), 'error must be JSON');
}
function expectEntry(entry, wallet, { allTime, diamonds, forks }) {
  assert(entry && entry.wallet === wallet.address, `entry wallet mismatch: ${JSON.stringify(entry)}`);
  assert(entry.allTime === allTime, `allTime ${entry.allTime} !== ${allTime}`);
  assert(entry.diamonds === diamonds, `diamonds ${entry.diamonds} !== ${diamonds}`);
  assert(entry.forks === forks, `forks ${entry.forks} !== ${forks}`);
  assert(Number.isInteger(entry.rank) && entry.rank >= 1, `bad rank ${entry.rank}`);
  assert(Number.isInteger(entry.updatedAt) && entry.updatedAt > 0, `bad updatedAt ${entry.updatedAt}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${err instanceof AssertionError ? err.message : err.stack || err}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Leaderboard e2e against ${BASE}\n`);
  try {
    await fetch(BASE + '/leaderboard');
  } catch (err) {
    console.error(`Cannot reach ${BASE} (${err.cause?.code || err.message}). Start it with "npm run dev".`);
    process.exit(2);
  }

  // Wallets A < B < C get scores just above the current #1, so they should become ranks 3, 2, 1
  // even on a database full of older test runs. Values above 1e21 also exercise the
  // exponent form, e.g. String(1.7e22) === "1.7e+22".
  const top = (await request('GET', '/leaderboard?limit=1')).data?.entries?.[0]?.allTime ?? 0;
  const base = Math.max(top, Math.floor(Date.now() / 1000) * 1e13);
  const takesTop = base * 1.003 <= 1e100; // otherwise only the relative order can be checked
  const scale = takesTop ? base : 1e95;
  const [walletA, walletB, walletC] = [newWallet(), newWallet(), newWallet()];
  const scoreA = { allTime: scale * 1.001, diamonds: 3, forks: 1 };
  const scoreB = { allTime: scale * 1.002, diamonds: 0, forks: 0 };
  const scoreC = { allTime: scale * 1.003, diamonds: 1000, forks: 7 };
  const fieldsOf = (s) => ({ lifetime: String(s.allTime), diamonds: String(s.diamonds), forks: String(s.forks) });

  // The "lower score" check needs THROTTLE_MS (20 s) between two submissions from one
  // wallet, so its first submission happens now and the second at the end of the run.
  const walletLow = newWallet();
  const lowFirst = { allTime: 5_000_000_000, diamonds: 10, forks: 2 };
  let lowFirstAt = 0;
  let lowFirstEntry = null;

  await test('GET /leaderboard returns {entries, total}', async () => {
    const res = await request('GET', '/leaderboard');
    expectStatus(res, 200);
    assert(Array.isArray(res.data.entries), 'entries must be an array');
    assert(Number.isInteger(res.data.total), 'total must be an integer');
    assert((res.headers.get('content-type') || '').startsWith('application/json'), 'Content-Type must be JSON');
    assert(/max-age=15|no-store/.test(res.headers.get('cache-control') || ''), 'Cache-Control missing');
  });

  await test('valid submit is accepted with a rank (exponent-form lifetime)', async () => {
    const res = await submitScore(walletA, fieldsOf(scoreA));
    expectStatus(res, 200);
    assert(String(scoreA.allTime).includes('e+'), `test value should be exponent form, got ${scoreA.allTime}`);
    assert(res.data.ok === true && res.data.improved === true, JSON.stringify(res.data));
    assert(Number.isInteger(res.data.rank) && res.data.rank >= 1, `rank ${res.data.rank}`);
    assert(Number.isInteger(res.data.total) && res.data.total >= 1, `total ${res.data.total}`);
    expectEntry(res.data.entry, walletA, scoreA);
    assert(res.data.entry.rank === res.data.rank, 'entry.rank must equal rank');
    assert(res.headers.get('cache-control') === 'no-store', 'submit must be Cache-Control: no-store');
  });

  await test('plain-digit lifetime is accepted', async () => {
    const res = await submitScore(walletLow, fieldsOf(lowFirst));
    lowFirstAt = Date.now();
    expectStatus(res, 200);
    assert(res.data.improved === true, JSON.stringify(res.data));
    expectEntry(res.data.entry, walletLow, lowFirst);
    lowFirstEntry = res.data.entry;
  });

  await test('leaderboard orders 3 wallets by lifetime earnings', async () => {
    expectStatus(await submitScore(walletB, fieldsOf(scoreB)), 200);
    const resC = await submitScore(walletC, fieldsOf(scoreC));
    expectStatus(resC, 200);

    const res = await request('GET', '/leaderboard?limit=100');
    expectStatus(res, 200);
    const { entries } = res.data;
    assert(entries.length <= 100, 'limit=100 must return at most 100 entries');
    for (let i = 0; i < entries.length; i++) {
      const higher = entries.filter((e) => e.allTime > entries[i].allTime).length;
      assert(entries[i].rank === higher + 1, `rank at index ${i} is ${entries[i].rank}, expected ${higher + 1}`);
      if (i > 0) assert(entries[i - 1].allTime >= entries[i].allTime, `not sorted at index ${i}`);
    }
    const pos = (w) => entries.findIndex((e) => e.wallet === w.address);
    const [a, b, c] = [pos(walletA), pos(walletB), pos(walletC)];
    assert(a >= 0 && b >= 0 && c >= 0, `all three wallets should be in the top 100 (positions ${a}, ${b}, ${c})`);
    assert(c < b && b < a, `expected C before B before A, got positions C=${c} B=${b} A=${a}`);
    expectEntry(entries[c], walletC, scoreC);
    assert(entries[c].rank < entries[b].rank && entries[b].rank < entries[a].rank, 'ranks must increase C<B<A');
    if (takesTop) {
      assert(c === 0 && b === 1 && a === 2, `expected C, B, A at the top, got positions ${c}, ${b}, ${a}`);
      assert(entries[c].rank === 1 && entries[b].rank === 2 && entries[a].rank === 3, 'expected ranks 1, 2, 3');
      assert(resC.data.rank === 1, `submit response rank for C should be 1, got ${resC.data.rank}`);
    }
    assert(res.data.total >= 4, `total ${res.data.total}`);
  });

  await test('limit is clamped to 1..100', async () => {
    const one = await request('GET', '/leaderboard?limit=1');
    expectStatus(one, 200);
    assert(one.data.entries.length === 1 && one.data.entries[0].rank === 1, JSON.stringify(one.data));
    const zero = await request('GET', '/leaderboard?limit=0');
    assert(zero.data.entries.length === 1, `limit=0 should clamp to 1, got ${zero.data.entries.length}`);
    const big = await request('GET', '/leaderboard?limit=100000');
    assert(big.data.entries.length <= 100, `limit=100000 should clamp to 100, got ${big.data.entries.length}`);
    const junk = await request('GET', '/leaderboard?limit=abc');
    expectStatus(junk, 200);
  });

  await test('immediate resubmit from the same wallet is throttled (429)', async () => {
    const wallet = newWallet();
    expectStatus(await submitScore(wallet, { lifetime: '2000' }), 200);
    const res = await submitScore(wallet, { lifetime: '3000' });
    expectRejected(res, 429);
    assert(Number(res.headers.get('retry-after')) >= 1, 'Retry-After header expected');
    const rank = await request('GET', `/rank?wallet=${wallet.address}`);
    assert(rank.data.entry.allTime === 2000, 'throttled submission must not change the score');
  });

  await test('tampered signature is rejected', async () => {
    const wallet = newWallet();
    const message = buildMessage(wallet);
    const sig = Buffer.from(signText(wallet, message), 'base64');
    sig[10] ^= 0x01;
    expectRejected(await submit(wallet, message, { signature: sig.toString('base64') }), 401);
    expectRejected(await submit(wallet, message, { signature: randomBytes(64).toString('base64') }), 401);
    expectRejected(await submit(wallet, message, { signature: 'not base64!' }), 400);
    expectRejected(await submit(wallet, message, { signature: randomBytes(32).toString('base64') }), 400);
    // A valid signature over a different message (e.g. a lower score) cannot be reused for this one.
    const other = buildMessage(wallet, { lifetime: '1' });
    expectRejected(await submit(wallet, message, { signature: signText(wallet, other) }), 401);
  });

  await test('small-order / non-canonical keys cannot post with a forged R = identity, S = 0 signature', async () => {
    for (const [label, hex] of Object.entries(WEAK_KEYS)) {
      const address = base58Encode(hexBytes(hex));
      const before = await request('GET', `/rank?wallet=${address}`);
      expectStatus(before, 200);
      // Different "Issued at" values give different hashes k; for a small-order key [k]A is
      // the identity for 1 in (order of A) of them, which is when the forgery would verify.
      for (let i = 0; i < 6; i++) {
        const message = buildMessage({ address }, {
          lifetime: '9.99e+99',
          issuedAt: new Date(Date.now() - i * 1000).toISOString(),
        });
        const res = await request('POST', '/submit', { body: { wallet: address, message, signature: FORGED_SIGNATURE } });
        assert(res.status === 400, `${label} (${address}) try ${i + 1}: expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
        expectRejected(res);
        assert(/cannot post|can sign/i.test(res.data.error), `${label}: unexpected error ${res.data.error}`);
      }
      const after = await request('GET', `/rank?wallet=${address}`);
      assert(JSON.stringify(after.data.entry) === JSON.stringify(before.data.entry), `${label}: stored row changed`);
    }
  });

  await test('signature from a different key is rejected', async () => {
    const owner = newWallet();
    const attacker = newWallet();
    const message = buildMessage(owner, { lifetime: '999999999' });
    expectRejected(await submit(owner, message, { signature: signText(attacker, message) }), 401);
    const rank = await request('GET', `/rank?wallet=${owner.address}`);
    assert(rank.data.rank === null, 'no row should be created for a forged submission');
  });

  await test('"Wallet:" line that does not match the submitted wallet is rejected', async () => {
    const signer = newWallet();
    const other = newWallet();
    // Message names `other` but is submitted as `signer` (and properly signed by signer).
    expectRejected(await submit(signer, buildMessage(signer, { wallet: other.address })), 400);
    // Message names `signer`, submitted as `other`.
    expectRejected(await submit(signer, buildMessage(signer), { as: other.address }), 400);
  });

  await test('malformed messages (missing/extra/reordered lines, CRLF, trailing newline) are rejected', async () => {
    const wallet = newWallet();
    const good = buildMessage(wallet);
    const lines = good.split('\n');
    const variants = {
      'extra line': [...lines.slice(0, 6), 'Bonus: 1', lines[6]].join('\n'),
      'missing line': [...lines.slice(0, 4), ...lines.slice(5)].join('\n'),
      'trailing newline': good + '\n',
      'CRLF line endings': lines.join('\r\n'),
      'swapped lines': [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'),
      'wrong title': ['Crypto Capitalist score', ...lines.slice(1)].join('\n'),
      'wrong footer': [...lines.slice(0, 6), 'Sign here.'].join('\n'),
      'wrong prefix case': [lines[0], lines[1].replace('Wallet:', 'wallet:'), ...lines.slice(2)].join('\n'),
      'extra space': [lines[0], lines[1], lines[2].replace(': ', ':  '), ...lines.slice(3)].join('\n'),
      'empty message': '',
    };
    for (const [label, message] of Object.entries(variants)) {
      const res = await submit(wallet, message);
      assert(res.status === 400, `${label}: expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
      expectRejected(res);
    }
    const missingFields = await request('POST', '/submit', { body: { wallet: wallet.address } });
    expectRejected(missingFields, 400);
    const notJson = await request('POST', '/submit', { body: '{"wallet":' });
    expectRejected(notJson, 400);
    const array = await request('POST', '/submit', { body: '[]' });
    expectRejected(array, 400);
  });

  await test('stale "Issued at" (11 minutes old) is rejected', async () => {
    const wallet = newWallet();
    const issuedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    expectRejected(await submitScore(wallet, { issuedAt }), 400);
  });

  await test('future "Issued at" (5 minutes ahead) is rejected', async () => {
    const wallet = newWallet();
    const issuedAt = new Date(Date.now() + 5 * 60_000).toISOString();
    expectRejected(await submitScore(wallet, { issuedAt }), 400);
  });

  await test('non-ISO "Issued at" is rejected', async () => {
    const wallet = newWallet();
    expectRejected(await submitScore(wallet, { issuedAt: String(Date.now()) }), 400);
    expectRejected(await submitScore(wallet, { issuedAt: new Date().toUTCString() }), 400);
  });

  await test('slightly old (9 min) and slightly future (1 min) "Issued at" are accepted', async () => {
    const old = newWallet();
    expectStatus(await submitScore(old, { issuedAt: new Date(Date.now() - 9 * 60_000).toISOString() }), 200);
    const ahead = newWallet();
    expectStatus(await submitScore(ahead, { issuedAt: new Date(Date.now() + 60_000).toISOString() }), 200);
  });

  await test('Diamond Hands inconsistent with lifetime earnings is rejected', async () => {
    // floor(150 * sqrt(1e12 / 1e12)) = 150, so 151 is impossible and 150 is the maximum.
    expectRejected(await submitScore(newWallet(), { lifetime: '1000000000000', diamonds: '151' }), 400);
    expectRejected(await submitScore(newWallet(), { lifetime: '0', diamonds: '1' }), 400);
    expectStatus(await submitScore(newWallet(), { lifetime: '1000000000000', diamonds: '150' }), 200);
  });

  await test('Diamond Hands check allows the fraction of a dollar lost to Math.floor', async () => {
    // The first Diamond Hand arrives at 1e12 / 22500 = 44,444,444.44…; a save forked at
    // 44,444,444.6 signs "44444444" with 1 Diamond Hand and must be accepted.
    expectStatus(await submitScore(newWallet(), { lifetime: '44444444', diamonds: '1' }), 200);
    // …but the slack is under $1: one dollar lower is still impossible.
    expectRejected(await submitScore(newWallet(), { lifetime: '44444443', diamonds: '1' }), 400);
  });

  await test('negative, NaN, fractional and huge numbers are rejected', async () => {
    const wallet = newWallet();
    const cases = [
      { lifetime: '-5' },
      { lifetime: 'NaN' },
      { lifetime: 'Infinity' },
      { lifetime: '' },
      { lifetime: '1.5' },
      { lifetime: '0x10' },
      { lifetime: '1e+101' },
      { lifetime: '1'.padEnd(102, '0') }, // 1e101 written out in digits
      { lifetime: '1e-7' },
      { diamonds: '-1' },
      { diamonds: '1.5' },
      { diamonds: 'NaN' },
      { forks: '-1' },
      { forks: '1000000001' },
      { forks: '1e3' },
      { forks: '01' },
      // valid numbers, but not the one spelling String() gives them
      { lifetime: '1e+5' },
      { lifetime: '5.0' },
      { lifetime: '1.50e+25' },
      { lifetime: '12.34e+24' },
      { lifetime: '1.234e+025' },
      { lifetime: '1234567890123456789012345' }, // String() of that value is 1.2345678901234568e+24
    ];
    for (const fields of cases) {
      const res = await submitScore(wallet, fields);
      assert(res.status === 400, `${JSON.stringify(fields)}: expected 400, got ${res.status} ${JSON.stringify(res.data)}`);
      expectRejected(res);
    }
  });

  await test('non-base58 or wrong-length wallet is rejected', async () => {
    const wallet = newWallet();
    const message = buildMessage(wallet);
    const signature = signText(wallet, message);
    const bad = [
      wallet.address.slice(0, -1) + '0', // '0' is not in the base58 alphabet
      wallet.address.slice(0, -1) + 'l', // nor is 'l'
      'O' + wallet.address.slice(1),     // nor is 'O'
      base58Encode(randomBytes(31)),     // decodes to 31 bytes
      base58Encode(randomBytes(33)),     // decodes to 33 bytes
      '',
    ];
    for (const as of bad) {
      const res = await request('POST', '/submit', { body: { wallet: as, message, signature } });
      assert(res.status === 400, `wallet ${JSON.stringify(as)}: expected 400, got ${res.status}`);
      expectRejected(res);
    }
    expectRejected(await request('GET', `/rank?wallet=${encodeURIComponent('0OIl' + wallet.address.slice(4))}`), 400);
    expectRejected(await request('GET', '/rank'), 400);
  });

  await test('body larger than 2 KB is rejected (413)', async () => {
    const wallet = newWallet();
    const message = buildMessage(wallet);
    const body = JSON.stringify({ wallet: wallet.address, message, signature: signText(wallet, message), pad: 'x'.repeat(2100) });
    assert(Buffer.byteLength(body) > 2048, 'test body should exceed 2048 bytes');
    expectRejected(await request('POST', '/submit', { body }), 413);
    // A stream without Content-Length must also be capped.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const res = await fetch(BASE + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    });
    assert(res.status === 413, `streamed body: expected 413, got ${res.status}`);
  });

  await test('POST /submit without Content-Type application/json is rejected (415)', async () => {
    const wallet = newWallet();
    const message = buildMessage(wallet);
    const body = JSON.stringify({ wallet: wallet.address, message, signature: signText(wallet, message) });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const res = await fetch(BASE + '/submit', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': randomIp(), ...(type ? { 'Content-Type': type } : {}) },
        body: type ? body : new Blob([body]), // a Blob without a type sends no Content-Type
      });
      const data = await res.json();
      assert(res.status === 415, `${type}: expected 415, got ${res.status} ${JSON.stringify(data)}`);
      assert(data.ok === false && /application\/json/.test(data.error), JSON.stringify(data));
    }
    const rank = await request('GET', `/rank?wallet=${wallet.address}`);
    assert(rank.data.rank === null, 'a refused submission must not create a row');
    // Parameters such as charset are fine.
    const ok = await request('POST', '/submit', { body, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expectStatus(ok, 200);
  });

  await test('GET /rank for a known wallet', async () => {
    const res = await request('GET', `/rank?wallet=${walletC.address}`);
    expectStatus(res, 200);
    expectEntry(res.data.entry, walletC, scoreC);
    assert(res.data.rank === res.data.entry.rank, 'rank must equal entry.rank');
    assert(Number.isInteger(res.data.total) && res.data.total >= 3, `total ${res.data.total}`);
    const resA = await request('GET', `/rank?wallet=${walletA.address}`);
    assert(resA.data.rank > res.data.rank, 'A must rank below C');
    assert(res.headers.get('cache-control') === 'no-store', 'rank must be Cache-Control: no-store');
  });

  await test('GET /rank for an unknown wallet returns nulls', async () => {
    const res = await request('GET', `/rank?wallet=${newWallet().address}`);
    expectStatus(res, 200);
    assert(res.data.rank === null && res.data.entry === null, JSON.stringify(res.data));
    assert(Number.isInteger(res.data.total), `total ${res.data.total}`);
  });

  await test('real Solana addresses (incl. leading "1"s) are accepted by /rank', async () => {
    for (const address of ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']) {
      const res = await request('GET', `/rank?wallet=${address}`);
      expectStatus(res, 200);
    }
  });

  await test('tied scores share a rank (1 + number of strictly higher wallets)', async () => {
    const [t1, t2, after] = [newWallet(), newWallet(), newWallet()];
    const tied = String(scale * 1.0005); // between A and the previous #1, unique to this run
    const lower = String(scale * 1.0004);
    const r1 = await submitScore(t1, { lifetime: tied });
    const r2 = await submitScore(t2, { lifetime: tied });
    const r3 = await submitScore(after, { lifetime: lower });
    for (const r of [r1, r2, r3]) expectStatus(r, 200);
    const [k1, k2] = await Promise.all([t1, t2].map((w) => request('GET', `/rank?wallet=${w.address}`)));
    assert(k1.data.rank === k2.data.rank, `tied wallets have ranks ${k1.data.rank} and ${k2.data.rank}`);
    const k3 = await request('GET', `/rank?wallet=${after.address}`);
    assert(k3.data.rank === k1.data.rank + 2, `next wallet should be rank ${k1.data.rank + 2}, got ${k3.data.rank}`);
  });

  await test('CORS: allowed origin is echoed', async () => {
    const res = await request('GET', '/leaderboard?limit=1', { headers: { Origin: ALLOWED_ORIGIN } });
    expectStatus(res, 200);
    assert(res.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
      `ACAO was ${res.headers.get('access-control-allow-origin')}`);
    assert(/origin/i.test(res.headers.get('vary') || ''), 'Vary: Origin expected');
    const err = await request('GET', '/nope', { headers: { Origin: ALLOWED_ORIGIN } });
    assert(err.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'errors must carry CORS headers too');
  });

  await test('CORS: disallowed origin gets no Access-Control-Allow-Origin', async () => {
    const res = await request('GET', '/leaderboard?limit=1', { headers: { Origin: DISALLOWED_ORIGIN } });
    assert(res.headers.get('access-control-allow-origin') === null,
      `ACAO was ${res.headers.get('access-control-allow-origin')}`);
    const pre = await request('OPTIONS', '/submit', {
      headers: { Origin: DISALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert(pre.headers.get('access-control-allow-origin') === null, 'preflight must not allow a foreign origin');
  });

  await test('CORS: OPTIONS preflight returns 204 with methods, headers and max-age', async () => {
    const res = await request('OPTIONS', '/submit', {
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expectStatus(res, 204);
    assert(res.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'ACAO missing');
    const methods = res.headers.get('access-control-allow-methods') || '';
    for (const m of ['GET', 'POST', 'OPTIONS']) assert(methods.includes(m), `Allow-Methods missing ${m}`);
    assert(/content-type/i.test(res.headers.get('access-control-allow-headers') || ''), 'Allow-Headers missing');
    assert(res.headers.get('access-control-max-age') === '86400', 'Max-Age should be 86400');
  });

  await test('unknown route → 404, wrong method → 405', async () => {
    expectRejected(await request('GET', '/does-not-exist'), 404);
    expectRejected(await request('POST', '/leaderboard', { body: {} }), 405);
    const res = await request('GET', '/submit');
    expectRejected(res, 405);
    assert((res.headers.get('allow') || '').includes('POST'), 'Allow header expected on 405');
    expectRejected(await request('DELETE', '/rank'), 405);
  });

  await test('total is a stored wallet count: +1 for a new wallet, unchanged for a known one', async () => {
    const t0 = (await request('GET', '/leaderboard?limit=1')).data.total;
    const wallet = newWallet();
    const first = await submitScore(wallet, { lifetime: '12345' });
    expectStatus(first, 200);
    assert(first.data.total === t0 + 1, `total after a new wallet: ${first.data.total}, expected ${t0 + 1}`);
    const board = await request('GET', '/leaderboard?limit=1', { headers: { 'Cache-Control': 'no-cache' } });
    assert(board.data.total === t0 + 1, `GET /leaderboard total ${board.data.total}, expected ${t0 + 1}`);
    const rank = await request('GET', `/rank?wallet=${wallet.address}`);
    assert(rank.data.total === t0 + 1, `GET /rank total ${rank.data.total}, expected ${t0 + 1}`);
    // Rejected submissions (throttled, forged) don't count.
    expectRejected(await submitScore(wallet, { lifetime: '99999' }), 429);
    expectRejected(await submit(newWallet(), buildMessage(newWallet())), 400);
    const again = await request('GET', `/rank?wallet=${wallet.address}`);
    assert(again.data.total === t0 + 1, `total moved to ${again.data.total} after rejected submissions`);
  });

  await test('per-network limit: 30 signed submissions per IP (IPv6: per /64) per hour, then 429', async () => {
    const r = () => (1 + Math.floor(Math.random() * 0xfffe)).toString(16);
    const prefix = `2001:db8:${r()}:${r()}`; // a random /64 in the IPv6 documentation range
    const from = (ip) => ({ headers: { 'CF-Connecting-IP': ip } });
    // 30 different fresh wallets from addresses inside one /64 are all accepted…
    for (let i = 0; i < 30; i++) {
      const wallet = newWallet();
      const res = await submit(wallet, buildMessage(wallet, { lifetime: '1000' }), from(`${prefix}:${r()}:${r()}:${r()}:${r()}`));
      assert(res.status === 200, `submission ${i + 1} from the /64: expected 200, got ${res.status} ${JSON.stringify(res.data)}`);
    }
    // …the 31st is refused, even from another address in the same /64 (written in compressed form)…
    const late = newWallet();
    const refused = await submit(late, buildMessage(late, { lifetime: '1000' }), from(`${prefix}::1`));
    expectRejected(refused, 429);
    assert(/network/i.test(refused.data.error), `unexpected error ${refused.data.error}`);
    const retry = Number(refused.headers.get('retry-after'));
    assert(retry > 3000 && retry <= 3600, `Retry-After should be about an hour, got ${retry}`);
    assert((await request('GET', `/rank?wallet=${late.address}`)).data.rank === null, 'refused score must not be stored');
    // …while another /64, and an IPv4 client, are unaffected.
    const other = newWallet();
    expectStatus(await submit(other, buildMessage(other, { lifetime: '1000' }), from(`2001:db8:${r()}:${r()}::1`)), 200);
    expectStatus(await submit(late, buildMessage(late, { lifetime: '1000' }), from(randomIp())), 200);
  });

  await test('lower score → improved:false and the stored row is unchanged', async () => {
    assert(lowFirstEntry, 'first submission for this wallet failed earlier');
    const wait = lowFirstAt + 21_000 - Date.now();
    if (wait > 0) {
      console.log(`      (waiting ${Math.ceil(wait / 1000)} s for the per-wallet throttle window)`);
      await sleep(wait);
    }
    const totalBefore = (await request('GET', `/rank?wallet=${walletLow.address}`)).data.total;
    const res = await submitScore(walletLow, { lifetime: '1000', diamonds: '0', forks: '0' });
    expectStatus(res, 200);
    assert(res.data.ok === true && res.data.improved === false, JSON.stringify(res.data));
    assert(res.data.total === totalBefore, `a known wallet must not change total (${totalBefore} → ${res.data.total})`);
    assert(Number.isInteger(res.data.rank), 'rank must still be returned');
    expectEntry(res.data.entry, walletLow, lowFirst);
    assert(res.data.entry.updatedAt === lowFirstEntry.updatedAt, 'updatedAt must not change');
    const rank = await request('GET', `/rank?wallet=${walletLow.address}`);
    expectEntry(rank.data.entry, walletLow, lowFirst);
    // A non-improving submission still counts as accepted, so the throttle applies again.
    expectRejected(await submitScore(walletLow, { lifetime: '6000000000' }), 429);
  });

  // ---------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.name).join('; ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
