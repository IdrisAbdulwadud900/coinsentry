import { GrammyError, type Bot } from "grammy";
import { getDeps } from "./deps.js";
import { formatAgo, formatDeadDuration, formatUsd } from "./format.js";
import { deadListKeyboard, mainMenuKeyboard, performanceKeyboard, refreshButton, type DeadListFilter } from "./keyboards.js";
import type { TokenRow } from "../types/domain.js";
import { CLASSIFIER_CONFIG_KEYS, type ClassifierConfig } from "../engine/classifier.js";
import { effectiveBundleCapPct, FOCUS_CHAIN_SETTING_KEY } from "../engine/poller.js";
import { chainBadge, CHAINS } from "../data/chains.js";

const DEAD_PAGE_SIZE = 10;
const PERFORMANCE_LEADERBOARD_SIZE = 15;

function buildStatusText(): string {
  const { tokenRepo, poller } = getDeps();
  const counts = tokenRepo.countByStatus();
  const reviving = tokenRepo.countRevivingCandidates();
  const graduation = tokenRepo.countByGraduation();
  const lastRun = poller.getLastRunAt();

  const focusChain = getDeps().settingsRepo.get(FOCUS_CHAIN_SETTING_KEY);
  const focusLine = focusChain ? `🎯 Focused on ${chainBadge(focusChain)} — /focus off to widen` : undefined;
  const perChain = tokenRepo
    .countByChain()
    .map((c) => `${chainBadge(c.chain)}: ${c.count}`)
    .join(" · ");

  return [
    "<b>Status</b>",
    `Active: ${counts.active}`,
    `Dead: ${counts.dead}`,
    `Reviving: ${reviving}`,
    `Alerted: ${counts.alerted}`,
    `Graduated: ${graduation.graduated} / Ungraduated: ${graduation.ungraduated}`,
    ``,
    `<b>Tracked by chain</b>`,
    perChain || "none yet",
    focusLine,
    ``,
    `Last poll: ${formatAgo(lastRun)}`,
  ]
    .filter((l): l is string => l != null)
    .join("\n");
}

