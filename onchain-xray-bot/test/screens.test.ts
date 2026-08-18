import { describe, it, expect } from 'vitest';
import { makeReport, makeToken, makeProviderEntry, makeLedger } from './fixtures.js';
import { renderOverview } from '../src/bot/render/overview.js';
import {
  renderFloorEntries,
  renderProviderEntries,
  renderDiamondHands,
  renderDevCluster,
  renderRelays,
  renderRisk,
  renderWallet,
  renderCopyList,
  paginate,
} from '../src/bot/render/screens.js';

/** Telegram rejects malformed HTML outright, so every screen must be well-formed. */
function assertValidTelegramHtml(html: string) {
  const allowed = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)(?: [^>]*)?>/g)) {
    const [, close, tag] = m;
    expect(allowed.has(tag!), `unexpected tag <${tag}>`).toBe(true);
    if (close) {
      expect(stack.pop(), `unbalanced </${tag}>`).toBe(tag);
    } else {
      stack.push(tag!);
    }
  }
  expect(stack, `unclosed tags: ${stack.join(',')}`).toHaveLength(0);
}

const SCREENS: [string, (r: ReturnType<typeof makeReport>) => string][] = [
  ['overview', (r) => renderOverview(r)],
  ['floor', (r) => renderFloorEntries(r, 0, 'earliest')],
  ['first', (r) => renderProviderEntries(r, 0)],
  ['diamond', (r) => renderDiamondHands(r, 0)],
  ['dev', (r) => renderDevCluster(r, 0)],
  ['relay', (r) => renderRelays(r, 0)],
  ['risk', (r) => renderRisk(r)],
];

describe('every screen renders valid Telegram HTML', () => {
  for (const [name, render] of SCREENS) {
    it(`${name}: populated report`, () => {
      const html = render(makeReport());
      assertValidTelegramHtml(html);
      expect(html.length).toBeLessThanOrEqual(4096);
    });

    it(`${name}: completely empty report`, () => {
      const html = render(
        makeReport({
          floorEntries: [], diamondHands: [], providerEntries: [], providerDiamondHands: [],
          linkedWallets: [], supplyRelays: [], devWallet: null, devLedger: null,
          mcapSeries: [], warnings: [],
        }),
      );
      assertValidTelegramHtml(html);
      expect(html.length).toBeGreaterThan(0);
    });
  }

  it('wallet detail renders valid HTML', () => {
    const html = renderWallet(makeReport(), makeLedger());
    assertValidTelegramHtml(html);
  });
});

describe('hostile token metadata cannot break the message', () => {
  it('escapes HTML in the token name and symbol', () => {
    // A token can name itself anything; unescaped it would corrupt the message
    // or inject markup into every screen it appears on.
    const evil = makeToken({ symbol: '<b>x</b>&', name: '<script>alert(1)</script>' });
    for (const [, render] of SCREENS) {
      const html = render(makeReport({ token: evil }));
      expect(html).not.toContain('<script>');
      assertValidTelegramHtml(html);
    }
  });

  it('escapes HTML in relay flags and warnings', () => {
    const r = makeReport({ warnings: ['bad <b>warning</b> & stuff'] });
    r.supplyRelays[0]!.flags = ['flag with <i>markup</i> & ampersand'];
    assertValidTelegramHtml(renderOverview(r));
    assertValidTelegramHtml(renderRelays(r, 0));
  });
});

describe('long reports stay inside Telegram limits', () => {
  it('clamps a 200-wallet list to one message', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      makeProviderEntry({ wallet: `W${String(i).padStart(43, 'x')}`, entryRank: i + 1 }),
    );
    const html = renderProviderEntries(makeReport({ providerEntries: many, reachedLaunch: false }), 0);
    expect(html.length).toBeLessThanOrEqual(4096);
    assertValidTelegramHtml(html);
  });
});

describe('paginate', () => {
  it('clamps out-of-range pages instead of returning nothing', () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 99, 2).info.page).toBe(2);
    expect(paginate(items, -5, 2).info.page).toBe(0);
    expect(paginate(items, 99, 2).slice).toEqual([5]);
  });

  it('reports one page for an empty list', () => {
    const { slice, info } = paginate([], 0, 8);
    expect(slice).toEqual([]);
    expect(info).toEqual({ page: 0, pages: 1, total: 0 });
  });
});

describe('copy list', () => {
  it('emits plain addresses with no markup inside the block', () => {
    const html = renderCopyList(makeReport(), 'floor');
    expect(html).toContain('<pre>');
    assertValidTelegramHtml(html);
  });

  it('handles a section with nothing in it', () => {
    const html = renderCopyList(makeReport({ supplyRelays: [] }), 'relay');
    expect(html.length).toBeGreaterThan(0);
    assertValidTelegramHtml(html);
  });
});
