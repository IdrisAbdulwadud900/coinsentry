import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeReport, makeProviderEntry } from './fixtures.js';

// The analysis is network-bound; routing is what these tests exercise.
const analyzeMock = vi.fn();
vi.mock('../src/engine/analyze.js', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/analyze.js')>(
    '../src/engine/analyze.js',
  );
  return { ...actual, analyzeToken: (...a: unknown[]) => analyzeMock(...a) };
});

// The wallet/mint distinction asks the chain. Left unmocked these tests need a
// live Helius key and network, and quietly change behaviour when either is
// missing — which is how a suite starts lying about what it covers.
const accountKindMock = vi.fn();
vi.mock('../src/data/helius.js', async () => {
  const actual = await vi.importActual<typeof import('../src/data/helius.js')>(
    '../src/data/helius.js',
  );
  return {
    ...actual,
    HeliusClient: {
      ...actual.HeliusClient,
      fromConfig: () => ({ accountKind: (a: string) => accountKindMock(a) }),
    },
  };
});

const { Bot } = await import('grammy');
const { registerHandlers } = await import('../src/bot/handlers.js');

const BOT_INFO = {
  id: 1, is_bot: true as const, first_name: 'XRAY', username: 'xray_bot',
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business_account: false,
  has_main_web_app: false,
};

interface ApiCall { method: string; payload: Record<string, unknown> }

