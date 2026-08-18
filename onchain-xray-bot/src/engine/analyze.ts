import { config } from '../config.js';
import { log } from '../util/log.js';
import { RateLimiter } from '../util/http.js';
import type {
  AnalysisReport,
  Chain,
  ProgressFn,
  TokenMeta,
  Trade,
  SupplyTransfer,
  FundingTransfer,
  WalletLedger,
} from '../types/domain.js';
import { detectAddressKind, normalizeAddress, CHAINS, logChunkFor } from '../data/chains.js';
import { lookupToken } from '../data/dexscreener.js';
import { getToken as getJupToken } from '../data/jupiter.js';
import { HeliusClient } from '../data/helius.js';
import { SolanaTrackerClient, type FirstBuyer } from '../data/solanatracker.js';
import { parseSolanaHistory } from '../data/solanaParse.js';
import { EvmClient } from '../data/evmPair.js';
import { getContractCreator } from '../data/blockscout.js';
import { NativePriceOracle } from '../data/nativePrice.js';
import { fetchCandleSeries, CandleIndex } from '../data/ohlcv.js';
import { launchpadFloorUsd, getLaunchpadSpec, floorUnavailableReason } from '../data/launchpads.js';
import { PriceCurve } from './priceCurve.js';
import { buildLedgers, priceTransfers } from './ledger.js';
import { findEarlyBuyers, findDiamondHands, resolveEntryBand, type TierContext } from './entries.js';
import { findSupplyRelays } from './supplyRelay.js';
import { rejectPriceOutliers } from './sanitize.js';
import { buildDevGraph } from './devGraph.js';
import { buildProviderEntries, findProviderDiamondHands } from './providerEntries.js';
import { rateFromTokenResults, type SmartMoney } from './smartMoney.js';
import { buildWinner, rankWinners, qualifiesOnThisCoin, type ProvenWinner } from './provenWinners.js';
import {
  extractFundingPeers,
  findSideWallets,
  orderByQuietness,
  buildClusters,
  type PeerMap,
  type SideCluster,
} from './sideWallets.js';

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** Compact USD for warning copy, without pulling in the render layer. */
function usdShort(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`;
}

/** Share of the hydration budget spent on the launch window vs. recent activity. */
const LAUNCH_WINDOW_SHARE = 0.7;

export interface AnalyzeOptions {
  /**
   * Replay every transaction. Off by default: the replay costs minutes and only
   * adds supply relays and the dev funding graph, neither of which is needed to
   * answer who made money on a coin or whether they are any good at it.
   */
  deep?: boolean;
}

export async function analyzeToken(
  input: string,
  onProgress: ProgressFn,
  options: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  const deep = options.deep ?? config.DEEP_SCAN_BY_DEFAULT;
  const address = input.trim();
  const kind = detectAddressKind(address);
  if (kind === 'invalid') {
    throw new AnalysisError(
      'That does not look like a contract address.',
      'Send a Solana mint (base58) or an EVM address starting with 0x.',
    );
  }

  await onProgress({ stage: 'Resolving token', pct: 0.03 });

  const ds = await lookupToken(address);
  if (!ds) {
    throw new AnalysisError(
      'No trading pair found for that address.',
      'The token may be unlaunched, rugged, or on a chain this bot does not cover (Solana, Ethereum, BNB Chain, Base).',
    );
  }

  const chain = ds.best.chain;
  const warnings: string[] = [];

  const meta = await buildTokenMeta(chain, address, ds, warnings);
  await onProgress({ stage: 'Loading price history', detail: CHAINS[chain].label, pct: 0.08 });

  const sinceTs = meta.createdAt ?? Math.floor(Date.now() / 1000) - 30 * 86400;
  const oracle = await NativePriceOracle.create(chain, sinceTs);
  if (oracle.isSpotOnly) {
    warnings.push(
      `Historical ${CHAINS[chain].nativeSymbol} pricing was unavailable — entry market caps are approximated at today's rate.`,
    );
  }

  // The fast path skips the replay entirely. Everything it would have provided
  // for these screens — who bought first, who profited, how far the coin ran —
  // comes from the provider's own records and from candles, both of which cover
  // the token's whole life in a couple of requests.
  const providerOnly = !deep && chain === 'solana' && config.hasSolanaTracker;

  const history = providerOnly
    ? await loadProviderOnlyHistory(meta, warnings)
    : chain === 'solana'
      ? await loadSolanaHistory(meta, oracle, warnings, onProgress)
      : await loadEvmHistory(meta, oracle, ds.best.quoteToken, warnings, onProgress);

  if (!providerOnly && history.trades.length === 0) {
    throw new AnalysisError(
      'Could not reconstruct any trades for this token.',
      chain === 'solana' && !config.hasHelius
        ? 'Set HELIUS_API_KEY to enable Solana history.'
        : 'The pair may be too new, or the public RPC rejected the log range.',
    );
  }

  await onProgress({ stage: 'Reconstructing positions', detail: `${history.trades.length} trades`, pct: 0.72 });

  // Strip reconstructions that cannot be real before anything derives a price
  // from them — the floor, the peak and every multiple depend on this.
  const { trades: cleanTrades, dropped } = rejectPriceOutliers(history.trades);
  history.trades = cleanTrades;
  if (dropped > 0) {
    log.debug({ dropped, kept: cleanTrades.length }, 'rejected price outliers');
    const share = dropped / (dropped + cleanTrades.length);
    if (share > 0.05) {
      warnings.push(
        `${dropped} of ${dropped + cleanTrades.length} reconstructed trades priced implausibly against their neighbours and were discarded.`,
      );
    }
  }

  if (!providerOnly && history.trades.length === 0) {
    throw new AnalysisError(
      'Every reconstructed trade for this token priced implausibly.',
      'This usually means the pool type is not one the parser understands yet.',
    );
  }

  const curve = new PriceCurve(history.trades);

  // Candle highs span the token's whole life, keyless. Without them a peak is
  // only ever a lower bound taken from the replayed window, which understates
  // every "how far did they ride it" figure on a token too busy to scan fully.
  if (meta.pairAddress) {
    await onProgress({ stage: 'Loading candle history', pct: 0.75 });
    const series = await fetchCandleSeries(chain, meta.pairAddress, meta.createdAt, meta.address);

    // Defence in depth against the series describing the wrong asset. Candle
    // data is only trusted when its latest close is in the same neighbourhood
    // as the price we already know independently; a pool whose base token is
    // something else entirely would otherwise feed in that token's price and
    // silently inflate every peak derived from it.
    const latestClose = series.candles[series.candles.length - 1]?.close ?? 0;
    const sane =
      meta.priceUsd <= 0 ||
      latestClose <= 0 ||
      (latestClose / meta.priceUsd < 50 && meta.priceUsd / latestClose < 50);

    if (series.candles.length > 0 && sane) {
      curve.withCandles(new CandleIndex(series), meta.totalSupply);
      log.debug({ candles: series.candles.length, period: series.periodSeconds }, 'candle coverage');
    } else if (series.candles.length > 0 && !sane) {
      log.warn(
        { latestClose, tokenPrice: meta.priceUsd, pair: meta.pairAddress },
        'candle series price disagrees with the token price; discarding as the wrong asset',
      );
      warnings.push(
        'Candle history for this pair described a different asset than the token and was discarded, so hold-through-the-run figures cover only the replayed window.',
      );
    } else {
      warnings.push(
        'Candle history was unavailable for this pair, so hold-through-the-run figures cover only the replayed window.',
      );
    }
  }

  priceTransfers(history.supplyTransfers, curve);

  const currentPrice = meta.priceUsd > 0 ? meta.priceUsd : (curve.last?.price ?? 0);
  const currentMcap = meta.mcap > 0 ? meta.mcap : currentPrice * meta.totalSupply;
  const ledgers = buildLedgers(
    history.trades,
    history.supplyTransfers,
    curve,
    currentPrice,
    currentMcap,
  );

  // Every tier, the floor band and all market-cap figures are derived from
  // supply. Without it they silently collapse to zero and the report renders
  // as "no early buyers found", which reads like a finding rather than a gap.
  if (meta.totalSupply <= 0) {
    warnings.push(
      'Total supply could not be determined, so market-cap figures and entry tiers are unavailable for this token.',
    );
  }

  // A launchpad coin's floor is a program constant, so it does not depend on
  // how far the scan reached. Valued at the SOL price on its launch day, not
  // today's — the same curve opens at $1.7k with SOL at $60 and $6.7k at $240.
  const observedFloor = curve.floorMcap;
  const derivedFloor = meta.createdAt
    ? launchpadFloorUsd(meta.launchpad, oracle.at(meta.createdAt))
    : null;

  // The curve's opening tick is the lowest price that can exist, so anything
  // observed above it means the scan simply never saw the bottom.
  const useDerived = derivedFloor !== null && derivedFloor > 0 && derivedFloor < observedFloor;
  const floorMcap = useDerived ? derivedFloor! : observedFloor;
  const floorSource: 'observed' | 'launchpad' = useDerived ? 'launchpad' : 'observed';

  if (useDerived) {
    const spec = getLaunchpadSpec(meta.launchpad);
    log.debug({ observedFloor, derivedFloor, launchpad: meta.launchpad }, 'using launchpad floor');
    if (!history.reachedLaunch) {
      warnings.push(
        `The floor shown is exact even so: ${spec?.label ?? 'this launchpad'} opens at a fixed ${(spec?.fdvNative ?? 0).toFixed(1)} SOL, priced here at the rate on launch day.`,
      );
    }
  } else if (!history.reachedLaunch) {
    // Say which of the two reasons applies — an unrecognised launchpad and one
    // whose curve is configured per launch are different problems.
    warnings.push(floorUnavailableReason(meta.launchpad));
  }

  const ctx: TierContext = {
    floorMcap,
    floorBandMax: floorMcap * config.FLOOR_BAND_MULT,
    firstTradeTs: curve.first?.ts ?? history.trades[0]?.ts ?? meta.createdAt ?? 0,
    totalSupply: meta.totalSupply,
  };

  await onProgress({ stage: 'Scoring wallets', pct: 0.82 });

  const entryBand = resolveEntryBand(ledgers, ctx);
  const floorEntries = findEarlyBuyers(ledgers, ctx);

  // When our own replay never reached the launch, the provider's first-buyers
  // are the only view of who was actually there. Built alongside rather than
  // merged: the two sources support different claims, and blending them would
  // imply a conviction measure the provider data cannot support.
  const providerEntries = buildProviderEntries(history.providerFirstBuyers, ctx, currentPrice, curve);
  const diamondHands = findDiamondHands(ledgers, ctx);
  const providerDiamondHands = findProviderDiamondHands(providerEntries);

  await onProgress({ stage: 'Tracing supply relays', pct: 0.9 });
  const supplyRelays = findSupplyRelays(history.supplyTransfers, ledgers, ctx, chain);

  await onProgress({ stage: 'Mapping dev cluster', pct: 0.95 });
  const linkedWallets = meta.dev
    ? buildDevGraph({
        chain,
        dev: meta.dev,
        fundingTransfers: history.fundingTransfers,
        supplyTransfers: history.supplyTransfers,
        trades: history.trades,
        ledgers,
        firstTradeTs: ctx.firstTradeTs,
        totalSupply: meta.totalSupply,
      })
    : [];

  if (!meta.dev) {
    warnings.push('Deployer wallet could not be identified, so the dev cluster is unavailable.');
  }
  if (chain !== 'solana' && history.fundingTransfers.length === 0 && meta.dev) {
    warnings.push(
      'EVM funding links need transaction traces that public RPCs do not expose — the dev cluster uses token transfers and launch-bundle timing only.',
    );
  }

  if (!history.reachedLaunch && providerEntries.length > 0) {
    warnings.push(
      `The launch window was out of reach, so the ${providerEntries.length} earliest buyers below come from SolanaTracker's first-buyer record. Their entry prices are exact, and how far each rode it is measured against candle highs spanning the coin's full history.`,
    );
  } else if (!history.reachedLaunch && !config.hasSolanaTracker) {
    warnings.push(
      'Set SOLANATRACKER_API_KEY to recover the earliest buyers on tokens too busy to scan back to launch.',
    );
  }

  const smartMoney: Record<string, SmartMoney> = {};

  // --- Proven repeat winners ------------------------------------------------
  // Read from the coin's own leaderboard rather than the replay: who made money
  // here is a solved question, and the part worth computing is whether they
  // have done it before.
  let provenWinners: ProvenWinner[] = [];
  let sideClusters: SideCluster[] = [];
  let winnersChecked = 0;
  const tracker = SolanaTrackerClient.fromConfig();
  if (tracker && chain === 'solana' && config.WINNER_LOOKUPS > 0) {
    await onProgress({ stage: 'Finding proven winners', pct: 0.96 });
    const leaderboard = await tracker.topTraders(meta.address);
    const candidates = leaderboard.filter(qualifiesOnThisCoin).slice(0, config.WINNER_LOOKUPS);
    winnersChecked = candidates.length;

    const built: ProvenWinner[] = [];
    const phaseDeadline = Date.now() + config.WINNER_PHASE_BUDGET_MS;
    let skipped = 0;

    for (const [i, cand] of candidates.entries()) {
      // One slow wallet must not cost the whole report. Stopping here still
      // leaves everyone already checked, ranked correctly.
      if (Date.now() > phaseDeadline) {
        skipped = candidates.length - i;
        break;
      }
      await onProgress({
        stage: 'Checking track records',
        detail: `${i + 1} / ${candidates.length}`,
        pct: 0.96,
      });
      const results = await tracker.walletTokenResults(cand.wallet);
      built.push(buildWinner(cand, results, meta.address));

      // The same records answer "are they any good overall", so the lifetime
      // rating comes free rather than costing a second request per wallet.
      const rating = rateFromTokenResults(cand.wallet, results);
      if (rating) smartMoney[cand.wallet] = rating;
    }
    winnersChecked = built.length;

    if (skipped > 0) {
      warnings.push(
        `${skipped} of the ${candidates.length} biggest earners could not be checked in time — very active wallets have histories too large to read quickly, so they are left out rather than waited for.`,
      );
    }
    provenWinners = rankWinners(built);

    // Side wallets. Seeded with the QUIETEST qualifying wallets rather than the
    // biggest earners: history is read newest-first, so a 5,000-coin trader's
    // budget covers a few hours of today, while a 20-coin wallet's covers its
    // whole life — and the funding happened once, long ago.
    const helius = HeliusClient.fromConfig();
    if (helius && config.SIDE_WALLET_LOOKUPS > 0 && built.length > 0) {
      const seeds = orderByQuietness(built).slice(0, config.SIDE_WALLET_LOOKUPS);
      const peerSets = new Map<string, PeerMap>();
      // Its own budget, starting now. Sharing the track-record deadline meant
      // this never ran: that loop is built to spend the entire budget, so by
      // the time it exits there is nothing left and every wallet was skipped.
      const sideDeadline = Date.now() + config.SIDE_WALLET_BUDGET_MS;

      // Run these together: they are independent wallet histories, and doing
      // them one at a time spent the whole budget on six lookups. Coverage is
      // what makes this work — a link needs BOTH of its wallets read. Helius's
      // own limiter is the real pacing control; this pool just queues.
      const limiter = new RateLimiter(config.SIDE_WALLET_CONCURRENCY);
      let done = 0;
      await limiter.map(seeds, async (w) => {
        if (Date.now() > sideDeadline) return;
        try {
          const txs = await helius.walkAddress(w.wallet, config.SIDE_WALLET_TX_BUDGET);
          peerSets.set(w.wallet, extractFundingPeers(txs, w.wallet));
        } catch (err) {
          // walkAddress throws on a 429 that outlives its retries. One wallet
          // failing costs its links; it must never take the report down.
          log.debug({ err, wallet: w.wallet }, 'side wallet history failed');
        }
        await onProgress({
          stage: 'Finding side wallets',
          detail: `${++done} / ${seeds.length}`,
          pct: 0.98,
        });
      });

      const links = findSideWallets(peerSets, leaderboard);
      for (const w of provenWinners) w.sideWallets = links.get(w.wallet) ?? [];
      sideClusters = buildClusters(links, leaderboard);
    }

    if (leaderboard.length > 0 && candidates.length === 0) {
      warnings.push(
        `Nobody on this coin's leaderboard cleared ${usdShort(config.WINNER_MIN_PROFIT_USD)} profit at ${config.WINNER_MIN_MULTIPLE}x or better, so there were no candidates to check for a track record.`,
      );
    }
  }

  await onProgress({ stage: 'Done', pct: 1 });

  return {
    token: meta,
    generatedAt: Math.floor(Date.now() / 1000),
    floorMcap,
    floorSource,
    floorBandMax: entryBand.floorBandMax,
    entryBandMin: entryBand.floorMcap,
    entryBandRebased: entryBand.rebased,
    peakMcap: curve.peakMcap,
    firstTradeTs: ctx.firstTradeTs,
    tradeCount: history.trades.length,
    uniqueWallets: ledgers.size,
    truncated: history.truncated,
    coverageFrom: history.coverageFrom,
    reachedLaunch: history.reachedLaunch,
    mcapSeries: curve.series(24),
    floorEntries,
    providerEntries,
    diamondHands,
    providerDiamondHands,
    devWallet: meta.dev,
    devLedger: meta.dev ? (ledgers.get(meta.dev) ?? null) : null,
    linkedWallets,
    supplyRelays,
    smartMoney,
    provenWinners,
    sideClusters,
    winnersChecked,
    warnings,
  };
}

