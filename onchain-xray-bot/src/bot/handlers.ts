import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { analyzeToken, AnalysisError } from '../engine/analyze.js';
import { extractAddress, detectAddressKind } from '../data/chains.js';
import { renderOverview } from './render/overview.js';
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
  renderCopyList,
  renderWatchlist,
  paginate,
} from './render/screens.js';
import {
  watchWallet,
  unwatchWallet,
  listWatched,
  isWatched,
  isWatchableWallet,
  setWatchFilter,
} from '../data/watchlist.js';
import type { WatchFilter } from '../engine/walletWatch.js';
import type { AnalysisReport, Chain } from '../types/domain.js';
import {
  homeKeyboard,
  listKeyboard,
  walletKeyboard,
  simpleBack,
  walletPickerRow,
  walletTrackRow,
  parseCb,
  trackPromptKeyboard,
  trackFilterKeyboard,
  trackChainKeyboard,
  type View,
  type ParsedCb,
} from './keyboards.js';
import {
  createSession,
  getSession,
  getCachedAnalysis,
  cacheAnalysis,
  checkCooldown,
  markRun,
  createTrackPrompt,
  getTrackPrompt,
  type Session,
} from './session.js';
import { progressCard, ICON } from './ui.js';
import { sortEarlyBuyers, type EntrySort } from '../engine/entries.js';
import { rankBadge, esc, shortAddr } from '../util/format.js';
import { CHAINS } from '../data/chains.js';
import { HeliusClient } from '../data/helius.js';

const SEND_OPTS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
};

const WELCOME = [
  `${ICON.brand} <b>XRAY</b> — find traders worth following`,
  '',
  'Paste a contract address. In about a minute you get:',
  '',
  `🏆 <b>Proven winners</b> — wallets that made ${'$'}300+ at 3x+ on this coin AND have won at least 3 other coins the same way`,
  `${ICON.floor} <b>First buyers</b> — who was in at the bottom, and what they walked away with`,
  `${ICON.diamond} <b>Diamond hands</b> — who rode it 3x, 10x, 100x before selling anything`,
  '📌 <b>Track</b> any wallet on any chain and get told when it trades',
  '',
  `<b>Paste a wallet address</b> and I will offer to watch it — buys, sells, transfers, or all three. Two tracked wallets buying the same coin raises a louder alert.`,
  `<b>${'/'}deep &lt;contract&gt;</b> replays every transaction instead — much slower, but it is what uncovers supply relays and the dev's linked wallets.`,
  '',
  '<b>Chains:</b> Solana, Ethereum, BNB Chain, Base, HyperEVM.',
].join('\n');

const HELP = [
  `${ICON.brand} <b>How to read the report</b>`,
  '',
  '<b>Floor band</b> — the lowest market cap this coin ever printed, up to a small multiple above it. Wallets that bought inside that band caught the actual bottom.',
  '',
  '<b>Peak while holding</b> — the highest market cap reached between a wallet\'s first buy and its first sell. This is the conviction number: it measures how far someone rode it before taking anything off, not what they ended up with.',
  '',
  '<b>Supply relay</b> — wallet A buys early, sends tokens to wallet B, and B sells them. A never prints a sell, so it still looks like a holder. The suspicion score weighs how good A\'s entry was, whether B ever bought anything itself, how much of the relayed supply B dumped, and how fast.',
  '',
  '<b>Confidence vs proof</b> — dev-cluster links are inference. A shared funder is often just an exchange withdrawal, and a high fan-in address is usually a CEX deposit. Both are flagged rather than hidden.',
  '',
  '<b>Tracking</b> — paste a wallet address and pick what to hear about: 🟢 buys, 🔴 sells, 📤 transfers, or ⚡ everything. Transfers are worth watching on their own: tokens leaving without a sale is how a position gets handed to another address. A tracked wallet is checked every couple of minutes, and the first check only records where it is, so nothing fires for trades it already made. Two tracked wallets BUYING the same coin raises a louder alert — selling never converges, since agreeing to leave is not agreeing to enter.',
  '',
  '<b>Commands</b>',
  '<code>/start</code> — the welcome card',
  '<code>/help</code> — this page',
  '<code>/track &lt;wallet&gt;</code> — watch a wallet (paste the address instead to choose what to hear about)',
  '<code>/untrack &lt;wallet&gt;</code> — stop watching it',
  '<code>/watchlist</code> — everything you are watching',
  '<code>/deep &lt;contract&gt;</code> — replay every transaction',
  '<i>Anything else that looks like an address is treated as one — paste a wallet and I will offer to track it.</i>',
].join('\n');

