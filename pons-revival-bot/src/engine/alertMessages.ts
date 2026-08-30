import type { TokenRow, MarketSnapshot } from "../types/domain.js";
import type { Baseline } from "./classifier.js";
import type { HolderConcentration } from "../data/blockscoutClient.js";
import type { EarlyBuyConcentrationResult } from "../data/chainClient.js";
import { chainBadge } from "../data/chains.js";
import type { SolanaMintSafety } from "../data/solanaClient.js";
import type { XMention } from "../data/xSearchClient.js";

/** Real early-buyer concentration ("bundle %"), plus the block window it was computed
 * over so the alert line can show its own scope (e.g. "first 500 blocks"). */
export interface EarlyBuyConcentration extends EarlyBuyConcentrationResult {
  windowBlocks: number;
}

function formatUsd(value: number | null): string {
  if (value == null) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatDuration(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return `${days}d ${rem}h`;
}

function formatMultiple(current: number, baseline: number): string {
  if (baseline <= 0) return "n/a";
  return `${(current / baseline).toFixed(1)}x`;
}

export function weiToEthString(wei: string): string {
  return (Number(BigInt(wei)) / 1e18).toFixed(2);
}

/** Bonding-curve completion percentage (paired / threshold, capped at 100%), or null
 * when the threshold is unknown/zero. Purely derived from the same real wei figures
 * already shown as "X / Y ETH" — never a separate/fabricated source. */
export function formatCurvePct(pairedWei: string, thresholdWei: string): string | null {
  const threshold = Number(BigInt(thresholdWei));
  if (threshold <= 0) return null;
  const paired = Number(BigInt(pairedWei));
  const pct = Math.min(100, (paired / threshold) * 100);
  return `${pct.toFixed(0)}%`;
}

/** Real, on-chain-observed status of the deployer wallet's holdings for this token,
 * resolved via a single `balanceOf` read at alert-send time. `holdingPct` is only ever
 * populated from real cached decimals/totalSupply — never fabricated; `null` means the
 * wallet holds tokens but we don't have a reliable supply figure to compute a percentage. */
export interface DevStatus {
  sold: boolean;
  holdingPct: number | null;
}

/** Friendly display symbol for a token — falls back to "New Token" instead of a bare
 * "?" placeholder when DexScreener hasn't indexed the token's identity yet. Purely
 * cosmetic; never affects the real `token.symbol` value stored elsewhere. */
function displaySymbol(token: TokenRow): string {
  return token.symbol && token.symbol !== "?" ? token.symbol : "New Token";
}

/** "◎ Solana" chain badge line, so a multi-chain alert always states which chain the
 * coin is on. Reads the real stored chain — never inferred; omitted entirely on the
 * (schema-impossible) chance the field is absent rather than rendering a placeholder. */
function formatChainLine(token: TokenRow): string | undefined {
  return token.chain ? line("🔗", "Chain", chainBadge(token.chain)) : undefined;
}

/** A single metric line, e.g. "💰 Market Cap: <b>$45,000</b>", optionally followed by a
 * de-emphasized italic note in parens, e.g. "📊 Volume (1h): <b>$12,340</b> <i>(8.2x vs
 * median)</i>". Replaces the old separate indented "↳" sub-line so each data point costs
 * one line instead of two. */
function line(icon: string, label: string, value: string, note?: string): string {
  const base = `${icon} ${label}: <b>${value}</b>`;
  return note ? `${base} <i>(${note})</i>` : base;
}

/** "👤 Dev Wallet: ✅ Sold" / "⚠️ Holding 3.1%" / "⚠️ Holding" line, or undefined when no
 * dev status could be resolved (on-chain read failed, or no deployer address on record) —
 * omitted entirely rather than guessing. */
function formatDevStatusLine(devStatus: DevStatus | null | undefined): string | undefined {
  if (!devStatus) return undefined;
  if (devStatus.sold) return line("👤", "Dev Wallet", "✅ Sold");
  const holding = devStatus.holdingPct != null ? `⚠️ Holding ${devStatus.holdingPct.toFixed(1)}%` : "⚠️ Holding";
  return line("👤", "Dev Wallet", holding);
}

/** "🛒 Buys/Sells (1h): 142 / 88" when sell counts are available, falling back to a
 * lone "Buys (1h): 142" when the window's sell count is unavailable — never fabricated. */
function formatBuySellLine(windowLabel: string, buys: number, sells: number | null): string {
  if (sells != null) {
    return line("🛒", `Buys/Sells (${windowLabel})`, `${buys} / ${sells}`);
  }
  return line("🛒", `Buys (${windowLabel})`, String(buys));
}

/**
 * Breaks the top holders into position sizes, so "top 10 hold 42%" becomes something a
 * trader can act on: ten $500 wallets and one $80,000 wallet are the same percentage and
 * completely different risks.
 *
 * Each holder's position is priced exactly, with no extra API calls: a wallet's share of
 * supply multiplied by the coin's market cap *is* the USD value of what it holds, and both
 * numbers are already in hand. Returns undefined when market cap is unknown or untrusted
 * rather than showing dollar figures derived from a price nothing backs.
 */
function formatWhaleBreakdownLine(
  concentration: HolderConcentration | null | undefined,
  marketCapUsd: number | null | undefined
): string | undefined {
  if (!concentration || marketCapUsd == null || marketCapUsd <= 0) return undefined;
  const holders = concentration.topHolders ?? [];
  if (holders.length === 0) return undefined;

  let mega = 0; // >= $100k
  let whale = 0; // >= $10k
  let trader = 0; // >= $1k
  let small = 0; // below $1k
  let biggestUsd = 0;
  for (const holder of holders) {
    const usd = (holder.pct / 100) * marketCapUsd;
    if (usd > biggestUsd) biggestUsd = usd;
    if (usd >= 100_000) mega += 1;
    else if (usd >= 10_000) whale += 1;
    else if (usd >= 1_000) trader += 1;
    else small += 1;
  }

  const parts: string[] = [];
  if (mega > 0) parts.push(`🐋 ${mega} over $100k`);
  if (whale > 0) parts.push(`🐳 ${whale} over $10k`);
  if (trader > 0) parts.push(`🐟 ${trader} over $1k`);
  if (small > 0) parts.push(`🦐 ${small} under $1k`);
  if (parts.length === 0) return undefined;
  return `${parts.join(" · ")} · biggest <b>${formatUsd(biggestUsd)}</b>`;
}

/** "🐳 Top 10 Holders: 42% of supply" line, colored by concentration severity (🐳 normal,
 * ⚠️ ≥50%, 🚨 ≥80%), or undefined when concentration couldn't be resolved (no cached
 * supply, or the Blockscout holders read failed) — omitted entirely rather than guessing. */
function formatHolderConcentrationLine(concentration: HolderConcentration | null | undefined): string | undefined {
  if (!concentration) return undefined;
  const pct = concentration.top10Pct;
  const icon = pct >= 80 ? "🚨" : pct >= 50 ? "⚠️" : "🐳";
  return line(icon, "Top 10 Holders", `${pct.toFixed(0)}% of supply`);
}

/** Conviction rating line. The ratings come from measured win rates by chain and
 * age-at-alert (see rateConviction in poller.ts) — the only two features found to
 * separate winners from dumpers. The percentages themselves live in /insights, where the
 * sample size is visible alongside them. */
function formatConvictionLine(conviction: string | null | undefined): string | undefined {
  if (!conviction) return undefined;
  if (conviction === "high") return line("⭐", "Conviction", "HIGH — best-performing profile");
  if (conviction === "low") return line("⚠️", "Conviction", "LOW — historically dump-prone profile");
  return line("•", "Conviction", "Medium");
}

/** Solana mint/freeze authority line. An active freeze authority is the Solana honeypot
 * vector (holders can be frozen out of selling) and separately blocks the alert; an active
 * mint authority means supply can still be printed. Omitted when the mint couldn't be read
 * — never assumed safe, since "safe" is the dangerous default to guess. */
function formatSolanaSafetyLine(safety: SolanaMintSafety | null | undefined): string | undefined {
  if (!safety) return undefined;
  if (safety.freezeAuthorityActive) return line("🚨", "Freeze Authority", "ACTIVE — selling can be blocked");
  if (safety.mintAuthorityActive) return line("⚠️", "Mint Authority", "ACTIVE — supply can be inflated");
  return line("🔐", "Mint/Freeze Authority", "✅ Both revoked");
}

/** Solana holder concentration + holder count, from Jupiter's audit data. Labelled "Top
 * Holders" rather than "Top 10" because Jupiter doesn't document the wallet count behind
 * the figure — reporting a specific N would be asserting something unverified. */
function formatSolanaHoldersLine(safety: SolanaMintSafety | null | undefined): string | undefined {
  if (!safety || safety.topHoldersPct == null) return undefined;
  const pct = safety.topHoldersPct;
  const icon = pct >= 80 ? "🚨" : pct >= 50 ? "⚠️" : "🐳";
  const note = safety.holderCount != null ? `${safety.holderCount.toLocaleString("en-US")} holders` : undefined;
  return line(icon, "Top Holders", `${pct.toFixed(0)}% of supply`, note);
}

/** Jupiter's published organic-activity rating for a Solana token. */
function formatSolanaOrganicLine(safety: SolanaMintSafety | null | undefined): string | undefined {
  if (!safety?.organicScoreLabel) return undefined;
  const label = safety.organicScoreLabel.toLowerCase();
  const icon = label === "high" ? "🌿" : label === "medium" ? "🍃" : "🥀";
  return line(icon, "Organic Activity", safety.organicScoreLabel);
}

/** "🎯 Early Buy Concentration: 62% top-5 / 21% top-1 (first 500 blocks)" line — real
 * DEX-buy concentration in the first N blocks after launch ("bundle %"), or undefined
 * when it couldn't be resolved (legacy token with no recorded launch block, or the
 * getLogs read failed) — omitted entirely rather than guessing. */
function formatEarlyBuyConcentrationLine(earlyBuy: EarlyBuyConcentration | null | undefined): string | undefined {
  if (!earlyBuy) return undefined;
  const pct = earlyBuy.top5Pct;
  const icon = pct >= 80 ? "🚨" : pct >= 50 ? "⚠️" : "🐳";
  return line(
    icon,
    "Early Buy Concentration",
    `${pct.toFixed(0)}% top-5 / ${earlyBuy.topBuyerPct.toFixed(0)}% top-1`,
    `first ${earlyBuy.windowBlocks} blocks`
  );
}

/**
 * Resolves the best available market cap figure for a token: prefers DexScreener's own
 * `marketCapUsd` on the snapshot (real circulating mcap or FDV, section 1a of the plan),
 * falling back to an on-chain-computed value threaded in by the poller (section 1b, for
 * tokens DexScreener hasn't indexed yet). Never fabricates — returns null if neither
 * source has a value.
 */
export function resolveMarketCapUsd(
  snapshot: Pick<MarketSnapshot, "marketCapUsd"> | null | undefined,
  onChainMarketCapUsd?: number | null
): number | null {
  return snapshot?.marketCapUsd ?? onChainMarketCapUsd ?? null;
}

/** "🌱 Bonding Curve: 72% (3.60 / 5.00 ETH)" line from real paired/threshold wei figures. */
function formatBondingCurveLine(pairedWei: string, thresholdWei: string): string {
  const paired = weiToEthString(pairedWei);
  const threshold = weiToEthString(thresholdWei);
  const pct = formatCurvePct(pairedWei, thresholdWei);
  const value = pct ? `${pct} (${paired} / ${threshold} ETH)` : `${paired} / ${threshold} ETH`;
  return line("🌱", "Bonding Curve", value);
}

/** Graduation (bonded/unbonded) status line, or undefined if never checked yet. */
function formatGraduationLine(token: TokenRow): string | undefined {
  if (token.graduated) return line("🎓", "Graduation", "Graduated");
  if (token.graduation_paired_wei && token.graduation_threshold_wei) {
    return formatBondingCurveLine(token.graduation_paired_wei, token.graduation_threshold_wei);
  }
  return undefined;
}

/** "🏆 ATH: $X (-Y% from high)" / "(new high)", or undefined if no ATH is known yet or the
 * current market cap is unavailable. Purely informational — never a fabricated figure,
 * since ath_market_cap_usd is only ever set from a previously observed real market cap. */
function formatAthLine(token: TokenRow, marketCapUsd: number | null): string | undefined {
  const ath = token.ath_market_cap_usd;
  if (ath == null || ath <= 0 || marketCapUsd == null) return undefined;
  const dropPct = ((ath - marketCapUsd) / ath) * 100;
  const note = dropPct > 0.5 ? `-${dropPct.toFixed(0)}% from high` : dropPct < -0.5 ? "new high" : undefined;
  return line("🏆", "ATH", formatUsd(ath), note);
}

/** "📈 Since alert: 3.2x (peak 4.1x)" line showing performance since the token's first
 * alert, or undefined if no entry baseline has been captured yet or current market cap is
 * unavailable. Ties the post-alert performance-tracking feature into every alert type, not
 * just the dedicated milestone alert. */
function formatSinceAlertLine(token: TokenRow, marketCapUsd: number | null): string | undefined {
  const baseline = token.first_alert_market_cap_usd;
  if (baseline == null || baseline <= 0 || marketCapUsd == null) return undefined;
  const note = token.peak_multiple > 0 ? `peak ${token.peak_multiple.toFixed(1)}x` : undefined;
  return line("📈", "Since alert", formatMultiple(marketCapUsd, baseline), note);
}

const DISCLAIMER = `<i>Not financial advice · verify before acting</i>`;

/** "📈 3.2x since alert", or nothing when there's no entry baseline to measure against. */
function formatSinceAlertCompact(token: TokenRow, marketCapUsd: number | null): string | undefined {
  const baseline = token.first_alert_market_cap_usd;
  if (baseline == null || baseline <= 0 || marketCapUsd == null) return undefined;
  return `📈 <b>${formatMultiple(marketCapUsd, baseline)}</b> since alert`;
}

/** "🏆 ATH $12,000", omitted when no real high has been observed. */
function formatAthCompact(token: TokenRow, marketCapUsd: number | null): string | undefined {
  const ath = token.ath_market_cap_usd;
  if (ath == null || ath <= 0) return undefined;
  const drop = marketCapUsd != null && ath > 0 ? ((ath - marketCapUsd) / ath) * 100 : null;
  return drop != null && drop > 5 ? `🏆 ATH ${formatUsd(ath)} (-${drop.toFixed(0)}%)` : `🏆 ATH ${formatUsd(ath)}`;
}

/** Joins metrics onto one line so a reader scans four facts instead of four lines. */
function joinLine(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => p != null && p.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

/** A compact "icon value label" fragment, e.g. "💰 <b>$8,400</b> mcap". */
function frag(icon: string, value: string, label?: string): string {
  return label ? `${icon} <b>${value}</b> ${label}` : `${icon} <b>${value}</b>`;
}

/** Grey subheader carrying chain and age — context, not a headline metric. */
function subHeader(token: TokenRow, ageText?: string): string | undefined {
  const parts = [token.chain ? chainBadge(token.chain) : undefined, ageText].filter(Boolean);
  return parts.length > 0 ? `<i>${parts.join(" · ")}</i>` : undefined;
}

/**
 * The risk line, which only appears when there is an actual risk to report.
 *
 * Previously every alert carried a row per check, including reassuring ones like
 * "Mint/Freeze: ✅ Both revoked" — so the lines that mattered were buried among lines that
 * didn't. Silence here now means nothing was flagged.
 */
/**
 * Which X accounts have posted this contract address, biggest first.
 *
 * Follower counts are the point: five throwaway accounts and one 90,000-follower account
 * are very different signals about who is behind a coin. Rendered only when the lookup
 * actually succeeded — a failed or unconfigured search omits the line entirely rather than
 * implying nobody is talking about the coin.
 */
function formatXMentionsLine(mentions: XMention[] | null | undefined): string | undefined {
  if (mentions == null || mentions.length === 0) return undefined;
  const shown = mentions.slice(0, 4).map((m) => {
    const followers = m.followers != null ? ` <i>(${formatCompactCount(m.followers)})</i>` : "";
    return `<a href="${m.tweetUrl}">@${m.username}</a>${followers}`;
  });
  const extra = mentions.length > shown.length ? ` +${mentions.length - shown.length} more` : "";
  return `🐦 posted by ${shown.join(" · ")}${extra}`;
}

/** 90000 -> "90k", 1200000 -> "1.2M". Follower counts are read at a glance, not audited. */
function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Holder picture on every alert: concentration plus who is actually holding.
 *
 * The risk line below only mentions holders once concentration passes 50%, which hides the
 * information for the majority of coins where it is still worth seeing. This always renders
 * when the data resolved, and stays silent rather than guessing when it did not.
 */
function formatHoldersLine(
  holders: HolderConcentration | null | undefined,
  marketCapUsd: number | null | undefined
): string | undefined {
  if (!holders) return undefined;
  const pct = holders.top10Pct;
  const icon = pct >= 80 ? "🚨" : pct >= 50 ? "⚠️" : "🐳";
  const breakdown = formatWhaleBreakdownLine(holders, marketCapUsd);
  const head = `${icon} top 10 hold <b>${pct.toFixed(0)}%</b>`;
  return breakdown ? `${head} · ${breakdown}` : head;
}

function formatRiskLine(
  devStatus: DevStatus | null | undefined,
  holders: HolderConcentration | null | undefined,
  earlyBuy: EarlyBuyConcentration | null | undefined,
  solana: SolanaMintSafety | null | undefined
): string | undefined {
  const flags: string[] = [];
  if (devStatus && !devStatus.sold) {
    flags.push(devStatus.holdingPct != null ? `👤 dev holds ${devStatus.holdingPct.toFixed(0)}%` : "👤 dev holding");
  }
  // Holder concentration is not repeated here: formatHoldersLine now reports it on every
  // alert, with position sizes, so duplicating it in the risk flags said the same thing
  // twice in consecutive lines.
  if (earlyBuy && earlyBuy.top5Pct >= 40) flags.push(`🎯 bundle ${earlyBuy.top5Pct.toFixed(0)}%`);
  if (solana?.freezeAuthorityActive) flags.push("🚨 freeze authority live");
  if (solana?.mintAuthorityActive) flags.push("⚠️ mint authority live");
  if (solana?.topHoldersPct != null && solana.topHoldersPct >= 50) {
    flags.push(`🐳 top holders ${solana.topHoldersPct.toFixed(0)}%`);
  }
  return flags.length > 0 ? `⚠️ ${flags.join(" · ")}` : undefined;
}

/** Compact links row: chart first, then whatever the project actually published. */
function formatFooterLinks(dexUrl: string, snapshot?: Pick<MarketSnapshot, "websiteUrl" | "socials"> | null): string {
  const parts = [`<a href="${dexUrl}">📊 Chart</a>`];
  if (snapshot?.websiteUrl) parts.push(`<a href="${snapshot.websiteUrl}">🌐 Web</a>`);
  for (const social of snapshot?.socials ?? []) {
    parts.push(`<a href="${social.url}">${socialLabel(social.type).split(" ")[0]}</a>`);
  }
  return parts.join(" · ");
}

/** Friendly label + icon for a DexScreener social link type (e.g. "twitter" -> "🐦 Twitter"). */
function socialLabel(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("twitter") || t === "x") return "🐦 Twitter";
  if (t.includes("telegram")) return "💬 Telegram";
  if (t.includes("discord")) return "🎮 Discord";
  return "🔗 Link";
}

/** "🌐 Website | 🐦 Twitter | 💬 Telegram" links line, or undefined when the snapshot has
 * no website/socials data — never fabricated, only rendered when DexScreener actually
 * reports a link. */
function formatLinksLine(current: Pick<MarketSnapshot, "websiteUrl" | "socials">): string | undefined {
  const parts: string[] = [];
  if (current.websiteUrl) parts.push(`<a href="${current.websiteUrl}">🌐 Website</a>`);
  for (const social of current.socials) {
    parts.push(`<a href="${social.url}">${socialLabel(social.type)}</a>`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * Assembles a message from a header and any number of line-groups ("sections"),
 * dropping undefined lines and skipping any section that ends up empty, then joins
 * surviving sections with a blank line so the alert reads as distinct scannable
 * groups (core metrics / token health / performance / footer) instead of one long
 * undifferentiated list. Replaces the old fixed-width dashed divider, which wrapped
 * awkwardly on narrow phone screens.
 */
function renderMessage(header: string, ...sections: (string | undefined)[][]): string {
  const blocks = [[header], ...sections]
    .map((section) => section.filter((l): l is string => l != null))
    .filter((section) => section.length > 0);
  return blocks.map((block) => block.join("\n")).join("\n\n");
}

/**
 * Builds the HTML alert message for a dead -> revival transition. Grouped into a
 * header, a core-metrics section, a token-health section (bonding curve / dev wallet),
 * a performance section (ATH / since-alert), and a footer with a link out to verify
 * independently and a disclaimer that this is not financial advice / not an auto-trader.
 */
export function buildRevivalAlertHtml(
  token: TokenRow,
  current: MarketSnapshot,
  baseline: Baseline,
  deadForHours: number,
  dexScreenerChainId: string,
  onChainMarketCapUsd?: number | null,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  conviction?: string | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${current.pairAddress}`;
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;
  const liquidity = current.liquidityUsd ?? 0;
  const liquidityPct = baseline.medianLiquidityUsd > 0 ? (liquidity / baseline.medianLiquidityUsd) * 100 : 0;
  const marketCapUsd = resolveMarketCapUsd(current, onChainMarketCapUsd);

  const header = `🟢 <b>REVIVAL SIGNAL</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token, `dead ${formatDuration(deadForHours)}`),
    joinLine(frag("💰", formatUsd(marketCapUsd), "mcap"), frag("💧", formatUsd(liquidity), "liq")),
    joinLine(
      `📊 <b>${formatUsd(volume1h)}</b> vol (1h)`,
      `<i>${formatMultiple(volume1h, baseline.medianVolume1h)} vs median</i>`
    ),
    joinLine(
      current.sells1h != null ? `🛒 <b>${buys1h}</b>/<b>${current.sells1h}</b> buys/sells` : `🛒 <b>${buys1h}</b> buys`,
      `💧 <i>${liquidityPct.toFixed(0)}% of median liq</i>`
    ),
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const performance = [joinLine(formatSinceAlertCompact(token, marketCapUsd), formatAthCompact(token, marketCapUsd))];
  const footer = [formatFooterLinks(dexUrl, current), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, performance, footer, [DISCLAIMER]);
}

/**
 * Builds the HTML alert message sent the moment a token first crosses the graduation
 * threshold. Separate from the revival alert — this fires purely off the on-chain
 * `graduated` flag flipping 0->1, independent of dead/revival status.
 */
export function buildGraduationAlertHtml(
  token: TokenRow,
  pairedWei: string,
  thresholdWei: string,
  dexScreenerChainId: string,
  marketCapUsd?: number | null,
  snapshot?: Pick<MarketSnapshot, "websiteUrl" | "socials"> | null,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  conviction?: string | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${token.pair_address}`;
  const paired = weiToEthString(pairedWei);
  const threshold = weiToEthString(thresholdWei);
  const resolvedMcap = marketCapUsd ?? null;

  const header = `🎓 <b>GRADUATED</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token),
    joinLine(frag("💰", formatUsd(resolvedMcap), "mcap"), `🌱 <b>${paired}</b>/${threshold} ETH paired`),
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const performance = [joinLine(formatSinceAlertCompact(token, resolvedMcap), formatAthCompact(token, resolvedMcap))];
  const footer = [formatFooterLinks(dexUrl, snapshot), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, performance, footer, [DISCLAIMER]);
}

/**
 * Builds the HTML alert for a token (pre- or post-graduation) newly crossing one or
 * more real market-cap tiers. Market cap here is always a real, sourced figure — either
 * DexScreener's own mcap/fdv, or the on-chain pool-price-derived value for tokens
 * DexScreener hasn't indexed yet (see `readPoolMarketCaps`) — never fabricated or
 * approximated from bonding-curve "raised" ETH.
 */
export function buildMarketCapAlertHtml(
  token: TokenRow,
  crossedTiersUsd: number[],
  marketCapUsd: number,
  pairedWei: string,
  thresholdWei: string,
  dexScreenerChainId: string,
  snapshot?: Pick<MarketSnapshot, "websiteUrl" | "socials"> | null,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  conviction?: string | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const fmtTier = (n: number) => `$${n.toLocaleString("en-US")}`;
  const tierLine =
    crossedTiersUsd.length > 1
      ? `🚀 crossed ${fmtTier(crossedTiersUsd[0]!)} → ${fmtTier(crossedTiersUsd[crossedTiersUsd.length - 1]!)}`
      : `🚀 crossed ${fmtTier(crossedTiersUsd[0]!)}`;
  const curveLine = token.graduated
    ? line("🎓", "Graduation", "Graduated")
    : formatBondingCurveLine(pairedWei, thresholdWei);
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${token.pair_address}`;

  const header = `📈 <b>MARKET CAP</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token),
    joinLine(frag("💰", formatUsd(marketCapUsd), "mcap"), tierLine),
    curveLine,
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const performance = [joinLine(formatSinceAlertCompact(token, marketCapUsd), formatAthCompact(token, marketCapUsd))];
  const footer = [formatFooterLinks(dexUrl, snapshot), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, performance, footer, [DISCLAIMER]);
}

/**
 * Builds the HTML alert for a freshly-launched token showing early buy/volume
 * acceleration (`meetsEarlyMomentumCriteria` for the first alert, or
 * `meetsMomentumReAlertCriteria` for the bounded follow-up). `alertNumber` (1 or 2)
 * distinguishes the two in the header so a re-alert doesn't look like a duplicate.
 */
export function buildMomentumAlertHtml(
  token: TokenRow,
  current: MarketSnapshot,
  ageMinutes: number,
  dexScreenerChainId: string,
  alertNumber: number,
  onChainMarketCapUsd?: number | null,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  conviction?: string | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${current.pairAddress}`;
  const buys5m = current.buys5m ?? 0;
  const volume5m = current.volume5m ?? 0;
  const liquidity = current.liquidityUsd ?? 0;
  const marketCapUsd = resolveMarketCapUsd(current, onChainMarketCapUsd);
  const header =
    alertNumber >= 2
      ? `⚡ <b>MOMENTUM ACCELERATING</b> · ${displaySymbol(token)}`
      : `⚡ <b>EARLY MOMENTUM</b> · ${displaySymbol(token)}`;

  const core = [
    subHeader(token, `${ageMinutes.toFixed(0)}m old`),
    joinLine(frag("💰", formatUsd(marketCapUsd), "mcap"), frag("💧", formatUsd(liquidity), "liq")),
    joinLine(
      current.sells5m != null ? `🛒 <b>${buys5m}</b>/<b>${current.sells5m}</b> buys/sells` : `🛒 <b>${buys5m}</b> buys`,
      frag("📊", formatUsd(volume5m), "vol (5m)")
    ),
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const performance = [joinLine(formatSinceAlertCompact(token, marketCapUsd), formatAthCompact(token, marketCapUsd))];
  const footer = [formatFooterLinks(dexUrl, current), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, performance, footer, [DISCLAIMER]);
}

/**
 * Builds the HTML alert for a token newly crossing one or more multiples-since-first-alert
 * milestones (2x, 3x, 5x, ...), per PERFORMANCE_MILESTONE_MULTIPLES. Entry and current market
 * cap are always real, previously-resolved figures (see resolveMarketCapUsd) — never fabricated.
 * `crossedMultiples` lists every milestone newly crossed since the last check, in ascending
 * order; the header uses the highest one.
 */
export function buildPerformanceMilestoneAlertHtml(
  token: TokenRow,
  crossedMultiples: number[],
  marketCapUsd: number,
  dexScreenerChainId: string,
  pairAddress: string,
  snapshot?: Pick<MarketSnapshot, "websiteUrl" | "socials"> | null,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  conviction?: string | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const baseline = token.first_alert_market_cap_usd ?? 0;
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${pairAddress}`;
  const topMilestone = crossedMultiples[crossedMultiples.length - 1]!;
  const milestoneLine =
    crossedMultiples.length > 1
      ? `🚀 crossed ${crossedMultiples[0]}x → ${topMilestone}x`
      : `🚀 crossed ${topMilestone}x`;

  const header = `🚀 <b>${topMilestone}X SINCE ALERT</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token),
    joinLine(`🎯 entry <b>${formatUsd(baseline)}</b>`, `💰 now <b>${formatUsd(marketCapUsd)}</b>`),
    joinLine(milestoneLine, `🏆 peak <b>${token.peak_multiple.toFixed(1)}x</b>`),
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const footer = [formatFooterLinks(dexUrl, snapshot), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, footer, [DISCLAIMER]);
}

/**
 * Builds the HTML alert for a token demoted from 'alerted' back to 'dead' after revival
 * criteria stopped holding for demoteConfirmPolls consecutive polls ("revival fizzled").
 * Shows only real, already-computed current-vs-baseline figures — the same volume/buys/
 * liquidity data the demotion decision itself was based on — with no fabricated severity
 * label or "rug" classification, so the user can judge the numbers themselves.
 */
/**
 * Builds the one-time HTML warning sent when a previously-alerted coin's trading pair
 * vanishes from DexScreener (liquidity pulled/delisted, observedMarketCapUsd = 0) or its
 * market cap crashes below the warning floor relative to entry. Both figures are real,
 * previously-recorded observations — nothing here is estimated.
 */
export function buildDumpWarningAlertHtml(token: TokenRow, entryMarketCapUsd: number, observedMarketCapUsd: number): string {
  const pulled = observedMarketCapUsd <= 0;
  const dropPct = ((entryMarketCapUsd - observedMarketCapUsd) / entryMarketCapUsd) * 100;

  const header = `🚨 <b>${pulled ? "LIQUIDITY GONE" : "DUMP WARNING"}</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token),
    pulled
      ? `🎯 entry <b>${formatUsd(entryMarketCapUsd)}</b> · ❌ no trading pair left — liquidity pulled or delisted`
      : joinLine(
          `🎯 entry <b>${formatUsd(entryMarketCapUsd)}</b>`,
          `💰 now <b>${formatUsd(observedMarketCapUsd)}</b> <i>(-${dropPct.toFixed(0)}%)</i>`
        ),
  ];
  const footer = [`<code>${token.address}</code>`];

  return renderMessage(header, core, footer, [DISCLAIMER]);
}

