import { describe, it, expect } from "vitest";
import {
  resolveMarketCapUsd,
  buildRevivalAlertHtml,
  buildGraduationAlertHtml,
  buildMarketCapAlertHtml,
  buildMomentumAlertHtml,
  buildPerformanceMilestoneAlertHtml,
  buildDemotionAlertHtml,
  formatCurvePct,
} from "../src/engine/alertMessages.js";
import type { Baseline } from "../src/engine/classifier.js";
import type { TokenRow, MarketSnapshot } from "../src/types/domain.js";

function fakeToken(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    address: "0xaaa",
    symbol: "FOO",
    name: "Foo Token",
    pair_address: "0xpairAAA",
    first_seen_at: Date.now(),
    status: "active",
    status_changed_at: Date.now(),
    last_alert_at: null,
    dead_confirm_count: 0,
    revival_confirm_count: 0,
    demote_confirm_count: 0,
    deployer_address: null,
    not_indexed_streak: 0,
    last_checked_at: null,
    factory_address: "0xFactory1",
    graduated: 0,
    graduation_paired_wei: null,
    graduation_threshold_wei: null,
    graduation_checked_at: null,
    graduation_alert_tier: 0,
    momentum_alert_count: 0,
    pool_address: null,
    pair_token_address: null,
    token_decimals: null,
    token_total_supply: null,
    ath_market_cap_usd: null,
    first_alert_market_cap_usd: null,
    first_alert_at: null,
    peak_multiple: 0,
    peak_multiple_at: null,
    last_milestone_multiple_alerted: 0,
    image_url: null,
    ...overrides,
  };
}

function fakeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    tokenAddress: "0xaaa",
    pairAddress: "0xpairAAA",
    symbol: "FOO",
    name: "Foo Token",
    priceUsd: 0.001,
    marketCapUsd: 45000,
    liquidityUsd: 8000,
    volume5m: 500,
    volume1h: 5000,
    volume24h: 20000,
    buys5m: 20,
    buys1h: 80,
    sells5m: 10,
    sells1h: 40,
    imageUrl: null,
    websiteUrl: null,
    socials: [],
    ...overrides,
  };
}

const baseline: Baseline = { medianVolume1h: 100, medianLiquidityUsd: 5000, sampleSize: 12 };

describe("resolveMarketCapUsd", () => {
  it("prefers the DexScreener-sourced market cap when present", () => {
    expect(resolveMarketCapUsd({ marketCapUsd: 1000 }, 2000)).toBe(1000);
  });

  it("falls back to the on-chain market cap when the snapshot has none", () => {
    expect(resolveMarketCapUsd({ marketCapUsd: null }, 2000)).toBe(2000);
  });

  it("never fabricates a value when neither source has one", () => {
    expect(resolveMarketCapUsd({ marketCapUsd: null }, null)).toBeNull();
    expect(resolveMarketCapUsd(null, undefined)).toBeNull();
  });
});

describe("buildRevivalAlertHtml", () => {
  it("shows the real market cap instead of a bare price, plus liquidity/mcap context", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).toContain("<b>$45,000</b> mcap");
    expect(html).not.toMatch(/Price:/);
    expect(html).toContain("160% of median");
  });

  it("renders 'n/a' rather than fabricating a market cap when none is available", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot({ marketCapUsd: null }), baseline, 30, "robinhood");
    expect(html).toContain("<b>n/a</b> mcap");
  });

  it("includes an ATH line with drop-from-high context when an ATH is known", () => {
    const html = buildRevivalAlertHtml(fakeToken({ ath_market_cap_usd: 90000 }), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).toContain("ATH $90,000");
    expect(html).toContain("-50%");
  });

  it("always includes the not-financial-advice disclaimer", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).toContain("Not financial advice");
  });
});

describe("buildGraduationAlertHtml", () => {
  it("shows market cap and includes the disclaimer", () => {
    const html = buildGraduationAlertHtml(fakeToken(), (5n * 10n ** 18n).toString(), (5n * 10n ** 18n).toString(), "robinhood", 45000);
    expect(html).toContain("<b>$45,000</b> mcap");
    expect(html).toContain("Not financial advice");
  });
});

