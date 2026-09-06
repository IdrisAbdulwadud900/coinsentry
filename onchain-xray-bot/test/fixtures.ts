import type {
  AnalysisReport,
  TokenMeta,
  WalletLedger,
  EarlyBuyer,
  DiamondHand,
  ProviderEntry,
  LinkedWallet,
  SupplyRelay,
  Trade,
} from '../src/types/domain.js';

export const SUPPLY = 1_000_000_000;

export function makeLedger(over: Partial<WalletLedger> = {}): WalletLedger {
  const base: WalletLedger = {
    wallet: 'Wa11etAddress1111111111111111111111111111111',
    firstBuyTs: 1_000,
    lastActivityTs: 5_000,
    entryMcap: 3_000,
    entryPriceUsd: 0.000003,
    avgBuyPriceUsd: 0.000003,
    avgBuyMcap: 3_000,
    peakTokens: 10_000_000,
    totalBoughtTokens: 10_000_000,
    totalSoldTokens: 0,
    totalBoughtUsd: 30,
    totalSoldUsd: 0,
    receivedTokens: 0,
    sentTokens: 0,
    balanceTokens: 10_000_000,
    unrealizedUsd: 270,
    realizedUsd: 0,
    totalPnlUsd: 270,
    roi: 9,
    peakMcapBeforeFirstSell: 30_000,
    heldMultiple: 10,
    realizedMultiple: 0,
    currentMultiple: 10,
    firstSellTs: null,
    holdSeconds: null,
    stillHolding: true,
    fullyExited: false,
    buyCount: 2,
    sellCount: 0,
    trades: [] as Trade[],
  };
  return { ...base, ...over };
}

export function makeToken(over: Partial<TokenMeta> = {}): TokenMeta {
  return {
    chain: 'solana',
    address: 'MintAddress1111111111111111111111111111111',
    name: 'Test Coin',
    symbol: 'TEST',
    decimals: 6,
    totalSupply: SUPPLY,
    dev: 'DevWa11et111111111111111111111111111111111',
    launchpad: 'pump.fun',
    createdAt: 1_000,
    pairAddress: 'Poo1Address111111111111111111111111111111',
    dexId: 'pumpswap',
    priceUsd: 0.00003,
    mcap: 30_000,
    liquidityUsd: 12_000,
    volume24hUsd: 90_000,
    holderCount: 1_200,
    imageUrl: null,
    safety: {},
    ...over,
  };
}

export function makeProviderEntry(over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    wallet: 'Prov1derWa11et11111111111111111111111111111',
    tier: 'floor',
    entryMcap: 2_500,
    entryPriceUsd: 0.0000025,
    entryTs: 1_010,
    entryRank: 1,
    secondsAfterLaunch: 10,
    investedUsd: 300,
    soldUsd: 900,
    totalPnlUsd: 600,
    movedOutTokens: 0,
    everHeldTokens: 1_000_000,
    holdingTokens: 0,
    supplyPct: 1.2,
    buyCount: 3,
    sellCount: 2,
    holdSeconds: 3_600,
    stillHolding: false,
    realizedMultiple: 3,
    currentMultiple: 12,
    heldMultiple: 12,
    peakMcapBeforeFirstSell: 30_000,
    ...over,
  };
}

export function makeReport(over: Partial<AnalysisReport> = {}): AnalysisReport {
  const ledger = makeLedger();
  const floorEntries: EarlyBuyer[] = [
    { ledger, tier: 'floor', entryRank: 1, secondsAfterLaunch: 12, supplyPct: 1.0 },
  ];
  const diamondHands: DiamondHand[] = [
    { ledger, bucket: 10, entryTier: 'floor', supplyPct: 1.0 },
  ];
  const linkedWallets: LinkedWallet[] = [
    {
      wallet: 'Linked1111111111111111111111111111111111111',
      links: ['funded-by-dev'],
      strength: 86,
      hops: 1,
      via: null,
      ledger,
    },
  ];
  const relaySource = makeLedger({ wallet: 'Source111111111111111111111111111111111111' });
  const relaySink = makeLedger({ wallet: 'Sink11111111111111111111111111111111111111', buyCount: 0 });
  const supplyRelays: SupplyRelay[] = [
    {
      source: relaySource.wallet,
      sink: relaySink.wallet,
      transfers: [
        { ts: 2_000, from: relaySource.wallet, to: relaySink.wallet, tokenAmount: 5_000_000, usdAtTransfer: 50, tx: 'tx1', block: 2 },
      ],
      tokensRelayed: 5_000_000,
      relaySupplyPct: 0.5,
      sinkSoldUsd: 400,
      sinkSellRatio: 0.95,
      sourceLedger: relaySource,
      sinkLedger: relaySink,
      sourceEntryMcap: 3_000,
      sourceEntryTier: 'floor',
      combinedTakeUsd: 400,
      suspicion: 82,
      flags: ['Source caught the floor', 'Sink never bought — pure exit wallet'],
    },
  ];

  return {
    token: makeToken(),
    generatedAt: 9_999,
    floorMcap: 2_200,
    floorSource: 'launchpad',
    floorBandMax: 3_850,
    entryBandMin: 2_200,
    entryBandRebased: false,
    peakMcap: 60_000,
    firstTradeTs: 1_000,
    tradeCount: 1_500,
    uniqueWallets: 400,
    truncated: false,
    coverageComplete: true,
    coverageFrom: 1_000,
    reachedLaunch: true,
    mcapSeries: [2_200, 5_000, 12_000, 30_000],
    floorEntries,
    providerEntries: [],
    diamondHands,
    providerDiamondHands: [],
    devWallet: 'DevWa11et111111111111111111111111111111111',
    devLedger: ledger,
    linkedWallets,
    supplyRelays,
    smartMoney: {},
    provenWinners: [],
    sideClusters: [],
    winningPlays: [],
    repeatOffenders: [],
    winnersChecked: 0,
    warnings: [],
    ...over,
  };
}
