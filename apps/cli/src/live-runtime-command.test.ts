import { describe, expect, it } from "vitest";

import { resolveLiveResearchConfig, resolveOutputChannel } from "./live-runtime-command.js";

describe("live RSS research configuration", () => {
  it("normalizes unique HTTPS feed URLs and budgets", () => {
    expect(
      resolveLiveResearchConfig({
        RSS_FEED_URLS: "https://36kr.com/feed, https://example.com/ai.xml ",
        RSS_TIMEOUT_MS: "7000",
        RSS_MAX_TOOL_CALLS: "6",
      }),
    ).toEqual({
      feedUrls: ["https://36kr.com/feed", "https://example.com/ai.xml"],
      timeoutMs: 7000,
      maxToolCalls: 6,
      maxItemAgeHours: 48,
      maxExcerptChars: 600,
      maxEvidence: 12,
      maxCandidateEvidence: 24,
      historyLookbackDays: 7,
      storyEventLookbackDays: 30,
    });
  });

  it("uses the three built-in feeds and safe limits by default", () => {
    expect(resolveLiveResearchConfig({})).toEqual({
      feedUrls: ["https://36kr.com/feed", "https://rss.huxiu.com/", "https://www.infoq.cn/feed"],
      timeoutMs: 5000,
      maxToolCalls: 1,
      maxItemAgeHours: 48,
      maxExcerptChars: 600,
      maxEvidence: 12,
      maxCandidateEvidence: 24,
      historyLookbackDays: 7,
      storyEventLookbackDays: 30,
    });
  });

  it("rejects unsafe endpoints, duplicate feeds, and invalid budgets", () => {
    expect(() =>
      resolveLiveResearchConfig({
        RSS_FEED_URLS: "http://example.com/feed",
      }),
    ).toThrow("must use HTTPS");

    expect(() =>
      resolveLiveResearchConfig({
        RSS_FEED_URLS: "https://example.com/feed,https://example.com/feed",
      }),
    ).toThrow("unique comma-separated feed URLs");

    expect(() =>
      resolveLiveResearchConfig({
        RSS_MAX_TOOL_CALLS: "0",
      }),
    ).toThrow("integer from 1 to 16");

    expect(() =>
      resolveLiveResearchConfig({
        RSS_MAX_EXCERPT_CHARS: "99",
      }),
    ).toThrow("integer from 100 to 4000");

    expect(() =>
      resolveLiveResearchConfig({
        RSS_MAX_EVIDENCE: "25",
      }),
    ).toThrow("integer from 1 to 24");

    expect(() =>
      resolveLiveResearchConfig({
        RSS_MAX_EVIDENCE: "12",
        RSS_MAX_CANDIDATE_EVIDENCE: "8",
      }),
    ).toThrow("integer from 12 to 24");
  });
});

describe("live output configuration", () => {
  it("selects Feishu when its webhook is configured", () => {
    expect(
      resolveOutputChannel({
        FEISHU_BOT_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
      }),
    ).toBe("feishu");
    expect(resolveOutputChannel({})).toBe("file");
  });

  it("fails closed when Feishu is explicitly selected without a webhook", () => {
    expect(() => resolveOutputChannel({ AGENT_OUTPUT_CHANNEL: "feishu" })).toThrow(
      "FEISHU_BOT_WEBHOOK_URL is required",
    );
    expect(() => resolveOutputChannel({ AGENT_OUTPUT_CHANNEL: "email" })).toThrow(
      "must be file or feishu",
    );
  });
});
