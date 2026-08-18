import type { AnalysisReport } from '../types/domain.js';
import { summariseSmartMoney } from './smartMoney.js';

export interface VerdictFactor {
  label: string;
  /** Positive = adds risk, negative = reduces it. */
  weight: number;
  detail: string;
}

export interface Verdict {
  /** 0-100. Higher = more concerning. */
  risk: number;
  band: 'CLEAN' | 'WATCH' | 'ELEVATED' | 'HOSTILE';
  icon: string;
  factors: VerdictFactor[];
  /** Positive observations, shown separately so the card is not all red. */
  positives: VerdictFactor[];
}

/**
 * Rolls the individual findings into one number.
 *
 * Weighted rather than multiplicative on purpose: a single bad signal should
 * move the needle without pinning the score, because every input here is
 * inference from on-chain behaviour, not a verified fact about intent.
 */
export function computeVerdict(report: AnalysisReport): Verdict {
  const factors: VerdictFactor[] = [];
  const positives: VerdictFactor[] = [];

  // --- Dev cluster concentration -------------------------------------------
  const clusterHolding = clusterHoldingPct(report);
  if (clusterHolding >= 20) {
    factors.push({
      label: 'Dev cluster concentration',
      weight: 26,
      detail: `Dev and linked wallets hold ${clusterHolding.toFixed(1)}% of supply`,
    });
  } else if (clusterHolding >= 8) {
    factors.push({
      label: 'Dev cluster concentration',
      weight: 14,
      detail: `Dev and linked wallets hold ${clusterHolding.toFixed(1)}% of supply`,
    });
  } else if (clusterHolding > 0) {
    positives.push({
      label: 'Dev cluster is small',
      weight: -6,
      detail: `Linked wallets hold only ${clusterHolding.toFixed(1)}% of supply`,
    });
  }

  // --- Supply relays --------------------------------------------------------
  const strongRelays = report.supplyRelays.filter((r) => r.suspicion >= 60);
  if (strongRelays.length > 0) {
    const relayed = strongRelays.reduce((s, r) => s + r.relaySupplyPct, 0);
    factors.push({
      label: 'Hidden supply relays',
      weight: Math.min(30, 12 + strongRelays.length * 6),
      detail: `${strongRelays.length} early wallet${strongRelays.length > 1 ? 's' : ''} exited through a second address (${relayed.toFixed(2)}% of supply)`,
    });
  }

  // --- Dev behaviour --------------------------------------------------------
  const dev = report.devLedger;
  if (dev) {
    if (dev.fullyExited) {
      factors.push({
        label: 'Dev exited',
        weight: 22,
        detail: 'Deployer wallet has sold effectively its entire position',
      });
    } else if (dev.sellCount > 0) {
      factors.push({
        label: 'Dev has sold',
        weight: 11,
        detail: `Deployer took ${fmtPct(dev.totalSoldTokens, dev.totalBoughtTokens + dev.receivedTokens)} off the table`,
      });
    } else if (dev.balanceTokens > 0) {
      positives.push({
        label: 'Dev still holding',
        weight: -8,
        detail: 'Deployer wallet shows no sells',
      });
    }
  }

  // --- Launch bundling ------------------------------------------------------
  const bundled = report.linkedWallets.filter((l) => l.links.includes('bundle-cobuy'));
  if (bundled.length >= 8) {
    factors.push({
      label: 'Heavy launch bundle',
      weight: 16,
      detail: `${bundled.length} wallets bought within seconds of launch`,
    });
  } else if (bundled.length >= 3) {
    factors.push({
      label: 'Launch bundle',
      weight: 8,
      detail: `${bundled.length} wallets bought within seconds of launch`,
    });
  }

  // --- Token-level safety ---------------------------------------------------
  const safety = report.token.safety;
  if (safety.freezeAuthorityDisabled === false) {
    factors.push({
      label: 'Freeze authority live',
      weight: 24,
      detail: 'Holders can be frozen out of selling',
    });
  }
  if (safety.mintAuthorityDisabled === false) {
    factors.push({
      label: 'Mint authority live',
      weight: 18,
      detail: 'Supply can still be inflated',
    });
  }
  if (safety.topHoldersPct != null && safety.topHoldersPct >= 40) {
    factors.push({
      label: 'Holder concentration',
      weight: 12,
      detail: `Top holders control ${safety.topHoldersPct.toFixed(1)}%`,
    });
  }

  // --- Liquidity ------------------------------------------------------------
  if (report.token.liquidityUsd > 0 && report.token.liquidityUsd < 5_000) {
    factors.push({
      label: 'Thin liquidity',
      weight: 14,
      detail: `Only $${Math.round(report.token.liquidityUsd).toLocaleString()} in the pool`,
    });
  }

  // --- Positive: conviction holders ----------------------------------------
  const holders = report.diamondHands.filter((d) => d.ledger.stillHolding);
  if (holders.length >= 5) {
    positives.push({
      label: 'Early conviction',
      weight: -10,
      detail: `${holders.length} floor-range wallets are still holding through a ${holders[0]!.bucket}x+ run`,
    });
  }

  // --- Proven traders in this coin -----------------------------------------
  // Several independently profitable wallets buying the same coin early is the
  // strongest read available here, and the one thing an explorer cannot say.
  const smart = summariseSmartMoney(Object.values(report.smartMoney));
  if (smart.smart >= 3) {
    positives.push({
      label: 'Smart money present',
      weight: -12,
      detail: `${smart.smart} of the ${smart.rated} early wallets checked are profitable across other tokens${
        smart.elite > 0 ? ` (${smart.elite} up six figures)` : ''
      }`,
    });
  } else if (smart.rated >= 3 && smart.smart === 0) {
    factors.push({
      label: 'No proven traders',
      weight: 8,
      detail: `None of the ${smart.rated} early wallets checked are profitable across other tokens`,
    });
  }

  const raw = [...factors, ...positives].reduce((s, f) => s + f.weight, 0);
  const risk = Math.max(0, Math.min(100, Math.round(raw)));

  const band: Verdict['band'] =
    risk >= 70 ? 'HOSTILE' : risk >= 45 ? 'ELEVATED' : risk >= 22 ? 'WATCH' : 'CLEAN';
  const icon = { CLEAN: '🟢', WATCH: '🟡', ELEVATED: '🟠', HOSTILE: '🔴' }[band];

  factors.sort((a, b) => b.weight - a.weight);
  positives.sort((a, b) => a.weight - b.weight);

  return { risk, band, icon, factors, positives };
}

function clusterHoldingPct(report: AnalysisReport): number {
  const supply = report.token.totalSupply;
  if (supply <= 0) return 0;
  const seen = new Set<string>();
  let held = 0;
  if (report.devLedger) {
    seen.add(report.devLedger.wallet);
    held += report.devLedger.balanceTokens;
  }
  for (const l of report.linkedWallets) {
    if (!l.ledger || seen.has(l.wallet)) continue;
    // Only count wallets we are reasonably confident about.
    if (l.strength < 50) continue;
    seen.add(l.wallet);
    held += l.ledger.balanceTokens;
  }
  return (held / supply) * 100;
}

function fmtPct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.min(100, (part / whole) * 100).toFixed(0)}%`;
}
