# Crypto Capitalist: engagement roadmap

*2026-10-05. **[Claude]** = a code change Claude can make directly in `index.html`.*

## Summary

Fix the leaks before you send players in. Right now the game stops earning in a hidden tab, never tells new players to tap, hides managers on phones and can lose saves. Fix those and add anonymous measurement this week. Then launch once in the community built for this genre (r/incremental_games), and spend November adding depth for the channels that reward it.

## Step 0: Make it shareable (today)

Done: GitHub Pages is live and the README leads with https://saymirr.github.io/Crypto-Capitalist/. Use that exact URL everywhere, because the lowercase `/crypto-capitalist/` returns 404.

1. In the repo's **About** settings, set Website to the play URL, add a description ending "play money only", and add the topics `incremental-game`, `idle-game`, `browser-game`, `html5-game`.
2. **[Claude]** Add `og:*` and `twitter:card` tags, a 1200x630 screenshot and a favicon. Without them, Reddit and Discord show a bare URL.
3. Write a 2-3 sentence AI disclosure. r/incremental_games Rule 5 and itch.io require one. **[Claude]** Remove the `window.claude?.hot` lines (893-894) and call `start({})` directly.
4. **[Claude]** Add GoatCounter (free, no cookies) behind a `track()` helper that can't break the game. Set `allow_frame:true` so itch.io plays count, and skip loading it when Global Privacy Control or Do Not Track is on.
5. Join the r/incremental_games and galaxy.click Discords now. Accounts that only drop a link get removed.

## Step 1: Fix the first 10 minutes (this week)

1. **[Claude]** Call `offline()` on `visibilitychange` (line 873). Today a background tab earns nothing.
2. **[Claude]** Add a 3-step coach: "Tap to mine $1", "Buy a second faucet", "Hire Drip Bot ($1,000)". A player who never taps earns $0 forever.
3. **[Claude]** On phones, add a "Hire manager" chip in each row and a sticky Managers/Upgrades/Fork bar. Below 960 px wide, the managers panel sits under all 10 business rows.
4. **[Claude]** Show a "Fork ready: +X%" pill when the claimable Diamond Hands reach at least 25 + diamonds/2. The first fork worth taking comes at 1-1.5 h, which is exactly where the game's one pacing wall is.
5. **[Claude]** Add Export/Import save plus `navigator.storage.persist()`. Safari wipes storage after 7 days without a visit, and each portal keeps saves separately.
6. **[Claude]** Replace the 4.5 s offline toast with a "While you were away" screen.
7. **[Claude]** Send one-time events: `new@b1`, `ret-d1@b1`, `ret-d7@b1`, `f-mgr1`, `f-dh1`, `f-fork1`, plus session-length and away-time buckets. Keep a first-played date in the save and carry it through forks.
8. Fri Oct 9 or 16: post one comment in the r/incremental_games **Feedback Friday** thread with two pacing questions. Review 2-3 other games there, then fix the top complaints.

## Step 2: Launch (Oct 20-27)

1. **[Claude]** Add a share button, about 40 headlines that react to the player's progress (the 12 current ones repeat every 108 s), and WebAudio sound with a mute toggle.
2. Tue-Thu Oct 20-22, 9am-2pm ET: make the main **r/incremental_games** text post. First line: "Parody with play money only: no wallet, no tokens, no blockchain, nothing to buy." Include an "AI disclosure" section and reply to comments for 3 hours.
3. Same day: put up an **itch.io** HTML page with 10 tags, the GenAI field filled in, and the github.io link for reliable saves.
4. Around Oct 27: make a **r/WebGames** link post straight to github.io, with a title that starts with "Crypto Capitalist".

## Step 3: Keep players coming back (weeks 3-6)

1. **[Claude]** Add 30-40 achievements (+1% profit each) with a "Next goal" bar. They fill the 15-40 min stretch that has no unlocks.
2. **[Claude]** Add a daily market event picked from the date (one business earns ×3 that day). No streaks or penalties.
3. **[Claude]** If the data shows players dropping off at ASIC or Your Own Blockchain, halve those cycle times.
4. Post 2-3 YouTube Shorts a week (a timelapse to the first fork, a whale bull run) and repost them to TikTok and Reels.
5. Try a CrazyGames Basic Launch. Post on r/playmygame, presenting the game as a parody and leading with whale alerts and Diamond Hands.
6. After 30+ days and a real update: a second r/incremental_games post, then a galaxy.click submission.