// --- Metadata ----------------------------------------------------------------

async function buildTokenMeta(
  chain: Chain,
  address: string,
  ds: NonNullable<Awaited<ReturnType<typeof lookupToken>>>,
  warnings: string[],
): Promise<TokenMeta> {
  const best = ds.best;
  const base: TokenMeta = {
    chain,
    address: normalizeAddress(address),
    name: best.name,
    symbol: best.symbol,
    decimals: 18,
    totalSupply: 0,
    dev: null,
    launchpad: null,
    createdAt: best.pairCreatedAt,
    pairAddress: best.pairAddress,
    dexId: best.dexId,
    priceUsd: best.priceUsd,
    mcap: best.mcap,
    liquidityUsd: best.liquidityUsd,
    volume24hUsd: best.volume24hUsd,
    holderCount: null,
    imageUrl: best.imageUrl,
    safety: {},
  };

  if (chain === 'solana') {
    const jup = await getJupToken(address);
    if (jup) {
      base.name = jup.name || base.name;
      base.symbol = jup.symbol || base.symbol;
      base.decimals = jup.decimals ?? 6;
      base.totalSupply = jup.totalSupply ?? jup.circSupply ?? 0;
      base.dev = jup.dev ?? null;
      base.launchpad = jup.launchpad ?? null;
      base.holderCount = jup.holderCount ?? null;
      base.imageUrl = jup.icon ?? base.imageUrl;
      if (jup.graduatedAt) base.createdAt = Math.floor(Date.parse(jup.graduatedAt) / 1000);
      if (jup.firstPool?.createdAt) {
        base.createdAt = Math.floor(Date.parse(jup.firstPool.createdAt) / 1000);
      }
      base.safety = {
        mintAuthorityDisabled: jup.audit?.mintAuthorityDisabled,
        freezeAuthorityDisabled: jup.audit?.freezeAuthorityDisabled,
        topHoldersPct: jup.audit?.topHoldersPercentage ?? null,
        devBalancePct: jup.audit?.devBalancePercentage ?? null,
      };
    } else {
      warnings.push('Jupiter metadata was unavailable, so the deployer wallet is unknown.');
    }
    // Fall back to price-derived supply when Jupiter has no figure.
    if (base.totalSupply <= 0 && base.priceUsd > 0 && base.mcap > 0) {
      base.totalSupply = base.mcap / base.priceUsd;
    }
  } else {
    const evm = new EvmClient(chain);
    try {
      const basics = await evm.tokenBasics(address);
      base.decimals = basics.decimals;
      base.totalSupply = basics.totalSupply;
      base.name = basics.name || base.name;
      base.symbol = basics.symbol || base.symbol;
    } catch {
      if (base.priceUsd > 0 && base.mcap > 0) base.totalSupply = base.mcap / base.priceUsd;
      warnings.push('Token contract calls failed; supply figures are derived from market cap.');
    }
  }

  return base;
}

