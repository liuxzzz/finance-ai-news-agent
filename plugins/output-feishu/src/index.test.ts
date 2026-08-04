import { describe, expect, it, vi } from "vitest";

import {
  FeishuWebhookOutputPlugin,
  createFeishuSignature,
  renderFeishuText,
  validateFeishuWebhookUrl,
} from "./index.js";

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook-id";

describe("Feishu webhook output", () => {
  it("sends UTF-8 text and maps a successful Feishu response to a safe receipt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: "success", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const output = new FeishuWebhookOutputPlugin({
      webhookUrl: WEBHOOK,
      fetch: request,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    const receipt = await output.deliver(
      {
        id: "run-1:digest",
        mediaType: "text/markdown",
        content: "# 每日简报\n\n- [来源](<https://example.com/news>)",
      },
      { deliveryKey: "stable-key" },
    );

    expect(request).toHaveBeenCalledOnce();
    const [, init] = request.mock.calls[0]!;
    expect(init?.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(JSON.parse(String(init?.body))).toEqual({
      msg_type: "text",
      content: {
        text: "Finance AI News Agent\n\n每日简报\n\n- 来源\nhttps://example.com/news",
      },
    });
    expect(receipt).toEqual({
      deliveryId: expect.stringMatching(/^feishu-/),
      target: expect.stringMatching(/^feishu-webhook:/),
      deliveredAt: "2026-08-04T12:00:00.000Z",
    });
    expect(JSON.stringify(receipt)).not.toContain("test-webhook-id");
  });

  it("adds an official signature when a signing secret is configured", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 }),
      );
    const output = new FeishuWebhookOutputPlugin({
      webhookUrl: WEBHOOK,
      signingSecret: "secret",
      fetch: request,
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    await output.deliver(
      { id: "artifact", mediaType: "text/plain", content: "digest" },
      { deliveryKey: "delivery" },
    );

    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.timestamp).toBe("1785844800");
    expect(body.sign).toBe(createFeishuSignature("1785844800", "secret"));
  });

  it("rejects API failures, oversized payloads, and non-Feishu endpoints", async () => {
    const rejected = new FeishuWebhookOutputPlugin({
      webhookUrl: WEBHOOK,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ code: 19021, msg: "sign fail" }))),
    });

    await expect(
      rejected.deliver(
        { id: "artifact", mediaType: "text/plain", content: "digest" },
        { deliveryKey: "delivery" },
      ),
    ).rejects.toThrow("code 19021");
    await expect(
      rejected.deliver(
        { id: "artifact", mediaType: "text/plain", content: "x".repeat(21_000) },
        { deliveryKey: "delivery" },
      ),
    ).rejects.toThrow("payload exceeds");
    expect(() => validateFeishuWebhookUrl("https://example.com/hook/secret")).toThrow(
      "official Feishu",
    );
  });

  it("renders Markdown links as readable Feishu text", () => {
    expect(renderFeishuText("## 标题\n\n**来源：** [文章](https://example.com)")).toBe(
      "Finance AI News Agent\n\n标题\n\n来源： 文章\nhttps://example.com",
    );
  });
});