## Step 4: Measure and iterate (ongoing)

1. Do a 20-minute review every Monday. Change one thing per build and bump the build tag (b1 to b2). With 50 new players, D1 carries about ±11 points of noise, so wait for about 100 before calling a change a win.
2. **[Claude]** Add a feedback button that opens a free Tally form with hidden game-state fields. Add a daily GitHub Action that archives traffic stats, since GitHub only keeps 14 days.

## Where to post

| Channel | Worth it? | Key rule | When |
|---|---|---|---|
| r/incremental_games | Yes, main channel (191k members) | 1 post about your own game per 30 days; "AI disclosure" section; Rule 8 bans games built on real-crypto trading | Oct 20-22 |
| Feedback Friday | Yes | One comment; review other games | Oct 9 or 16 |
| r/WebGames | Yes | Title starts with the game name; 3 months between reposts; 10 comment karma needed | ~Oct 27 |
| itch.io | Yes, but weak discovery | GenAI disclosure is mandatory | Oct 20-22 |
| r/playmygame | Maybe | Rule 6 bans clones and reskins | Nov |
| CrazyGames | Maybe | First tap within 10 s; clone check; rules don't mention crypto | Weeks 3-4 |
| galaxy.click | Later | Rejects heavy GenAI use, very short games and "contentious real-world topics"; ask staff about crypto first | After 30 days |
| Poki, Kongregate, r/CryptoCurrency, r/indiegames | No | Poki bans crypto; Kongregate takes no new games since 2020; r/CryptoCurrency bans promo links; r/indiegames bans GenAI posts | Never |

The Reddit rules come from ThreadFox snapshots (Sept 24-Oct 5) because Reddit blocked direct fetches, so re-read each sidebar before posting. The Discord self-promotion rules are unverified.

## Metrics to watch

The targets are starting guesses. Compare builds against each other.

| Metric | Formula | Target | What it tells you |
|---|---|---|---|
| First-manager rate | `f-mgr1` / `new` | 70%+ | If low, onboarding or the phone layout is the problem |
| D1 retention | `ret-d1` / `new` | Beat the last build | 39.4% was the 2020 top-25% for mobile idle games; browser games run lower |
| Prestige reach | `f-dh1`, `f-fork1` / `new` | Rising | A big gap between them is the 1-2 h wall |
| Offline returns | 1 − `away-nomgr` / all `away-*` | Rising | Whether players come back to collect, i.e. the idle loop works |
| Channel yield | `new` by `?ref=` | Compare channels | Where next month's time should go |

Ad blockers block GoatCounter, so trust the ratios more than the totals.

## Avoid

1. **Crypto bait.** Keep "earn", "free crypto", "airdrop", "token" and "wallet" out of titles. TikTok bans crypto branded content.
2. **Repeat posting.** Updates go in Feedback Friday comments, not new threads.
3. **Hiding AI use.** galaxy.click's owner says misreporting AI use is worse than disclosing it.
4. **Dark patterns.** No streaks, missed-day penalties or fake "double it" buttons.
5. **Portals before Export/Import.** Saves don't carry over between github.io, itch.io and CrazyGames.

## Sources

- https://threadfox.vip/rules/r/incremental_games
- https://reddit.sentinel-team.org/posts/1tk7n47/snapshots/2026-05-22T07%3A35%3A11.89636Z
- https://threadfox.vip/rules/r/WebGames
- https://threadfox.vip/rules/r/playmygame
- https://threadfox.vip/rules/r/indiegames
- https://threadfox.vip/rules/r/CryptoCurrency
- https://itch.io/docs/creators/html5
- https://www.pcgamesinsider.biz/news/74828/devs-need-to-disclose-if-game-uses-genai-on-itchio/
- https://galaxy.click/docs/verification
- https://docs.crazygames.com/requirements/intro/
- https://developers.poki.com/guide/requirements-quality
- https://www.wepc.com/news/web-game-platform-kongregate-no-longer-accepting-new-games/
- https://forkast.news/tiktok-bans-crypto-promotions-amid-fears-young-users/
- https://www.goatcounter.com/help/events
- https://easylist.to/easylist/easyprivacy.txt
- https://docs.github.com/en/rest/metrics/traffic
- https://tally.so/help/hidden-fields
- https://wnhub.io/news/marketing/item-3203
