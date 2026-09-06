import type { HeliusTx } from '../data/helius.js';
import type { FirstBuyer } from '../data/solanatracker.js';
import { isInfrastructure } from '../data/knownAddresses.js';
import { config } from '../config.js';

/**
 * Finds the other wallets a profitable trader is running on the same coin.
 *
 * Serious traders rarely use one address. They split entries across alts to
 * hide size, to avoid being copy-traded, or to keep positions separate — so the
 * leaderboard shows several unremarkable wallets where there is really one
 * operator with a large position.
 *
 * **Direct funding between two winners does not work, and measuring it was how
 * that was established.** Across three coins and ~200 funding relationships,
 * not one profitable wallet had sent SOL straight to another profitable wallet
 * on the same coin. The reason is visible in the same data: the peers are
 * overwhelmingly wallets that never traded the coin at all, holding no position
 * and moving 100-400 SOL. Alts are funded THROUGH an intermediary, which is
 * exactly what defeats the naive A-to-B check.
 *
 * So the link this looks for is A <- F -> B: two wallets that both profited on
 * the coin and were both funded by the same address. On one sample coin two
 * wallets shared five separate funders, several sending mirrored amounts
 * (2.0/2.0, 1.5/1.5, 0.5/0.5 SOL) — a coincidence no unrelated pair produces.
 *
 * Keeping shared services out is the hard part, and the obvious guards do not
 * work. Amount does not separate them: one confirmed cluster was linked by
 * 0.5-2.0 SOL transfers, the very range a tip account moves. Nor does counting
 * how many wallets a peer touches — that flagged a treasury sending 19-200 SOL
 * to three of its own alts, while trading terminals slipped through.
 *
 * What separates them is whether the two amounts MATCH. An operator topping up
 * their own wallets sends each the same: 2.0/2.0, 1.5/1.5, 0.5/0.5, or 304.8
 * and 303.4. A service bills each wallet on its own usage, which is why the
 * false cluster measured while building this was linked by 14.4/2.7, 0.8/1.9
 * and 0.5/1.7 — nine shared peers, not one of them mirrored.
 *
 * None of this proves common ownership, and the UI says so. Two traders in the
 * same group chat can be funded by the same desk. It narrows the field.
 */

export interface SideWallet {
  wallet: string;
  /** Profit this wallet made on the coin being analysed. */
  profitUsd: number;
  investedUsd: number;
  multiple: number;
  /** Distinct addresses that funded both this wallet and the anchor. */
  sharedFunders: number;
  /** The largest amount any one shared funder sent to this wallet. */
  linkedSol: number;
  /** True when the two wallets also moved SOL between each other directly. */
  direct: boolean;
}

export interface FundingLink {
  sol: number;
  sent: boolean;
  received: boolean;
}

export type PeerMap = Map<string, FundingLink>;

const LAMPORTS = 1e9;

/**
 * Wallets that exchanged SOL directly with `wallet`, with how much and which
 * way. Dust is excluded — a few lamports is noise, not a funding relationship.
 */
export function extractFundingPeers(txs: HeliusTx[], wallet: string): PeerMap {
  const peers: PeerMap = new Map();

  for (const tx of txs) {
    if (!tx || tx.transactionError) continue;
    for (const nt of tx.nativeTransfers ?? []) {
      const amount = Number(nt.amount) / LAMPORTS;
      if (!Number.isFinite(amount) || amount < config.SIDE_WALLET_MIN_SOL) continue;

      const from = nt.fromUserAccount;
      const to = nt.toUserAccount;
      if (!from || !to || from === to) continue;

      const isSender = from === wallet;
      const isReceiver = to === wallet;
      if (!isSender && !isReceiver) continue;

      const peer = isSender ? to : from;
      if (!peer || peer === wallet) continue;
      // Exchanges and programs move SOL with everyone. Note this uses
      // isInfrastructure, not isNonTrader: the relay screen keeps exchanges
      // because a CEX is a real place supply can go, but here an exchange is
      // the single most common peer any wallet has and links nothing.
      if (isInfrastructure('solana', peer)) continue;

      const entry = peers.get(peer) ?? { sol: 0, sent: false, received: false };
      entry.sol += amount;
      if (isSender) entry.sent = true;
      else entry.received = true;
      peers.set(peer, entry);
    }
  }

  return peers;
}