export function registerHandlers(bot: Bot): void {
  bot.command('start', (ctx) => ctx.reply(WELCOME, SEND_OPTS));
  bot.command('help', (ctx) => ctx.reply(HELP, SEND_OPTS));

  bot.command('deep', async (ctx) => {
    const target = extractAddress(ctx.match ?? '');
    if (!target) {
      await ctx.reply(
        'Send <code>/deep &lt;contract&gt;</code>. A deep scan replays every transaction — slower, but it is what finds supply relays and the dev funding graph.',
        SEND_OPTS,
      );
      return;
    }
    const userId = ctx.from?.id ?? 0;
    const wait = checkCooldown(userId);
    if (wait > 0) {
      await ctx.reply(`${ICON.clock} Hold on ${wait}s.`, SEND_OPTS);
      return;
    }
    markRun(userId);
    await runAnalysis(ctx, target, { force: true, deep: true });
  });

  bot.command('watchlist', async (ctx) => {
    const entries = await listWatched(ctx.chat.id);
    await ctx.reply(renderWatchlist(entries), SEND_OPTS);
  });

  bot.command('track', async (ctx) => {
    const target = extractAddress(ctx.match ?? '');
    if (!target) {
      await ctx.reply(
        'Send <code>/track &lt;wallet&gt;</code> to be told when it buys something new.',
        SEND_OPTS,
      );
      return;
    }
    if (/^0x/i.test(target)) {
      const promptId = createTrackPrompt(target, ctx.chat.id);
      await ctx.reply(
        [
          '📌 <b>Which chain is that wallet on?</b>',
          '',
          `<code>${esc(target)}</code>`,
          '',
          '<i>The same address exists on every EVM chain, so I have to be told which one to watch.</i>',
        ].join('\n'),
        { ...SEND_OPTS, reply_markup: trackChainKeyboard(promptId) },
      );
      return;
    }
    await ctx.reply(await trackWallet(ctx.chat.id, target, 'Added by hand'), SEND_OPTS);
  });

  bot.command('untrack', async (ctx) => {
    const target = extractAddress(ctx.match ?? '');
    if (!target) {
      await ctx.reply('Send <code>/untrack &lt;wallet&gt;</code>, or open the wallet and tap Track.', SEND_OPTS);
      return;
    }
    const removed = await unwatchWallet(ctx.chat.id, target);
    await ctx.reply(
      removed ? `Stopped tracking <code>${esc(target)}</code>.` : 'That wallet was not on your list.',
      SEND_OPTS,
    );
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const address = extractAddress(text);
    if (!address || detectAddressKind(address) === 'invalid') {
      await ctx.reply(
        `${ICON.warn} That does not look like a contract address.\n\n<i>Send a Solana mint (base58) or an EVM address starting with 0x.</i>`,
        SEND_OPTS,
      );
      return;
    }

    const userId = ctx.from?.id ?? 0;
    const wait = checkCooldown(userId);
    if (wait > 0) {
      await ctx.reply(`${ICON.clock} Hold on ${wait}s — one scan at a time.`, SEND_OPTS);
      return;
    }
    markRun(userId);

    await runAnalysis(ctx, address);
  });

  bot.on('callback_query:data', async (ctx) => {
    const parsed = parseCb(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    // The track flow is not report navigation — its id points at a pasted
    // wallet, not a session, so it is handled before the session lookup that
    // would otherwise reject it as an expired report.
    if (
      parsed.view === 'trackask' ||
      parsed.view === 'trackset' ||
      parsed.view === 'trackchain'
    ) {
      await handleTrackFlow(ctx, parsed, chatId);
      return;
    }

    const session = getSession(parsed.id, chatId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: 'That report expired. Send the address again to re-scan.',
        show_alert: true,
      });
      return;
    }

    // A re-scan is a fresh analysis, not a navigation event.
    if (parsed.view === 'home' && parsed.arg === 'refresh') {
      const userId = ctx.from?.id ?? 0;
      const wait = checkCooldown(userId);
      if (wait > 0) {
        await ctx.answerCallbackQuery({ text: `Hold on ${wait}s.`, show_alert: false });
        return;
      }
      markRun(userId);
      await ctx.answerCallbackQuery({ text: 'Re-scanning…' });
      await runAnalysis(ctx, session.report.token.address, { force: true });
      return;
    }

    try {
      await renderView(ctx, session, parsed.view, parsed.page, parsed.arg);
      await ctx.answerCallbackQuery();
    } catch (err) {
      // Telegram rejects an edit that would not change the message; that is a
      // no-op from the user's point of view, not an error worth surfacing.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('message is not modified')) {
        await ctx.answerCallbackQuery();
        return;
      }
      log.error({ err }, 'callback render failed');
      await ctx.answerCallbackQuery({ text: 'Something broke rendering that view.', show_alert: true });
    }
  });

  bot.catch((err) => {
    log.error({ err: err.error, update: err.ctx.update.update_id }, 'bot error');
  });
}

