# CoinSentry

A Telegram bot that watches any crypto token, on any chain, and alerts you the moment your
conditions are met. Paste a contract address, DexScreener tells CoinSentry which chain and pair
it lives on, and you configure alerts with a few button taps.

## Features

- **Any chain, auto-detected** — Solana, Ethereum, BSC, Base, pump.fun, anything [DexScreener](https://docs.dexscreener.com/api/reference) indexes.
- **Threshold alerts** — market cap / price / liquidity drops to or rises above a target, one-shot or repeating with hysteresis so it doesn't spam you on noise.
- **Trend alerts** — detects the start of an uptrend or downtrend using 5m/1h price change, a volume spike, and consecutive-poll confirmation, with a cooldown so it doesn't re-fire on every poll of the same move.
- **% move alerts** — a catch-all "notify me if it moves ±X% from here."
- **Clean, all-button UX** — after pasting a contract address, everything is inline buttons. Menus are edited in place instead of spamming new messages.
- **Quiet hours** — alerts during your configured quiet window are queued and delivered as a digest afterward.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and grab the token.
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in `BOT_TOKEN`:
   ```
   cp .env.example .env
   ```
4. Run it:
   ```
   npm run dev      # tsx watch, for development
   npm run build && npm run start   # compiled, for production
   ```

The SQLite database is created automatically at the path in `DB_PATH` (default `./data/coinsentry.db`).

## Using the bot

1. `/start` for the welcome menu, or just paste a contract address straight away.
2. CoinSentry looks the address up on DexScreener (across all chains) and shows a token card with
   its price, market cap, liquidity, and recent price change.
3. Tap an alert type (`🔔 MCap alert`, `💲 Price alert`, `💧 Liquidity alert`, `📈 Trend alert`,
   `↕️ % Move alert`) and follow the short guided conversation — pick a direction, type a value
   (shorthand like `5k`, `250k`, `1.2m` all work), pick one-shot or repeating, then confirm.
4. `📋 My watchlist` lists everything you're watching, paginated 5 per page. Tap a coin to view/add
   rules or remove it from your watchlist.
5. When a rule fires you get a notification with `🔕 Disable rule`, `🔁 Re-arm`, and
   `📊 Token card` buttons right on the alert.

### Value shorthand

`5k` → 5,000 · `250k` → 250,000 · `1.2m` → 1,200,000 · `2b` → 2,000,000,000 · plain numbers and
`$`/comma-formatted numbers also work.

## How alerts work

### Threshold alerts

Watches market cap, price, or liquidity against a target you set. In **one-shot** mode it fires
once and disables itself. In **repeating** mode it re-arms only after the metric crosses back over
the target by more than the hysteresis band (±3% by default) — this stops it from firing over and
over while the value oscillates right around your target.

### Trend alerts

Fires when, on the same poll:

- 5-minute price change is at least `m5ChangePct` in the trend's direction (default **4%**),
- 1-hour price change is at least `h1ChangePct` in the same direction (default **0%**, i.e. not
  fighting a bigger opposite move),
- current 5-minute volume is at least `volumeMultiplier`× the average 5-minute volume across the
  stored snapshot history (default **1.5×**), and
- there have been at least `consecutivePolls` polls in a row with the price moving in that
  direction (default **3**).

After firing, the rule enters a `cooldownMinutes` cooldown (default **30**) during which it won't
fire again, even if conditions are still met — this avoids re-alerting on every poll of the same
move. All five numbers are configurable per-alert when you choose "Customize" instead of
"Use defaults."

Downtrend alerts mirror the same logic with the signs flipped.

### % move alerts

Records the price at the moment you create the alert and fires when the price moves ±X% away from
it, with the same one-shot/repeating + hysteresis behavior as threshold alerts.

## Architecture

```
src/
  bot/            grammY handlers, menus, conversations, card rendering
  engine/         poller, rule evaluator, alert message building
  data/           SQLite repositories + DexScreener HTTP client
  types/          shared TypeScript types + zod schemas for the DexScreener API
  util/           number-shorthand parser, HTML escaping
```

- The **poller** runs every `POLL_INTERVAL_SECONDS` (default 20s), batches all actively-watched
  tokens by chain (up to 30 addresses per DexScreener request), evaluates every active rule against
  the fresh data, and only then persists the new snapshot — so trend rules compare against
  snapshots that don't yet include the current poll (correct "N consecutive polls" semantics).
  A failing chain or token never blocks the rest of the poll cycle.
- Rule state (`armed`, `active`, `last_fired_at`) is written back to SQLite in the same pass that
  evaluated it, so dispatch is idempotent even across a crash/restart.
- If a token stops being indexed by DexScreener (rugged/delisted), watchers get a one-time
  "no longer indexed" notice and its rules are auto-paused.
- Bot dependencies (repos, DexScreener client, logger) are a module-level singleton rather than
  attached to grammY's `ctx`, because `@grammyjs/conversations` replays conversation functions
  against reconstructed contexts — anything not explicitly re-registered via `conversation.run()`
  would otherwise be missing on replay. A plain singleton sidesteps that entirely since these are
  stateless-per-request objects wrapping one shared DB connection / HTTP client.
- `@grammyjs/menu` provides the main menu (`src/bot/menus/main.ts`) — a single flat, stateless
  `Menu` instance whose buttons dispatch straight into the watchlist/settings/help screens or the
  add-coin conversation. Every other screen (settings, watchlist pagination, token cards, per-token
  rule lists, confirmations, alert notification buttons) is dynamic/data-driven and uses plain
  `InlineKeyboard` + `bot.callbackQuery` regex handlers instead, since their layout depends on
  runtime data (page counts, rule ids, token ids) that doesn't fit the menu plugin's
  identifier-based navigation model as cleanly.

## Tests

```
npm test
```

Covers the number-shorthand parser (`5k` → 5000, `1.2m` → 1200000, etc.) and the rule evaluator
(threshold hysteresis/re-arm behavior, trend condition combinations, cooldown, percent-move).

## Configuration reference (`.env`)

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | — | Telegram bot token from BotFather (required) |
| `POLL_INTERVAL_SECONDS` | `20` | How often to poll DexScreener |
| `DB_PATH` | `./data/coinsentry.db` | SQLite file location |
| `LOG_LEVEL` | `info` | pino log level |

## Deployment (Fly.io)

CoinSentry is a long-lived process (Telegram long-polling + a background poller loop), not a
web server, so it needs a host that keeps a process running continuously with a persistent disk
for the SQLite file — it is **not** deployable to serverless/edge platforms as-is. This repo
includes a `Dockerfile`, `.dockerignore`, and `fly.toml` already set up for
[Fly.io](https://fly.io).

Only a machine with the app secret and Fly account access can complete a deploy, so these steps
need to be run by you, from a terminal, on your own machine:

1. **Install the Fly CLI** (one-time):
   ```
   curl -L https://fly.io/install.sh | sh
   ```
2. **Sign up / log in:**
   ```
   fly auth signup   # or: fly auth login
   ```
3. **Launch the app** from the project root. This detects the `Dockerfile`/`fly.toml`, and will
   ask you to confirm or change the app name (must be globally unique on Fly) and region — say
   **no** if it asks to overwrite `fly.toml`, since one is already committed:
   ```
   fly launch --no-deploy
   ```
4. **Create the persistent volume** for the SQLite database (must match the region you picked
   above; 1GB is overkill but Fly's minimum billing unit):
   ```
   fly volumes create coinsentry_data --size 1 --region iad
   ```
5. **Set your bot token as a secret** (never put this in `fly.toml` or any committed file):
   ```
   fly secrets set BOT_TOKEN=your_botfather_token_here
   ```
6. **Deploy:**
   ```
   fly deploy
   ```
7. **Check it's running:**
   ```
   fly logs
   ```

After this, the bot runs continuously on Fly's infrastructure — you can close your laptop and it
keeps polling and alerting. To ship a future code change, just run `fly deploy` again from the
project root.
