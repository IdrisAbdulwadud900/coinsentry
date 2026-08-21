import { describe, it, expect } from 'vitest';
import { makeReport, makeToken, makeLedger, makeProviderEntry } from './fixtures.js';
import { renderOverview } from '../src/bot/render/overview.js';
import {
  renderFloorEntries,
  renderProviderEntries,
  renderProvenWinners,
  renderWinningPlay,
  renderDiamondHands,
  renderDevCluster,
  renderRelays,
  renderRisk,
  renderWallet,
} from '../src/bot/render/screens.js';
import { homeKeyboard, listKeyboard, walletKeyboard, simpleBack } from '../src/bot/keyboards.js';
import type { AnalysisReport } from '../src/types/domain.js';

/**
 * Every screen is checked against what Telegram actually accepts, because a
 * violation is not caught by types or by a passing render — it surfaces as a
 * 400 at send time, which reads to a user as a dead button.
 */

// parse_mode=HTML supports only this set; anything else is rejected outright.
const ALLOWED = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'span',
]);

function tagsOf(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z-]+)[^>]*>/g)].map((m) => m[1]!.toLowerCase());
}

/** Text with every tag stripped, to check for stray angle brackets. */
function stripTags(html: string): string {
  return html.replace(/<\/?[a-zA-Z-]+[^>]*>/g, '');
}

