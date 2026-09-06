import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBuyAlert } from '../src/bot/render/screens.js';

const A = 'WalletAAA111111111111111111111111111111111';
const B = 'WalletBBB222222222222222222222222222222222';
const MINT = 'NewCoin111111111111111111111111111111111111';
const now = () => Math.floor(Date.now() / 1000);

describe('convergence detection', () => {
  let dir: string;
  let mod: typeof import('../src/data/buyLog.js');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xray-buylog-'));
    process.env.BUYLOG_PATH = join(dir, 'buys.json');
    vi.resetModules();
    mod = await import('../src/data/buyLog.js');
    mod.__resetForTests();
  });

  afterEach(async () => {
    delete process.env.BUYLOG_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  const buy = (wallet: string, ts = now(), chatId = 1) => ({
    chatId, wallet, mint: MINT, symbol: 'NEW', solSpent: 1, ts,
  });

  it('stays silent for a single wallet', async () => {
    await mod.recordBuys([buy(A)]);
    expect(await mod.findConvergence(1, MINT)).toBeNull();
  });

  it('fires when two distinct wallets buy the same token', async () => {
    await mod.recordBuys([buy(A), buy(B)]);
    const c = await mod.findConvergence(1, MINT);
    expect(c).not.toBeNull();
    expect(c!.wallets.sort()).toEqual([A, B].sort());
    expect(c!.totalSolSpent).toBeCloseTo(2, 6);
  });

  it('does NOT count one wallet buying repeatedly', async () => {
    // Averaging in is one decision, not two independent ones.
    await mod.recordBuys([buy(A), buy(A), buy(A)]);
    expect(await mod.findConvergence(1, MINT)).toBeNull();
  });

  it('ignores buys outside the window', async () => {
    await mod.recordBuys([buy(A, now() - 60 * 3600), buy(B)]);
    expect(await mod.findConvergence(1, MINT)).toBeNull();
  });

  it('keeps chats separate', async () => {
    // Two wallets converging only means something if one person chose both.
    await mod.recordBuys([buy(A, now(), 1), buy(B, now(), 2)]);
    expect(await mod.findConvergence(1, MINT)).toBeNull();
    expect(await mod.findConvergence(2, MINT)).toBeNull();
  });

  it('prunes stale entries so the log cannot grow forever', async () => {
    await mod.recordBuys([buy(A, now() - 60 * 3600)]);
    await mod.recordBuys([buy(B)]);
    // The stale entry is dropped, so B alone cannot converge.
    expect(await mod.findConvergence(1, MINT)).toBeNull();
  });
});

describe('buy alert rendering', () => {
  const base = {
    wallet: A, mint: MINT, symbol: 'NEW', name: 'New Coin',
    tokenAmount: 1000, solSpent: 0.84, usdSpent: 63.2, mcapUsd: 18_400,
    note: 'Found on $TRIPLET', signature: 'sigABC',
  };

  it('renders a routine buy', () => {
    const html = renderBuyAlert(base);
    expect(html).toContain('🔔');
    expect(html).toContain('$NEW');
    expect(html).toContain('Found on $TRIPLET');
  });

  it('renders convergence with a different header, not a footnote', () => {
    const html = renderBuyAlert({
      ...base,
      convergence: { wallets: [A, B], totalSolSpent: 3.2, firstTs: now() - 1800 },
    });
    expect(html).toContain('2 TRACKED WALLETS');
    expect(html).not.toContain('🔔');
    expect(html).toContain('3.20 SOL between them');
  });

  it('warns about live authorities', () => {
    const html = renderBuyAlert({ ...base, freezeAuthorityActive: true, mintAuthorityActive: true });
    expect(html).toContain('freeze authority is live');
    expect(html).toContain('mint authority is live');
  });

  it('says nothing about authorities when they are unknown', () => {
    // Absent data must never read as an all-clear.
    const html = renderBuyAlert(base);
    expect(html).not.toContain('authority');
  });

  it('escapes a hostile token name', () => {
    const html = renderBuyAlert({ ...base, name: '<script>x</script>', symbol: '<b>&' });
    expect(html).not.toContain('<script>');
  });

  it('stays inside the Telegram limit', () => {
    const html = renderBuyAlert({
      ...base,
      convergence: {
        wallets: Array.from({ length: 25 }, (_, i) => `W${String(i).padStart(43, 'x')}`),
        totalSolSpent: 99, firstTs: now() - 3600,
      },
    });
    expect(html.length).toBeLessThanOrEqual(4096);
  });
});

describe('alert suppression', () => {
  let dir: string;
  let mod: typeof import('../src/data/buyLog.js');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xray-cooldown-'));
    process.env.BUYLOG_PATH = join(dir, 'buys.json');
    vi.resetModules();
    mod = await import('../src/data/buyLog.js');
    mod.__resetForTests();
  });

  afterEach(async () => {
    delete process.env.BUYLOG_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  const buy = (wallet: string, ts = now()) => ({
    chatId: 1, wallet, mint: MINT, symbol: 'NEW', solSpent: 1, ts,
  });

  it('reports a repeat buy of the same token as recent', async () => {
    // A wallet averaging in over several transactions made one decision.
    await mod.recordBuys([buy(A)]);
    expect(await mod.hasRecentBuy(1, A, MINT, 3600)).toBe(true);
  });

  it('lets the same wallet alert again once the cooldown passes', async () => {
    await mod.recordBuys([buy(A, now() - 2 * 3600)]);
    expect(await mod.hasRecentBuy(1, A, MINT, 3600)).toBe(false);
  });

  it('does not suppress a DIFFERENT wallet buying the same token', async () => {
    // This is precisely the convergence case and must never be muted.
    await mod.recordBuys([buy(A)]);
    expect(await mod.hasRecentBuy(1, B, MINT, 3600)).toBe(false);
  });

  it('does not suppress the same wallet buying a different token', async () => {
    await mod.recordBuys([buy(A)]);
    expect(await mod.hasRecentBuy(1, A, 'Other11111111111111111111111111111111111111', 3600)).toBe(false);
  });
});