/**
 * Whether a pair's shared funders clear the bar, and the strongest amount.
 *
 * Two shared funders is the ordinary threshold. One is accepted only when both
 * sides received a lot from it, which is the pattern real alt funding shows —
 * a single address sending 300+ SOL to each of two wallets is not a dispenser.
 */
function scorePair(a: PeerMap, b: PeerMap): { shared: number; strongest: number } | null {
  let shared = 0;
  let strongest = 0;
  let bigBoth = false;

  for (const [funder, linkA] of a) {
    const linkB = b.get(funder);
    if (!linkB) continue;
    // The funder has to have sent a real amount to BOTH sides. Bots and fee
    // payers touch thousands of wallets for a fraction of a SOL.
    if (linkA.sol < config.SIDE_WALLET_SHARED_MIN_SOL) continue;
    if (linkB.sol < config.SIDE_WALLET_SHARED_MIN_SOL) continue;
    // And it has to have sent them COMPARABLE amounts. This is the rule that
    // separates a real operator from a shared service, and size alone does not:
    // one confirmed cluster was linked by 0.5-2.0 SOL transfers, the same range
    // as a false one. What differs is the pairing. An operator topping up their
    // own wallets sends each the same — 2.0/2.0, 1.5/1.5, 0.5/0.5, or 304.8 and
    // 303.4 — while a terminal or bot service bills each wallet on its own
    // usage: 14.4/2.7, 0.8/1.9, 0.5/1.7.
    const ratio = Math.max(linkA.sol, linkB.sol) / Math.min(linkA.sol, linkB.sol);
    if (ratio > config.SIDE_WALLET_MIRROR_RATIO) continue;
    shared++;
    strongest = Math.max(strongest, linkB.sol);
    if (linkA.sol >= config.SIDE_WALLET_STRONG_SOL && linkB.sol >= config.SIDE_WALLET_STRONG_SOL) {
      bigBoth = true;
    }
  }

  if (shared === 0) return null;
  if (shared < config.SIDE_WALLET_MIN_SHARED_FUNDERS && !bigBoth) return null;
  return { shared, strongest };
}

/**
 * Links every wallet in `peerSets` to the others it shares funders with.
 *
 * `leaderboard` supplies the profit figures, and membership in it is the second
 * required fact: a linked wallet that did not make money on this coin is not
 * reported, because funding alone is a weak signal by itself.
 */
export function findSideWallets(
  peerSets: Map<string, PeerMap>,
  leaderboard: FirstBuyer[],
): Map<string, SideWallet[]> {
  const byWallet = new Map(leaderboard.map((b) => [b.wallet, b]));
  const out = new Map<string, SideWallet[]>();
  const wallets = [...peerSets.keys()];

  for (const anchor of wallets) {
    const anchorPeers = peerSets.get(anchor)!;
    const found: SideWallet[] = [];

    for (const other of wallets) {
      if (other === anchor) continue;
      const record = byWallet.get(other);
      // Only profitable positions count. A linked wallet that lost money on the
      // coin is not evidence of a coordinated entry.
      if (!record || record.totalPnlUsd < config.SIDE_WALLET_MIN_PROFIT_USD) continue;

      const otherPeers = peerSets.get(other)!;
      const score = scorePair(anchorPeers, otherPeers);
      const direct = anchorPeers.has(other) || otherPeers.has(anchor);
      if (!score && !direct) continue;

      const invested = record.totalInvestedUsd;
      found.push({
        wallet: other,
        profitUsd: record.totalPnlUsd,
        investedUsd: invested,
        multiple: invested > 0 ? (invested + record.totalPnlUsd) / invested : 0,
        sharedFunders: score?.shared ?? 0,
        linkedSol: score?.strongest ?? anchorPeers.get(other)?.sol ?? 0,
        direct,
      });
    }

    if (found.length > 0) {
      // Most shared funders first — that count is the strength of the claim.
      found.sort((x, y) => y.sharedFunders - x.sharedFunders || y.profitUsd - x.profitUsd);
      out.set(anchor, found);
    }
  }

  return out;
}