function makeBot() {
  const calls: ApiCall[] = [];
  const bot = new Bot('12345:test-token-aaaaaaaaaaaaaaaaaaaaaaaa', { botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    // Minimal believable responses for the methods the handlers use.
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { ok: true, result: { message_id: 999, date: 0, chat: { id: 1, type: 'private' } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  registerHandlers(bot);
  return { bot, calls };
}

let uid = 5000;
const msg = (text: string, chatId = 1) => ({
  update_id: ++uid,
  message: {
    message_id: uid, date: 0, text,
    chat: { id: chatId, type: 'private' as const },
    from: { id: ++uid, is_bot: false, first_name: 'U' },
    // grammy matches commands off entities, and real Telegram always sends
    // them. Without this, bot.command() never fires and the test would look
    // like a broken handler rather than an incomplete fixture.
    ...(text.startsWith('/')
      ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] }
      : {}),
  },
});

const cbq = (data: string, chatId = 1) => ({
  update_id: ++uid,
  callback_query: {
    id: String(uid), data, chat_instance: 'ci',
    from: { id: ++uid, is_bot: false, first_name: 'U' },
    message: {
      message_id: 999, date: 0,
      chat: { id: chatId, type: 'private' as const },
      from: BOT_INFO,
    },
  },
});

let watchDir: string;

beforeEach(async () => {
  analyzeMock.mockReset();
  analyzeMock.mockResolvedValue(makeReport());
  accountKindMock.mockReset();
  accountKindMock.mockResolvedValue('mint');

  // A watchlist that survives between tests made "/track" report "already on
  // your list" on a re-run, so an earlier version of these tests passed only
  // because of the order they happened to run in.
  watchDir = await mkdtemp(join(tmpdir(), 'xray-handlers-'));
  process.env.WATCHLIST_PATH = join(watchDir, 'watchlist.json');
  const watchlist = await import('../src/data/watchlist.js');
  watchlist.__resetForTests();
});

afterEach(async () => {
  delete process.env.WATCHLIST_PATH;
  await rm(watchDir, { recursive: true, force: true });
});

const text = (c: ApiCall) => String(c.payload.text ?? '');

describe('address input', () => {
  it('rejects non-addresses without touching the analyser', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('gm ser'));
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(text(calls[0]!)).toContain('does not look like a contract address');
  });

  it('runs an analysis and lands on the overview with a keyboard', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump'));

    expect(analyzeMock).toHaveBeenCalledOnce();
    const edits = calls.filter((c) => c.method === 'editMessageText');
    const final = edits[edits.length - 1]!;
    expect(text(final)).toContain('XRAY');
    expect(final.payload.reply_markup).toBeTruthy();
  });

  it('extracts an address out of surrounding chatter', async () => {
    const { bot } = makeBot();
    await bot.handleUpdate(msg('ape this 0x6982508145454Ce325dDbE47a25d4ec3d2311933 now'));
    expect(analyzeMock).toHaveBeenCalledOnce();
    expect(analyzeMock.mock.calls[0]![0]).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
  });

  it('ignores slash commands as addresses', async () => {
    const { bot } = makeBot();
    await bot.handleUpdate(msg('/help'));
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('surfaces an analysis failure as a readable message, not a crash', async () => {
    const { AnalysisError } = await import('../src/engine/analyze.js');
    analyzeMock.mockRejectedValue(new AnalysisError('No pair found.', 'Try another address.'));
    const { bot, calls } = makeBot();
    // A distinct address: completed reports are cached by address for
    // CACHE_TTL_SECONDS, so reusing one already scanned above would serve the
    // cache and never reach the analyser at all.
    await bot.handleUpdate(msg('4xMegMRMd2TFQEXxv39vtMP1r5fFVuA7VcaSmAhLpump'));
    const last = calls.filter((c) => c.method === 'editMessageText').pop()!;
    expect(text(last)).toContain('No pair found.');
    expect(text(last)).toContain('Try another address.');
  });
});

describe('callback navigation', () => {
  async function sessionId(bot: ReturnType<typeof makeBot>['bot'], calls: ApiCall[]) {
    await bot.handleUpdate(msg('J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump'));
    const kb = calls.filter((c) => c.method === 'editMessageText').pop()!
      .payload.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    const first = kb.inline_keyboard.flat().find((b) => b.callback_data)!.callback_data!;
    return first.split('|')[1]!;
  }

  it('routes every view without throwing', async () => {
    const { bot, calls } = makeBot();
    const id = await sessionId(bot, calls);

    for (const view of ['floor', 'diamond', 'dev', 'relay', 'risk', 'home']) {
      calls.length = 0;
      await bot.handleUpdate(cbq(`x|${id}|${view}|0|`));
      const edit = calls.find((c) => c.method === 'editMessageText');
      expect(edit, `view ${view} produced no edit`).toBeTruthy();
      expect(text(edit!).length).toBeGreaterThan(0);
    }
  });

  it('opens a wallet drill-down', async () => {
    const { bot, calls } = makeBot();
    const id = await sessionId(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(cbq(`x|${id}|wallet|0|floor:0`));
    const edit = calls.find((c) => c.method === 'editMessageText')!;
    expect(text(edit)).toContain('👤');
  });

  it('tells the user to re-scan when the session is unknown', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cbq('x|zzzzzz|floor|0|'));
    const ans = calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(String(ans.payload.text)).toContain('expired');
    expect(ans.payload.show_alert).toBe(true);
  });

  it('ignores a malformed payload quietly', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(cbq('total-garbage'));
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('a session from another chat is not readable', async () => {
    const { bot, calls } = makeBot();
    const id = await sessionId(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(cbq(`x|${id}|floor|0|`, 777));
    const ans = calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(String(ans.payload.text)).toContain('expired');
  });

  it('serves the first-buyers view when the report has one', async () => {
    analyzeMock.mockResolvedValue(
      makeReport({ reachedLaunch: false, providerEntries: [makeProviderEntry()] }),
    );
    const { bot, calls } = makeBot();
    const id = await sessionId(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(cbq(`x|${id}|first|0|`));
    expect(text(calls.find((c) => c.method === 'editMessageText')!)).toContain('FIRST BUYERS');
  });

  it('copy view returns a pasteable block', async () => {
    const { bot, calls } = makeBot();
    const id = await sessionId(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(cbq(`x|${id}|copy|0|floor`));
    expect(text(calls.find((c) => c.method === 'editMessageText')!)).toContain('<pre>');
  });
});

describe('commands', () => {
  it('/start and /help answer without an analysis', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('/start'));
    await bot.handleUpdate(msg('/help'));
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });
});

describe('tracking is offered only where it can work', () => {
  it('hides the track button on an EVM report', async () => {
    // Helius speaks Solana only — it rejects an EVM address as "Invalid Base58
    // String" — so a tracked Base wallet would wear the badge and never alert.
    const { walletKeyboard } = await import('../src/bot/keyboards.js');
    const labels = walletKeyboard('s1', 'floor', 0, { walletIdx: undefined })
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(labels.some((l) => l.includes('Track'))).toBe(false);
  });

  it('offers it when a wallet index is supplied', async () => {
    const { walletKeyboard } = await import('../src/bot/keyboards.js');
    const labels = walletKeyboard('s1', 'floor', 0, { walletIdx: 3 })
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(labels.some((l) => l.includes('Track'))).toBe(true);
  });
});



describe('tracking a wallet directly', () => {
  it('/track with no argument says how to use it', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('/track'));
    expect(text(calls[0]!)).toContain('/track');
  });

  it('/track refuses an EVM address and says why', async () => {
    // The watcher reads Helius, which cannot see EVM addresses at all — so
    // accepting one would put a wallet on the list that can never alert.
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('/track 0x8367d463abda0b0270e81e6e5f5d701f8d3cf82d'));
    expect(text(calls[0]!)).toMatch(/only solana/i);
  });

  it('/track accepts a Solana wallet and explains the baseline', async () => {
    // The first poll only records where the wallet is, so a new tracker must
    // not imply it will replay trades the wallet already made.
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('/track 7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8'));
    const reply = text(calls[0]!);
    expect(reply).toContain('Now tracking');
    expect(reply).toMatch(/baseline/i);
  });

  it('/untrack removes what /track added', async () => {
    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg('/track 7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8'));
    await bot.handleUpdate(msg('/untrack 7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8'));
    expect(text(calls[calls.length - 1]!)).toMatch(/stopped tracking/i);
  });
})