// --- Analysis run ------------------------------------------------------------

/**
 * Adds a wallet to the watchlist and says what happened, in one place.
 *
 * The button and the command share this so they cannot drift into telling the
 * user different things about the same list.
 */
async function trackWallet(chatId: number, wallet: string, note: string): Promise<string> {
  if (!isWatchableWallet(wallet)) {
    return `${ICON.warn} <b>That does not look like a wallet address.</b>`;
  }

  const res = await watchWallet(chatId, wallet, note);
  switch (res) {
    case 'added':
      return (
        `📌 <b>Now tracking</b> <code>${esc(wallet)}</code>\n\n` +
        `<i>You will get a message when it buys something new. First check establishes a baseline, so nothing fires for trades it already made.</i>\n\n` +
        `<code>/watchlist</code> to see the list ${ICON.bullet} <code>/untrack ${esc(wallet)}</code> to stop.`
      );
    case 'duplicate':
      return `Already on your list. <code>/watchlist</code> to see it.`;
    case 'full':
      return `${ICON.warn} Watchlist is full (${config.MAX_WATCHED_WALLETS}). Remove one with <code>/untrack</code> first.`;
    default:
      return `${ICON.warn} That wallet cannot be tracked.`;
  }
}

/**
 * The two taps between pasting a wallet and watching it: choose to track, then
 * choose what to hear about.
 */
