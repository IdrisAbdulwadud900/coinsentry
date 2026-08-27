/**
 * Unified domain model. Every data source (Helius, SolanaTracker, EVM logs)
 * normalizes into these shapes so the analysis engines are chain-agnostic.
 */

export type Chain = 'solana' | 'ethereum' | 'bsc' | 'base' | 'hyperevm' | 'robinhood';


/** A single directional swap against the token's pool(s). */
export interface Trade {
  /** Unix seconds. */
  ts: number;
  /** Buyer/seller wallet (owner, not the token account). */
  wallet: string;
  side: 'buy' | 'sell';
  /** Token units, decimal-adjusted, always positive. */
  tokenAmount: number;
  /** USD value of this leg. */
  usd: number;
  /** Per-token USD price implied by this trade. */
  priceUsd: number;
  /** Market cap implied by this trade (priceUsd * totalSupply). */
  mcap: number;
  /** Tx signature / hash. */
  tx: string;
  /** Block number (EVM) or slot (Solana) — used for same-block bundle detection. */
  block: number;
}

/** A wallet-to-wallet token movement that is NOT a swap (no pool involved). */
export interface SupplyTransfer {
  ts: number;
  from: string;
  to: string;
  tokenAmount: number;
  /** USD value at the time of transfer, using nearest known price. */
  usdAtTransfer: number;
  tx: string;
  block: number;
}

/** A native-currency (SOL/ETH) funding movement, used to link wallets. */
export interface FundingTransfer {
  ts: number;
  from: string;
  to: string;
  /** Native units (SOL or ETH). */
  amount: number;
  tx: string;
}

export interface TokenMeta {
  chain: Chain;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: number;
  /** Creator/deployer wallet if known. */
  dev: string | null;
  launchpad: string | null;
  createdAt: number | null;
  /** Primary pool/pair address used for trade replay. */
  pairAddress: string | null;
  dexId: string | null;
  /** Pool version ("v2"/"v3"/"v4") when the source states one. */
  poolVersion: string | null;
  priceUsd: number;
  mcap: number;
  liquidityUsd: number;
  volume24hUsd: number;
  holderCount: number | null;
  imageUrl: string | null;
  /** Chain-specific safety flags, rendered as-is. */
  safety: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPct?: number | null;
    devBalancePct?: number | null;
  };
}

/** Full reconstructed position history for one wallet on one token. */
export interface WalletLedger {
  wallet: string;

  firstBuyTs: number;
  lastActivityTs: number;

  /** Market cap at the wallet's FIRST buy — the "entry" that matters. */
  entryMcap: number;
  entryPriceUsd: number;
  /** Volume-weighted average across all buys. */
  avgBuyPriceUsd: number;
  avgBuyMcap: number;

  totalBoughtTokens: number;
  /**
   * Largest position ever held at one time. Distinct from `totalBoughtTokens`,
   * which is cumulative and can exceed the entire supply for a wallet that
   * trades in and out repeatedly.
   */
  peakTokens: number;
  totalSoldTokens: number;
  totalBoughtUsd: number;
  totalSoldUsd: number;

  /** Tokens received from / sent to other wallets (not swaps). */
  receivedTokens: number;
  sentTokens: number;

  /** Current on-book balance implied by trades + transfers. */
  balanceTokens: number;
  /** Value of remaining balance at current price. */
  unrealizedUsd: number;
  realizedUsd: number;
  totalPnlUsd: number;
  /** totalPnl / totalBoughtUsd. */
  roi: number;

  /** Highest market cap reached between first buy and first sell. */
  peakMcapBeforeFirstSell: number;
  /** peakMcapBeforeFirstSell / entryMcap — "how far they rode it before taking profit". */
  heldMultiple: number;
  /** avgSellPrice / avgBuyPrice — what they actually realized. */
  realizedMultiple: number;
  /** Current price / entry price, for wallets still holding. */
  currentMultiple: number;

  firstSellTs: number | null;
  /** Seconds between first buy and first sell. */
  holdSeconds: number | null;
  stillHolding: boolean;
  /** Sold >=95% of everything they ever held. */
  fullyExited: boolean;

