import { describe, it, expect } from 'vitest';
import { analyzeToken, AnalysisError } from '../src/engine/analyze.js';

// Deliberately NOT in handlers.test.ts, which mocks analyzeToken away — these
// need the real guards, and they must reject before any network call.
describe('addresses refused before a scan starts', () => {
  it('rejects the zero address with an explanation', async () => {
    // DexScreener returns 30 real pools for 0x0, because Uniswap V4 uses it to
    // mean native ETH — so "no pair found" never fires, and the bot began a
    // 412-chunk Ethereum replay of something with no supply, no Transfer
    // events and no deployer.
    await expect(analyzeToken('0x0000000000000000000000000000000000000000', async () => {})).rejects.toThrow(
      /zero address/i,
    );
  });

  it('rejects it with surrounding whitespace', async () => {
    await expect(
      analyzeToken('  0x0000000000000000000000000000000000000000  ', async () => {}),
    ).rejects.toThrow(/zero address/i);
  });

  it('rejects an uppercase 0X prefix as a malformed address', async () => {
    // Caught by the shape check before the sentinel test, which is fine — it is
    // still refused, just for the more basic reason. Explorers emit lowercase.
    await expect(
      analyzeToken('0X0000000000000000000000000000000000000000', async () => {}),
    ).rejects.toThrow(AnalysisError);
  });

  it('rejects a string that is not an address at all', async () => {
    await expect(analyzeToken('notanaddress', async () => {})).rejects.toThrow(AnalysisError);
  });

  it('does not reject a real token that merely starts with zeros', async () => {
    // The guard must be the exact sentinel, not a prefix match — plenty of
    // vanity contracts begin with a long run of zeros.
    const near = '0x0000000000000000000000000000000000000001';
    await expect(analyzeToken(near, async () => {})).rejects.not.toThrow(/zero address/i);
  });
});