async function handleTrackFlow(ctx: Context, parsed: ParsedCb, chatId: number): Promise<void> {
  const wallet = getTrackPrompt(parsed.id, chatId);
  if (!wallet) {
    await ctx.answerCallbackQuery({
      text: 'That prompt expired. Paste the wallet again.',
      show_alert: true,
    });
    return;
  }

  if (parsed.view === 'trackchain') {
    const chain = parsed.arg as Chain;
    const res = await watchWallet(chatId, wallet, 'Added by hand', 'buys', chain);
    await ctx.answerCallbackQuery({
      text: res === 'full' ? 'Watchlist is full.' : `Tracking on ${CHAINS[chain].label}.`,
      show_alert: res === 'full',
    });
    if (res !== 'full') {
      await ctx.api
        .editMessageText(
          chatId,
          ctx.callbackQuery!.message!.message_id,
          [
            `📌 <b>Now tracking on ${esc(CHAINS[chain].label)}</b>`,
            '',
            `<code>${esc(wallet)}</code>`,
            '',
            `<i>The first check only records where the chain is, so nothing fires for trades already made.</i>`,
          ].join('\n'),
          SEND_OPTS,
        )
        .catch(() => undefined);
    }
    return;
  }

  if (parsed.view === 'trackask') {
    await ctx.answerCallbackQuery();
    await ctx.api
      .editMessageText(
        chatId,
        ctx.callbackQuery!.message!.message_id,
        [
          `📌 <b>What should I tell you about?</b>`,
          '',
          `<code>${esc(wallet)}</code>`,
          '',
          `<i>🟢 Buys — it opened or added to a position</i>`,
          `<i>🔴 Sells — it took money off the table</i>`,
          `<i>📤 Transfers — tokens moved in or out without a trade, which is how a position gets handed to another address</i>`,
          `<i>⚡ Everything — all three</i>`,
        ].join('\n'),
        { ...SEND_OPTS, reply_markup: trackFilterKeyboard(parsed.id) },
      )
      .catch(() => undefined);
    return;
  }

  const filter = parsed.arg as WatchFilter;
  const res = await watchWallet(chatId, wallet, 'Added by hand', filter);
  if (res === 'added' || res === 'duplicate') {
    // Choosing again on a wallet already watched changes what it reports rather
    // than refusing — that is what tapping a different filter plainly means.
    if (res === 'duplicate') await setWatchFilter(chatId, wallet, filter);
    await ctx.answerCallbackQuery({ text: `Tracking ${FILTER_LABEL[filter]}.` });
    await ctx.api
      .editMessageText(
        chatId,
        ctx.callbackQuery!.message!.message_id,
        [
          `📌 <b>Now tracking</b> ${FILTER_LABEL[filter]}`,
          '',
          `<code>${esc(wallet)}</code>`,
          '',
          `<i>The first check only records where the wallet is now, so nothing fires for trades it already made.</i>`,
          '',
          `<code>/watchlist</code> to see the list ${ICON.bullet} <code>/untrack ${esc(wallet)}</code> to stop.`,
        ].join('\n'),
        SEND_OPTS,
      )
      .catch(() => undefined);
    return;
  }

  await ctx.answerCallbackQuery({
    text:
      res === 'full'
        ? `Watchlist is full (${config.MAX_WATCHED_WALLETS}). Remove one with /untrack first.`
        : 'That does not look like a wallet address.',
    show_alert: true,
  });
}

const FILTER_LABEL: Record<WatchFilter, string> = {
  buys: 'buys',
  sells: 'sells',
  transfers: 'transfers',
  all: 'buys, sells and transfers',
};

