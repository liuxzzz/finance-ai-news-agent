import type {
  RawSourceItemRecord,
  RecordSourceCollectionInput,
  SourceAuditStore,
  SourceRunRecord,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import { RssNewsGateway, validateRssFeedUrl } from "./index.js";

const FEED_NOW = Date.parse("2026-08-04T12:00:00.000Z");

// Shapes produced by rss-parser 3.13, Node sockets, and fetch. See the retry
// tests below for which of these are transient.
const TRANSIENT_FEED_FAILURES = [
  { label: "HTTP 429", failure: new Error("Status code 429") },
  { label: "HTTP 502", failure: new Error("Status code 502") },
  { label: "HTTP 503", failure: new Error("Status code 503") },
  { label: "HTTP 504", failure: new Error("Status code 504") },
  {
    label: "status property 429",
    failure: Object.assign(new Error("rate limited"), { status: 429 }),
  },
  { label: "rss-parser timeout", failure: new Error("Request timed out after 5000ms") },
  { label: "ECONNRESET", failure: withCode("read ECONNRESET", "ECONNRESET") },
  { label: "ETIMEDOUT", failure: withCode("connect ETIMEDOUT 203.0.113.8:443", "ETIMEDOUT") },
  {
    label: "ECONNREFUSED",
    failure: withCode("connect ECONNREFUSED 203.0.113.8:443", "ECONNREFUSED"),
  },
  { label: "ENOTFOUND", failure: withCode("getaddrinfo ENOTFOUND flaky.example", "ENOTFOUND") },
  { label: "EAI_AGAIN", failure: withCode("getaddrinfo EAI_AGAIN flaky.example", "EAI_AGAIN") },
  { label: "ECONNABORTED", failure: withCode("connection aborted", "ECONNABORTED") },
  { label: "ENETUNREACH", failure: withCode("network unreachable", "ENETUNREACH") },
  { label: "EHOSTUNREACH", failure: withCode("host unreachable", "EHOSTUNREACH") },
  { label: "EPIPE", failure: withCode("broken pipe", "EPIPE") },
  {
    label: "UND_ERR_CONNECT_TIMEOUT",
    failure: withCode("undici failure", "UND_ERR_CONNECT_TIMEOUT"),
  },
  {
    label: "UND_ERR_HEADERS_TIMEOUT",
    failure: withCode("undici failure", "UND_ERR_HEADERS_TIMEOUT"),
  },
  { label: "UND_ERR_BODY_TIMEOUT", failure: withCode("undici failure", "UND_ERR_BODY_TIMEOUT") },
  { label: "UND_ERR_SOCKET", failure: withCode("undici failure", "UND_ERR_SOCKET") },
  { label: "ECONNRESET message only", failure: new Error("read ECONNRESET") },
  { label: "socket hang up", failure: new Error("socket hang up") },
  {
    label: "response status 503",
    failure: Object.assign(new Error("upstream unavailable"), { response: { status: 503 } }),
  },
  { label: "AbortError", failure: namedError("AbortError", "The operation was aborted") },
  {
    label: "TimeoutError",
    failure: namedError("TimeoutError", "The operation was aborted due to timeout"),
  },
  { label: "fetch TypeError", failure: new TypeError("fetch failed") },
  {
    label: "fetch cause ECONNREFUSED",
    failure: Object.assign(new Error("fetch failed"), {
      cause: withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"),
    }),
  },
];

const NON_TRANSIENT_FEED_FAILURES = [
  { label: "HTTP 404", failure: new Error("Status code 404") },
  { label: "HTTP 400", failure: new Error("Status code 400") },
  { label: "HTTP 500", failure: new Error("Status code 500") },
  { label: "status property 404", failure: Object.assign(new Error("missing"), { status: 404 }) },
  { label: "redirect cap", failure: new Error("Too many redirects") },
  { label: "empty XML", failure: new Error("Unable to parse XML.") },
  { label: "unrecognized feed", failure: new Error("Feed not recognized as RSS 1 or 2.") },
  {
    label: "xml2js syntax error",
    failure: new Error("Non-whitespace before first tag.\nLine: 0\nColumn: 1\nChar: <"),
  },
  {
    label: "xml2js close tag",
    failure: new Error("Unexpected close tag\nLine: 2\nColumn: 3\nChar: >"),
  },
  { label: "application error", failure: new Error("feed unavailable") },
];

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("RSS news gateway", () => {
  it("fetches configured feeds, ranks matching items, and returns normalized evidence", async () => {
    let requests = 0;
    const gateway = new RssNewsGateway({
      feeds: [{ id: "36kr", name: "36氪", url: "https://36kr.com/feed" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => {
        requests += 1;
        return {
          title: "36氪",
          items: [
            {
              title: "普通公司动态",
              link: "https://36kr.com/p/older",
              pubDate: "Mon, 03 Aug 2026 08:00:00 GMT",
              contentSnippet: "普通商业新闻",
            },
            {
              title: "AI 芯片公司发布新产品",
              link: "https://36kr.com/p/ai-chip",
              isoDate: "2026-08-04T09:00:00.000Z",
              content: "<p>新产品用于 AI 推理。</p>",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "call-1",
      name: "search_news",
      arguments: { query: "AI 芯片", limit: 1 },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual({
      items: [
        {
          id: expect.stringMatching(/^rss-[a-f0-9]{24}$/),
          title: "AI 芯片公司发布新产品",
          url: "https://36kr.com/p/ai-chip",
          excerpt: "新产品用于 AI 推理。",
          source: "36氪",
          sourceId: "36kr",
          publishedAt: "2026-08-04T09:00:00.000Z",
        },
      ],
    });

    await gateway.callTool({
      id: "call-2",
      name: "search_news",
      arguments: { query: "公司", limit: 2 },
    });
    expect(requests).toBe(1);
  });

  it("continues when one feed fails and falls back to latest items without keyword matches", async () => {
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "broken", url: "https://broken.example/feed" },
        { id: "working", url: "https://working.example/feed" },
      ],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          throw new Error("network unavailable");
        }

        return {
          title: "Working feed",
          items: [
            {
              title: "Newest item",
              link: "https://working.example/newest",
              pubDate: "2026-08-04T10:00:00Z",
            },
            {
              title: "Older item",
              link: "https://working.example/older",
              pubDate: "2026-08-03T10:00:00Z",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "call-1",
      name: "search_news",
      arguments: { query: "unmatched keyword", limit: 1 },
    });

    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Newest item" })],
      },
      isError: false,
    });
  });

  it("balances sources, filters stale items, and bounds excerpts before model use", async () => {
    const longExcerpt = "长".repeat(2_000);
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "source-a", name: "Source A", url: "https://a.example/feed" },
        { id: "source-b", name: "Source B", url: "https://b.example/feed" },
        { id: "source-c", name: "Source C", url: "https://c.example/feed" },
      ],
      maxItemAgeHours: 24,
      maxExcerptChars: 500,
      minimumResultCount: 6,
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async (url) => {
        const source = new URL(url).hostname[0];
        return {
          items: [
            {
              title: `${source} AI latest`,
              link: `https://${source}.example/latest`,
              pubDate: "2026-08-04T11:00:00Z",
              contentSnippet: longExcerpt,
            },
            {
              title: `${source} AI second`,
              link: `https://${source}.example/second`,
              pubDate: "2026-08-04T10:00:00Z",
              contentSnippet: "second",
            },
            {
              title: `${source} stale`,
              link: `https://${source}.example/stale`,
              pubDate: "2026-07-01T10:00:00Z",
              contentSnippet: "stale AI item",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "balanced",
      name: "search_news",
      arguments: { query: "AI", limit: 1 },
    });
    const items = (
      result.content as { items: Array<{ source: string; excerpt: string; url: string }> }
    ).items;

    expect(items).toHaveLength(6);
    expect(
      items
        .slice(0, 3)
        .map((item) => item.source)
        .sort(),
    ).toEqual(["Source A", "Source B", "Source C"]);
    expect(items.filter((item) => item.source === "Source A")).toHaveLength(2);
    expect(items.some((item) => item.url.endsWith("/stale"))).toBe(false);
    expect(Math.max(...items.map((item) => item.excerpt.length))).toBe(500);
  });

  it("rejects model-selected URLs and unsafe configured feed URLs", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "test", url: "https://example.com/feed" }],
      parseFeed: async () => ({ items: [] }),
    });

    await expect(
      gateway.callTool({
        id: "call-1",
        name: "search_news",
        arguments: { query: "AI", limit: 2, url: "https://attacker.example/feed" },
      }),
    ).rejects.toThrow("Invalid arguments");
    expect(() => validateRssFeedUrl("http://example.com/feed")).toThrow("must use HTTPS");
  });

  it("audits successful and failed sources with their raw parsed items", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "working", url: "https://working.example/feed" },
        { id: "broken", url: "https://broken.example/feed" },
      ],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          throw new Error("feed unavailable");
        }

        return {
          title: "Working",
          items: [
            {
              guid: "external-1",
              title: "AI update",
              link: "https://working.example/article",
              pubDate: "2026-08-04T11:00:00Z",
              contentSnippet: "Evidence text",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "audited",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-1" },
    );

    expect(result.isError).toBe(false);
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-1",
          sourceId: "working",
          status: "succeeded",
          itemCount: 1,
          items: [
            expect.objectContaining({
              externalId: "external-1",
              url: "https://working.example/article",
            }),
          ],
        }),
        expect.objectContaining({
          runId: "run-1",
          sourceId: "broken",
          status: "failed",
          itemCount: 0,
          error: expect.objectContaining({ message: "feed unavailable" }),
          items: [],
        }),
      ]),
    );
  });

  it("resolves relative article links and falls back to absolute permalink guids", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "36kr", name: "36氪", url: "https://36kr.com/feed" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "相对链接稿件",
            link: "/p/relative-ai",
            isoDate: "2026-08-04T09:00:00.000Z",
          },
          {
            title: "协议相对稿件",
            link: "//cdn.36kr.com/p/protocol",
            isoDate: "2026-08-04T08:00:00.000Z",
          },
          {
            title: "只有永久链接",
            guid: "https://36kr.com/p/guid-only",
            isoDate: "2026-08-04T07:00:00.000Z",
          },
          {
            title: "危险链接被忽略",
            link: "javascript:alert(1)",
            guid: "opaque-guid",
            isoDate: "2026-08-04T06:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "links",
      name: "search_news",
      arguments: { query: "unmatched", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string; url: string }> }).items;

    expect(items.map((item) => item.url)).toEqual([
      "https://36kr.com/p/relative-ai",
      "https://cdn.36kr.com/p/protocol",
      "https://36kr.com/p/guid-only",
    ]);
    expect(items.map((item) => item.title)).not.toContain("危险链接被忽略");
  });

  it("decodes numeric HTML entities before ranking and model use", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "&#20013;&#x6587; &#65;I &#39;芯片&#39;",
            link: "https://www.sec.gov/news/press-release/ai",
            isoDate: "2026-08-04T09:00:00.000Z",
            contentSnippet: "增长 &gt; 10&#160;%",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "entities",
      name: "search_news",
      arguments: { query: "中文", limit: 1 },
    });

    expect(result.content).toEqual({
      items: [
        expect.objectContaining({
          title: "中文 AI '芯片'",
          excerpt: "增长 > 10 %",
        }),
      ],
    });
  });

  it("collapses tracking parameters and fragments before ranking", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "AI rule older copy",
            link: "https://www.sec.gov/news/press-release/ai-rule?utm_source=rss&id=7#body",
            isoDate: "2026-08-04T08:00:00.000Z",
          },
          {
            title: "AI rule latest copy",
            link: "https://www.sec.gov/news/press-release/ai-rule?id=7&utm_medium=feed",
            isoDate: "2026-08-04T10:00:00.000Z",
          },
          {
            title: "Separate filing",
            link: "https://www.sec.gov/news/press-release/other?ref=rss",
            isoDate: "2026-08-04T09:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "tracked",
      name: "search_news",
      arguments: { query: "unmatched", limit: 5 },
    });
    const items = (result.content as { items: Array<{ title: string; url: string }> }).items;

    expect(items).toEqual([
      expect.objectContaining({
        title: "AI rule latest copy",
        url: "https://www.sec.gov/news/press-release/ai-rule?id=7",
      }),
      expect.objectContaining({
        title: "Separate filing",
        url: "https://www.sec.gov/news/press-release/other",
      }),
    ]);
  });

  it("drops items dated beyond the allowed clock skew", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "Current filing",
            link: "https://www.sec.gov/news/press-release/current",
            isoDate: "2026-08-04T11:00:00.000Z",
          },
          {
            title: "Slightly ahead filing",
            link: "https://www.sec.gov/news/press-release/ahead",
            isoDate: "2026-08-04T14:00:00.000Z",
          },
          {
            title: "Tomorrow filing",
            link: "https://www.sec.gov/news/press-release/tomorrow",
            isoDate: "2026-08-05T12:00:00.000Z",
          },
          {
            title: "Far future filing",
            link: "https://www.sec.gov/news/press-release/future",
            isoDate: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "future",
      name: "search_news",
      arguments: { query: "filing", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string }> }).items;

    expect(items.map((item) => item.title)).toEqual(["Slightly ahead filing", "Current filing"]);
  });

  // rss-parser 3.13 parseURL does not set status or statusCode. HTTP failures
  // are `Error` messages `Status code <n>` (retry only 429/502/503/504; other
  // statuses, including 4xx and 500, are final). Timeouts are
  // `Request timed out after <ms>ms`. Socket failures reject the Node error
  // (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`,
  // `ECONNABORTED`, `ENETUNREACH`, `EHOSTUNREACH`, `EPIPE`, and undici
  // `UND_ERR_*` timeout/socket codes), matched from `code` or the message, or
  // an AbortError / TimeoutError / fetch TypeError. A code nested on `cause`
  // still counts. XML parsing runs only after the response
  // ends, so `Unable to parse XML.`, `Feed not recognized as RSS 1 or 2.`,
  // xml2js syntax errors, and `Too many redirects` are not retried. A finished
  // body that fails the parser stays non-transient even when the wording could
  // also describe a short document. Other application errors are not retried.
  it.each(TRANSIENT_FEED_FAILURES)(
    "retries a transient $label once and then uses the feed",
    async ({ failure }) => {
      let attempts = 0;
      const delays: number[] = [];
      const gateway = new RssNewsGateway({
        feeds: [{ id: "flaky", name: "Flaky", url: "https://flaky.example/feed" }],
        now: () => FEED_NOW,
        retryDelayMs: 5_000,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        parseFeed: async () => {
          attempts += 1;

          if (attempts === 1) {
            throw failure;
          }

          return {
            title: "Flaky",
            items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
          };
        },
      });
      const startedAt = Date.now();
      const result = await gateway.callTool({
        id: "retry-ok",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      });

      expect(attempts).toBe(2);
      expect(delays).toEqual([5_000]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toEqual({
        content: {
          items: [expect.objectContaining({ title: "Recovered AI item", sourceId: "flaky" })],
        },
        isError: false,
      });
    },
  );

  it("audits a feed as succeeded when the single retry recovers", async () => {
    let attempts = 0;
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", name: "Flaky", url: "https://flaky.example/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Status code 429");
        }

        return {
          title: "Flaky",
          items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "retry-audit",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-retry" },
    );

    expect(attempts).toBe(2);
    expect(result.isError).toBe(false);
    expect(audit.collections).toEqual([
      expect.objectContaining({
        runId: "run-retry",
        sourceId: "flaky",
        status: "succeeded",
        itemCount: 1,
        error: null,
      }),
    ]);
  });

  it("fails a feed once after two transient errors and keeps the other feeds", async () => {
    const attempts = new Map<string, number>();
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "flaky", url: "https://flaky.example/feed" },
        { id: "working", name: "Working", url: "https://working.example/feed" },
      ],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      retryDelayMs: 5_000,
      sleep: async () => undefined,
      parseFeed: async (url) => {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);

        if (url.includes("flaky")) {
          throw withCode("read ECONNRESET", "ECONNRESET");
        }

        return {
          title: "Working",
          items: [feedArticle("Working AI item", "https://working.example/ai")],
        };
      },
    });
    const startedAt = Date.now();
    const result = await gateway.callTool(
      {
        id: "partial",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-partial" },
    );

    expect(attempts.get("https://flaky.example/feed")).toBe(2);
    expect(attempts.get("https://working.example/feed")).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Working AI item", sourceId: "working" })],
      },
      isError: false,
    });
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "working",
          status: "succeeded",
          itemCount: 1,
        }),
        expect.objectContaining({
          sourceId: "flaky",
          status: "failed",
          itemCount: 0,
          error: expect.objectContaining({ message: "read ECONNRESET" }),
          items: [],
        }),
      ]),
    );
    expect(audit.collections.filter((collection) => collection.status === "failed")).toHaveLength(
      1,
    );
  });

  it("keeps the all-feeds-failed result when every transient retry is exhausted", async () => {
    const attempts = new Map<string, number>();
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "left", url: "https://left.example/feed" },
        { id: "right", url: "https://right.example/feed" },
      ],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async (url) => {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);
        throw new Error("Request timed out after 5000ms");
      },
    });

    const result = await gateway.callTool(
      {
        id: "all-failed",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-all-failed" },
    );

    expect(attempts.get("https://left.example/feed")).toBe(2);
    expect(attempts.get("https://right.example/feed")).toBe(2);
    expect(result).toEqual({
      content: {
        error: "All configured RSS feeds failed: Request timed out after 5000ms",
      },
      isError: true,
    });
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "left", status: "failed", itemCount: 0, items: [] }),
        expect.objectContaining({ sourceId: "right", status: "failed", itemCount: 0, items: [] }),
      ]),
    );
  });

  it.each(NON_TRANSIENT_FEED_FAILURES)(
    "does not retry a non-transient $label",
    async ({ failure }) => {
      let attempts = 0;
      const delays: number[] = [];
      const gateway = new RssNewsGateway({
        feeds: [
          { id: "broken", url: "https://broken.example/feed" },
          { id: "working", name: "Working", url: "https://working.example/feed" },
        ],
        now: () => FEED_NOW,
        retryDelayMs: 5_000,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        parseFeed: async (url) => {
          if (url.includes("broken")) {
            attempts += 1;
            throw failure;
          }

          return {
            title: "Working",
            items: [feedArticle("Working AI item", "https://working.example/ai")],
          };
        },
      });

      const result = await gateway.callTool({
        id: "no-retry",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      });

      expect(attempts).toBe(1);
      expect(delays).toEqual([]);
      expect(result).toEqual({
        content: {
          items: [expect.objectContaining({ title: "Working AI item" })],
        },
        isError: false,
      });
    },
  );

  it("sleeps for the default delay only through the injected timer", async () => {
    const delays: number[] = [];
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", url: "https://flaky.example/feed" }],
      now: () => FEED_NOW,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      parseFeed: async () => {
        if (delays.length === 0) {
          throw new Error("Request timed out after 5000ms");
        }

        return {
          items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
        };
      },
    });
    const startedAt = Date.now();

    await gateway.callTool({
      id: "default-delay",
      name: "search_news",
      arguments: { query: "AI", limit: 1 },
    });

    expect(delays).toEqual([400]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

class RecordingSourceAudit implements SourceAuditStore {
  readonly collections: RecordSourceCollectionInput[] = [];

  async recordSourceCollection(input: RecordSourceCollectionInput): Promise<SourceRunRecord> {
    this.collections.push(structuredClone(input));
    return {
      ...structuredClone(input),
      attempt: 1,
      createdAt: input.startedAt,
    };
  }

  async listSourceRuns(): Promise<SourceRunRecord[]> {
    return [];
  }

  async listRawSourceItems(): Promise<RawSourceItemRecord[]> {
    return [];
  }
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `source-run-${(value += 1)}`;
}

function feedArticle(title: string, url: string) {
  return {
    title,
    link: url,
    isoDate: "2026-08-04T09:00:00.000Z",
    contentSnippet: title,
  };
}