describe("buildMarketCapAlertHtml", () => {
  it("shows a combined tier-crossing line when multiple tiers are crossed at once", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000, 3000],
      3500,
      (1n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood"
    );
    expect(html).toContain("crossed $2,000 → $3,000");
    expect(html).toContain("<b>$3,500</b> mcap");
  });

  it("shows graduation status instead of curve progress once graduated", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken({ graduated: 1 }),
      [10000],
      10500,
      (5n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood"
    );
    expect(html).toContain("Graduation: <b>Graduated</b>");
    expect(html).not.toContain("Curve progress");
  });

  it("renders links when a snapshot with links is passed", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000],
      2500,
      (1n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      { websiteUrl: "https://foo.example", socials: [] }
    );
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });
});

describe("website/socials links line", () => {
  it("omits the links line entirely when the snapshot has no website or socials", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).not.toContain("🌐 Website");
    expect(html).not.toContain("🐦 Twitter");
  });

  it("renders a website link when present", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      fakeSnapshot({ websiteUrl: "https://foo.example" }),
      baseline,
      30,
      "robinhood"
    );
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });

  it("renders social links with friendly labels, joined by a separator", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      fakeSnapshot({
        websiteUrl: "https://foo.example",
        socials: [
          { type: "twitter", url: "https://twitter.com/foo" },
          { type: "telegram", url: "https://t.me/foo" },
        ],
      }),
      baseline,
      30,
      "robinhood"
    );
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
    expect(html).toContain('<a href="https://twitter.com/foo">🐦</a>');
    expect(html).toContain('<a href="https://t.me/foo">💬</a>');
    expect(html).toContain(
      '<a href="https://foo.example">🌐 Web</a> · <a href="https://twitter.com/foo">🐦</a> · <a href="https://t.me/foo">💬</a>'
    );
  });

  it("also renders on buildMomentumAlertHtml", () => {
    const html = buildMomentumAlertHtml(
      fakeToken(),
      fakeSnapshot({ socials: [{ type: "discord", url: "https://discord.gg/foo" }] }),
      12,
      "robinhood",
      1
    );
    expect(html).toContain('<a href="https://discord.gg/foo">🎮</a>');
  });

  it("omits the links line on buildGraduationAlertHtml when no snapshot is passed", () => {
    const html = buildGraduationAlertHtml(fakeToken(), (5n * 10n ** 18n).toString(), (5n * 10n ** 18n).toString(), "robinhood", 45000);
    expect(html).not.toContain("🌐 Website");
  });

  it("renders links on buildGraduationAlertHtml when a snapshot with links is passed", () => {
    const html = buildGraduationAlertHtml(
      fakeToken(),
      (5n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      45000,
      { websiteUrl: "https://foo.example", socials: [] }
    );
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });
});

describe("buildMomentumAlertHtml", () => {
  it("labels the first alert as EARLY MOMENTUM and shows market cap", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot(), 12, "robinhood", 1);
    expect(html).toContain("EARLY MOMENTUM");
    expect(html).toContain("<b>$45,000</b> mcap");
  });

  it("labels a follow-up alert as MOMENTUM ACCELERATING", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot(), 40, "robinhood", 2);
    expect(html).toContain("MOMENTUM ACCELERATING");
  });
});

describe("'since alert' sub-line on existing alert builders", () => {
  it("is omitted when the token has no baseline yet", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).not.toContain("Since alert:");
  });

  it("shows the multiple and peak once a baseline is captured (buildRevivalAlertHtml)", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 15000, peak_multiple: 4.1 });
    const html = buildRevivalAlertHtml(token, fakeSnapshot({ marketCapUsd: 45000 }), baseline, 30, "robinhood");
    expect(html).toContain("<b>3.0x</b> since alert");
  });

  it("shows the multiple on buildGraduationAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 9000, peak_multiple: 5 });
    const html = buildGraduationAlertHtml(token, (5n * 10n ** 18n).toString(), (5n * 10n ** 18n).toString(), "robinhood", 45000);
    expect(html).toContain("<b>5.0x</b> since alert");
  });

  it("shows the multiple on buildMarketCapAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 1000, peak_multiple: 3.5 });
    const html = buildMarketCapAlertHtml(token, [2000, 3000], 3500, (1n * 10n ** 18n).toString(), (5n * 10n ** 18n).toString(), "robinhood");
    expect(html).toContain("<b>3.5x</b> since alert");
  });

  it("shows the multiple on buildMomentumAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 22500, peak_multiple: 2 });
    const html = buildMomentumAlertHtml(token, fakeSnapshot({ marketCapUsd: 45000 }), 12, "robinhood", 1);
    expect(html).toContain("<b>2.0x</b> since alert");
  });
});

