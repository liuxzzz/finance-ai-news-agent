import type {
  RawSourceItemRecord,
  RecordSourceCollectionInput,
  SourceAuditStore,
  SourceRunRecord,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import { RssNewsGateway, validateRssFeedUrl } from "./index.js";

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
