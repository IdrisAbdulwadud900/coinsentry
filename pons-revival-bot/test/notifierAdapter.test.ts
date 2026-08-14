import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import type { Api } from "grammy";
import { createNotifier } from "../src/bot/notifierAdapter.js";

const logger = pino({ level: "silent" });

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    sendPhoto: vi.fn(async () => ({}) as never),
    sendMessage: vi.fn(async () => ({}) as never),
    ...overrides,
  } as unknown as Api;
}

describe("createNotifier / sendAlert", () => {
  it("sends the photo before the text message when an image candidate is provided", async () => {
    const api = fakeApi();
    const notifier = createNotifier(api, logger);

    await notifier.sendAlert("chat1", "<b>hello</b>", { imageUrls: ["https://example.com/foo.png"] });

    expect(api.sendPhoto).toHaveBeenCalledWith("chat1", "https://example.com/foo.png");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat1",
      "<b>hello</b>",
      expect.objectContaining({ parse_mode: "HTML" })
    );
    const photoOrder = vi.mocked(api.sendPhoto).mock.invocationCallOrder[0];
    const messageOrder = vi.mocked(api.sendMessage).mock.invocationCallOrder[0];
    expect(photoOrder).toBeLessThan(messageOrder);
  });

  it("stops at the first successful candidate and never tries the rest", async () => {
    const api = fakeApi();
    const notifier = createNotifier(api, logger);

    await notifier.sendAlert("chat1", "<b>hello</b>", {
      imageUrls: ["https://example.com/first.png", "https://example.com/second.png"],
    });

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledWith("chat1", "https://example.com/first.png");
  });

  it("skips sendPhoto entirely when no image candidates are provided", async () => {
    const api = fakeApi();
    const notifier = createNotifier(api, logger);

    await notifier.sendAlert("chat1", "<b>hello</b>");

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalled();
  });

  it("falls back to downloading and re-uploading the image when Telegram rejects the URL", async () => {
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(new Error("wrong file identifier / HTTP URL specified"))
      .mockResolvedValueOnce({} as never);
    const api = fakeApi({ sendPhoto: sendPhoto as never });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
    try {
      const notifier = createNotifier(api, logger);
      await notifier.sendAlert("chat1", "<b>hello</b>", { imageUrls: ["https://example.com/foo.png"] });

      // First call with the raw URL (rejected), second with the downloaded bytes.
      expect(sendPhoto).toHaveBeenCalledTimes(2);
      expect(sendPhoto.mock.calls[0]?.[1]).toBe("https://example.com/foo.png");
      expect(sendPhoto.mock.calls[1]?.[1]).not.toBe("https://example.com/foo.png");
      expect(api.sendMessage).toHaveBeenCalledWith(
        "chat1",
        "<b>hello</b>",
        expect.objectContaining({ parse_mode: "HTML" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves on to the next candidate when the first fails both strategies", async () => {
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(new Error("URL rejected")) // candidate 1, URL strategy
      .mockRejectedValueOnce(new Error("bytes rejected")) // candidate 1, upload strategy
      .mockResolvedValueOnce({} as never); // candidate 2, URL strategy
    const api = fakeApi({ sendPhoto: sendPhoto as never });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
    try {
      const notifier = createNotifier(api, logger);
      await notifier.sendAlert("chat1", "<b>hello</b>", {
        imageUrls: ["https://example.com/broken.png", "https://example.com/works.png"],
      });

      expect(sendPhoto).toHaveBeenCalledTimes(3);
      expect(sendPhoto.mock.calls[2]?.[1]).toBe("https://example.com/works.png");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logs and continues, still sending the text alert, when every candidate fails", async () => {
    const api = fakeApi({
      sendPhoto: vi.fn(async () => {
        throw new Error("bad image URL");
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    try {
      const notifier = createNotifier(api, logger);

      await expect(
        notifier.sendAlert("chat1", "<b>hello</b>", { imageUrls: ["https://example.com/broken.png"] })
      ).resolves.toBeUndefined();

      expect(api.sendMessage).toHaveBeenCalledWith(
        "chat1",
        "<b>hello</b>",
        expect.objectContaining({ parse_mode: "HTML" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
