import { InlineKeyboard } from 'grammy';
import type { AnalysisReport } from '../types/domain.js';
import { computeVerdict } from '../engine/verdict.js';
import { dexScreenerUrl } from '../util/format.js';
import type { EntrySort } from '../engine/entries.js';
import type { PageInfo } from './render/screens.js';

export type View = 'home' | 'floor' | 'first' | 'winners' | 'play' | 'diamond' | 'dev' | 'relay' | 'risk' | 'wallet' | 'copy' | 'track';

/**
 * Callback payloads are limited to 64 bytes, so everything is positional and
 * addressed by the session's short id rather than by contract address.
 * Format: x|<sessionId>|<view>|<page>|<arg>
 */
export function cb(id: string, view: View, page = 0, arg = ''): string {
  return `x|${id}|${view}|${page}|${arg}`;
}

export interface ParsedCb {
  id: string;
  view: View;
  page: number;
  arg: string;
}

export function parseCb(data: string): ParsedCb | null {
  const parts = data.split('|');
  if (parts.length < 4 || parts[0] !== 'x') return null;
  const [, id, view, page, arg = ''] = parts;
  if (!id || !view) return null;
  return { id, view: view as View, page: Number(page) || 0, arg };
}

/** Home screen: one tap to every module, with counts so the tap is informed. */
export function homeKeyboard(id: string, report: AnalysisReport): InlineKeyboard {
  const v = computeVerdict(report);
  const useProviderDiamond =
    report.diamondHands.length === 0 && report.providerDiamondHands.length > 0;
  const diamondCount = useProviderDiamond
    ? report.providerDiamondHands.length
    : report.diamondHands.length;
  const holding = useProviderDiamond
    ? report.providerDiamondHands.filter((e) => e.stillHolding).length
    : report.diamondHands.filter((d) => d.ledger.stillHolding).length;
  const strongRelays = report.supplyRelays.filter((r) => r.suspicion >= 60).length;

  // When the replay never reached launch, the provider's first-buyer list is
  // the real answer to "who was early" — surface it in place of the thin one.
  // Same test the overview uses, so the button and the summary can never
  // disagree about which list exists.
  const useProvider =
    report.providerEntries.length > 0 &&
    (report.floorEntries.length === 0 || !report.reachedLaunch);

  const kb = new InlineKeyboard();

  // Repeat winners answer the question people actually act on, so it leads.
  if (report.provenWinners.length > 0) {
    kb.text(`🏆 Proven winners · ${report.provenWinners.length}`, cb(id, 'winners')).row();
  }
  // "How" sits next to "who": the style that earned most is the part a reader
  // can actually reuse on the next coin.
  if (report.winningPlays.length > 0) {
    kb.text('🧠 Winning play', cb(id, 'play')).row();
  }

  return kb
    .text(
      useProvider
        ? `🎯 First buyers · ${report.providerEntries.length}`
        : `🎯 Floor · ${report.floorEntries.length}`,
      cb(id, useProvider ? 'first' : 'floor'),
    )
    .text(`💎 Diamond · ${diamondCount}${holding ? `/${holding}💎` : ''}`, cb(id, 'diamond'))
    .row()
    .text(`🧬 Dev · ${report.linkedWallets.length}`, cb(id, 'dev'))
    .text(
      `🚨 Relays · ${report.supplyRelays.length}${strongRelays ? `/${strongRelays}🔴` : ''}`,
      cb(id, 'relay'),
    )
    .row()
    .text(`${v.icon} Risk ${v.risk}`, cb(id, 'risk'))
    .url('📊 Chart', dexScreenerUrl(report.token.chain, report.token.pairAddress ?? report.token.address))
    .row()
    .text('🔄 Re-scan', cb(id, 'home', 0, 'refresh'));
}

/** Pager + section actions. `sort` is only rendered for the floor-entry list. */
export function listKeyboard(
  id: string,
  view: View,
  info: PageInfo,
  opts: { sort?: EntrySort; copyKind?: string } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (info.pages > 1) {
    const prev = (info.page - 1 + info.pages) % info.pages;
    const next = (info.page + 1) % info.pages;
    kb.text('◀', cb(id, view, prev))
      .text(`${info.page + 1}/${info.pages}`, cb(id, view, info.page))
      .text('▶', cb(id, view, next))
      .row();
  }

  if (opts.sort) {
    const mark = (s: EntrySort, label: string) => (opts.sort === s ? `● ${label}` : label);
    kb.text(mark('earliest', '⏱ Earliest'), cb(id, view, 0, 'earliest'))
      .text(mark('biggest', '💰 Biggest'), cb(id, view, 0, 'biggest'))
      .text(mark('profit', '📈 Profit'), cb(id, view, 0, 'profit'))
      .row();
  }

  if (opts.copyKind) {
    kb.text('📋 Copy addresses', cb(id, 'copy', 0, opts.copyKind)).row();
  }

  kb.text('◀ Overview', cb(id, 'home'));
  return kb;
}

export function walletKeyboard(
  id: string,
  back: View,
  page: number,
  opts: { walletIdx?: number; watched?: boolean } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Tracking is the payoff of the whole report: once a wallet looks worth
  // following, the useful question stops being what it did and becomes what it
  // buys next.
  if (opts.walletIdx !== undefined) {
    kb.text(
      opts.watched ? '📌 Tracked — tap to stop' : '📌 Track this wallet',
      cb(id, 'track', page, `${back}:${opts.walletIdx}`),
    ).row();
  }
  return kb.text('◀ Back', cb(id, back, page)).text('🏠 Overview', cb(id, 'home'));
}

export function simpleBack(id: string): InlineKeyboard {
  return new InlineKeyboard().text('◀ Overview', cb(id, 'home'));
}

/**
 * Wallet drill-down buttons for the rows currently on screen.
 * Labelled by rank so each button maps visually to the entry above it.
 */
export function walletPickerRow(
  kb: InlineKeyboard,
  id: string,
  view: View,
  page: number,
  indices: { label: string; walletIdx: number }[],
): InlineKeyboard {
  if (indices.length === 0) return kb;
  indices.forEach((entry, i) => {
    kb.text(entry.label, cb(id, 'wallet', page, `${view}:${entry.walletIdx}`));
    if ((i + 1) % 4 === 0) kb.row();
  });
  kb.row();
  return kb;
}
