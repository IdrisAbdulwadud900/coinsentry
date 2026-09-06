# 🔬 XRAY — on-chain wallet forensics bot

Paste a contract address into Telegram. The bot reconstructs the token's entire
trade history from raw chain data and answers four questions:

| | |
|---|---|
| 🎯 **Floor entries** | Which wallets bought at the actual bottom |
| 💎 **Diamond hands** | Which of those held through a 3x / 10x / 100x run *before* selling anything |
| 🧬 **Dev cluster** | The deployer, plus every wallet linked to it by funding, transfers, or launch bundling |
| 🚨 **Supply relays** | Early buyers who moved supply to a second wallet and let *that* one do the selling |

**Chains:** Solana, Ethereum, BNB Chain, Base.

---

## The core idea

Most tools tell you who currently holds a token. That is the wrong question,
because the interesting behaviour is *historical* and often *deliberately
obscured*.

Two things make this bot different:

**1. Conviction is measured by the peak reached before the first sell.**
Not final PnL. A wallet that entered at the floor and watched it run 40x before
trimming showed conviction; a wallet that flipped at 1.2x and got lucky later
did not. Final PnL cannot tell those apart. `peakMcapBeforeFirstSell / entryMcap`
can.

**2. Supply relays are reconstructed, not assumed.**
A wallet buys at $4k market cap, sends its bag to a fresh address, and that
address dumps. The original wallet never prints a single sell, so every
"top holders still holding" check stays green. The bot attributes the sink's
sells back to the source and scores how deliberate the pattern looks — weighing
the source's entry quality, whether the sink ever bought anything itself, what
share of the relayed supply it dumped, and how fast.

The obvious false positive is a CEX deposit address, which also receives and
"sells". Those are caught by fan-in — many unrelated wallets paying into one
address — and demoted rather than dropped, since a deposit address is still an
exit.

---

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN` from [@BotFather](https://t.me/BotFather), then:

```bash
npm run dev
```

### API keys

**EVM chains need no keys at all** — the bot replays `Swap` and `Transfer` logs
directly from the pair contract.

**Solana needs at least one key.** No keyless source provides trade history back
to launch (verified: GeckoTerminal caps at the last 300 trades; Helius,
SolanaTracker, Birdeye, Moralis and Bitquery all require auth; hydrating public
RPC signatures is far too slow).

| Provider | Free tier | What it does here |
|---|---|---|
| [Helius](https://dashboard.helius.dev) | 1M credits/mo | **The important one.** Raw parsed transactions — the only source that can produce the supply-relay and dev-cluster analysis. |
| [SolanaTracker](https://www.solanatracker.io/data-api) | 10k req/mo | Optional. Precomputed first-buyers, covering wallets outside the replayed window on heavily traded tokens. |

### Try it without a bot token

```bash
npm run xray -- 0x6982508145454Ce325dDbE47a25d4ec3d2311933
```

Runs the full pipeline and prints every screen to the terminal.

---

## Sample output

Real output from the command above (PEPE, Ethereum):

```
🔬 XRAY · $PEPE
⟠ Ethereum · uniswap

💰 $1.18B  ·  🌊 $21.3M
▁▃▅▅▆▆▆▆▇▆▇▇██████████
floor $9.11K → now $1.18B  (129831x)

🟢 RISK 0 · CLEAN
░░░░░░░░░░░░ 0
│ ✓ 24 floor-range wallets are still holding through a 100x+ run

🎯 Floor entries  41 wallets
💎 Diamond hands  38 (24 holding)
🧬 Dev cluster    0 linked
🚨 Supply relays  none

3,155 trades · 1,083 wallets · first trade 1214d 14h ago
```

Tapping **🎯 Floor** gives:

```
🥇 0xaf…4534 🎯 FLOOR
   entry $9.17K · → 131045x · 0.60% supply
   🟩 +$7.20M · 💎 HOLDING
   #2 in · 2h 10m after launch
