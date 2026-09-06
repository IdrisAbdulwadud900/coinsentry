import { describe, it, expect } from 'vitest';
import { rateWallet, isSmartMoney, summariseSmartMoney } from '../src/engine/smartMoney.js';
import type { WalletPnl } from '../src/data/solanatracker.js';

function pnl(over: Partial<WalletPnl> = {}): WalletPnl {
  return {
    wallet: 'W1', realizedUsd: 0, unrealizedUsd: 0, totalPnlUsd: 0,
    totalInvestedUsd: 1_000, wins: 20, losses: 20, winPercentage: 50,
    averageBuyUsd: 25, ...over,
  };
}

describe('rateWallet', () => {
  it('tiers on lifetime profit', () => {
    expect(rateWallet(pnl({ totalPnlUsd: 234_429 }))!.tier).toBe('elite');
    expect(rateWallet(pnl({ totalPnlUsd: 25_000 }))!.tier).toBe('profitable');
    expect(rateWallet(pnl({ totalPnlUsd: 500 }))!.tier).toBe('mixed');
    expect(rateWallet(pnl({ totalPnlUsd: -8_000 }))!.tier).toBe('losing');
  });

  it('does NOT punish a low win rate, which is normal here', () => {
    // The real wallet that prompted this module: up $234k on 389W/454L.
    // Memecoin returns are power-law — a few large winners pay for a long tail
    // of small losses. Ranking on win rate would put a break-even careful
    // trader above a hugely profitable one.
    const real = rateWallet(pnl({
      totalPnlUsd: 234_429, totalInvestedUsd: 682_045,
      wins: 389, losses: 454, winPercentage: 38.94,
    }))!;
    expect(real.tier).toBe('elite');
    expect(isSmartMoney(real)).toBe(true);
    expect(real.winPercentage).toBeLessThan(50);
  });

  it('refuses to rate too small a sample, whatever the profit', () => {
    // Three trades and one lucky win is not a track record.
    const lucky = rateWallet(pnl({ totalPnlUsd: 500_000, wins: 1, losses: 2 }))!;
    expect(lucky.tier).toBe('unknown');
    expect(isSmartMoney(lucky)).toBe(false);
  });

  it('computes lifetime ROI and position count', () => {
    const r = rateWallet(pnl({ totalPnlUsd: 500, totalInvestedUsd: 1_000, wins: 30, losses: 10 }))!;
    expect(r.roi).toBeCloseTo(0.5, 6);
    expect(r.positions).toBe(40);
  });

  it('survives a zero-invested record without dividing by zero', () => {
    const r = rateWallet(pnl({ totalInvestedUsd: 0, totalPnlUsd: 100 }))!;
    expect(Number.isFinite(r.roi)).toBe(true);
  });

  it('returns null when the provider had nothing', () => {
    expect(rateWallet(null)).toBeNull();
  });
});

describe('summariseSmartMoney', () => {
  it('counts only wallets with a real track record', () => {
    const s = summariseSmartMoney([
      rateWallet(pnl({ wallet: 'a', totalPnlUsd: 200_000 })),
      rateWallet(pnl({ wallet: 'b', totalPnlUsd: 15_000 })),
      rateWallet(pnl({ wallet: 'c', totalPnlUsd: -5_000 })),
      rateWallet(pnl({ wallet: 'd', totalPnlUsd: 999_999, wins: 1, losses: 1 })), // unrated
      null,
    ]);
    expect(s.rated).toBe(3);
    expect(s.smart).toBe(2);
    expect(s.elite).toBe(1);
    // The unrated lottery winner must not inflate the combined figure.
    expect(s.combinedPnlUsd).toBeCloseTo(215_000, 0);
  });

  it('handles an empty set', () => {
    expect(summariseSmartMoney([])).toEqual({ smart: 0, rated: 0, elite: 0, combinedPnlUsd: 0 });
  });
});
