import { InlineKeyboard } from "grammy";
import { cb } from "./callbackData.js";
import { escapeHtml } from "../util/html.js";
import { formatCompactUsd, formatPercent } from "../util/numberParser.js";
import type { MarketSnapshot, RuleRow, TokenRow, WatchRow } from "../types/domain.js";

const CHAIN_LABELS: Record<string, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  bsc: "BSC",
  base: "Base",
  arbitrum: "Arbitrum",
  polygon: "Polygon",
  avalanche: "Avalanche",
};

function chainLabel(chainId: string): string {
  return CHAIN_LABELS[chainId] ?? chainId.charAt(0).toUpperCase() + chainId.slice(1);
}

function dexLabel(dexId: string): string {
  return dexId.charAt(0).toUpperCase() + dexId.slice(1);
}

export function marketCardText(market: MarketSnapshot): string {
  const lines = [
    `🪙 <b>${escapeHtml(market.symbol)}</b> (${escapeHtml(market.name)}) — ${chainLabel(market.chainId)} · ${dexLabel(market.dexId)}`,
    `💰 Price: $${market.priceUsd}`,
    `📊 MCap: ${market.mcap !== null ? formatCompactUsd(market.mcap) : "N/A"}   💧 Liq: ${market.liquidityUsd !== null ? formatCompactUsd(market.liquidityUsd) : "N/A"}`,
    `📈 5m: ${formatPercent(market.priceChangeM5 ?? 0)} | 1h: ${formatPercent(market.priceChangeH1 ?? 0)} | 24h: ${formatPercent(market.priceChangeH24 ?? 0)}`,
    `🔗 <a href="${market.pairUrl}">Chart</a>`,
  ];
  return lines.join("\n");
}

export function newTokenCardKeyboard(tokenId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔔 MCap alert", cb.tokenAddRuleMcap(tokenId))
    .text("💲 Price alert", cb.tokenAddRulePrice(tokenId))
    .row()
    .text("💧 Liquidity alert", cb.tokenAddRuleLiquidity(tokenId))
    .row()
    .text("📈 Trend alert", cb.tokenAddRuleTrend(tokenId))
    .text("↕️ % Move alert", cb.tokenAddRulePercent(tokenId))
    .row()
    .text("❌ Cancel", cb.tokenCancel());
}

export function watchedTokenCardKeyboard(watchId: number, tokenId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔔 MCap alert", cb.tokenAddRuleMcap(tokenId))
    .text("💲 Price alert", cb.tokenAddRulePrice(tokenId))
    .row()
    .text("💧 Liquidity alert", cb.tokenAddRuleLiquidity(tokenId))
    .row()
    .text("📈 Trend alert", cb.tokenAddRuleTrend(tokenId))
    .text("↕️ % Move alert", cb.tokenAddRulePercent(tokenId))
    .row()
    .text("👁 View rules", cb.tokenViewRules(watchId))
    .row()
    .text("🗑 Remove coin", cb.tokenRemove(watchId))
    .text("« Back", cb.watchlist(0));
}

export function watchlistText(page: number, totalPages: number): string {
  return `📋 <b>My watchlist</b> (page ${page + 1}/${Math.max(totalPages, 1)})`;
}

export function watchlistKeyboard(
  rows: { watch: WatchRow; token: TokenRow; market: MarketSnapshot | null; ruleCount: number }[],
  page: number,
  totalPages: number
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    const mcap = row.market?.mcap;
    const mcapText = mcap !== null && mcap !== undefined ? formatCompactUsd(mcap) : "N/A";
    kb.text(`${row.token.symbol} · ${mcapText} · ${row.ruleCount} rule(s)`, cb.tokenCard(row.token.id)).row();
  }

  const navRow: [string, string][] = [];
  if (page > 0) navRow.push(["« Prev", cb.watchlist(page - 1)]);
  if (page < totalPages - 1) navRow.push(["Next »", cb.watchlist(page + 1)]);
  for (const [label, data] of navRow) kb.text(label, data);
  if (navRow.length > 0) kb.row();

  kb.text("➕ Add coin", cb.addCoin());
  return kb;
}

export function rulesListText(token: TokenRow, rules: RuleRow[]): string {
  if (rules.length === 0) {
    return `👁 <b>Rules for ${escapeHtml(token.symbol)}</b>\n\nNo rules yet.`;
  }
  const lines = [`👁 <b>Rules for ${escapeHtml(token.symbol)}</b>`, ""];
  for (const rule of rules) {
    const status = rule.active ? (rule.armed ? "🟢 active" : "🟡 waiting to re-arm") : "⏸ paused";
    lines.push(`#${rule.id} — ${rule.type} — ${status}`);
  }
  return lines.join("\n");
}

export function rulesListKeyboard(watchId: number, tokenId: number, rules: RuleRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const rule of rules) {
    if (rule.active) {
      kb.text(`⏸ Pause #${rule.id}`, cb.rulePause(rule.id));
    } else {
      kb.text(`▶️ Resume #${rule.id}`, cb.ruleResume(rule.id));
    }
    kb.text(`🗑 Delete #${rule.id}`, cb.ruleDelete(rule.id)).row();
  }
  kb.text("➕ Add rule", cb.tokenCard(tokenId)).row();
  kb.text("« Back", cb.tokenCard(tokenId));
  return kb;
}

export function confirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", cb.confirmYes())
    .text("✏️ Edit", cb.confirmEdit())
    .text("❌ Cancel", cb.confirmCancel());
}

export function directionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⬇️ Drops to", cb.ruleDirBelow()).text("⬆️ Rises to", cb.ruleDirAbove());
}

export function modeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔂 One-shot", cb.ruleModeOneShot())
    .text("🔁 Repeating", cb.ruleModeRepeating());
}

export function trendDirectionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("📈 Uptrend", cb.ruleTrendUp()).text("📉 Downtrend", cb.ruleTrendDown());
}

export function trendModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Use defaults", cb.ruleTrendDefault())
    .text("🛠 Customize", cb.ruleTrendCustom());
}

export function welcomeText(): string {
  return [
    "👋 <b>Welcome to CoinSentry</b>",
    "",
    "Paste any token contract address and I'll watch it for you — market cap drops, price pumps, trend reversals, whatever you need.",
  ].join("\n");
}

export function helpText(): string {
  return [
    "❓ <b>How CoinSentry works</b>",
    "",
    "1. Paste a token contract address (Solana, Ethereum, BSC, Base, pump.fun — anything DexScreener indexes).",
    "2. Pick an alert type and configure it with the buttons.",
    "3. I'll check the token every few seconds and DM you the moment your condition is met.",
    "",
    "<b>Value shorthand:</b> you can type <code>5k</code>, <code>250k</code>, <code>1.2m</code>, or plain numbers like <code>0.0045</code>.",
    "",
    "<b>Examples:</b>",
    "• \"Alert me if this coin's mcap drops to 5k\" → 🔔 MCap alert → ⬇️ Drops to → 5k",
    "• \"Tell me when it starts pumping\" → 📈 Trend alert → Uptrend → defaults",
  ].join("\n");
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("« Main menu", cb.mainMenu());
}
