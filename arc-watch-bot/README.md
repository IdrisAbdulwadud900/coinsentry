# arc-watch-bot

> **The name is now too narrow.** This is a chain-agnostic launch watcher: every
> chain-specific value (RPC, explorer, factories, quote assets, block timing) is
> configuration. It ships presets for two chains — Arc (`.env.example`) and
> Robinhood Chain (`.env.robinhood.example`) — and Arc is currently the one that
> *doesn't* work, because Circle shut public access. Renaming the directory is
> pending.

## Chain support

| | Arc | Robinhood Chain |
|---|---|---|
| Status | **blocked** — public access gated | **working**, verified live 2026-07-31 |
| Discovery source | Blockscout logs API (RPC rejects `eth_getLogs`) | RPC `eth_getLogs` (Blockscout free tier rate-limits far too hard) |
| Quote asset | native USDC, 6dp | WETH 18dp (+ USDG 6dp) |
| Block time | 505ms | 101ms |
| Launch rate | n/a | **~18,700/day** |

Telegram alert bot for new token and pool launches on **Arc mainnet** (Circle's L1, chain ID 5042). Discovery is fully on-chain — Arc has no DexScreener/DEXTools coverage yet, which is the entire point: this bot sees launches nothing else reports.

## What it watches

Factory contracts discovered by scanning the whole chain on 2026-07-30:

| Factory | Kind | Behavior |
|---|---|---|
| `0xdfef2f90f7e52609cc89b80b68ff6a1c86c4ddc4` | launchpad | `PairCreated` where pair == token: the token contract embeds its own bonding curve |
| `0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10` | amm-v2 | Classic UniswapV2-style factory, separate pair contract |
| `0xf0db7b58379503491d857db50ac9ece64c653918` | amm-v3 | Verified `UniswapV3Factory` |

Every pool quotes against native USDC (`0x3600…0000`, 6 decimals — the gas token's ERC-20 interface).

## Pipeline

1. Poll Blockscout's logs API for `PairCreated`/`PoolCreated` since the persisted block cursor (chunked under the 1000-record response cap; capped chunks are re-scanned in sub-chunks).
2. Enrich each new token on-chain: name/symbol/decimals via `eth_call`, USDC liquidity via `balanceOf(pool)`, deployer via the launch tx, verified status via Blockscout.
3. Gate: skip non-USDC quotes, unknown or sub-floor liquidity ($1000 default), and serial deployers (>10 launches).
4. Alert to a Telegram channel (HTML, with Blockscout links).

Alerting is gated on **block age relative to the chain head** (`ALERT_RECENCY_BLOCKS`, ~1h), not on whether it's the process's first scan. Anything older is recorded but stays silent. This is what makes the three awkward cases behave: a fresh install backfilling months of history alerts on none of it, a redeploy that was down 30 minutes still alerts on the launches it missed, and a reopening after a multi-week outage absorbs the backlog quietly while alerting on genuinely new launches in the same scan.

Cursor semantics match the pons bot: the cursor only advances after every launch in the range is durably inserted, and inserts are idempotent, so a crashed cycle re-scans safely.

## Run

```bash
cp .env.example .env   # set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID to go live
npm install
npm run scan           # single scan, then exit
npm run dev            # continuous watch loop
```

`DRY_RUN_ALERTS=true` (the default) logs alerts instead of sending them.

## Deploy (Fly.io)

```bash
fly launch --no-deploy   # accept fly.toml, create the arc_watch_data volume
fly secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
fly deploy
```

Note: deploy health-check timeouts observed from this machine are a local network artifact — verify via `fly ssh console` / `fly status` / `fly logs` instead of trusting the local CLI result.

## Status: blocked on data access (as of 2026-07-30)

**Circle closed public read access to Arc mainnet partway through building this.** Earlier the same day, all three sources were open and a live scan of blocks 12,880,000–12,903,154 returned 1,407 real launches. Hours later:

| Endpoint | Was | Now |
|---|---|---|
| `arc-mainnet.cloud.blockscout.com` | 200, full logs API | 404 at every path, route removed |
| `rpc.blockdaemon.mainnet.arc.io` | 200, `eth_call` worked | 401 Authorization Required |
| `explorer.arc.io` | — | 302 → Circle's Cloudflare Access SSO |
| `5042.rpc.thirdweb.com` | 500s on everything | unchanged |

This is server-side, not a local network problem: `eth.blockscout.com` returns 200 from the same machine, DNS resolves normally, and the rejections are clean HTTP 401/404 from the origins rather than connection failures.

The bot is complete and was proven against live data, but **cannot scan until access returns** — either when Circle opens mainnet officially (targeted summer 2026) or via partner RPC credentials.

So deploy it now and leave it running: the built-in access watchdog is the thing that tells you the window reopened, which is the starting gun for everything else on this chain.

## Access watchdog

The bot is access-aware rather than merely crash-resistant:

- **While closed** it idles on `ACCESS_PROBE_INTERVAL_SECONDS` (default 300s), running only a cheap two-request probe. A gated host may stay shut for weeks; hammering it every 15s would be pointless and abusive.
- **When access returns** it sends a 🟢 alert listing which endpoints answered and the current chain head, then resumes scanning automatically in the same tick — no restart, no intervention.
- **If access drops again** it sends a 🔴 alert naming the failing endpoint and role (RPC vs logs, since one host can serve both), pauses scanning, and falls back to probing.
- **State is persisted**, so a bot restarted mid-outage stays quiet and a flapping chain doesn't produce duplicate notifications. Only genuine transitions alert; the first observation ever is recorded silently.
- **While open** there is no probe overhead at all — a probe runs only after a cycle fails, to determine whether the failure means access closed.

Both transition paths are verified end to end against real endpoints.

## Quality gates

Alerting is a **two-stage pipeline**, because the signals that matter don't exist
at discovery time — the buys they measure happen in the blocks *after* the pool
is created.

1. **Discover** (`discover`) — find launches, enrich them, apply the cheap gates
   (recognised quote asset, liquidity floor, deployer reputation, recency).
   Survivors are stored as *pending*, not alerted.
2. **Assess** (`processPending`) — once `QUALITY_WINDOW_BLOCKS` have elapsed since
   launch, read the token's own `Transfer` events and derive:
   - **Bundle concentration** — share of supply taken by the top 5 early buyers,
     counting only transfers *out of the pool* (real DEX buys, excluding
     wallet-to-wallet moves and the LP mint). Blocked above `BUNDLE_MAX_TOP5_PCT`
     (default 60%, matching `pons-revival-bot`'s hard rule).
   - **Sell evidence** — whether anything went back *into* the pool. Buyers with
     zero sells is the classic honeypot shape, only counted once at least
     `HONEYPOT_MIN_BUYERS` wallets have bought.

An unavailable reading blocks the alert rather than passing it.

### Measured effect (Robinhood Chain, 2026-07-31)

A 6,000-block window produced 114 launches; 3 cleared a 0.5 WETH floor; the
quality pass alerted **1**:

| Token | Liquidity | Verdict |
|---|---|---|
| Nascat | 8.27 WETH | blocked — top-5 hold **71%** |
| TROY | 5.63 WETH | blocked — top-5 hold **69%** |
| BRODIE | 5.89 WETH | ✅ alerted — 12% top-5, 3 buyers, 1 sell, verified |

Note which ones lost: **the highest-liquidity launch in the sample was the most
bundled.** Liquidity would have ranked Nascat first; supply concentration shows
it was a setup. That inversion is the entire argument for this stage.

The honeypot check was inert here (3 buyers, below the 15-buyer threshold) — it
only bites on tokens with real early traffic.

## Known gap: liquidity alone can't filter a busy chain

Measured on Robinhood Chain, 2026-07-31, over a 4,010-block window:

| Liquidity floor | Alerts/day |
|---|---|
| 0.05 WETH | ~2,470 |
| 1 WETH | ~1,650 |
| 5 WETH | ~1,030 |
| 8 WETH | ~410 |

Raising the floor never gets this to a channel-appropriate rate, because ~18,700
launches a day means even a strict cut leaves hundreds. The sample also showed
why: two identical "Always has been" tokens appeared in seven minutes, which is
the copycat spam that reportedly overwhelmed the Noxa launchpad.

The bundle/honeypot gates above are what actually cut this down — see their
measured effect. Two gates from `pons-revival-bot` are **not** ported, because
both need DexScreener data this engine deliberately doesn't depend on: the $11k
market-cap entry cap, and the "must have a website or social link" filter. If
this bot ever gains a price source, those are the next two to add.

## Caveats

- Arc mainnet is **pre-release**: Circle hasn't publicly launched it, could reset state, re-gate access (it already has once), or freeze USDC held by any contract. Treat everything on it as maximum-risk.
- Endpoints rate-ban under burst load even when open; the client paces, fails over across endpoints, and retries once after a pause. Expect occasional `liquidity-unknown` skips, which are gated out of alerts rather than sent unvetted.
- Factory addresses are env-configurable (`V2_FACTORIES` / `V3_FACTORIES`) — when 5042.fun or DYORSwap deploy new factories, add them without a code change.
- `DISCOVERY_START_BLOCK` / `BLOCKSCOUT_BASE_URL` / `ARC_RPC_URLS` are likewise env-driven, so pointing this at a partner RPC or a relocated explorer needs no code change.