// --- History loaders ---------------------------------------------------------

interface History {
  trades: Trade[];
  supplyTransfers: SupplyTransfer[];
  fundingTransfers: FundingTransfer[];
  truncated: boolean;
  coverageFrom: number;
  reachedLaunch: boolean;
  providerFirstBuyers: FirstBuyer[];
}

async function loadSolanaHistory(
  meta: TokenMeta,
  oracle: NativePriceOracle,
  warnings: string[],
  onProgress: ProgressFn,
): Promise<History> {
  const helius = HeliusClient.fromConfig();
  const tracker = SolanaTrackerClient.fromConfig();

  if (!helius && !tracker) {
    throw new AnalysisError(
      'No Solana data provider is configured.',
      'Set HELIUS_API_KEY (recommended) and/or SOLANATRACKER_API_KEY, then restart the bot.',
    );
  }

  // Precomputed first buyers cost one request and cover wallets that a
  // truncated raw replay might miss entirely.
  const providerFirstBuyers = tracker ? await tracker.firstBuyers(meta.address) : [];

  if (!helius) {
    warnings.push('Running without Helius — supply-relay and dev-cluster analysis are unavailable.');
    const trades = tracker ? await tracker.trades(meta.address, Math.min(config.MAX_TX_FETCH, 3000)) : [];
    for (const t of trades) t.mcap = t.priceUsd * meta.totalSupply;
    return {
      trades,
      supplyTransfers: [],
      fundingTransfers: [],
      truncated: trades.length >= 3000,
      coverageFrom: trades[0]?.ts ?? 0,
      reachedLaunch: trades.length < 3000,
      providerFirstBuyers,
    };
  }

  await onProgress({ stage: 'Listing transactions', pct: 0.14 });
  // Listed to the token's genesis, not to the hydration budget — see
  // MAX_SIGNATURE_SCAN. Reaching the first transaction is what makes the floor
  // and the early-buyer list mean anything.
  const sigs = await helius.listSignatures(meta.address, config.MAX_SIGNATURE_SCAN, (n) => {
    void onProgress({ stage: 'Listing transactions', detail: `${n.toLocaleString()} found`, pct: 0.14 });
  });

  if (sigs.length === 0) {
    throw new AnalysisError('No transactions found for that mint.', 'Double-check the address.');
  }

  // Whether the walk actually reached the token's first transaction. If it did
  // not, the oldest signature in hand is mid-history and must not be presented
  // as the launch — the floor, the entry tiers and "who was first" all become
  // statements about an arbitrary recent window instead.
  const reachedLaunch = sigs.length < config.MAX_SIGNATURE_SCAN;
  const truncated = !reachedLaunch || sigs.length > config.MAX_TX_FETCH;

  if (!reachedLaunch) {
    // Deliberately says nothing about the floor: a launchpad coin's floor is
    // still exact here, and that is decided later. Claiming otherwise would
    // contradict the launchpad note.
    warnings.push(
      `This token has more than ${config.MAX_SIGNATURE_SCAN.toLocaleString()} transactions, so the scan could not reach its launch — the wallet lists below cover only the most recent window, and the earliest buyers are missing.`,
    );
  } else if (sigs.length > config.MAX_TX_FETCH) {
    warnings.push(
      `This token has ${sigs.length.toLocaleString()} transactions — the launch window and recent activity were read in full, but not everything in between.`,
    );
  }

  // Signatures come back newest-first; the launch window is the tail.
  const oldest = [...sigs].reverse();
  const budget = Math.min(sigs.length, config.MAX_TX_FETCH);
  const launchCount = Math.min(oldest.length, Math.floor(budget * LAUNCH_WINDOW_SHARE));
  const recentCount = Math.min(sigs.length - launchCount, budget - launchCount);

  const selected = [
    ...oldest.slice(0, launchCount),
    ...sigs.slice(0, Math.max(0, recentCount)),
  ];
  const unique = [...new Map(selected.map((s) => [s.signature, s])).values()];

  await onProgress({ stage: 'Reading transactions', detail: `0 / ${unique.length}`, pct: 0.2 });
  const hydrated = await helius.hydrate(
    unique.map((s) => s.signature),
    (done) => {
      const pct = 0.2 + 0.35 * (done / Math.max(1, unique.length));
      void onProgress({
        stage: 'Reading transactions',
        detail: `${done.toLocaleString()} / ${unique.length.toLocaleString()}`,
        pct,
      });
    },
  );

  // Losing batches to rate limits is recoverable; hiding it is not. A report
  // built from a fraction of the history looks identical to a complete one.
  if (hydrated.failedBatches > 0) {
    // Measured against batches, not transactions. Helius legitimately returns
    // nothing for a large share of signatures (failed and unparseable ones),
    // so comparing returned-to-requested would report normal coverage as loss.
    const pctLost = Math.round((hydrated.failedBatches / Math.max(1, hydrated.totalBatches)) * 100);
    warnings.push(
      `The data provider rate-limited this scan: ${pctLost}% of the requested batches could not be read, so wallet lists and trade counts are incomplete. Re-scanning in a few minutes usually recovers them.`,
    );
  }

  const parsed = parseSolanaHistory(hydrated.txs, {
    mint: meta.address,
    decimals: meta.decimals,
    totalSupply: meta.totalSupply,
    solPriceAt: (ts) => oracle.at(ts),
  });

  // Plain transfers are filtered server-side, which is far cheaper than
  // hydrating every swap just to find the handful of supply hand-offs.
  await onProgress({ stage: 'Tracing token transfers', pct: 0.57 });
  const transferTxs = await helius.walkAddress(meta.address, 2_000, 'TRANSFER');
  const transferParsed = parseSolanaHistory(transferTxs, {
    mint: meta.address,
    decimals: meta.decimals,
    totalSupply: meta.totalSupply,
    solPriceAt: (ts) => oracle.at(ts),
  });

  // Funding edges come from the dev's own history — a bounded query, unlike
  // trying to observe funding across the whole token.
  let fundingTransfers = [...parsed.fundingTransfers, ...transferParsed.fundingTransfers];
  if (meta.dev) {
    await onProgress({ stage: 'Mapping dev funding', pct: 0.64 });
    const devTxs = await helius.walkAddress(meta.dev, 400);
    const devParsed = parseSolanaHistory(devTxs, {
      mint: meta.address,
      decimals: meta.decimals,
      totalSupply: meta.totalSupply,
      solPriceAt: (ts) => oracle.at(ts),
    });
    fundingTransfers = [...fundingTransfers, ...devParsed.fundingTransfers];
  }

  const supplyTransfers = dedupeTransfers([
    ...parsed.supplyTransfers,
    ...transferParsed.supplyTransfers,
  ]);

  return {
    trades: parsed.trades,
    supplyTransfers,
    fundingTransfers: dedupeFunding(fundingTransfers),
    truncated,
    coverageFrom: parsed.trades[0]?.ts ?? 0,
    reachedLaunch,
    providerFirstBuyers,
  };
}