function buildDeadListText(
  page: number,
  filter: DeadListFilter
): { text: string; totalPages: number; deadTokens: TokenRow[] } {
  const { tokenRepo } = getDeps();
  let deadTokens = tokenRepo.listByStatus("dead").sort((a, b) => a.status_changed_at - b.status_changed_at);
  if (filter === "grad") {
    deadTokens = deadTokens.filter((t) => t.graduated);
  } else if (filter === "ungrad") {
    deadTokens = deadTokens.filter((t) => !t.graduated);
  }

  if (deadTokens.length === 0) {
    return {
      text: "No dead tokens match this filter right now. Check back after the next poll.",
      totalPages: 0,
      deadTokens,
    };
  }

  const totalPages = Math.max(1, Math.ceil(deadTokens.length / DEAD_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * DEAD_PAGE_SIZE;
  const pageItems = deadTokens.slice(start, start + DEAD_PAGE_SIZE);

  const lines = [
    `<b>Dead tokens</b> (longest dead first) — page ${clampedPage + 1}/${totalPages}`,
    ``,
    ...pageItems.map(
      (t) => `${t.graduated ? "🎓" : "🌱"} ${t.symbol} — dead ${formatDeadDuration(t.status_changed_at)} — <code>${t.address}</code>`
    ),
  ];

  return { text: lines.join("\n"), totalPages, deadTokens };
}

/** Leaderboard of tokens by peak multiple-since-first-alert (see performance-tracking
 * feature in poller.ts). Cheap — reads already-tracked figures, no live fetch needed. */
function buildPerformanceText(): string {
  const { tokenRepo } = getDeps();
  const top = tokenRepo.listTopByPeakMultiple(PERFORMANCE_LEADERBOARD_SIZE);

  if (top.length === 0) {
    return (
      "<b>🚀 Top Performers</b> (since alert)\n\n" +
      "No performance data yet — this fills in once alerted tokens have at least one " +
      "market-cap check after their entry baseline is captured."
    );
  }

  const lines = [
    "<b>🚀 Top Performers</b> (since alert)",
    "",
    ...top.map(
      (t, i) =>
        `${i + 1}. ${t.graduated ? "🎓" : "🌱"} ${t.symbol} — <b>${t.peak_multiple.toFixed(1)}x</b> peak ` +
        `(entry ${formatUsd(t.first_alert_market_cap_usd)}, ${formatAgo(t.peak_multiple_at ?? undefined)})`
    ),
  ];

  return lines.join("\n");
}

/**
 * The observer's report: alert outcomes (winner/dumper/flat), the average entry features
 * of each group (the "learned patterns"), missed winners the gates blocked, and — only
 * when the data actually shows a meaningful gap — concrete tuning recommendations. Every
 * figure is an aggregate of real recorded observations; with too little data it says so
 * instead of inventing patterns.
 */
function buildInsightsText(): string {
  const { outcomeRepo, settingsRepo } = getDeps();
  const counts = outcomeRepo.countByOutcome();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const missedCount = outcomeRepo.countMissedWinners();

  if (total === 0 && missedCount === 0) {
    return (
      "<b>🧠 Observer Insights</b>\n\n" +
      "No observations recorded yet — this fills in as alerts fire and the observer " +
      "checks each coin 1h/6h/24h later, and as the missed-winners audit runs."
    );
  }

  const stats = new Map(outcomeRepo.featureStatsByOutcome().map((s) => [s.outcome, s]));
  const pct = (v: number | null) => (v != null ? `${v.toFixed(0)}%` : "n/a");
  const rate = (v: number | null) => (v != null ? `${(v * 100).toFixed(0)}%` : "n/a");

  const groupLine = (label: string, outcome: string): string | null => {
    const s = stats.get(outcome);
    if (!s) return null;
    return (
      `${label} (${s.count}): bundle ${pct(s.avgBundleTop5Pct)} · top-10 holders ${pct(s.avgHolderTop10Pct)}` +
      ` · dev sold ${rate(s.devSoldRate)}`
    );
  };

  const lines: string[] = [
    "<b>🧠 Observer Insights</b>",
    "",
    `Alerted coins tracked: <b>${total}</b>`,
    `🏆 Winners (≥2x): <b>${counts["winner"] ?? 0}</b> · 📉 Dumpers (≤0.5x in 24h): <b>${counts["dumper"] ?? 0}</b>` +
      ` · ➖ Flat: <b>${counts["flat"] ?? 0}</b> · ⏳ Pending: <b>${counts["pending"] ?? 0}</b>`,
    `🔧 Live bundle cap: <b>${effectiveBundleCapPct(settingsRepo)}%</b> (auto-tuned by the observer, never above 60%)`,
  ];

  // The honest scoreboard sits directly under the headline, because "touched 2x once" and
  // "was actually worth more an hour later" are very different claims.
  const board = outcomeRepo.checkpointScoreboard().filter((row) => row.total > 0);
  if (board.length > 0) {
    lines.push("", "<b>What the coins were actually worth after the alert</b>");
    for (const row of board) {
      const share = (n: number) => `${Math.round((n / row.total) * 100)}%`;
      lines.push(
        `${row.horizon.padEnd(3)} up <b>${share(row.up)}</b> · ≥2x <b>${share(row.doubled)}</b> · ` +
          `halved <b>${share(row.halved)}</b> <i>(n=${row.total})</i>`
      );
    }
    const byConviction = outcomeRepo
      .oneHourUpRateByConviction()
      .filter((row) => row.total >= 10)
      .sort((a, b) => b.up / b.total - a.up / a.total);
    if (byConviction.length > 1) {
      lines.push(
        "up at 1h by conviction: " +
          byConviction.map((r) => `${r.conviction} <b>${Math.round((r.up / r.total) * 100)}%</b>`).join(" · ")
      );
    }
    lines.push(`<i>The win rate above counts any coin that ever touched 2x, even for a moment.</i>`);
  }

  const patternLines = [groupLine("🏆 Winners", "winner"), groupLine("📉 Dumpers", "dumper")].filter(
    (l): l is string => l != null
  );
  if (patternLines.length > 0) {
    lines.push("", "<b>Average entry features</b>", ...patternLines);
  }

  // Conviction scoreboard: whether the measured buckets still hold on fresh data.
  const byConviction = outcomeRepo.outcomeCountsByConviction().filter((c) => c.winners + c.dumpers + c.flat > 0);
  if (byConviction.length > 0) {
    lines.push("", "<b>Win rate by conviction</b>");
    const order: Record<string, number> = { high: 0, medium: 1, low: 2, unrated: 3 };
    for (const c of [...byConviction].sort((a, b) => (order[a.conviction] ?? 9) - (order[b.conviction] ?? 9))) {
      const resolved = c.winners + c.dumpers + c.flat;
      const rate = ((c.winners / resolved) * 100).toFixed(0);
      lines.push(`${c.conviction}: <b>${rate}%</b> win — ${c.winners}W / ${c.dumpers}D / ${c.flat} flat (n=${resolved})`);
    }
  }

  // Which signal actually pays: the single most decision-useful thing the observer knows.
  const byType = outcomeRepo.outcomeCountsByAlertType().filter((t) => t.winners + t.dumpers + t.flat > 0);
  if (byType.length > 0) {
    lines.push("", "<b>Win rate by signal</b> (resolved only)");
    for (const t of byType) {
      const resolved = t.winners + t.dumpers + t.flat;
      const rate = ((t.winners / resolved) * 100).toFixed(0);
      lines.push(`${t.alertType}: <b>${rate}%</b> — ${t.winners}W / ${t.dumpers}D / ${t.flat} flat`);
    }
  }

  // Recommendations only when both groups have enough samples AND the observed gap is
  // meaningful — never invented from thin data.
  const winner = stats.get("winner");
  const dumper = stats.get("dumper");
  const recs: string[] = [];
  if (winner && dumper && winner.count >= 5 && dumper.count >= 5) {
    if (
      winner.avgBundleTop5Pct != null &&
      dumper.avgBundleTop5Pct != null &&
      dumper.avgBundleTop5Pct - winner.avgBundleTop5Pct >= 10
    ) {
      recs.push(
        `Dumpers average ${dumper.avgBundleTop5Pct.toFixed(0)}% bundle vs ${winner.avgBundleTop5Pct.toFixed(0)}% for winners — a tighter bundle cap may cut losers.`
      );
    }
    if (
      winner.avgHolderTop10Pct != null &&
      dumper.avgHolderTop10Pct != null &&
      dumper.avgHolderTop10Pct - winner.avgHolderTop10Pct >= 10
    ) {
      recs.push(
        `Dumpers average ${dumper.avgHolderTop10Pct.toFixed(0)}% top-10 holder concentration vs ${winner.avgHolderTop10Pct.toFixed(0)}% for winners.`
      );
    }
    if (winner.devSoldRate != null && dumper.devSoldRate != null && dumper.devSoldRate - winner.devSoldRate >= 0.3) {
      recs.push(
        `Dev had sold in ${(dumper.devSoldRate * 100).toFixed(0)}% of dumpers vs ${(winner.devSoldRate * 100).toFixed(0)}% of winners.`
      );
    }
  }
  if (recs.length > 0) {
    lines.push("", "<b>Patterns worth acting on</b>", ...recs.map((r) => `• ${r}`), "", "Apply threshold changes with /setconfig.");
  }

  if (missedCount > 0) {
    const missed = outcomeRepo.listMissedWinners(8);
    lines.push(
      "",
      `<b>🔍 Missed winners</b> (never alerted, ATH ≥ $25k): ${missedCount}`,
      ...missed.map(
        (m) => `${m.symbol} — ATH ${formatUsd(m.ath_market_cap_usd)}${m.block_reason ? ` — blocked: ${m.block_reason}` : ""}`
      )
    );
  }

  return lines.join("\n");
}

/** Lists all 11 classifier thresholds with their current effective value, tagged
 * [default] or [override] depending on whether a /setconfig override is stored for it. */
function buildConfigText(): string {
  const { classifierConfig, settingsRepo } = getDeps();
  const lines = CLASSIFIER_CONFIG_KEYS.map((key) => {
    const value = classifierConfig[key];
    const tag = settingsRepo.get(key) != null ? "[override]" : "[default]";
    return `<code>${key}</code>: <b>${value}</b> <i>${tag}</i>`;
  });
  return [
    "<b>⚙️ Classifier Config</b>",
    "",
    ...lines,
    "",
    "Owner-only: /setconfig &lt;key&gt; &lt;value&gt; · /resetconfig &lt;key&gt;",
  ].join("\n");
}

/** True if the sender is the bot's configured owner (currently TELEGRAM_CHAT_ID). Used to
 * gate the mutating /setconfig and /resetconfig commands — every other command is public. */
function isOwner(fromId: number | undefined): boolean {
  return fromId != null && String(fromId) === getDeps().telegramChatId;
}

/** Ignores the harmless "message is not modified" error Telegram throws when a refresh
 * button is tapped but the content is identical to what's already shown. */
async function editIgnoringNotModified(edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) {
      return;
    }
    throw err;
  }
}

