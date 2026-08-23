import { describe, it, expect } from 'vitest';
import { computeVerdict } from '../src/engine/verdict.js';
import { makeReport, makeLedger, makeProviderEntry } from './fixtures.js';
import type { EarlyBuyer } from '../src/types/domain.js';

const floorEntry = (supplyPct: number): EarlyBuyer => ({
  ledger: makeLedger(),
  tier: 'floor',
  entryRank: 1,
  secondsAfterLaunch: 0,
  supplyPct,
});

describe('one wallet taking the floor is a risk on its own', () => {
  it('flags a single wallet that bought most of the supply', () => {
    // Observed live: one HyperEVM address bought 73.63% of the supply nought
    // seconds after launch and dumped at 1.22x, scoring zero risk for it.
    const v = computeVerdict(makeReport({ floorEntries: [floorEntry(73.63)] }));
    const hit = v.factors.find((f) => /took the floor/i.test(f.label));
    expect(hit).toBeTruthy();
    expect(hit!.detail).toContain('73.6');
    expect(v.risk).toBeGreaterThan(0);
  });

  it('grades a quarter of the supply lower than most of it', () => {
    const heavy = computeVerdict(makeReport({ floorEntries: [floorEntry(80)] }));
    const some = computeVerdict(makeReport({ floorEntries: [floorEntry(30)] }));
    const heavyW = heavy.factors.find((f) => /floor/i.test(f.label))!.weight;
    const someW = some.factors.find((f) => /floor/i.test(f.label))!.weight;
    expect(heavyW).toBeGreaterThan(someW);
  });

  it('says nothing when the floor was shared out', () => {
    // Many small entries is the healthy shape and must not be penalised.
    const v = computeVerdict(
      makeReport({ floorEntries: [floorEntry(4), floorEntry(3), floorEntry(2)] }),
    );
    expect(v.factors.find((f) => /took the floor|Concentrated floor/i.test(f.label))).toBeFalsy();
  });

  it('still sees it on the Solana fast path, which has no replay', () => {
    // The provider entry list is the only one that exists there, so reading
    // only the replay's would drop the signal on an entire chain.
    const v = computeVerdict(
      makeReport({
        floorEntries: [],
        providerEntries: [makeProviderEntry({ tier: 'floor', supplyPct: 61 })],
      }),
    );
    expect(v.factors.find((f) => /took the floor/i.test(f.label))).toBeTruthy();
  });
});