  buyCount: number;
  sellCount: number;
  trades: Trade[];
}

export type EntryTier = 'floor' | 'sub10k' | 'early' | 'late';

export interface EarlyBuyer {
  ledger: WalletLedger;
  tier: EntryTier;
  /** Rank by entry time among all buyers (1 = very first buyer). */
  entryRank: number;
  /** Seconds after the first ever trade on this token. */
  secondsAfterLaunch: number;
  /** Percentage of total supply acquired. */
  supplyPct: number;
}

export interface DiamondHand {
  ledger: WalletLedger;
  /** Which multiple bucket they cleared before selling: 3, 4, 5, 10, 25, 50, 100. */
  bucket: number;
  entryTier: EntryTier;
  supplyPct: number;
}

/**
 * An early buyer sourced from a data provider rather than our own replay.
 *
 * Carries an exact entry market cap (the provider reports the first buy in both
 * tokens and USD) but no per-trade history, so peak-while-holding — the
 * conviction measure used elsewhere — cannot be derived and is absent by design
 * rather than estimated.
 */
export interface RepeatOffender {
  wallet: string;
  role: 'floor-taker' | 'relay-source';
  supplyPct: number;
  /** Symbols of earlier tokens it was seen on, for naming them. */
  priorTokens: string[];
  priorCount: number;
}

export interface ProviderEntry {
  wallet: string;
  tier: EntryTier;
  entryMcap: number;
  entryPriceUsd: number;
  entryTs: number;
  entryRank: number;
  secondsAfterLaunch: number;
  investedUsd: number;
  soldUsd: number;
  totalPnlUsd: number;
  holdingTokens: number;
  /**
   * Tokens that left this wallet without being sold — acquired, minus sold,
   * minus still held. This is the source half of a supply relay, and it is
   * derivable from the provider's own counts, so it survives on coins whose
   * history is far too large to replay.
   */
  movedOutTokens: number;
  /** Tokens the wallet ever acquired, the denominator for the above. */
  everHeldTokens: number;
  supplyPct: number;
  buyCount: number;
  sellCount: number;
  holdSeconds: number | null;
  stillHolding: boolean;
  realizedMultiple: number;
  currentMultiple: number;
  /**
   * Highest market cap between this wallet's first buy and its first sell,
   * taken from candle highs. Zero when candles do not cover the period — never
   * estimated, because that number is the whole basis of a conviction claim.
   */
  heldMultiple: number;
  peakMcapBeforeFirstSell: number;
}

export type LinkType =
  | 'funded-by-dev'
  | 'funded-dev'
  | 'common-funder'
  | 'token-transfer'
  | 'bundle-cobuy';

export interface LinkedWallet {
  wallet: string;
  links: LinkType[];
  /** 0-100 confidence that this wallet is controlled by / coordinated with the dev. */
  strength: number;
  /** Hops from the dev wallet in the funding graph. */
  hops: number;
  /** Shared funder address, when link is 'common-funder'. */
  via: string | null;
  ledger: WalletLedger | null;
}

export interface SupplyRelay {
  /** The wallet that acquired early and then pushed supply out. */
  source: string;
  /** The wallet that received the supply and sold it. */
  sink: string;
  transfers: SupplyTransfer[];
  tokensRelayed: number;
  /** Percentage of total supply relayed. */
  relaySupplyPct: number;
  /** USD the sink realized from selling the relayed supply. */
  sinkSoldUsd: number;
  /** Portion of received tokens the sink sold. */
  sinkSellRatio: number;
  sourceLedger: WalletLedger;
  sinkLedger: WalletLedger | null;
  /** Source's entry quality — this is what makes the relay interesting. */
  sourceEntryMcap: number;
  sourceEntryTier: EntryTier;
  /**
   * Source's own realized PnL plus the value the sink extracted on its behalf.
   * Not "hidden" on its own — the relayed portion is the concealed part, and
   * is reported separately as `sinkSoldUsd`.
   */
  combinedTakeUsd: number;
  /** 0-100, how strongly this looks like a deliberate exit-wallet pattern. */
  suspicion: number;
  /** Human-readable reasons behind the suspicion score. */
  flags: string[];
}

