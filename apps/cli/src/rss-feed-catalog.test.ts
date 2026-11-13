import { RssNewsGateway, validateRssFeedUrl } from "@finance-ai-news-agent/source-rss";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RSS_FEED_URLS,
  FINANCE_AI_RSS_CATALOG,
  resolveRssFeedSelection,
} from "./rss-feed-catalog.js";

describe("finance and AI RSS catalog", () => {
  it("lists unique public feeds, including at least two finance and two AI sources", () => {
    expect(
      FINANCE_AI_RSS_CATALOG.filter((feed) => feed.topic === "finance").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      FINANCE_AI_RSS_CATALOG.filter((feed) => feed.topic === "ai").length,
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(FINANCE_AI_RSS_CATALOG.map((feed) => feed.id)).size).toBe(
      FINANCE_AI_RSS_CATALOG.length,
    );
    expect(new Set(FINANCE_AI_RSS_CATALOG.map((feed) => feed.url)).size).toBe(
      FINANCE_AI_RSS_CATALOG.length,
    );
    expect(new Set(FINANCE_AI_RSS_CATALOG.map((feed) => feed.name)).size).toBe(
      FINANCE_AI_RSS_CATALOG.length,
    );

    for (const feed of FINANCE_AI_RSS_CATALOG) {
      expect(feed.name.trim()).toBe(feed.name);
      expect(feed.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
      expect(feed.id).not.toMatch(/^feed-\d+$/);
      expect(validateRssFeedUrl(feed.url).toString()).toBe(feed.url);
    }

    expect(
      () =>
        new RssNewsGateway({
          feeds: FINANCE_AI_RSS_CATALOG.map((feed) => ({
            id: feed.id,
            name: feed.name,
            url: feed.url,
          })),
          parseFeed: async () => ({ items: [] }),
        }),
    ).not.toThrow();
  });

  it("keeps the historical default feeds in catalog order", () => {
    expect(DEFAULT_RSS_FEED_URLS).toEqual([
      "https://36kr.com/feed",
      "https://rss.huxiu.com/",
      "https://www.infoq.cn/feed",
    ]);
    expect(
      resolveRssFeedSelection({
        feedIds: "   ",
        feedUrls: "   ",
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toEqual([
      { id: "feed-1", url: "https://36kr.com/feed" },
      { id: "feed-2", url: "https://rss.huxiu.com/" },
      { id: "feed-3", url: "https://www.infoq.cn/feed" },
    ]);
  });

  it("selects catalog feeds by id without using the built-in defaults", () => {
    expect(
      resolveRssFeedSelection({
        feedIds: " sec-press, openai-news ,qbitai ",
        feedUrls: undefined,
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toEqual([
      {
        id: "sec-press",
        name: "U.S. SEC Press Releases",
        url: "https://www.sec.gov/news/pressreleases.rss",
        topic: "finance",
      },
      {
        id: "openai-news",
        name: "OpenAI News",
        url: "https://openai.com/news/rss.xml",
        topic: "ai",
      },
      {
        id: "qbitai",
        name: "量子位",
        url: "https://www.qbitai.com/feed",
        topic: "ai",
      },
    ]);
  });

  it("appends custom URLs after catalog feeds and skips URLs already selected", () => {
    expect(
      resolveRssFeedSelection({
        feedIds: "federal-reserve",
        feedUrls:
          "https://example.com/custom.xml, https://www.federalreserve.gov/feeds/press_all.xml",
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toEqual([
      {
        id: "federal-reserve",
        name: "Federal Reserve Press",
        url: "https://www.federalreserve.gov/feeds/press_all.xml",
        topic: "finance",
      },
      { id: "feed-1", url: "https://example.com/custom.xml" },
    ]);
  });

  it("rejects unknown ids, duplicate ids, duplicate URLs, unsafe URLs, and more than 16 feeds", () => {
    expect(() =>
      resolveRssFeedSelection({
        feedIds: "sec-press,not-a-feed",
        feedUrls: undefined,
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("Unknown RSS feed id: not-a-feed.");

    expect(() =>
      resolveRssFeedSelection({
        feedIds: "sec-press,sec-press",
        feedUrls: undefined,
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("Duplicate RSS feed id: sec-press.");

    expect(() =>
      resolveRssFeedSelection({
        feedIds: undefined,
        feedUrls: "https://example.com/feed,https://example.com/feed",
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("unique comma-separated feed URLs");

    expect(() =>
      resolveRssFeedSelection({
        feedIds: undefined,
        feedUrls: ",",
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("unique comma-separated feed URLs");

    expect(() =>
      resolveRssFeedSelection({
        feedIds: ",",
        feedUrls: undefined,
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("RSS_FEED_IDS must contain at least one catalog id.");

    expect(() =>
      resolveRssFeedSelection({
        feedIds: "openai-news",
        feedUrls: "http://example.com/feed",
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("must use HTTPS");

    const urls = Array.from({ length: 16 }, (_, index) => `https://example.com/feed-${index}.xml`);

    expect(() =>
      resolveRssFeedSelection({
        feedIds: "ecb-press",
        feedUrls: urls.join(","),
        fallbackUrls: DEFAULT_RSS_FEED_URLS,
      }),
    ).toThrow("RSS feeds must contain 1 to 16 unique entries.");
  });
});