/**
 * Builds the alert for a coin breaking out — surging against its own trailing baseline at
 * any age. This is the signal that catches a coin making its move hours or days after
 * launch, which the launch-anchored paths (momentum ≤60 min, high conviction ≤5 min)
 * structurally cannot see. Every figure shown is a real observation compared against the
 * coin's own recorded history.
 */
export function buildBreakoutAlertHtml(
  token: TokenRow,
  current: MarketSnapshot,
  baseline: Baseline,
  ageHours: number,
  dexScreenerChainId: string,
  devStatus?: DevStatus | null,
  holderConcentration?: HolderConcentration | null,
  earlyBuyConcentration?: EarlyBuyConcentration | null,
  solanaSafety?: SolanaMintSafety | null,
  /** X accounts that posted this contract address; null when the lookup could not run. */
  xMentions?: XMention[] | null
): string {
  const dexUrl = `https://dexscreener.com/${dexScreenerChainId}/${current.pairAddress}`;
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;
  const marketCapUsd = resolveMarketCapUsd(current);

  const header = `🚀 <b>BREAKOUT</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token, `${formatDuration(ageHours)} old`),
    joinLine(frag("💰", formatUsd(marketCapUsd), "mcap"), frag("💧", formatUsd(current.liquidityUsd ?? 0), "liq")),
    joinLine(
      `📊 <b>${formatUsd(volume1h)}</b> vol (1h)`,
      `<i>${formatMultiple(volume1h, baseline.medianVolume1h)} vs its own median</i>`
    ),
    current.sells1h != null ? `🛒 <b>${buys1h}</b>/<b>${current.sells1h}</b> buys/sells (1h)` : `🛒 <b>${buys1h}</b> buys (1h)`,
  ];
  const risk = [
    formatHoldersLine(holderConcentration, marketCapUsd),
    formatXMentionsLine(xMentions),
    formatRiskLine(devStatus, holderConcentration, earlyBuyConcentration, solanaSafety),
  ];
  const performance = [joinLine(formatSinceAlertCompact(token, marketCapUsd), formatAthCompact(token, marketCapUsd))];
  const footer = [formatFooterLinks(dexUrl, current), `<code>${token.address}</code>`];

  return renderMessage(header, core, risk, performance, footer, [DISCLAIMER]);
}

export function buildDemotionAlertHtml(token: TokenRow, current: MarketSnapshot, baseline: Baseline): string {
  const volume1h = current.volume1h ?? 0;
  const buys1h = current.buys1h ?? 0;
  const liquidity = current.liquidityUsd ?? 0;
  const liquidityPct = baseline.medianLiquidityUsd > 0 ? (liquidity / baseline.medianLiquidityUsd) * 100 : 0;

  const header = `🔴 <b>REVIVAL FIZZLED</b> · ${displaySymbol(token)}`;
  const core = [
    subHeader(token),
    joinLine(`📊 <b>${formatUsd(volume1h)}</b> vol (1h)`, `<i>${formatMultiple(volume1h, baseline.medianVolume1h)} vs median</i>`),
    joinLine(
      current.sells1h != null ? `🛒 <b>${buys1h}</b>/<b>${current.sells1h}</b> buys/sells` : `🛒 <b>${buys1h}</b> buys`,
      `💧 <b>${formatUsd(liquidity)}</b> <i>(${liquidityPct.toFixed(0)}% of median)</i>`
    ),
  ];
  const footer = [`<code>${token.address}</code>`];

  return renderMessage(header, core, footer, [DISCLAIMER]);
}