export interface AnalysisReport {
  token: TokenMeta;
  generatedAt: number;

  /** The coin's floor market cap. */
  floorMcap: number;
  /**
   * Where the floor came from. 'launchpad' means it was derived from the
   * bonding curve's known opening price and is exact regardless of how much
   * history was scanned; 'observed' means it is the lowest price actually seen,
   * which is only the true bottom when `reachedLaunch` is set.
   */
  floorSource: 'observed' | 'launchpad';
  /** Upper bound of the "floor range" band, as actually applied. */
  floorBandMax: number;
  /**
   * Lower bound of the band entries were judged against. Equals `floorMcap`
   * unless the lowest print was a sell no buyer could reach, in which case the
   * band is rebased onto the lowest genuine entry.
   */
  entryBandMin: number;
  /** True when the band was rebased off the raw floor. */
  entryBandRebased: boolean;
  /** Highest market cap seen. */
  peakMcap: number;
  firstTradeTs: number;

  tradeCount: number;
  uniqueWallets: number;
  /** True when the history had to be truncated by provider limits. */
  truncated: boolean;
  /** Oldest timestamp we actually have data for. */
  coverageFrom: number;
  /**
   * True when the scan reached the token's very first transaction. When false,
   * the floor and every entry tier describe the scanned window, not the coin.
   */
  reachedLaunch: boolean;
  /** Downsampled market-cap trajectory, for the overview sparkline. */
  mcapSeries: number[];

  floorEntries: EarlyBuyer[];
  /** Early buyers from the provider, used when our replay could not reach launch. */
  providerEntries: ProviderEntry[];
  diamondHands: DiamondHand[];
  /** Diamond hands derived from provider records, when the replay saw none. */
  providerDiamondHands: ProviderEntry[];
  devWallet: string | null;
  devLedger: WalletLedger | null;
  linkedWallets: LinkedWallet[];
  supplyRelays: SupplyRelay[];

  /**
   * Lifetime trading record for the strongest wallets found, keyed by address.
   * Empty when no provider is configured — absence means unrated, not unproven.
   */
  smartMoney: Record<string, import('../engine/smartMoney.js').SmartMoney>;

  /**
   * Traders who profited on this coin and have repeated the result elsewhere.
   * Empty when no provider is configured, or when nobody cleared the bars.
   */
  provenWinners: import('../engine/provenWinners.js').ProvenWinner[];
  /** How many leaderboard entries were checked, so "0 found" is readable. */
  winnersChecked: number;

  /**
   * Groups of wallets that both profited here and share funding, i.e. one
   * operator running several addresses. Independent of provenWinners on
   * purpose: splitting size across alts is what keeps each wallet off a
   * repeat-winner list in the first place.
   */
  sideClusters: import('../engine/sideWallets.js').SideCluster[];

  /**
   * Which trading STYLE earned the most here, richest first. Answers "how",
   * where every other screen answers "who".
   */
  winningPlays: import('../engine/winningPlay.js').PlayGroup[];

  /**
   * Wallets in this report that already appeared on a token scanned earlier.
   * Empty on a fresh install, which means "nothing to compare against" rather
   * than "these wallets are new" — the UI must not confuse the two.
   */
  repeatOffenders: RepeatOffender[];

  /**
   * True when the scan read every block it set out to. False makes an absence
   * ambiguous — a missing early buyer may be missing from the DATA rather than
   * from the chain — and several screens soften what they claim because of it.
   */
  coverageComplete: boolean;

  /** Per-module warnings surfaced in the UI (missing key, partial data...). */
  warnings: string[];
}

export interface ProgressUpdate {
  stage: string;
  detail?: string;
  /** 0-1. */
  pct: number;
}

export type ProgressFn = (u: ProgressUpdate) => void | Promise<void>;