```

---

## How coverage works

**Listing signatures and reading them are budgeted separately, and that
distinction is load-bearing.** Solana returns a token's signatures newest-first.
Listing them is cheap (1000 per request, no bodies); reading them is not (one
request per 100, full bodies). If both share one budget, the walk stops
part-way through the token's life and the oldest signature in hand sits
somewhere in the middle — which everything downstream then treats as the
launch. The result is a confidently reported "floor" that is really just the low
of a recent window.

`MAX_SIGNATURE_SCAN` therefore governs how far back the scan walks, and must
stay well above `MAX_TX_FETCH`, which governs how many of those are read in
full. When the walk does reach the first transaction, the report says `floor`;
when it does not, it says `window low`, the floor-entries screen leads with a
warning, and `reachedLaunch` is false on the report. A windowed low is never
presented as the coin's bottom.

Within that scan, a token with millions of transactions still cannot be *read*
in full inside a Telegram interaction, so hydration is deliberately weighted
toward the **launch window** — that is where floor entries live.

- **Solana:** signatures are listed cheaply via RPC (1000/call, no bodies), then
  only the oldest ~70% of the budget plus a recent slice are hydrated into
  parsed transactions. Plain transfers are fetched separately using Helius's
  server-side `type=TRANSFER` filter, which is far cheaper than pulling every
  swap to find a handful of hand-offs.
- **EVM:** the scan is anchored at the pair's creation block, found by binary
  search on block timestamps.

Whenever coverage is partial the report says so, in the **Coverage notes**
section — it is never silently truncated.

### Launchpad floors

A launchpad coin does not need its history scanned to find its floor. The
bonding curve's opening price is a program constant, so the launch market cap is
knowable from the launchpad alone:

```
pump.fun:  30 virtual SOL / 1.073B virtual tokens, 1B supply
           = 27.959 SOL fully-diluted at the first tick
