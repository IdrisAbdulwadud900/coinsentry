import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReport, makeProviderEntry } from './fixtures.js';

// The analysis is network-bound; routing is what these tests exercise.
const analyzeMock = vi.fn();
vi.mock('../src/engine/analyze.js', async () => {
  const actual = await vi.importActual<typeof import('../src/engine/analyze.js')>(
    '../src/engine/analyze.js',
  );
  return { ...actual, analyzeToken: (...a: unknown[]) => analyzeMock(...a) };
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

beforeEach(() => {
  analyzeMock.mockReset();
  analyzeMock.mockResolvedValue(makeReport());
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