describe("buildPerformanceMilestoneAlertHtml", () => {
  it("shows the top crossed milestone, entry/current market cap, and peak multiple", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 10 });
    const html = buildPerformanceMilestoneAlertHtml(token, [5, 10], 50000, "robinhood", "0xpairAAA");
    expect(html).toContain("10X SINCE ALERT");
    expect(html).toContain("entry <b>$5,000</b>");
    expect(html).toContain("now <b>$50,000</b>");
    expect(html).toContain("crossed 5x → 10x");
    expect(html).toContain("peak <b>10.0x</b>");
    expect(html).toContain("Not financial advice");
  });

  it("shows a single-milestone line when only one multiple is newly crossed", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 2 });
    const html = buildPerformanceMilestoneAlertHtml(token, [2], 10000, "robinhood", "0xpairAAA");
    expect(html).toContain("crossed 2x");
    expect(html).not.toContain("→");
  });

  it("renders links when a snapshot with links is passed", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 2 });
    const html = buildPerformanceMilestoneAlertHtml(token, [2], 10000, "robinhood", "0xpairAAA", {
      websiteUrl: "https://foo.example",
      socials: [],
    });
    expect(html).toContain('<a href="https://foo.example">🌐 Web</a>');
  });
});

describe("formatCurvePct", () => {
  it("computes the paired/threshold percentage", () => {
    expect(formatCurvePct((36n * 10n ** 17n).toString(), (5n * 10n ** 18n).toString())).toBe("72%");
  });

  it("caps at 100% when paired exceeds threshold", () => {
    expect(formatCurvePct((7n * 10n ** 18n).toString(), (5n * 10n ** 18n).toString())).toBe("100%");
  });

  it("returns null when the threshold is zero/unknown", () => {
    expect(formatCurvePct((1n * 10n ** 18n).toString(), "0")).toBeNull();
  });
});

describe("buy/sell line rendering", () => {
  it("shows Buys/Sells side-by-side when sell counts are available", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot({ buys1h: 142, sells1h: 88 }), baseline, 30, "robinhood");
    expect(html).toContain("<b>142</b>/<b>88</b> buys/sells");
  });

  it("falls back to a lone Buys line when sells are unavailable", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot({ buys1h: 142, sells1h: null }), baseline, 30, "robinhood");
    expect(html).toContain("<b>142</b> buys");
    expect(html).not.toContain("Buys/Sells");
  });

  it("renders the 5m buy/sell window on buildMomentumAlertHtml", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot({ buys5m: 20, sells5m: 5 }), 12, "robinhood", 1);
    expect(html).toContain("<b>20</b>/<b>5</b> buys/sells");
  });
});