async function loadEvmHistory(
  meta: TokenMeta,
  oracle: NativePriceOracle,
  quoteToken: string,
  warnings: string[],
  onProgress: ProgressFn,
): Promise<History> {
  if (!meta.pairAddress) {
    throw new AnalysisError('No pair address available for this token.');
  }

  // Say upfront when the token is beyond reach. Public RPCs cap getLogs at
  // 10,000 blocks, so a two-year-old Base token needs thousands of sequential
  // requests — the scan used to run for minutes and then quietly return a
  // sliver, which reads as the bot hanging rather than as a coverage limit.
  if (meta.createdAt) {
    const spec = CHAINS[meta.chain];
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - meta.createdAt);
    const secondsPerBlock = { ethereum: 12, bsc: 0.75, base: 2, solana: 0.4 }[meta.chain];
    const blocksNeeded = ageSeconds / secondsPerBlock;
    const chunksNeeded = blocksNeeded / logChunkFor(meta.chain);
    const chunkBudget = Math.floor(config.EVM_MAX_LOG_CHUNKS / 2);

    if (chunksNeeded > chunkBudget) {
      const budgetDays = (chunkBudget * logChunkFor(meta.chain) * secondsPerBlock) / 86_400;
      const launchDays = Math.round(budgetDays * config.EVM_LAUNCH_WINDOW_SHARE);
      const recentDays = Math.round(budgetDays * (1 - config.EVM_LAUNCH_WINDOW_SHARE));
      warnings.push(
        `This token is ${Math.round(ageSeconds / 86_400)} days old and ${spec.label} caps each log request at ${logChunkFor(meta.chain).toLocaleString()} blocks, so reading every block is not possible. The scan covers the first ~${launchDays} days from launch and the most recent ~${recentDays} days; the stretch in between is not read.`,
      );
      log.info(
        { chain: meta.chain, chunksNeeded: Math.round(chunksNeeded), chunkBudget },
        'token exceeds EVM log budget; covering launch window only',
      );
    }
  }

  await onProgress({ stage: 'Replaying pair logs', detail: CHAINS[meta.chain].label, pct: 0.15 });
  const evm = new EvmClient(meta.chain);
  const res = await evm.replay(
    meta.address,
    meta.pairAddress,
    {
      pairCreatedAt: meta.createdAt,
      nativePriceAt: (ts) => oracle.at(ts),
      quoteToken,
    },
    (pct, detail) => {
      void onProgress({ stage: 'Replaying pair logs', detail, pct: 0.15 + pct * 0.5 });
    },
  );

  // A token whose trading is mostly router-routed yields a wallet list that is
  // real but far from complete, and that is not obvious from the output alone.
  if (res.routedTrades > 0) {
    const share = res.routedTrades / (res.routedTrades + res.trades.length);
    if (share > 0.15) {
      warnings.push(
        `${Math.round(share * 100)}% of swaps reached the pair through a router or the token's own contract, so the wallet behind them is not recorded on-chain and they are excluded. Wallet lists cover the remainder.`,
      );
    }
  }

  // Only when the clock actually cut it short. A token that simply exceeds the
  // chunk budget is already explained above, and saying it timed out as well
  // would be both redundant and untrue.
  if (res.stoppedEarly) {
    warnings.push(
      `Log scanning hit its ${Math.round(config.EVM_SCAN_BUDGET_MS / 1000)}s time budget, so coverage is thinner than the windows above describe.`,
    );
  }
  if (res.totalSupply > 0) meta.totalSupply = res.totalSupply;

  // The deployer minted the supply before the pair existed, so it never appears
  // in the replayed logs — it has to be resolved from the contract itself.
  if (!meta.dev) {
    meta.dev = await getContractCreator(meta.chain, meta.address);
    if (!meta.dev && meta.chain === 'bsc') {
      warnings.push(
        'No public explorer API covers BNB Chain deployers, so the dev cluster is unavailable here.',
      );
    }
  }

  return {
    trades: res.trades,
    supplyTransfers: res.supplyTransfers,
    fundingTransfers: res.fundingTransfers,
    truncated: res.truncated,
    coverageFrom: res.coverageFrom,
    // Anchored at pair creation and walked forward — but only actually covering
    // the launch if the chunk budget did not run out on the way. Treating a
    // known creation timestamp as proof of coverage claimed launch data the
    // scan may never have reached.
    reachedLaunch: meta.createdAt !== null && !res.truncated,
    providerFirstBuyers: [],
  };
}