async function runAnalysis(
  ctx: Context,
  address: string,
  opts: { force?: boolean; deep?: boolean } = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const cached = opts.force || opts.deep ? null : getCachedAnalysis(address);
  const status = await ctx.reply(progressCard('', 'Starting', address.slice(0, 12), 0.01), SEND_OPTS);

  if (cached) {
    const session = createSession(cached, chatId);
    await ctx.api.editMessageText(chatId, status.message_id, renderOverview(cached), {
      ...SEND_OPTS,
      reply_markup: homeKeyboard(session.id, cached),
    });
    return;
  }

  // Telegram throttles edits per chat, so progress is coalesced rather than
  // streamed — the last state always wins.
  let lastEdit = 0;
  let pending: { stage: string; detail?: string; pct: number } | null = null;
  let symbol = '';
  let inFlight = false;

  const flush = async () => {
    if (!pending || inFlight) return;
    const now = Date.now();
    if (now - lastEdit < 1200) return;
    const snapshot = pending;
    pending = null;
    lastEdit = now;
    inFlight = true;
    try {
      await ctx.api.editMessageText(
        chatId,
        status.message_id,
        progressCard(symbol, snapshot.stage, snapshot.detail, snapshot.pct),
        SEND_OPTS,
      );
    } catch {
      // A failed progress edit must never abort the analysis behind it.
    } finally {
      inFlight = false;
    }
  };

  try {
    const report = await analyzeToken(
      address,
      async (u) => {
        pending = u;
        await flush();
      },
      { deep: opts.deep },
    );

    symbol = report.token.symbol;
    cacheAnalysis(address, report);
    const session = createSession(report, chatId);

    await ctx.api.editMessageText(chatId, status.message_id, renderOverview(report), {
      ...SEND_OPTS,
      reply_markup: homeKeyboard(session.id, report),
    });
  } catch (err) {
    const text =
      err instanceof AnalysisError
        ? `${ICON.warn} <b>${esc(err.message)}</b>${err.hint ? `\n\n<i>${esc(err.hint)}</i>` : ''}`
        : `${ICON.warn} <b>The scan failed.</b>\n\n<i>${esc(err instanceof Error ? err.message : String(err))}</i>`;

    if (!(err instanceof AnalysisError)) log.error({ err, address }, 'analysis failed');

    // A wallet address is not a broken contract address — it is a different
    // intention. Answering "no trading pair found" told the user their input
    // was wrong when it was simply not a coin, and buried the one thing the
    // bot can do with it.
    // Only when the chain itself confirms it is a wallet. A Solana mint has the
    // same shape, so guessing from the address would tell every user who pastes
    // an unlaunched token that they pasted a wallet.
    const helius = HeliusClient.fromConfig();
    const kind =
      err instanceof AnalysisError && isWatchableWallet(address) && helius
        ? await helius.accountKind(address)
        : 'unknown';
    if (kind === 'wallet') {
      const promptId = createTrackPrompt(address, chatId);
      const offer = [
        `📌 <b>That is a wallet, not a coin.</b>`,
        '',
        `<code>${esc(address)}</code>`,
        '',
        `<i>I can watch it and message you when it trades. Tap below to pick what you want to hear about.</i>`,
      ].join('\n');
      await ctx.api
        .editMessageText(chatId, status.message_id, offer, {
          ...SEND_OPTS,
          reply_markup: trackPromptKeyboard(promptId),
        })
        .catch(() => ctx.reply(offer, { ...SEND_OPTS, reply_markup: trackPromptKeyboard(promptId) }));
      return;
    }

    await ctx.api
      .editMessageText(chatId, status.message_id, text, SEND_OPTS)
      .catch(() => ctx.reply(text, SEND_OPTS));
  }
}

// --- View routing ------------------------------------------------------------

