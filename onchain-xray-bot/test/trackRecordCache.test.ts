import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getMock = vi.fn();
vi.mock('../src/util/http.js', async () => {
  const actual = await vi.importActual<typeof import('../src/util/http.js')>('../src/util/http.js');
  return { ...actual, fetchJson: (...a: unknown[]) => getMock(...a) };
});

const { SolanaTrackerClient, clearTrackRecordCache } = await import('../src/data/solanatracker.js');

const PNL = {
  tokens: {
    MintA: { total: 5_000, total_invested: 500, current_value: 0, first_buy_time: 1_700_000_000 },
  },
};

beforeEach(() => {
  clearTrackRecordCache();
  getMock.mockReset();
});
afterEach(() => clearTrackRecordCache());

describe('track records are not re-fetched for every scan', () => {
  const client = () => new SolanaTrackerClient('key');

  it('serves a second lookup of the same wallet from memory', async () => {
    // These are the largest responses the bot requests and the first the
    // provider rate-limits. Two coins sharing one profitable wallet used to
    // pay for that wallet twice.
    getMock.mockResolvedValue(PNL);
    const c = client();
    const first = await c.walletTokenResults('WalletA');
    const second = await c.walletTokenResults('WalletA');
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second[0]!.multiple).toBeCloseTo(11, 6);
  });

  it('still fetches a wallet it has not seen', async () => {
    getMock.mockResolvedValue(PNL);
    const c = client();
    await c.walletTokenResults('WalletA');
    await c.walletTokenResults('WalletB');
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    // Caching one rate-limited moment would turn it into an hour of insisting
    // the wallet has no history at all.
    getMock.mockRejectedValueOnce(new Error('429'));
    const c = client();
    expect(await c.walletTokenResults('WalletA')).toEqual([]);

    getMock.mockResolvedValue(PNL);
    const retry = await c.walletTokenResults('WalletA');
    expect(retry).toHaveLength(1);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