/**
 * History for the fast path: no transactions at all.
 *
 * Only the provider's first-buyer record is fetched. Trades, transfers and
 * funding edges are deliberately empty — the screens that need them say so
 * rather than showing a thin version built from partial data.
 */
async function loadProviderOnlyHistory(meta: TokenMeta, warnings: string[]): Promise<History> {
  const tracker = SolanaTrackerClient.fromConfig();
  const providerFirstBuyers = tracker ? await tracker.firstBuyers(meta.address) : [];

  warnings.push(
    'Fast scan: read from trade records and candles rather than replaying transactions. Supply relays and the dev funding graph need the full replay — use Deep scan for those.',
  );

  return {
    trades: [],
    supplyTransfers: [],
    fundingTransfers: [],
    truncated: false,
    coverageFrom: meta.createdAt ?? 0,
    // The provider's first-buyer record starts at the true first buy.
    reachedLaunch: providerFirstBuyers.length > 0,
    providerFirstBuyers,
  };
}

// --- Helpers -----------------------------------------------------------------

function dedupeTransfers(list: SupplyTransfer[]): SupplyTransfer[] {
  const seen = new Set<string>();
  const out: SupplyTransfer[] = [];
  for (const t of list) {
    const key = `${t.tx}|${t.from}|${t.to}|${t.tokenAmount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function dedupeFunding(list: FundingTransfer[]): FundingTransfer[] {
  const seen = new Set<string>();
  const out: FundingTransfer[] = [];
  for (const t of list) {
    const key = `${t.tx}|${t.from}|${t.to}|${t.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Reports how much of SolanaTracker's authoritative first-buyer list our own
 * replay actually covered.
 *
 * It deliberately does NOT merge those wallets into the leaderboards. The
 * provider gives an outcome (invested, sold, PnL) but no per-trade detail, so
 * there is no entry market cap to tier them by and no price history to measure
 * conviction against. Synthesising a ledger from that would put wallets in the
 * floor-entry list whose entry figures were invented, which is worse than
 * naming the gap. Presenting them properly needs its own screen.
 */
function reportProviderCoverageGap(
  providerBuyers: FirstBuyer[],
  ledgers: Map<string, WalletLedger>,
  floorEntries: { ledger: WalletLedger }[],
  ctx: TierContext,
  warnings: string[],
): void {
  if (providerBuyers.length === 0) return;
  const known = new Set(floorEntries.map((e) => e.ledger.wallet));
  const missing = providerBuyers.filter((b) => !known.has(b.wallet) && !ledgers.has(b.wallet));
  if (missing.length > 0) {
    log.debug({ missing: missing.length }, 'provider first-buyers not covered by replay');
    warnings.push(
      `${missing.length} of SolanaTracker's first buyers fall outside the replayed window and are not scored below.`,
    );
  }
}