async function renderView(
  ctx: Context,
  session: Session,
  view: View,
  page: number,
  arg: string,
): Promise<void> {
  const { report, id } = session;

  const edit = (text: string, markup: InlineKeyboard) =>
    ctx.editMessageText(text, { ...SEND_OPTS, reply_markup: markup });

  switch (view) {
    case 'home':
      await edit(renderOverview(report), homeKeyboard(id, report));
      return;

    case 'floor': {
      if (arg === 'earliest' || arg === 'biggest' || arg === 'profit') session.sort = arg as EntrySort;
      const sorted = sortEarlyBuyers(report.floorEntries, session.sort);
      const { slice, info } = paginate(sorted, page);
      const kb = listKeyboard(id, 'floor', info, { sort: session.sort, copyKind: 'floor' });
      await addWalletButtons(kb, session, 'floor', info.page, slice.map((e) => e.ledger.wallet));
      await edit(renderFloorEntries(report, info.page, session.sort), kb);
      return;
    }

    case 'first': {
      const { info } = paginate(report.providerEntries, page);
      const kb = listKeyboard(id, 'first', info, {});
      await edit(renderProviderEntries(report, info.page), kb);
      return;
    }

    case 'play': {
      await edit(renderWinningPlay(report), simpleBack(id));
      break;
    }

    case 'winners': {
      const { info } = paginate(report.provenWinners, page);
      await edit(renderProvenWinners(report, info.page), listKeyboard(id, 'winners', info, {}));
      return;
    }

    case 'diamond': {
      const useProvider =
        report.diamondHands.length === 0 && report.providerDiamondHands.length > 0;
      if (useProvider) {
        const { info } = paginate(report.providerDiamondHands, page);
        await edit(renderDiamondHands(report, info.page), listKeyboard(id, 'diamond', info, {}));
        return;
      }
      const { slice, info } = paginate(report.diamondHands, page);
      const kb = listKeyboard(id, 'diamond', info, { copyKind: 'diamond' });
      await addWalletButtons(kb, session, 'diamond', info.page, slice.map((d) => d.ledger.wallet));
      await edit(renderDiamondHands(report, info.page), kb);
      return;
    }

    case 'dev': {
      const { slice, info } = paginate(report.linkedWallets, page);
      const kb = listKeyboard(id, 'dev', info, { copyKind: 'dev' });
      await addWalletButtons(kb, session, 'dev', info.page, slice.map((l) => l.wallet));
      await edit(renderDevCluster(report, info.page), kb);
      return;
    }

    case 'relay': {
      const { slice, info } = paginate(report.supplyRelays, page, 4);
      const kb = listKeyboard(id, 'relay', info, { copyKind: 'relay' });
      await addWalletButtons(kb, session, 'relay', info.page, slice.map((r) => r.source));
      await edit(renderRelays(report, info.page), kb);
      return;
    }

    case 'risk':
      await edit(renderRisk(report), simpleBack(id));
      return;

    case 'copy': {
      const kind = (arg || 'floor') as 'floor' | 'diamond' | 'dev' | 'relay';
      await edit(renderCopyList(report, kind), simpleBack(id));
      return;
    }

    case 'wallet': {
      const [back = 'floor', idxRaw = ''] = arg.split(':');
      const idx = Number(idxRaw);
      const wallet = session.wallets[idx];
      const ledger = wallet ? session.ledgers.get(wallet) : undefined;
      if (!ledger) {
        await edit('<i>That wallet is no longer in this report.</i>', simpleBack(id));
        return;
      }
      const watched = await isWatched(session.chatId, wallet!);
      // No track button on chains the poller cannot read. Offering one is a
      // false affordance: Helius speaks Solana only, so an EVM wallet would
      // wear a "Tracked" badge and never alert.
      const trackable = report.token.chain === 'solana';
      await edit(
        renderWallet(report, ledger),
        walletKeyboard(id, back as View, page, {
          walletIdx: trackable ? idx : undefined,
          watched,
        }),
      );
      return;
    }

    // Toggling from a list. Deliberately re-renders the SAME screen rather than
    // opening the wallet: the reader is working down a list and being thrown to
    // another view for each decision is what made this worth adding.
    case 'qtrack': {
      const [back = 'floor', idxRaw = ''] = arg.split(':');
      const wallet = session.wallets[Number(idxRaw)];
      if (!wallet) {
        await ctx.answerCallbackQuery({ text: 'That wallet is no longer in this report.' });
        return;
      }
      const already = await isWatched(session.chatId, wallet);
      if (already) {
        await unwatchWallet(session.chatId, wallet);
        await ctx.answerCallbackQuery({ text: `Stopped tracking ${shortAddr(wallet, 4, 4)}.` });
      } else {
        // The chain comes from the report, which is why tracking from a list
        // needs no chain question the way a bare address does.
        const res = await watchWallet(
          session.chatId,
          wallet,
          `Found on $${report.token.symbol.trim().toUpperCase()}`,
          'buys',
          report.token.chain,
        );
        if (res === 'full') {
          await ctx.answerCallbackQuery({
            text: `Watchlist is full (${config.MAX_WATCHED_WALLETS}). Remove one with /untrack first.`,
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery({
          text: `Tracking ${shortAddr(wallet, 4, 4)} — you will hear when it buys.`,
        });
      }

      await rerenderList(ctx, session, report, back as View, page, edit);
      return;
    }

    case 'track': {
      const [back = 'floor', idxRaw = ''] = arg.split(':');
      const idx = Number(idxRaw);
      const wallet = session.wallets[idx];
      const ledger = wallet ? session.ledgers.get(wallet) : undefined;
      if (!wallet || !ledger) {
        await edit('<i>That wallet is no longer in this report.</i>', simpleBack(id));
        return;
      }

      const already = await isWatched(session.chatId, wallet);
      if (already) {
        await unwatchWallet(session.chatId, wallet);
      } else {
        const note = `Found on $${report.token.symbol.trim().toUpperCase()}`;
        const res = await watchWallet(session.chatId, wallet, note, 'buys', report.token.chain);
        if (res === 'unsupported') {
          await ctx.answerCallbackQuery({
            text: 'That does not look like a wallet address.',
            show_alert: true,
          });
          return;
        }
        if (res === 'full') {
          await ctx.answerCallbackQuery({
            text: `Watchlist is full (${config.MAX_WATCHED_WALLETS}). Remove one first.`,
            show_alert: true,
          });
          return;
        }
      }

      await edit(
        renderWallet(report, ledger),
        walletKeyboard(id, back as View, page, { walletIdx: idx, watched: !already }),
      );
      return;
    }

    default:
      await edit(renderOverview(report), homeKeyboard(id, report));
  }
}

/** Adds one drill-down button per visible row, labelled to match its rank. */
/**
 * Redraws whichever list the reader was on, with the track state refreshed.
 *
 * Shares the paging and sorting of the original handlers rather than
 * duplicating them, so a toggle cannot land the reader on a different page
 * than the one they tapped from.
 */
async function rerenderList(
  ctx: Context,
  session: Session,
  report: AnalysisReport,
  view: View,
  page: number,
  edit: (text: string, kb: InlineKeyboard) => Promise<unknown>,
): Promise<void> {
  const id = session.id;
  if (view === 'diamond') {
    const { slice, info } = paginate(report.diamondHands, page);
    const kb = listKeyboard(id, 'diamond', info, {});
    await addWalletButtons(kb, session, 'diamond', info.page, slice.map((d) => d.ledger.wallet));
    await edit(renderDiamondHands(report, info.page), kb);
    return;
  }
  if (view === 'dev') {
    const { slice, info } = paginate(report.linkedWallets, page);
    const kb = listKeyboard(id, 'dev', info, {});
    await addWalletButtons(kb, session, 'dev', info.page, slice.map((l) => l.wallet));
    await edit(renderDevCluster(report, info.page), kb);
    return;
  }
  if (view === 'relay') {
    const { slice, info } = paginate(report.supplyRelays, page, 4);
    const kb = listKeyboard(id, 'relay', info, {});
    await addWalletButtons(kb, session, 'relay', info.page, slice.map((r) => r.source));
    await edit(renderRelays(report, info.page), kb);
    return;
  }
  const sorted = sortEarlyBuyers(report.floorEntries, session.sort);
  const { slice, info } = paginate(sorted, page);
  const kb = listKeyboard(id, 'floor', info, { sort: session.sort, copyKind: 'floor' });
  await addWalletButtons(kb, session, 'floor', info.page, slice.map((e) => e.ledger.wallet));
  await edit(renderFloorEntries(report, info.page, session.sort), kb);
}

async function addWalletButtons(
  kb: InlineKeyboard,
  session: Session,
  view: View,
  page: number,
  wallets: string[],
): Promise<void> {
  const size = view === 'relay' ? 4 : config.LEADERBOARD_PAGE_SIZE;
  const entries = wallets
    .map((w, i) => {
      const walletIdx = session.walletIndex.get(w);
      // A linked wallet that never traded this token has no ledger to show, so
      // offering a button for it would only ever open an error screen.
      if (walletIdx === undefined || !session.ledgers.has(w)) return null;
      return { label: rankBadge(page * size + i).trim(), walletIdx };
    })
    .filter((e): e is { label: string; walletIdx: number } => e !== null);

  if (entries.length === 0) return;

  // The pager and section actions are already on the keyboard; wallet buttons
  // go above the final "Overview" row.
  const inline = kb.inline_keyboard;
  const lastRow = inline.pop();
  walletPickerRow(kb, session.id, view, page, entries);

  {
    const withState = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        tracked: await isWatched(session.chatId, session.wallets[e.walletIdx] ?? ''),
      })),
    );
    walletTrackRow(kb, session.id, view, page, withState);
  }

  if (lastRow) inline.push(lastRow);
}