```

That is ~$2.2k with SOL at $78.70 — and ~$1.7k at $60, or ~$6.7k at $240. The
floor is fixed in **SOL, not dollars**, so it is valued at the rate that was
live on the coin's launch day.

This matters most where scanning fails. A week-old pump.fun coin can already
carry >120,000 transactions, which cannot be paginated inside a Telegram
interaction — but its floor is still exact. When the derived floor sits below
anything observed, it wins, because the curve's opening tick is the lowest price
that can exist and a higher observation just means the scan never saw the
bottom. The report then labels it `launch` rather than `floor`, and still says
plainly that the *wallet list* covers only the scanned window.

Only launchpads whose constants are actually known live in the registry
(`src/data/launchpads.ts`). A guessed floor would be worse than none, since it
silently retiers every wallet on the coin.

**Not every launchpad has a floor to know.** Meteora's DBC lets the creator pick
the curve, and sampled launches opened anywhere from ~86 to ~2500 SOL. Those are
marked `configurable`, and the bot says so rather than inventing a number.

To measure a launchpad yourself — including new ones as they appear:

```bash
npm run launchpads -- 20
```

It samples Jupiter's recent feed, keeps only launches still sitting on their
opening tick, and reports the FDV in SOL per launchpad. The verdict column keys
off how many launches cluster **on the minimum**, not the min-to-max spread: a
curve only moves up from its opening price, so a high sample is a coin that
already traded, and judging by spread alone would wrongly call pump.fun
configurable because one coin ran 2x.

### Historical pricing

Every swap is denominated in SOL/ETH/BNB. Valuing a three-week-old trade at
today's SOL price would mis-state its market cap, which is exactly the number
the "sub-$10k entry" rule depends on. The bot pulls a timestamped native-price
series (CoinGecko, keyless — hourly under 90 days, daily beyond) and values each
trade at the rate that was live when it happened. If that series is unavailable
it falls back to spot and says so in the report.

### RPC reality check

Public EVM RPCs disagree sharply about archive access. Verified live 2026‑08‑11:

| Chain | Endpoint | Archive `eth_getLogs` |
|---|---|---|
| Ethereum | `rpc.mevblocker.io` | ✅ 10,000-block spans |
| Ethereum | `eth.drpc.org`, `publicnode`, `llamarpc`, `1rpc` | ❌ refused or ≤50 blocks |
| Base | `mainnet.base.org` | ✅ |
| BNB Chain | *(all free endpoints tested)* | ❌ requires a personal token |

The client keeps a fallback list per chain and rotates past endpoints that
reject a request. **For BSC tokens older than the public retention window, set
`BSC_RPC_URL` to a keyed archive endpoint** or the launch window will be missed.

---

## Architecture

```
src/
  data/          adapters — one per source, each returning the shared domain model
    chains.ts        chain registry, address detection, RPC fallback lists
    dexscreener.ts   pair resolution + chain detection (an EVM address alone
                     cannot tell you whether it is Ethereum or BSC)
    jupiter.ts       Solana metadata + the deployer wallet, keyless
    blockscout.ts    EVM deployer, keyless (ETH/Base)
    helius.ts        Solana transaction hydration
    solanatracker.ts precomputed first-buyers / top-traders
    solanaParse.ts   Helius transactions → trades, transfers, funding edges
    evmPair.ts       pair log replay → trades, transfers
    nativePrice.ts   historical SOL/ETH/BNB pricing
  engine/
    priceCurve.ts    market-cap history; O(1) range-max via sparse table
    ledger.ts        per-wallet position reconstruction
    entries.ts       floor / sub-10k classification, diamond hands
    supplyRelay.ts   relay detection and scoring
    devGraph.ts      funding graph, common funders, launch bundle
    verdict.ts       composite risk score
    analyze.ts       orchestrator
  bot/
    ui.ts            the visual language
    render/          one module per screen
    keyboards.ts     navigation; callback payloads are capped at 64 bytes, so
                     reports are addressed by a short session id
```

Every data source normalizes into `Trade` / `SupplyTransfer` / `FundingTransfer`,
so the analysis engines are entirely chain-agnostic.

---

## Interpreting the output

**Dev-cluster links are confidence, not proof.** A shared funder is very often
just an exchange withdrawal. Strength combines independent signals with
diminishing returns and decays with distance from the dev, and the reasoning is
always shown rather than hidden behind a number.

**The risk score is a heuristic.** It is weighted, not multiplicative, so no
single signal pins it. Read the underlying findings before acting on it.

**Cost basis is average-cost, not FIFO** — the question is what a wallet paid on
the way in, and average cost answers that without imposing a lot ordering the
chain never recorded. Tokens received by transfer are treated as zero-cost so
relayed supply cannot fake a loss.

**The minimum position scales with the coin.** A flat dollar bar is wrong at
both ends: $50 is a ~0.6% stake on a coin whose floor was $9k — filtering out
exactly the early buyers this bot exists to find — and pure dust on one whose
floor was $5M. The bar is `MIN_POSITION_FLOOR_PCT` of the floor market cap
(0.05% by default), so it means roughly "acquired at least this much of the
coin" at any scale. `MIN_POSITION_USD` remains only as a sanity floor. The
effective threshold is printed on the floor-entries screen rather than applied
silently.

---

## Tests

```bash
npm test
```

21 tests covering the parts where correctness actually matters: price-curve
range queries, ledger reconstruction, entry classification, diamond-hand
filtering, relay detection and scoring, and the Solana transaction parser
(including both sign conventions Helius uses for swap legs).

---

## Deploy

```bash
fly launch --no-deploy
fly secrets set TELEGRAM_BOT_TOKEN=... HELIUS_API_KEY=... SOLANATRACKER_API_KEY=...
fly deploy
```

Run exactly one instance — two would both long-poll Telegram and answer every
message twice.