export function registerHandlers(bot: Bot): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "🟢 <b>Pons Revival Signal Bot</b>\n\n" +
        "I watch dead Pons-launched tokens on Robinhood Chain and alert you when they show genuine signs of revival " +
        "(volume, buys, and liquidity all recovering together, not just noise).\n\n" +
        "⚠️ This is a signal-only bot. It never executes trades, and nothing here is financial advice — always verify " +
        "independently before acting.\n\n" +
        "Use the buttons below, or the /status, /dead, /performance, and /insights commands, to check in any time.",
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(buildStatusText(), { parse_mode: "HTML", reply_markup: refreshButton("status:refresh") });
  });

  bot.callbackQuery("status:refresh", async (ctx) => {
    try {
      await editIgnoringNotModified(() =>
        ctx.editMessageText(buildStatusText(), { parse_mode: "HTML", reply_markup: refreshButton("status:refresh") })
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      getDeps().logger.error({ err: String(err) }, "status:refresh callback failed");
      await ctx.answerCallbackQuery({ text: "Something went wrong, try again.", show_alert: false });
    }
  });

  bot.command("dead", async (ctx) => {
    const { text, totalPages, deadTokens } = buildDeadListText(0, "all");
    const keyboard = deadTokens.length === 0 ? refreshButton("dead:0:all") : deadListKeyboard(0, totalPages, "all");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.callbackQuery(/^dead:(\d+):(all|grad|ungrad)$/, async (ctx) => {
    try {
      const page = Number(ctx.match[1]);
      const filter = ctx.match[2] as DeadListFilter;
      const { text, totalPages, deadTokens } = buildDeadListText(page, filter);
      const keyboard = deadTokens.length === 0 ? refreshButton(`dead:0:${filter}`) : deadListKeyboard(page, totalPages, filter);
      await editIgnoringNotModified(() => ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }));
      await ctx.answerCallbackQuery();
    } catch (err) {
      getDeps().logger.error({ err: String(err) }, "dead:page callback failed");
      await ctx.answerCallbackQuery({ text: "Something went wrong, try again.", show_alert: false });
    }
  });

  bot.command("performance", async (ctx) => {
    await ctx.reply(buildPerformanceText(), { parse_mode: "HTML", reply_markup: performanceKeyboard() });
  });

  bot.callbackQuery("performance:refresh", async (ctx) => {
    try {
      await editIgnoringNotModified(() =>
        ctx.editMessageText(buildPerformanceText(), { parse_mode: "HTML", reply_markup: performanceKeyboard() })
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      getDeps().logger.error({ err: String(err) }, "performance:refresh callback failed");
      await ctx.answerCallbackQuery({ text: "Something went wrong, try again.", show_alert: false });
    }
  });

  bot.command("insights", async (ctx) => {
    await ctx.reply(buildInsightsText(), { parse_mode: "HTML", reply_markup: refreshButton("insights:refresh") });
  });

  bot.callbackQuery("insights:refresh", async (ctx) => {
    try {
      await editIgnoringNotModified(() =>
        ctx.editMessageText(buildInsightsText(), { parse_mode: "HTML", reply_markup: refreshButton("insights:refresh") })
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      getDeps().logger.error({ err: String(err) }, "insights:refresh callback failed");
      await ctx.answerCallbackQuery({ text: "Something went wrong, try again.", show_alert: false });
    }
  });

  bot.command("focus", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    const { settingsRepo, tokenRepo } = getDeps();
    const raw = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
    const current = settingsRepo.get(FOCUS_CHAIN_SETTING_KEY);

    if (!raw) {
      const counts = new Map(tokenRepo.countByChain().map((c) => [c.chain, c.count]));
      const options = Object.keys(CHAINS)
        .map((c) => `<code>/focus ${c}</code> — ${chainBadge(c)} (${counts.get(c) ?? 0} tracked)`)
        .join("\n");
      await ctx.reply(
        `<b>🎯 Focus mode</b>\n\nCurrently: <b>${current ? chainBadge(current) : "all chains"}</b>\n\n` +
          `Focusing spends the entire scan budget on one chain, so its coins get re-checked far more often ` +
          `and fewer moves are missed there — at the cost of ignoring the others.\n\n${options}\n` +
          `<code>/focus off</code> — track every chain again`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (raw === "off" || raw === "all") {
      settingsRepo.delete(FOCUS_CHAIN_SETTING_KEY);
      await ctx.reply("🎯 Focus cleared — tracking <b>all chains</b> again.", { parse_mode: "HTML" });
      return;
    }

    if (!(raw in CHAINS)) {
      await ctx.reply(`Unknown chain <code>${raw}</code>. Options: ${Object.keys(CHAINS).join(", ")}`, {
        parse_mode: "HTML",
      });
      return;
    }

    settingsRepo.set(FOCUS_CHAIN_SETTING_KEY, raw, Date.now());
    const tracked = new Map(tokenRepo.countByChain().map((c) => [c.chain, c.count])).get(raw) ?? 0;
    await ctx.reply(
      `🎯 Focused on <b>${chainBadge(raw)}</b> — the full scan budget now goes to its ${tracked.toLocaleString("en-US")} ` +
        `tracked coins, so each is revisited much more often.\n\n<code>/focus off</code> to go back to all chains.`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("config", async (ctx) => {
    await ctx.reply(buildConfigText(), { parse_mode: "HTML" });
  });

  bot.command("setconfig", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Owner only.");
      return;
    }

    const [rawKey, rawValue] = typeof ctx.match === "string" ? ctx.match.trim().split(/\s+/) : [];
    if (!rawKey || rawValue === undefined) {
      await ctx.reply("Usage: /setconfig <key> <value>");
      return;
    }

    if (!(CLASSIFIER_CONFIG_KEYS as string[]).includes(rawKey)) {
      await ctx.reply(`Unknown key <code>${rawKey}</code>. Use /config to see valid keys.`, { parse_mode: "HTML" });
      return;
    }
    const key = rawKey as keyof ClassifierConfig;

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      await ctx.reply("Value must be a finite number.");
      return;
    }

    const { settingsRepo, classifierConfig } = getDeps();
    settingsRepo.set(key, String(parsed), Date.now());
    await ctx.reply(`<code>${key}</code> set to <b>${classifierConfig[key]}</b> [override]`, { parse_mode: "HTML" });
  });

  bot.command("resetconfig", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("Owner only.");
      return;
    }

    const rawKey = typeof ctx.match === "string" ? ctx.match.trim() : "";
    if (!rawKey) {
      await ctx.reply("Usage: /resetconfig <key>");
      return;
    }

    if (!(CLASSIFIER_CONFIG_KEYS as string[]).includes(rawKey)) {
      await ctx.reply(`Unknown key <code>${rawKey}</code>. Use /config to see valid keys.`, { parse_mode: "HTML" });
      return;
    }
    const key = rawKey as keyof ClassifierConfig;

    const { settingsRepo, classifierConfig } = getDeps();
    settingsRepo.delete(key);
    await ctx.reply(`<code>${key}</code> reset to <b>${classifierConfig[key]}</b> [default]`, { parse_mode: "HTML" });
  });
}