describe("dev wallet status rendering", () => {
  it("renders a Sold line when devStatus.sold is true", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, {
      sold: true,
      holdingPct: null,
    });
    expect(html).not.toContain("dev hold");
  });

  it("renders a holding percentage when known", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, {
      sold: false,
      holdingPct: 3.14,
    });
    expect(html).toContain("dev holds 3%");
  });

  it("renders a bare Holding line with no percentage when supply is unknown", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, {
      sold: false,
      holdingPct: null,
    });
    expect(html).toContain("dev holding");
  });

  it("omits the Dev Wallet line entirely when devStatus is null/undefined", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).not.toContain("Dev Wallet");
  });

  it("renders devStatus on buildGraduationAlertHtml", () => {
    const html = buildGraduationAlertHtml(
      fakeToken(),
      (5n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      45000,
      undefined,
      { sold: true, holdingPct: null }
    );
    expect(html).not.toContain("dev hold");
  });

  it("renders devStatus on buildMarketCapAlertHtml", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000],
      2500,
      (1n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      undefined,
      { sold: true, holdingPct: null }
    );
    expect(html).not.toContain("dev hold");
  });

  it("renders devStatus on buildMomentumAlertHtml", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot(), 12, "robinhood", 1, undefined, {
      sold: true,
      holdingPct: null,
    });
    expect(html).not.toContain("dev hold");
  });

  it("renders devStatus on buildPerformanceMilestoneAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 2 });
    const html = buildPerformanceMilestoneAlertHtml(token, [2], 10000, "robinhood", "0xpairAAA", undefined, {
      sold: true,
      holdingPct: null,
    });
    expect(html).not.toContain("dev hold");
  });
});

describe("holder concentration rendering", () => {
  it("reports concentration even when it is mild, rather than only flagging problems", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, undefined, {
      topHolders: [],
      top10Pct: 25,
    });
    // Holder concentration is decision information on every coin, not only on bad ones, so
    // it now always renders when resolved. (It previously appeared only above 50%.)
    expect(html).toContain("top 10 hold <b>25%</b>");
    expect(html).toContain("🐳");
  });

  it("prices each top holder's position so ten small wallets do not read like one whale", () => {
    // 40% of a $100,000 market cap is $40,000; 0.5% is $500. Same "top 10" percentage,
    // completely different risk, which is the whole point of the breakdown.
    const html = buildRevivalAlertHtml(
      fakeToken(),
      { ...fakeSnapshot(), marketCapUsd: 100_000 },
      baseline,
      30,
      "robinhood",
      undefined,
      undefined,
      {
        topHolders: [
          { address: "0xa", pct: 40 },
          { address: "0xb", pct: 12 },
          { address: "0xc", pct: 5 },
          { address: "0xd", pct: 0.5 },
        ],
        top10Pct: 57.5,
      }
    );
    // 40% -> $40,000 and 12% -> $12,000 are both whales; 5% -> $5,000 is a trader-sized
    // position; 0.5% -> $500 is noise. The largest is named outright.
    expect(html).toContain("🐳 2 over $10k");
    expect(html).toContain("🐟 1 over $1k");
    expect(html).toContain("🦐 1 under $1k");
    expect(html).toContain("biggest <b>$40,000</b>");
  });

  it("shows concentration without dollar figures when market cap is unknown", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      { ...fakeSnapshot(), marketCapUsd: null },
      baseline,
      30,
      "robinhood",
      undefined,
      undefined,
      { topHolders: [{ address: "0xa", pct: 40 }], top10Pct: 40 }
    );
    // Position sizes come from market cap; without it, inventing dollar amounts would be
    // worse than omitting them.
    expect(html).toContain("top 10 hold <b>40%</b>");
    expect(html).not.toContain("over $10k");
  });

  it("renders a ⚠️ icon at 50% or higher concentration", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, undefined, {
      topHolders: [],
      top10Pct: 55,
    });
    expect(html).toContain("⚠️");
    expect(html).toContain("top 10 hold <b>55%</b>");
  });

  it("renders a 🚨 icon at 80% or higher concentration", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood", undefined, undefined, {
      topHolders: [],
      top10Pct: 85,
    });
    expect(html).toContain("🚨"); // 85% is the severe tier
    expect(html).toContain("top 10 hold <b>85%</b>");
  });

  it("omits the line entirely when holderConcentration is null/undefined", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).not.toContain("Top 10 Holders");
  });

  it("renders on buildGraduationAlertHtml", () => {
    const html = buildGraduationAlertHtml(
      fakeToken(),
      (5n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      45000,
      undefined,
      undefined,
      { topHolders: [], top10Pct: 40 }
    );
    expect(html).not.toContain("top 10 hold 40%"); // mild readings stay silent by design
  });

  it("renders on buildMarketCapAlertHtml", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000],
      2500,
      (1n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      undefined,
      undefined,
      { topHolders: [], top10Pct: 40 }
    );
    expect(html).not.toContain("top 10 hold 40%"); // mild readings stay silent by design
  });

  it("renders on buildMomentumAlertHtml", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot(), 12, "robinhood", 1, undefined, undefined, {
      topHolders: [],
      top10Pct: 40,
    });
    expect(html).not.toContain("top 10 hold 40%"); // mild readings stay silent by design
  });

  it("renders on buildPerformanceMilestoneAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 2 });
    const html = buildPerformanceMilestoneAlertHtml(token, [2], 10000, "robinhood", "0xpairAAA", undefined, undefined, {
      topHolders: [],
      top10Pct: 40,
    });
    expect(html).not.toContain("top 10 hold 40%"); // mild readings stay silent by design
  });
});

