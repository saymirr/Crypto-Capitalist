# Crypto Capitalist leaderboard

The optional global leaderboard for [Crypto Capitalist](https://saymirr.github.io/Crypto-Capitalist/). It's a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a [D1](https://developers.cloudflare.com/d1/) (SQLite) database, and both run on Cloudflare's free plan.

## What it does

Players who want a spot on the board connect a Solana wallet in the game. The game then asks the wallet to **sign a plain-text message** that contains the player's score. This Worker checks that signature against the wallet address, so a score can only be posted under a wallet by whoever controls that wallet.

The wallet is only used to prove who the player is:

- no transactions, no funds and no tokens are involved;
- the game never sees or asks for a seed phrase or private key;
- the signed message itself says it doesn't move funds or approve anything.

The board keeps one row per wallet: that wallet's best lifetime earnings, with its Diamond Hands and hard fork count.

> **Scores are self-reported.** A valid signature proves wallet ownership, not that the score was earned fairly. Someone who edits their save file can still sign a fake score. The Worker rejects impossible combinations (for example, more Diamond Hands than the lifetime earnings would give) and rate-limits each wallet and each network, but it can't stop cheating. Treat the board as just for fun.

Wallet addresses are public, so they're shown on the leaderboard as they are.

## API

All responses are JSON. Errors look like `{"ok": false, "error": "<reason>"}`.

| Request | Response |
| --- | --- |
| `GET /leaderboard?limit=N` (default 50, clamped to 1–100) | `{"entries": [{"rank", "wallet", "allTime", "diamonds", "forks", "updatedAt"}], "total": <wallets>}` |
| `GET /rank?wallet=<address>` | `{"rank": <int or null>, "entry": <entry or null>, "total": <int>}` |
| `POST /submit` with `{"wallet", "message", "signature"}` and `Content-Type: application/json` | `{"ok": true, "improved": <bool>, "rank", "entry", "total"}`, or a 4xx error |

`signature` is the base64 of the wallet's 64-byte ed25519 signature over the exact UTF-8 bytes of `message`. The message has exactly these 7 lines, joined with `\n` and with no trailing newline:

```text
Crypto Capitalist leaderboard score
Wallet: <base58 wallet address>
Lifetime earnings: <String(Math.floor(allTime)), e.g. 123456 or 1.234e+25>
Diamond Hands: <integer>
Hard forks: <integer>
Issued at: <new Date().toISOString()>
This signature only proves you own this wallet. It does not move funds or approve any transaction.
```

A submission is rejected if any of these checks fail:

- **Size and format:** the body is JSON sent as `Content-Type: application/json` (anything else gets HTTP 415), it's at most 2 KB, and every line matches the format exactly.
- **Wallet:** the wallet is a valid base58 address of 32 bytes, and it's the same address as on the `Wallet:` line. It must also be a key that can actually sign: small-order and non-canonical ed25519 keys are refused (for those, a forged "identity" signature would verify, so anyone could post as, say, `11111111111111111111111111111111`), and so are off-curve program addresses.
- **Numbers:** lifetime earnings are a whole number from 0 to 1e100, written exactly as JavaScript's `String()` writes it (`123456` or `1.234e+25`, but not `1e+5` or `5.0`). Diamond Hands and hard forks are whole numbers from 0 to 1e9.
- **Diamond Hands:** the count is no more than `floor(150 × sqrt((lifetime + 1) / 1e12))`. That's the game's own formula; the `+ 1` covers the fraction of a dollar that `Math.floor` drops from the signed lifetime, so a save that forked just past a Diamond Hands threshold isn't turned away.
- **Issued at:** it's no more than 10 minutes old and no more than 2 minutes in the future.
- **Signature:** it verifies against the wallet address.
- **Rate limits:** each wallet gets one accepted submission every 20 seconds, and each network (one IPv4 address, or one IPv6 /64) gets 30 validly signed submissions an hour, so minting fresh wallets can't use up the database's free daily quota. Over a limit, the Worker returns HTTP 429 with a `Retry-After` header.

A lower score is accepted but doesn't replace the wallet's best. In that case the response has `improved: false` and the wallet's current rank.

Rank is 1 plus the number of wallets with higher lifetime earnings, so tied wallets share a rank.

Browsers may only call the API from the origins listed in `ALLOWED_ORIGINS` (CORS).

## Files

| File | Purpose |
| --- | --- |
| `src/index.js` | The Worker. It has no dependencies. |
| `schema.sql` | Database tables: `scores`, the two rate-limit tables and a small `meta` table that holds the wallet count. Safe to run more than once, so run it again after updating the Worker. |
| `wrangler.toml` | Worker name, D1 binding and allowed origins. |
| `.dev.vars.example` | Local-only settings. Copy it to `.dev.vars`. |
| `test/e2e.mjs` | End-to-end tests against a running Worker. |

## Run it locally

You need [Node.js](https://nodejs.org/) 22 or newer, which current Wrangler requires. No Cloudflare account is needed for local development.

```sh
cd leaderboard
npm install
cp .dev.vars.example .dev.vars   # lets http://127.0.0.1:5500 and http://localhost:5500 call the API
npm run db:local                 # creates the tables in a local SQLite file under .wrangler/
npm run dev                      # API on http://127.0.0.1:8787
```

In a second terminal, run the end-to-end tests:

```sh
npm test
```

They take about 25 seconds, because one test waits out the 20-second rate limit. Each run adds about 50 throwaway wallets to the local database. The tests send a made-up `CF-Connecting-IP` header with each request; local `wrangler dev` passes it through, while Cloudflare's edge replaces it with the real client address.

To try the game against the local API:

1. Serve the repo from its root with `python -m http.server 5500 --bind 127.0.0.1`.
2. In `index.html`, temporarily set `const LEADERBOARD_API = 'http://127.0.0.1:8787';`.
3. Open http://127.0.0.1:5500/.

To start the local database over, delete the `.wrangler/` folder and run `npm run db:local` again. After pulling a newer version of the Worker, run `npm run db:local` (and `npm run db:remote` for the live database) once more; it only adds what's missing.

## Deploy

Deploying needs a free Cloudflare account. Run these from the `leaderboard/` folder:

1. Sign in to Cloudflare. This opens a browser window.

   ```sh
   npx wrangler login
   ```

2. Create the database:

   ```sh
   npx wrangler d1 create crypto-capitalist-leaderboard
   ```

   Copy the `database_id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_DATABASE_ID`.

3. Create the tables in the new database:

   ```sh
   npm run db:remote
   ```

4. Deploy the Worker:

   ```sh
   npm run deploy
   ```

   It prints a URL like `https://crypto-capitalist-leaderboard.<your-subdomain>.workers.dev`. Opening that URL in a browser should show `{"ok":true,"service":"Crypto Capitalist leaderboard",…}`.

5. Copy that URL into `index.html` at the top of the game script, with no trailing slash:

   ```js
   const LEADERBOARD_API = 'https://crypto-capitalist-leaderboard.<your-subdomain>.workers.dev';
   ```

   Then commit and push so GitHub Pages serves the updated game.

If the game is served from somewhere other than `https://saymirr.github.io`, such as a custom domain, add that origin to `ALLOWED_ORIGINS` in `wrangler.toml`. Separate origins with commas and leave off trailing slashes. Then run `npm run deploy` again.

To clear the live leaderboard:

```sh
npx wrangler d1 execute crypto-capitalist-leaderboard --remote --command "DELETE FROM scores; DELETE FROM submit_throttle; DELETE FROM ip_throttle; UPDATE meta SET value = 0 WHERE key = 'wallets';"
```

## Free-tier limits

These are Cloudflare's free-plan limits at the time of writing. Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for current numbers.

- **Workers:** 100,000 requests a day, and 10 ms of CPU time per request. This Worker uses well under 10 ms.
- **D1:** 5 million rows read a day, 100,000 rows written a day, and 5 GB of storage.

How the Worker keeps D1 use down:

- `total` is a stored count (the `meta` table), updated when a new wallet is stored, so no request counts the whole table.
- A leaderboard request reads one row per entry returned (50 for the game) plus one. The response may be cached by the browser for 15 seconds, and the game refreshes it at most once a minute while its Ranks tab is open.
- A rank lookup reads one row per wallet ranked above that wallet. The game asks for its own rank only when it isn't in the top 50, and then at most every 5 minutes (a submission returns the rank directly).
- An accepted submission writes about four rows (both rate limits, the score and its index), and the per-network limit caps how many submissions one network can make.

If you delete score rows by hand, re-sync the count with `UPDATE meta SET value = (SELECT COUNT(*) FROM scores) WHERE key = 'wallets';`.

Privacy: the per-network limit stores only a SHA-256 hash of the client's IP address (IPv6: its /64 prefix) with a counter, and the Worker deletes those rows once their one-hour window has passed.

If a free limit is reached, requests fail until the daily reset. Nothing is billed unless you move to a paid plan.
