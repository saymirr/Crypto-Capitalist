# Crypto Capitalist

**[▶ Play in your browser](https://saymirr.github.io/Crypto-Capitalist/)**

An idle tycoon game in the style of AdVenture Capitalist, set in the crypto world. Start with one Satoshi Faucet and build up to running your own blockchain.

Play money only. There are no tokens, nothing to buy and no real exchanges. Connecting a Solana wallet is optional and only puts your score on the global leaderboard: you sign a plain text message, which moves no funds and approves no transaction.

## Play

Play it at **https://saymirr.github.io/Crypto-Capitalist/**. It works on desktop and phone and needs no install or sign-up. Progress saves in your browser's local storage.

To run it offline, download `index.html` and open it in any modern browser. Everything is in that one file, so there's no build step or server.

## How it works

- **Businesses:** ten of them, from Satoshi Faucet to Your Own Blockchain. Tap a tile to run one cycle and collect its profit.
- **Milestones:** owning 25, 50, 100, 200, 300 and 400 of a business doubles its speed each time. Past 400, every extra 100 doubles its profit.
- **Managers:** each one runs a business automatically, and keeps it earning while the page is closed.
- **Upgrades:** each one triples the profit of one business or of all of them.
- **Whale alerts:** a button appears at random and gives you either a 2× bull run or a cash tip.
- **Hard fork:** resets your progress in exchange for Diamond Hands. Each one adds 2% to all profits permanently.
- **Leaderboard:** optionally connect a Solana wallet (Phantom, Solflare, Backpack and other standard wallets) to put your lifetime earnings on the global top 50. Scores are self-reported: the signature proves who owns the wallet, not how the score was earned.

The leaderboard backend is a small Cloudflare Worker with a D1 database in [`leaderboard/`](leaderboard/). Its README covers local development and deployment.

The background is a night-time crypto city. A tower lights up for each business you own.