function checkHtml(name: string, html: string) {
  for (const tag of tagsOf(html)) {
    expect(ALLOWED.has(tag), `${name} uses <${tag}>, which Telegram rejects`).toBe(true);
  }

  // Balance, honouring nesting order.
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z-]+)[^>]*>/g)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (closing) {
      expect(stack.pop(), `${name} closes </${tag}> out of order`).toBe(tag);
    } else {
      stack.push(tag);
    }
  }
  expect(stack, `${name} leaves tags unclosed`).toEqual([]);

  // A bare < or & in the text is what an unescaped symbol or name looks like.
  const text = stripTags(html);
  expect(text.includes('<'), `${name} has an unescaped '<'`).toBe(false);
  expect(/&(?!(amp|lt|gt|quot|#\d+);)/.test(text), `${name} has an unescaped '&'`).toBe(false);

  expect(html.length, `${name} exceeds Telegram's 4096-char limit`).toBeLessThanOrEqual(4096);
}

/** A report with every optional section populated, so no branch goes unrendered. */
function fullReport(): AnalysisReport {
  const ledger = makeLedger();
  return makeReport({
    // Names really do contain these characters, and they reach the screen.
    token: makeToken({ name: 'Tom & Jerry <script>', symbol: 'A&B<>' }),
    providerEntries: [makeProviderEntry()],
    providerDiamondHands: [makeProviderEntry()],
    warnings: ['A warning with <angle> brackets & an ampersand.'],
    provenWinners: [
      {
        wallet: 'Winner11111111111111111111111111111111111',
        profitUsd: 52_500, investedUsd: 13_600, multiple: 3.85,
        stillHolding: true, repeatWins: 287, repeatProfitUsd: 12_400_000,
        bestOtherMultiple: 128, coinsTraded: 5099,
        sideWallets: [
          { wallet: 'Side111111111111111111111111111111111111', profitUsd: 3_400,
            investedUsd: 170, multiple: 19.7, sharedFunders: 5, linkedSol: 2, direct: false },
        ],
      },
    ],
    sideClusters: [
      {
        members: [
          { wallet: 'A1111111111111111111111111111111111111111', profitUsd: 4_950, multiple: 7 },
          { wallet: 'B1111111111111111111111111111111111111111', profitUsd: 4_620, multiple: 4.77 },
        ],
        sharedFunders: 18, combinedProfitUsd: 9_570, direct: false,
      },
    ],
    winningPlays: [
      { kind: 'scale-trim', wallets: 13, profitUsd: 24_400, medianMultiple: 2.48,
        medianHoldSeconds: 475_000, bestWallet: 'Best11111111111111111111111111111111111', bestProfitUsd: 5_270 },
      { kind: 'snipe-flip', wallets: 13, profitUsd: 17_100, medianMultiple: 4.41,
        medianHoldSeconds: 19, bestWallet: 'Best21111111111111111111111111111111111', bestProfitUsd: 4_670 },
    ],
    smartMoney: {
      [ledger.wallet]: {
        wallet: ledger.wallet, tier: 'elite', totalPnlUsd: 234_000, totalInvestedUsd: 40_000,
        wins: 300, losses: 470, winPercentage: 38.9, roi: 5.85, positions: 770,
      },
    },
    winnersChecked: 12,
  });
}

describe('every screen is valid Telegram HTML', () => {
  const report = fullReport();
  const screens: [string, string][] = [
    ['overview', renderOverview(report)],
    ['floor', renderFloorEntries(report, 0, 'earliest')],
    ['first buyers', renderProviderEntries(report, 0)],
    ['proven winners', renderProvenWinners(report, 0)],
    ['winning play', renderWinningPlay(report)],
    ['diamond hands', renderDiamondHands(report, 0)],
    ['dev cluster', renderDevCluster(report, 0)],
    ['relays', renderRelays(report, 0)],
    ['risk', renderRisk(report)],
    ['wallet', renderWallet(report, report.floorEntries[0]!.ledger)],
  ];

  for (const [name, html] of screens) {
    it(`renders ${name} safely`, () => checkHtml(name, html));
  }

  it('escapes a hostile token name rather than emitting it', () => {
    // The name is attacker-controlled: anyone can deploy a token called
    // "<script>". It must never reach Telegram as markup.
    expect(renderOverview(report)).not.toContain('<script>');
  });
});

describe('empty states are valid too', () => {
  // The empty branches are the ones a normal fixture never exercises.
  const bare = makeReport({
    floorEntries: [], diamondHands: [], linkedWallets: [], supplyRelays: [],
    providerEntries: [], providerDiamondHands: [], devWallet: null, devLedger: null,
    mcapSeries: [], warnings: [],
  });

  const screens: [string, string][] = [
    ['overview', renderOverview(bare)],
    ['floor', renderFloorEntries(bare, 0, 'earliest')],
    ['proven winners', renderProvenWinners(bare, 0)],
    ['winning play', renderWinningPlay(bare)],
    ['diamond hands', renderDiamondHands(bare, 0)],
    ['dev cluster', renderDevCluster(bare, 0)],
    ['relays', renderRelays(bare, 0)],
    ['risk', renderRisk(bare)],
  ];

  for (const [name, html] of screens) {
    it(`renders empty ${name} safely`, () => checkHtml(`empty ${name}`, html));
  }
});

describe('callback payloads fit Telegram\'s 64-byte limit', () => {
  const report = fullReport();
  const id = 'abcdef0123456789';

  const collect = (kb: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }) =>
    kb.inline_keyboard.flat();

  it('every home button carries a payload that fits', () => {
    for (const b of collect(homeKeyboard(id, report))) {
      if (b.callback_data === undefined) {
        expect(b.url, `${b.text} has neither payload nor url`).toBeTruthy();
        continue;
      }
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('list, wallet and back keyboards fit too', () => {
    const info = { page: 3, pages: 9, total: 90, start: 30 };
    const kbs = [
      listKeyboard(id, 'winners', info, {}),
      listKeyboard(id, 'floor', info, { sort: 'earliest', copyKind: 'floor' }),
      // Addresses are deliberately never in a payload — a wallet is addressed
      // by index, which is what keeps this under the limit on Solana.
      walletKeyboard(id, 'floor', 3, { walletIdx: 999, watched: true }),
      simpleBack(id),
    ];
    for (const kb of kbs) {
      for (const b of collect(kb)) {
        if (b.callback_data === undefined) continue;
        expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('a wallet that moved its position out is not reported as flat', () => {
  it('says SENT OUT rather than EXITED, and never a bare $0', async () => {
    // These wallets rode 233x and then transferred everything. Realised PnL is
    // genuinely zero, but "$0 · EXITED · no sells recorded" reads as "made
    // nothing" — the opposite of what happened, and it contradicts the supply
    // relay screen, which exists to show exactly this pattern.
    const { positionBadge, pnl, holdSummary } = await import('../src/bot/ui.js');
    const moved = makeLedger({
      sellCount: 0,
      sentTokens: 5_000_000,
      balanceTokens: 0,
      stillHolding: false,
      fullyExited: true,
      totalPnlUsd: 0,
    });
    expect(positionBadge(moved)).toBe('📤 SENT OUT');
    expect(pnl(0, { moved: true })).not.toContain('$0');
    expect(holdSummary(moved)).toContain('moved the position out');
  });

  it('still says EXITED for a wallet that genuinely sold', async () => {
    const { positionBadge } = await import('../src/bot/ui.js');
    const sold = makeLedger({
      sellCount: 4,
      sentTokens: 0,
      balanceTokens: 0,
      stillHolding: false,
      fullyExited: true,
    });
    expect(positionBadge(sold)).toBe('🚪 EXITED');
  });
});

describe('"none found" and "could not look" are different answers', () => {
  it('says relays were not searched when the scan missed the launch', async () => {
    // A relay is an EARLY wallet passing supply to a seller, so its evidence
    // sits at the start of the coin's life. A scan that only covered the last
    // day of a 176-day-old coin searched the one place relays are least likely
    // to be — reporting that as "none" turns a gap into a clean bill of health.
    const { renderRelays } = await import('../src/bot/render/screens.js');
    const html = renderRelays(
      makeReport({ supplyRelays: [], reachedLaunch: false, providerEntries: [] }),
      0,
    );
    expect(html).toContain('little sign of it');
    expect(renderOverview(makeReport({ supplyRelays: [], reachedLaunch: false }))).toContain(
      'not searched',
    );
  });

  it('names the wallets that moved supply out when the graph is incomplete', async () => {
    // The transfer graph needs a replay the coin was too large for, but the
    // provider's token counts still show the SOURCE half: supply that left a
    // wallet without being sold. Naming those beats saying "not searched".
    const { renderRelays } = await import('../src/bot/render/screens.js');
    const mover = makeProviderEntry({
      wallet: 'Mover11111111111111111111111111111111111',
      movedOutTokens: 600_000,
      everHeldTokens: 1_000_000,
      holdingTokens: 0,
      sellCount: 0,
      entryMcap: 7_500,
    });
    const html = renderRelays(
      makeReport({ supplyRelays: [], reachedLaunch: true, tradeCount: 0, providerEntries: [mover] }),
      0,
    );
    expect(html).toContain('source half');
    expect(html).toContain('60%');
    checkHtml('relay source half', html);
  });

  it('ignores a dust remainder rather than calling it a transfer out', async () => {
    const { movedSupplyOut } = await import('../src/engine/providerEntries.js');
    const dust = makeProviderEntry({ movedOutTokens: 1, everHeldTokens: 1_000_000 });
    expect(movedSupplyOut([dust])).toHaveLength(0);
  });

  it('still reports a clean result when the launch was reached', async () => {
    const { renderRelays } = await import('../src/bot/render/screens.js');
    const html = renderRelays(
      makeReport({ supplyRelays: [], reachedLaunch: true, tradeCount: 1_500 }),
      0,
    );
    expect(html).toContain('clean result');
    expect(renderOverview(makeReport({ supplyRelays: [], reachedLaunch: true }))).toContain('none');
  });
});


describe('alerts are valid Telegram HTML too', () => {
  // Alerts are the one message the user never asked for and cannot retry. If
  // Telegram rejects one, the tracked-wallet buy they were waiting for simply
  // never arrives, with nothing on screen to show it went wrong.
  const alert = (over: Record<string, unknown> = {}) => ({
    wallet: '7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8',
    mint: 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump',
    // Token names are attacker-controlled: anyone can deploy "<script> & co".
    symbol: 'A&B<>',
    name: 'Tom & Jerry <script>',
    tokenAmount: 1_234_567,
    solSpent: 2.5,
    usdSpent: 480,
    mcapUsd: 42_000,
    note: 'Found on $TRIPLET & friends <hi>',
    signature: '5'.repeat(64),
    ...over,
  });

  it('renders a plain buy alert safely', async () => {
    const { renderBuyAlert } = await import('../src/bot/render/screens.js');
    checkHtml('buy alert', renderBuyAlert(alert()));
  });

  it('renders a convergence alert safely', async () => {
    const { renderBuyAlert } = await import('../src/bot/render/screens.js');
    checkHtml(
      'convergence alert',
      renderBuyAlert(
        alert({
          convergence: {
            wallets: ['7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8', 'DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm'],
            totalSolSpent: 9.25,
            firstTs: Math.floor(Date.now() / 1000) - 600,
          },
        }),
      ),
    );
  });

  it('renders honeypot flags safely', async () => {
    const { renderBuyAlert } = await import('../src/bot/render/screens.js');
    checkHtml(
      'flagged alert',
      renderBuyAlert(alert({ freezeAuthorityActive: true, mintAuthorityActive: true })),
    );
  });

  it('never emits a hostile token name as markup', async () => {
    const { renderBuyAlert } = await import('../src/bot/render/screens.js');
    expect(renderBuyAlert(alert())).not.toContain('<script>');
  });

  it('renders the watchlist safely, including an empty one', async () => {
    const { renderWatchlist } = await import('../src/bot/render/screens.js');
    checkHtml('watchlist', renderWatchlist([
      { wallet: '7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8', note: 'Found on $A & B <x>', addedAt: 1_700_000_000 },
    ]));
    checkHtml('empty watchlist', renderWatchlist([]));
  });
});
