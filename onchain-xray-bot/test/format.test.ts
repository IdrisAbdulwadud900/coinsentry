import { describe, it, expect } from 'vitest';
import { usd, compact, count, mult, pct, duration, shortAddr, esc, bar, sparkline, rankBadge } from '../src/util/format.js';
import { detectAddressKind, normalizeAddress, extractAddress } from '../src/data/chains.js';

describe('usd', () => {
  it('keeps a memecoin\'s leading zeros readable', () => {
    // Losing these turns a real price into "$0.00", which is the failure mode
    // that matters: the significant digits must survive at any magnitude.
    expect(usd(0.00004821)).toBe('$0.00004821');
    expect(usd(0.0000000123)).toBe('$0.0000000123');
    expect(usd(0.000000000456)).toBe('$0.000000000456');
    for (const v of [0.00004821, 0.0000000123, 0.000000000456]) {
      expect(usd(v)).not.toBe('$0.00');
      expect(usd(v)).not.toBe('$0');
    }
  });

  it('never uses scientific notation, which is unreadable as a price', () => {
    // toPrecision flips to exponential below ~1e-7 and printed "$1.230e-8" —
    // exactly the magnitude this bot deals in most.
    for (const v of [1e-8, 1.23e-9, 4.56e-12, 1e-15]) {
      expect(usd(v)).not.toMatch(/e[+-]/);
      expect(usd(v)).toMatch(/^\$0\.0+\d+$/);
    }
  });

  it('trims trailing zeros but keeps cents readable', () => {
    expect(usd(0.5)).toBe('$0.50');
    expect(usd(0.0012)).toBe('$0.0012');
    expect(usd(0.015)).toBe('$0.015');
  });
  it('scales the suffix with magnitude', () => {
    expect(usd(1_234)).toBe('$1.23K');
    expect(usd(45_600_000)).toBe('$45.6M');
    expect(usd(2_100_000_000)).toBe('$2.10B');
  });
  it('handles zero, negative and non-finite without emitting NaN', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(-500)).toBe('-$500.00');
    for (const v of [NaN, Infinity, null, undefined]) expect(usd(v as number)).toBe('—');
  });
});

describe('numbers', () => {
  it('count keeps precision until it stops mattering', () => {
    // "3,155 trades" is information; "3K trades" is not.
    expect(count(3_155)).toBe('3,155');
    expect(count(2_500_000)).toBe('2.5M');
  });
  it('mult loses decimals as the number grows', () => {
    expect(mult(3.456)).toBe('3.46x');
    expect(mult(42.7)).toBe('42.7x');
    expect(mult(1425.6)).toBe('1426x');
  });
  it('rejects nonsense multiples rather than printing them', () => {
    for (const v of [0, -3, NaN, null]) expect(mult(v as number)).toBe('—');
  });
  it('pct and compact survive bad input', () => {
    expect(pct(NaN)).toBe('—');
    expect(compact(null)).toBe('—');
  });
});

describe('duration', () => {
  it('picks a sensible unit at each scale', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(600)).toBe('10m');
    expect(duration(3_600)).toBe('1h');
    expect(duration(3_900)).toBe('1h 5m');
    expect(duration(90_000)).toBe('1d 1h');
  });
  it('never renders a negative hold', () => {
    expect(duration(-10)).toBe('0s');
  });
});

describe('escaping and addresses', () => {
  it('escapes exactly the three characters Telegram HTML needs', () => {
    expect(esc('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
  it('shortens without mangling short strings', () => {
    expect(shortAddr('0xaf2358e98683265cbd3a48509123d390ddf54534')).toBe('0xaf…4534');
    expect(shortAddr('abc')).toBe('abc');
    expect(shortAddr('')).toBe('—');
  });
});

describe('bars and sparklines', () => {
  it('bar stays inside its width at any ratio', () => {
    for (const r of [-1, 0, 0.5, 1, 99, NaN]) expect(bar(r, 10)).toHaveLength(10);
  });
  it('sparkline renders a rising series as rising', () => {
    const s = sparkline([1, 10, 100, 1000, 10000], 5);
    expect(s).toHaveLength(5);
    expect(s.charCodeAt(0)).toBeLessThan(s.charCodeAt(s.length - 1));
  });
  it('sparkline tolerates empty and zero-only input', () => {
    expect(sparkline([], 5)).toBe('');
    expect(sparkline([0, 0], 5)).toBe('');
  });
  it('rankBadge gives medals then numerals', () => {
    expect(rankBadge(0)).toBe('🥇');
    expect(rankBadge(3).trim()).toBe('4.');
  });
});

describe('address detection', () => {
  it('tells Solana and EVM apart', () => {
    expect(detectAddressKind('0x6982508145454Ce325dDbE47a25d4ec3d2311933')).toBe('evm');
    expect(detectAddressKind('J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump')).toBe('solana');
    expect(detectAddressKind('nonsense')).toBe('invalid');
    expect(detectAddressKind('0x123')).toBe('invalid');
  });

  it('NEVER lowercases a Solana address', () => {
    // Base58 is case-sensitive: lowercasing produces a different account.
    const sol = 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump';
    expect(normalizeAddress(sol)).toBe(sol);
    // EVM hex is case-insensitive and normalising it is what makes lookups work.
    expect(normalizeAddress('0xAF2358E98683265CBD3A48509123D390DDF54534')).toBe(
      '0xaf2358e98683265cbd3a48509123d390ddf54534',
    );
  });

  it('pulls an address out of pasted text', () => {
    expect(extractAddress('check this 0x6982508145454Ce325dDbE47a25d4ec3d2311933 ser')).toBe(
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    );
    expect(extractAddress('no address here')).toBeNull();
  });
});