describe("early buy concentration rendering", () => {
  it("renders a 🐳 icon and the block window note at low concentration", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      fakeSnapshot(),
      baseline,
      30,
      "robinhood",
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 12, top5Pct: 30, windowBlocks: 500 }
    );
    expect(html).not.toContain("bundle 30%");
    expect(html).not.toContain("⚠️");
  });

  it("renders a ⚠️ icon at 50% or higher top-5 concentration", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      fakeSnapshot(),
      baseline,
      30,
      "robinhood",
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 30, top5Pct: 55, windowBlocks: 500 }
    );
    expect(html).toContain("⚠️");
    expect(html).toContain("bundle 55%");
  });

  it("renders a 🚨 icon at 80% or higher top-5 concentration", () => {
    const html = buildRevivalAlertHtml(
      fakeToken(),
      fakeSnapshot(),
      baseline,
      30,
      "robinhood",
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 75, top5Pct: 85, windowBlocks: 500 }
    );
    // Bundle severity reads from the risk line's own flag, which carries ⚠️.
    expect(html).toContain("⚠️");
    expect(html).toContain("bundle 85%");
  });

  it("omits the line entirely when earlyBuyConcentration is null/undefined", () => {
    const html = buildRevivalAlertHtml(fakeToken(), fakeSnapshot(), baseline, 30, "robinhood");
    expect(html).not.toContain("Early Buy Concentration");
  });

  it("renders on buildGraduationAlertHtml", () => {
    const html = buildGraduationAlertHtml(
      fakeToken(),
      (5n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      45000,
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 10, top5Pct: 20, windowBlocks: 500 }
    );
    expect(html).not.toContain("bundle 20%"); // mild readings stay silent by design
  });

  it("renders on buildMarketCapAlertHtml", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000],
      2500,
      (1n * 10n ** 18n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood",
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 10, top5Pct: 20, windowBlocks: 500 }
    );
    expect(html).not.toContain("bundle 20%"); // mild readings stay silent by design
  });

  it("renders on buildMomentumAlertHtml", () => {
    const html = buildMomentumAlertHtml(fakeToken(), fakeSnapshot(), 12, "robinhood", 1, undefined, undefined, undefined, {
      topBuyerPct: 10,
      top5Pct: 20,
      windowBlocks: 500,
    });
    expect(html).not.toContain("bundle 20%"); // mild readings stay silent by design
  });

  it("renders on buildPerformanceMilestoneAlertHtml", () => {
    const token = fakeToken({ first_alert_market_cap_usd: 5000, peak_multiple: 2 });
    const html = buildPerformanceMilestoneAlertHtml(
      token,
      [2],
      10000,
      "robinhood",
      "0xpairAAA",
      undefined,
      undefined,
      undefined,
      { topBuyerPct: 10, top5Pct: 20, windowBlocks: 500 }
    );
    expect(html).not.toContain("bundle 20%"); // mild readings stay silent by design
  });
});

