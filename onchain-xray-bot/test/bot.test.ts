import { describe, it, expect } from 'vitest';
import { makeReport, makeProviderEntry, makeLedger } from './fixtures.js';
import { cb, parseCb, homeKeyboard, listKeyboard, walletKeyboard } from '../src/bot/keyboards.js';
import { createSession, getSession } from '../src/bot/session.js';
import { computeVerdict } from '../src/engine/verdict.js';
import { renderOverview } from '../src/bot/render/overview.js';

describe('callback payloads', () => {
  it('round-trips every field', () => {
    const p = parseCb(cb('abc123', 'wallet', 7, 'floor:42'));
    expect(p).toEqual({ id: 'abc123', view: 'wallet', page: 7, arg: 'floor:42' });
  });

  it('stays inside Telegram\'s 64-byte callback limit', () => {
    // Longest realistic payload: wallet drill-down from a deep page.
    const longest = cb('abc123', 'wallet', 999, 'diamond:9999');
    expect(Buffer.byteLength(longest, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('rejects malformed or foreign payloads instead of throwing', () => {
    expect(parseCb('')).toBeNull();
    expect(parseCb('garbage')).toBeNull();
    expect(parseCb('y|abc|home|0|')).toBeNull();
    expect(parseCb('x|abc')).toBeNull();
  });
});

describe('home keyboard', () => {
  it('offers the floor list when the replay reached launch', () => {
    const kb = homeKeyboard('s1', makeReport({ reachedLaunch: true }));
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('Floor'))).toBe(true);
    expect(labels.some((l) => l.includes('First buyers'))).toBe(false);
  });

  it('switches to first-buyers when the launch was out of reach', () => {
    const kb = homeKeyboard(
      's1',
      makeReport({ reachedLaunch: false, providerEntries: [makeProviderEntry()] }),
    );
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('First buyers'))).toBe(true);
  });

  it('counts provider diamonds when the replay found none', () => {
    const kb = homeKeyboard(
      's1',
      makeReport({ diamondHands: [], providerDiamondHands: [makeProviderEntry(), makeProviderEntry()] }),
    );
    const diamond = kb.inline_keyboard.flat().find((b) => b.text.includes('Diamond'))!;
    expect(diamond.text).toContain('2');
  });

  it('every button carries a parseable payload or a url', () => {
    for (const btn of homeKeyboard('s1', makeReport()).inline_keyboard.flat()) {
      const b = btn as { callback_data?: string; url?: string };
      if (b.callback_data) expect(parseCb(b.callback_data)).not.toBeNull();
      else expect(b.url).toBeTruthy();
    }
  });
});

describe('list keyboard paging', () => {
  it('wraps around at both ends rather than dead-ending', () => {
    const kb = listKeyboard('s1', 'floor', { page: 0, pages: 3, total: 20 });
    const row = kb.inline_keyboard[0]!.map((b) => (b as { callback_data: string }).callback_data);
    expect(parseCb(row[0]!)!.page).toBe(2); // ◀ from page 0 wraps to last
    expect(parseCb(row[2]!)!.page).toBe(1); // ▶
  });

  it('hides the pager for a single page', () => {
    const kb = listKeyboard('s1', 'floor', { page: 0, pages: 1, total: 3 });
    expect(kb.inline_keyboard.flat().some((b) => b.text === '◀')).toBe(false);
  });

  it('marks the active sort', () => {
    const kb = listKeyboard('s1', 'floor', { page: 0, pages: 1, total: 3 }, { sort: 'profit' });
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.startsWith('●') && l.includes('Profit'))).toBe(true);
  });
});

describe('sessions', () => {
  it('is only readable from the chat that created it', () => {
    const s = createSession(makeReport(), 111);
    expect(getSession(s.id, 111)).not.toBeNull();
    // A guessed id from another chat must not expose someone's report.
    expect(getSession(s.id, 222)).toBeNull();
  });

  it('returns null for an unknown id instead of throwing', () => {
    expect(getSession('nope00', 111)).toBeNull();
  });

  it('indexes every wallet the screens can drill into', () => {
    const s = createSession(makeReport(), 1);
    for (const w of s.wallets) expect(s.walletIndex.get(w)).toBeTypeOf('number');
    // Wallets with a ledger must be resolvable, or the button opens an error.
    for (const [w, i] of s.walletIndex) expect(s.wallets[i]).toBe(w);
  });

  it('carries the dev and relay wallets, not just the leaderboards', () => {
    const r = makeReport();
    const s = createSession(r, 1);
    expect(s.wallets).toContain(r.devWallet);
    expect(s.wallets).toContain(r.supplyRelays[0]!.source);
    expect(s.wallets).toContain(r.supplyRelays[0]!.sink);
  });
});

describe('verdict', () => {
  it('scores a clean report low and a hostile one high', () => {
    const clean = computeVerdict(makeReport({ supplyRelays: [], linkedWallets: [] }));
    expect(clean.risk).toBeLessThan(30);

    const hostile = computeVerdict(
      makeReport({
        token: { ...makeReport().token, safety: { freezeAuthorityDisabled: false, mintAuthorityDisabled: false } },
        devLedger: makeLedger({ fullyExited: true, stillHolding: false, sellCount: 5, balanceTokens: 0 }),
      }),
    );
    expect(hostile.risk).toBeGreaterThan(clean.risk);
    expect(hostile.factors.length).toBeGreaterThan(0);
  });

  it('never leaves the 0-100 range', () => {
    for (const r of [makeReport(), makeReport({ supplyRelays: [], diamondHands: [] })]) {
      const v = computeVerdict(r);
      expect(v.risk).toBeGreaterThanOrEqual(0);
      expect(v.risk).toBeLessThanOrEqual(100);
    }
  });

  it('band always matches the score', () => {
    const v = computeVerdict(makeReport());
    const expected = v.risk >= 70 ? 'HOSTILE' : v.risk >= 45 ? 'ELEVATED' : v.risk >= 22 ? 'WATCH' : 'CLEAN';
    expect(v.band).toBe(expected);
  });
});

describe('the fast path must not report zero', () => {
  it('shows the provider list when nothing was replayed at all', () => {
    // The Solana fast path replays no transactions yet sets reachedLaunch, so
    // keying off that alone printed "Floor entries 0" next to a button
    // offering 82 wallets.
    const report = makeReport({
      reachedLaunch: true,
      floorEntries: [],
      tradeCount: 0,
      uniqueWallets: 0,
      providerEntries: [makeProviderEntry(), makeProviderEntry()],
    });
    const labels = homeKeyboard('s1', report).inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('First buyers'))).toBe(true);
    expect(renderOverview(report)).toContain('First buyers');
  });

  it('never prints "0 trades" when there was no replay to count', () => {
    const html = renderOverview(
      makeReport({ tradeCount: 0, uniqueWallets: 0, floorEntries: [], providerEntries: [makeProviderEntry()] }),
    );
    expect(html).not.toContain('0 trades');
    expect(html).toContain('no transaction replay');
  });

  it('still reports replay counts when there was a replay', () => {
    const html = renderOverview(makeReport({ tradeCount: 1_500, uniqueWallets: 400 }));
    expect(html).toContain('trades');
    expect(html).not.toContain('no transaction replay');
  });
});
