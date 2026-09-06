import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hist = await import('../src/data/walletHistory.js');

const W = '0x85b7c8453610d697666c3ef52634e283802b7bf3';
const sighting = (token: string, symbol: string, over = {}) => ({
  chain: 'hyperevm' as const,
  wallet: W,
  token,
  symbol,
  role: 'floor-taker' as const,
  supplyPct: 70,
  ts: 1_700_000_000,
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xray-hist-'));
  process.env.WALLET_HISTORY_PATH = join(dir, 'h.json');
  hist.__resetForTests();
});
afterEach(async () => {
  delete process.env.WALLET_HISTORY_PATH;
  await rm(dir, { recursive: true, force: true });
});

describe('recognising a wallet across scans', () => {
  it('reports a wallet seen on an earlier token', async () => {
    // The live case: one address took 73.63% of one HyperEVM token's floor and
    // is the relay source on another. No provider indexes that.
    await hist.recordSightings([sighting('0xtokenA', 'HYPECAT')]);
    const prior = await hist.priorSightings(W, '0xtokenB');
    expect(prior).toHaveLength(1);
    expect(prior[0]!.symbol).toBe('HYPECAT');
  });

  it('never counts the coin being scanned as a prior sighting', async () => {
    // Otherwise every wallet is a repeat of itself and the signal is noise.
    await hist.recordSightings([sighting('0xtokenA', 'HYPECAT')]);
    expect(await hist.priorSightings(W, '0xtokenA')).toHaveLength(0);
  });

  it('does not stack repeat scans of the same coin', async () => {
    await hist.recordSightings([sighting('0xtokenA', 'HYPECAT')]);
    await hist.recordSightings([sighting('0xtokenA', 'HYPECAT')]);
    expect(await hist.priorSightings(W, '0xother')).toHaveLength(1);
  });

  it('keeps roles apart', async () => {
    await hist.recordSightings([
      sighting('0xtokenA', 'HYPECAT'),
      sighting('0xtokenA', 'HYPECAT', { role: 'relay-source' }),
    ]);
    const prior = await hist.priorSightings(W, '0xother');
    expect(prior.map((p) => p.role).sort()).toEqual(['floor-taker', 'relay-source']);
  });

  it('matches a wallet whatever case it is written in', async () => {
    // EVM addresses arrive checksummed from some sources and lowercase from
    // others; a case-sensitive match would silently never fire.
    await hist.recordSightings([sighting('0xtokenA', 'HYPECAT')]);
    expect(await hist.priorSightings(W.toUpperCase(), '0xother')).toHaveLength(1);
  });

  it('counts distinct tokens scanned, so "first seen" can be honest', async () => {
    await hist.recordSightings([sighting('0xtokenA', 'A'), sighting('0xtokenB', 'B')]);
    expect(await hist.tokensScanned('hyperevm')).toBe(2);
    expect(await hist.tokensScanned('base')).toBe(0);
  });
});

describe('a repeat is counted once per wallet', () => {
  it('does not report one address many times', async () => {
    // A single address is routinely the source of dozens of relays on the same
    // coin. Counting rows instead of wallets turned one repeat operator into
    // "and 29 more wallets seen before".
    const { computeVerdict } = await import('../src/engine/verdict.js');
    const { makeReport } = await import('./fixtures.js');
    const one = {
      wallet: W,
      role: 'relay-source' as const,
      supplyPct: 3,
      priorTokens: ['HYPECAT'],
      priorCount: 1,
    };
    const v = computeVerdict(makeReport({ repeatOffenders: [one] }));
    const f = v.factors.find((x) => /Repeat operator/i.test(x.label))!;
    expect(f).toBeTruthy();
    expect(f.detail).not.toMatch(/more wallets recur/);
  });

  it('weights more distinct wallets higher than one', async () => {
    const { computeVerdict } = await import('../src/engine/verdict.js');
    const { makeReport } = await import('./fixtures.js');
    const mk = (w: string) => ({
      wallet: w, role: 'floor-taker' as const, supplyPct: 5,
      priorTokens: ['A'], priorCount: 1,
    });
    const single = computeVerdict(makeReport({ repeatOffenders: [mk('0xa')] }));
    const many = computeVerdict(makeReport({ repeatOffenders: [mk('0xa'), mk('0xb'), mk('0xc')] }));
    const w = (v: typeof single) => v.factors.find((x) => /Repeat operator/i.test(x.label))!.weight;
    expect(w(many)).toBeGreaterThan(w(single));
  });
});