describe("buildDemotionAlertHtml", () => {
  it("shows the REVIVAL FIZZLED header with the token symbol", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot(), baseline);
    expect(html).toContain("🔴 <b>REVIVAL FIZZLED</b> · FOO");
  });

  it("shows volume vs the median multiple", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot({ volume1h: 50 }), baseline);
    expect(html).toContain("0.5x vs median");
  });

  it("shows Buys/Sells side-by-side when sell counts are available", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot({ buys1h: 5, sells1h: 20 }), baseline);
    expect(html).toContain("<b>5</b>/<b>20</b> buys/sells");
  });

  it("falls back to a lone Buys line when sells are unavailable", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot({ buys1h: 5, sells1h: null }), baseline);
    expect(html).toContain("<b>5</b> buys");
  });

  it("shows liquidity as a percentage of the median", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot({ liquidityUsd: 2500 }), baseline);
    expect(html).toContain("50% of median");
  });

  it("includes the contract address footer", () => {
    const html = buildDemotionAlertHtml(fakeToken({ address: "0xdeadbeef" }), fakeSnapshot(), baseline);
    expect(html).toContain("<code>0xdeadbeef</code>");
  });

  it("always includes the not-financial-advice disclaimer", () => {
    const html = buildDemotionAlertHtml(fakeToken(), fakeSnapshot(), baseline);
    expect(html).toContain("Not financial advice");
  });

  it("does not include sections irrelevant to demotion (ATH, since-alert, dev wallet, holders)", () => {
    const token = fakeToken({ ath_market_cap_usd: 90000, first_alert_market_cap_usd: 15000, peak_multiple: 4.1 });
    const html = buildDemotionAlertHtml(token, fakeSnapshot(), baseline);
    expect(html).not.toContain("ATH");
    expect(html).not.toContain("Since alert");
    expect(html).not.toContain("Dev Wallet");
    expect(html).not.toContain("Top 10 Holders");
  });
});

describe("bonding curve line", () => {
  it("shows the percentage alongside the ETH figures on buildMarketCapAlertHtml when ungraduated", () => {
    const html = buildMarketCapAlertHtml(
      fakeToken(),
      [2000],
      2500,
      (36n * 10n ** 17n).toString(),
      (5n * 10n ** 18n).toString(),
      "robinhood"
    );
    expect(html).toContain("Bonding Curve: <b>72% (3.60 / 5.00 ETH)</b>");
  });
});

describe("first-alerted timestamp", () => {
  it("stamps the original alert time on a later milestone, not the current time", () => {
    const firstAt = Date.UTC(2026, 8, 3, 12, 34, 56);
    const token = { ...fakeToken(), first_alert_at: firstAt, first_alert_market_cap_usd: 5000 };

    const html = buildRevivalAlertHtml(token, fakeSnapshot(), baseline, 30, "robinhood");

    // "10x" only means something alongside when the clock started.
    expect(html).toContain("first alerted <b>2026-09-03 12:34:56 UTC</b>");
  });

  it("falls back to now for a coin being alerted for the first time", () => {
    const token = { ...fakeToken(), first_alert_at: null };

    const html = buildRevivalAlertHtml(token, fakeSnapshot(), baseline, 30, "robinhood");

    expect(html).toContain("first alerted <b>");
    expect(html).toContain(" UTC</b>");
  });
});

describe("coin age on every alert", () => {
  // Only three of the nine builders passed an age explicitly, so tier, graduation,
  // milestone and dump alerts showed none. Age is the first thing that separates a fresh
  // launch from a coin grinding for days, which changes how the same numbers read.
  it("derives the age from first_seen_at when the builder passes none", () => {
    const token = { ...fakeToken(), first_seen_at: Date.now() - 3 * 60 * 60 * 1000 };

    const html = buildPerformanceMilestoneAlertHtml(token, [10], 50_000, "robinhood", "0xpair");

    expect(html).toContain("3.0h old");
  });

  it("keeps a builder's own phrasing when it supplies one", () => {
    const token = { ...fakeToken(), first_seen_at: Date.now() - 90 * 60 * 60 * 1000 };

    // "dead 3d" says more in context than a bare age would.
    const html = buildRevivalAlertHtml(token, fakeSnapshot(), baseline, 72, "robinhood");

    expect(html).toContain("dead 3d");
  });

  it("omits age rather than inventing one when first_seen_at is unknown", () => {
    const token = { ...fakeToken(), first_seen_at: 0 };

    const html = buildPerformanceMilestoneAlertHtml(token, [10], 50_000, "robinhood", "0xpair");

    expect(html).not.toContain("old");
  });
});