describe('paste a wallet, pick a filter, end up tracking it', () => {
  const WALLET = '7Mwof5tBvNPC6e1zwtHRQynqXcuDpqqbeY9vSZLW2Bv8';

  /** Buttons on the last message the bot sent or edited. */
  const buttons = (calls: ApiCall[]) => {
    const kb = calls[calls.length - 1]!.payload.reply_markup as
      | { inline_keyboard: { text: string; callback_data?: string }[][] }
      | undefined;
    return (kb?.inline_keyboard ?? []).flat();
  };

  it('walks the whole flow and records the chosen filter', async () => {
    // Every step of this is a place a feature can run, log, throw nothing, and
    // still do nothing — which happened three times in this codebase already.
    // Driving the real handlers is the only way to know the buttons connect.
    const { AnalysisError } = await import('../src/engine/analyze.js');
    analyzeMock.mockRejectedValue(new AnalysisError('No trading pair found for that address.'));
    accountKindMock.mockResolvedValue('wallet');

    const { bot, calls } = makeBot();
    await bot.handleUpdate(msg(WALLET));

    // 1. It recognised a wallet and offered the button.
    expect(text(calls[calls.length - 1]!)).toMatch(/wallet, not a coin/i);
    const track = buttons(calls).find((b) => b.text.includes('Track'));
    expect(track?.callback_data).toBeTruthy();

    // 2. Tapping it offers the filters.
    calls.length = 0;
    await bot.handleUpdate(cbq(track!.callback_data!));
    const filters = buttons(calls).map((b) => b.text);
    expect(filters.some((t) => /Buys/i.test(t))).toBe(true);
    expect(filters.some((t) => /Sells/i.test(t))).toBe(true);
    expect(filters.some((t) => /Transfers/i.test(t))).toBe(true);
    expect(filters.some((t) => /Everything/i.test(t))).toBe(true);

    // 3. Choosing one tracks the wallet with that filter.
    const sells = buttons(calls).find((b) => /Sells/i.test(b.text))!;
    calls.length = 0;
    await bot.handleUpdate(cbq(sells.callback_data!));
    expect(text(calls[calls.length - 1]!)).toMatch(/now tracking/i);

    const { listWatched, filterOf } = await import('../src/data/watchlist.js');
    const watched = await listWatched(1);
    const entry = watched.find((e) => e.wallet === WALLET);
    expect(entry, 'the wallet should be on the list').toBeTruthy();
    expect(filterOf(entry!)).toBe('sells');
  });

  it('every button in the flow fits the 64-byte callback limit', async () => {
    // A Solana address is 44 chars, so this flow is exactly where that limit
    // gets breached — and Telegram rejects the whole message, not the button.
    const { trackPromptKeyboard, trackFilterKeyboard } = await import('../src/bot/keyboards.js');
    const all = [
      ...trackPromptKeyboard('abc123').inline_keyboard.flat(),
      ...trackFilterKeyboard('abc123').inline_keyboard.flat(),
    ];
    expect(all.length).toBeGreaterThan(3);
    for (const b of all) {
      expect(Buffer.byteLength(b.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
