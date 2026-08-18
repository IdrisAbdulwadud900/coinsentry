import { describe, it, expect } from 'vitest';
import { launchpadFloorUsd, getLaunchpadSpec, floorUnavailableReason } from '../src/data/launchpads.js';

describe('launchpad floors', () => {
  it('derives the documented pump.fun opening market cap', () => {
    // 30 virtual SOL / 1.073B virtual tokens on a 1B supply = 27.959 SOL FDV.
    // At $78.70/SOL that is the ~$2.2k figure quoted for a fresh launch.
    expect(launchpadFloorUsd('pump.fun', 78.7)).toBeCloseTo(2200, -1);
  });

  it('scales with the SOL price at launch, not a fixed dollar figure', () => {
    // The same curve is worth very different dollars in different markets —
    // which is why the floor must be valued at the launch-day rate.
    expect(launchpadFloorUsd('pump.fun', 60)).toBeCloseTo(1677.5, 0);
    expect(launchpadFloorUsd('pump.fun', 240)).toBeCloseTo(6710.2, 0);
  });

  it('recognises the post-graduation venue as the same curve', () => {
    expect(getLaunchpadSpec('pumpswap')?.label).toBe('pump.fun');
    expect(getLaunchpadSpec('PUMP.FUN')?.label).toBe('pump.fun');
  });

  it('returns null rather than guessing an unknown launchpad', () => {
    expect(launchpadFloorUsd('some-new-launchpad', 75)).toBeNull();
    expect(launchpadFloorUsd(null, 75)).toBeNull();
  });

  it('returns null when the native price is unusable', () => {
    expect(launchpadFloorUsd('pump.fun', 0)).toBeNull();
    expect(launchpadFloorUsd('pump.fun', Number.NaN)).toBeNull();
  });
});

describe('launchpads without a fixed curve', () => {
  it('refuses to derive a floor for a per-launch configurable curve', () => {
    // Meteora DBC lets the creator pick the curve, so no constant exists.
    expect(launchpadFloorUsd('met-dbc', 75)).toBeNull();
    expect(getLaunchpadSpec('met-dbc')?.configurable).toBe(true);
  });

  it('explains why the floor is unavailable, distinguishing the two cases', () => {
    expect(floorUnavailableReason('met-dbc')).toContain('per launch');
    expect(floorUnavailableReason('some-new-pad')).toContain('not known to this bot');
    expect(floorUnavailableReason(null)).toContain('launchpad is unknown');
  });

  it('treats the pump.fun floor as supply-independent', () => {
    // Sampled 2026-08-12: a 2B-supply launch opened at the same ~28 SOL FDV as
    // 1B-supply ones, because the virtual token reserve scales with supply.
    const floor = launchpadFloorUsd('pump.fun', 75.53);
    expect(floor).toBeCloseTo(2112, -1);
  });
});
