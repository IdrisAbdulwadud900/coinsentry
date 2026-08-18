import { config } from '../config.js';
import { isInfrastructure } from '../data/knownAddresses.js';
import type {
  Chain,
  FundingTransfer,
  SupplyTransfer,
  WalletLedger,
  LinkedWallet,
  LinkType,
  Trade,
} from '../types/domain.js';

interface DevGraphInput {
  chain: Chain;
  dev: string;
  fundingTransfers: FundingTransfer[];
  supplyTransfers: SupplyTransfer[];
  trades: Trade[];
  ledgers: Map<string, WalletLedger>;
  firstTradeTs: number;
  totalSupply: number;
}

const BASE_STRENGTH: Record<LinkType, number> = {
  'funded-by-dev': 86,
  'token-transfer': 80,
  'funded-dev': 74,
  'common-funder': 58,
  'bundle-cobuy': 52,
};

export const LINK_LABEL: Record<LinkType, string> = {
  'funded-by-dev': 'Funded by dev',
  'funded-dev': 'Funded the dev',
  'common-funder': 'Shares a funder with dev',
  'token-transfer': 'Traded supply with dev',
  'bundle-cobuy': 'Bought in the launch bundle',
};

/**
 * Maps out wallets that look controlled by, or coordinated with, the deployer.
 *
 * Evidence is combined rather than ranked: a wallet that was funded by the dev
 * AND bought in the launch bundle is a much stronger claim than either signal
 * alone, so additional independent links raise confidence with diminishing
 * returns instead of simply taking the strongest one.
 *
 * Confidence, not proof — a shared funder can be an exchange withdrawal, and
 * that ambiguity is surfaced in the UI rather than hidden behind a score.
 */
export function buildDevGraph(input: DevGraphInput): LinkedWallet[] {
  const { chain, dev, fundingTransfers, supplyTransfers, trades, ledgers, firstTradeTs } = input;
  if (!dev) return [];

  const links = new Map<string, Set<LinkType>>();
  const hops = new Map<string, number>();
  const via = new Map<string, string>();

  const addLink = (wallet: string, type: LinkType, hop: number, viaAddr?: string) => {
    if (!wallet || wallet === dev) return;
    // Every wallet on the token touches the router and the launchpad program,
    // so linking through them would make the dev cluster the entire chain.
    if (isInfrastructure(chain, wallet)) return;
    let set = links.get(wallet);
    if (!set) links.set(wallet, (set = new Set()));
    set.add(type);
    const prev = hops.get(wallet);
    if (prev === undefined || hop < prev) hops.set(wallet, hop);
    if (viaAddr && !via.has(wallet)) via.set(wallet, viaAddr);
  };

  // --- Funding graph, walked outward from the dev ---------------------------
  const outEdges = new Map<string, Set<string>>();
  const inEdges = new Map<string, Set<string>>();
  for (const f of fundingTransfers) {
    let o = outEdges.get(f.from);
    if (!o) outEdges.set(f.from, (o = new Set()));
    o.add(f.to);
    let i = inEdges.get(f.to);
    if (!i) inEdges.set(f.to, (i = new Set()));
    i.add(f.from);
  }

  const visited = new Set<string>([dev]);
  let frontier: string[] = [dev];

  for (let hop = 1; hop <= config.DEV_GRAPH_HOPS; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const outbound = [...(outEdges.get(node) ?? [])].slice(0, config.DEV_GRAPH_FANOUT);
      for (const w of outbound) {
        if (visited.has(w)) continue;
        addLink(w, 'funded-by-dev', hop, node === dev ? undefined : node);
        visited.add(w);
        next.push(w);
      }
      const inbound = [...(inEdges.get(node) ?? [])].slice(0, config.DEV_GRAPH_FANOUT);
      for (const w of inbound) {
        if (visited.has(w)) continue;
        addLink(w, 'funded-dev', hop, node === dev ? undefined : node);
        visited.add(w);
        next.push(w);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // --- Sibling wallets funded by the same source as the dev -----------------
  for (const funder of inEdges.get(dev) ?? []) {
    const siblings = [...(outEdges.get(funder) ?? [])].slice(0, config.DEV_GRAPH_FANOUT);
    for (const sib of siblings) {
      if (sib === dev) continue;
      addLink(sib, 'common-funder', 2, funder);
    }
  }

  // --- Direct token movement between the dev and anyone else ---------------
  for (const t of supplyTransfers) {
    if (t.from === dev) addLink(t.to, 'token-transfer', 1);
    else if (t.to === dev) addLink(t.from, 'token-transfer', 1);
  }

  // --- Launch bundle -------------------------------------------------------
  // Buys inside the opening seconds are the window where coordinated wallets
  // accumulate before anyone else can react.
  const bundleCutoff = firstTradeTs + config.BUNDLE_WINDOW_SECONDS;
  const devBuyBlocks = new Set(
    trades.filter((t) => t.wallet === dev && t.side === 'buy').map((t) => t.block),
  );
  const seenBundle = new Set<string>();
  for (const t of trades) {
    if (t.side !== 'buy' || t.ts > bundleCutoff) continue;
    if (t.wallet === dev || seenBundle.has(t.wallet)) continue;
    seenBundle.add(t.wallet);
    addLink(t.wallet, 'bundle-cobuy', devBuyBlocks.has(t.block) ? 1 : 2);
  }

  // --- Score ---------------------------------------------------------------
  const out: LinkedWallet[] = [];
  for (const [wallet, types] of links) {
    const sorted = [...types].sort((a, b) => BASE_STRENGTH[b] - BASE_STRENGTH[a]);
    const hop = hops.get(wallet) ?? 1;

    let strength = BASE_STRENGTH[sorted[0]!];
    // Each additional independent link adds less than the last.
    for (let i = 1; i < sorted.length; i++) {
      strength += BASE_STRENGTH[sorted[i]!] * 0.25 ** i;
    }
    // Distance from the dev dilutes the claim.
    strength *= hop <= 1 ? 1 : 0.72 ** (hop - 1);

    out.push({
      wallet,
      links: sorted,
      strength: Math.max(1, Math.min(100, Math.round(strength))),
      hops: hop,
      via: via.get(wallet) ?? null,
      ledger: ledgers.get(wallet) ?? null,
    });
  }

  // Wallets that actually touched this token come first. Walking the dev's
  // funding history surfaces every counterparty it ever paid — for a serial
  // deployer that is mostly unrelated activity, and those wallets would
  // otherwise outrank real participants purely on link strength.
  out.sort((a, b) => {
    const aActive = (a.ledger?.buyCount ?? 0) > 0 ? 1 : 0;
    const bActive = (b.ledger?.buyCount ?? 0) > 0 ? 1 : 0;
    return (
      bActive - aActive ||
      b.strength - a.strength ||
      (b.ledger?.totalBoughtUsd ?? 0) - (a.ledger?.totalBoughtUsd ?? 0)
    );
  });
  return out;
}