/**
 * Picks which wallets to spend funding lookups on, quietest first.
 *
 * This ordering is the difference between the check working and returning
 * nothing. A wallet's history is read newest-first with a fixed budget, so for
 * a trader with 5,000 coins those transactions cover a few hours of today and
 * never reach the funding. For a wallet with 8 coins the same budget covers its
 * entire life. Sorting by activity is what puts the funding event in range.
 */
export function orderByQuietness<T extends { wallet: string; coinsTraded: number }>(
  candidates: T[],
): T[] {
  return [...candidates]
    .filter((c) => c.coinsTraded > 0 && c.coinsTraded <= config.SIDE_WALLET_MAX_COINS)
    .sort((a, b) => a.coinsTraded - b.coinsTraded);
}

export interface SideCluster {
  /** Every wallet in the group, most profitable first. */
  members: { wallet: string; profitUsd: number; multiple: number }[];
  /** The strongest shared-funder count seen inside the group. */
  sharedFunders: number;
  /** Combined profit the group took out of this coin. */
  combinedProfitUsd: number;
  /** True when at least one pair also moved SOL directly. */
  direct: boolean;
}

/**
 * Groups linked pairs into clusters, so one operator running four wallets reads
 * as a single finding rather than six disconnected pairs.
 *
 * Deliberately NOT restricted to proven winners. The strongest cluster found
 * while building this — two wallets sharing twenty funders, roughly $4.7k profit
 * each — contained no repeat winner at all, and gating it behind that bar threw
 * the best result on the coin away. Splitting size across alts is the very thing
 * that keeps each individual wallet off a repeat-winner list.
 */
export function buildClusters(
  links: Map<string, SideWallet[]>,
  leaderboard: FirstBuyer[],
): SideCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const strength = new Map<string, number>();
  let anyDirect = new Set<string>();
  for (const [anchor, sides] of links) {
    if (!parent.has(anchor)) parent.set(anchor, anchor);
    for (const s of sides) {
      if (!parent.has(s.wallet)) parent.set(s.wallet, s.wallet);
      union(anchor, s.wallet);
      const key = find(anchor);
      strength.set(key, Math.max(strength.get(key) ?? 0, s.sharedFunders));
      if (s.direct) anyDirect.add(anchor);
    }
  }

  const byWallet = new Map(leaderboard.map((b) => [b.wallet, b]));
  const groups = new Map<string, string[]>();
  for (const w of parent.keys()) {
    const root = find(w);
    groups.set(root, [...(groups.get(root) ?? []), w]);
  }

  const clusters: SideCluster[] = [];
  for (const [root, wallets] of groups) {
    if (wallets.length < 2) continue;
    const members = wallets
      .map((w) => {
        const rec = byWallet.get(w);
        const invested = rec?.totalInvestedUsd ?? 0;
        const profit = rec?.totalPnlUsd ?? 0;
        return {
          wallet: w,
          profitUsd: profit,
          multiple: invested > 0 ? (invested + profit) / invested : 0,
        };
      })
      .sort((a, b) => b.profitUsd - a.profitUsd);

    clusters.push({
      members,
      // strength is stored per root, but union() can re-root mid-way, so scan
      // every key that now resolves to this root.
      sharedFunders: Math.max(
        0,
        ...[...strength.entries()].filter(([k]) => find(k) === root).map(([, v]) => v),
      ),
      combinedProfitUsd: members.reduce((sum, m) => sum + m.profitUsd, 0),
      direct: [...anyDirect].some((w) => find(w) === root),
    });
  }

  return clusters.sort((a, b) => b.combinedProfitUsd - a.combinedProfitUsd);
}
